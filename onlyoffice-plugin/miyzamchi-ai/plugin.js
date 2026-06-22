// ═══════════════════════════════════════════════════════════════════
// plugin.js — Мыйзамчы AI Plugin for ONLYOFFICE Document Server
// Этап 3 миграции: ONLYOFFICE Plugin SDK (window.Asc.plugin)
//
// Ключевая особенность: callCommand выполняется в контексте РЕДАКТОРА,
// а не плагина. Передача данных через Asc.scope (официальный механизм).
// ═══════════════════════════════════════════════════════════════════

(function (window) {
    'use strict';

    var BACKEND_URL = 'https://miyzamchi-backend.onrender.com';

    // ── Состояние плагина ────────────────────────────────────────────
    var state = {
        selectedText: '',  // текст выделенный в документе
        aiAnswer:     '',  // последний ответ ИИ
        mode:         'consult', // 'consult' | 'analyze' | 'agent'
        loading:      false,
        abortCtrl:    null
    };

    // ── Ссылки на DOM-элементы (заполняются после DOMContentLoaded) ──
    var el = {};

    // ════════════════════════════════════════════════════════════════
    // ONLYOFFICE Plugin SDK — точки входа
    // ════════════════════════════════════════════════════════════════

    window.Asc.plugin.init = function (selectedText) {
        // Вызывается при запуске плагина.
        // selectedText = текущее выделение (из initDataType: "text").
        if (selectedText) {
            state.selectedText = selectedText;
            ui.setSelection(selectedText);
        }
    };

    window.Asc.plugin.button = function (/*id*/) {
        // Нажатие кнопок тулбара (у нас кнопок нет — не используется).
        window.Asc.plugin.executeCommand('close', '');
    };

    // Вызывается при каждом отпускании кнопки мыши (снятие выделения).
    window.Asc.plugin.onExternalMouseUp = function () {
        refreshSelection();
    };

    // ════════════════════════════════════════════════════════════════
    // ПОЛУЧЕНИЕ ВЫДЕЛЕННОГО ТЕКСТА
    // ════════════════════════════════════════════════════════════════

    function refreshSelection() {
        // executeMethod — безопаснее чем callCommand для чтения данных.
        window.Asc.plugin.executeMethod('GetSelectedText', null, function (text) {
            var clean = (text || '').trim();
            if (clean === state.selectedText) return;
            state.selectedText = clean;
            ui.setSelection(clean);
        });
    }

    // ════════════════════════════════════════════════════════════════
    // ЗАПИСЬ В ДОКУМЕНТ
    // ════════════════════════════════════════════════════════════════

    // Заменить выделенный текст на ответ ИИ (режим Агент).
    function insertAnswer() {
        if (!state.aiAnswer) return;
        Asc.scope = { text: state.aiAnswer };
        window.Asc.plugin.callCommand(function () {
            var oDoc   = Api.GetDocument();
            var oRange = oDoc.GetRangeBySelect();
            if (oRange) {
                oRange.SetText(Asc.scope.text);
            } else {
                // Нет выделения — вставить в позицию курсора как новый абзац
                var oPara = Api.CreateParagraph();
                oPara.AddText(Asc.scope.text);
                oDoc.Push(oPara);
            }
        }, false, function () {
            ui.toast('✅ Вставлено в документ');
        });
    }

    // Добавить комментарий к выделенному тексту (режим Аудит).
    function addCommentAnswer() {
        if (!state.aiAnswer) return;
        Asc.scope = { comment: state.aiAnswer, author: 'Мыйзамчы AI' };
        window.Asc.plugin.callCommand(function () {
            var oDoc   = Api.GetDocument();
            var oRange = oDoc.GetRangeBySelect();
            if (oRange) {
                oRange.AddComment(Asc.scope.comment, Asc.scope.author);
            }
        }, false, function () {
            ui.toast('💬 Комментарий добавлен');
        });
    }

    // Разметить риски из анализа как комментарии по всему документу.
    // risks = [{ fragment, risk, severity }]
    function annotateRisks(risks) {
        if (!risks || !risks.length) return;
        var idx = 0;

        function annotateNext() {
            if (idx >= risks.length) {
                ui.toast('✅ Разметка завершена: ' + risks.length + ' рисков');
                return;
            }
            var r = risks[idx++];
            Asc.scope = {
                searchText: (r.fragment || '').slice(0, 255),
                comment:    '[' + (r.severity || 'medium').toUpperCase() + '] ' + (r.risk || ''),
                author:     'Мыйзамчы AI'
            };
            window.Asc.plugin.callCommand(function () {
                var oDoc     = Api.GetDocument();
                var results  = oDoc.Search(Asc.scope.searchText);
                if (results && results.length > 0) {
                    results[0].AddComment(Asc.scope.comment, Asc.scope.author);
                }
            }, false, annotateNext);
        }

        annotateNext();
    }

    // ════════════════════════════════════════════════════════════════
    // SSE — ЗАПРОС К БЭКЕНДУ
    // ════════════════════════════════════════════════════════════════

    function sendToChat(query, mode) {
        if (state.loading) { state.abortCtrl && state.abortCtrl.abort(); }
        state.loading  = true;
        state.aiAnswer = '';
        state.abortCtrl = new AbortController();
        ui.setLoading(true);
        ui.clearResult();

        var modeParam = (mode === 'agent') ? 'fast' : (mode === 'analyze' ? 'thinking' : 'fast');

        fetch(BACKEND_URL + '/api/chat', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                message:    query,
                mode:       modeParam,
                agentMode:  false
            }),
            signal: state.abortCtrl.signal
        })
        .then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.body.getReader();
        })
        .then(function (reader) {
            var decoder = new TextDecoder();
            var buffer  = '';

            function pump() {
                return reader.read().then(function (chunk) {
                    if (chunk.done) {
                        state.loading = false;
                        ui.setLoading(false);
                        ui.showActions(!!state.aiAnswer);
                        return;
                    }
                    buffer += decoder.decode(chunk.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop(); // неполная строка остаётся в буфере

                    lines.forEach(function (line) {
                        if (!line.startsWith('data: ')) return;
                        var raw = line.slice(6).trim();
                        if (raw === '[DONE]') return;
                        try {
                            var d = JSON.parse(raw);
                            if (d.type === 'text' && d.content) {
                                state.aiAnswer += d.content;
                                ui.appendResult(d.content);
                            } else if (d.type === 'step') {
                                ui.setStep(d.name, d.status);
                            } else if (d.type === 'sources' && d.data) {
                                ui.setSources(d.data);
                            }
                        } catch (_) {
                            // Иногда data: содержит plain text (fast mode)
                            if (raw && raw !== '[DONE]') {
                                state.aiAnswer += raw;
                                ui.appendResult(raw);
                            }
                        }
                    });

                    return pump();
                });
            }
            return pump();
        })
        .catch(function (err) {
            if (err.name === 'AbortError') return;
            state.loading = false;
            ui.setLoading(false);
            ui.appendResult('\n\n⚠ Ошибка: ' + err.message);
        });
    }

    // Режим «Анализ документа» — получить весь текст → /api/analyze → разметить риски.
    function analyzeFullDocument() {
        window.Asc.plugin.executeMethod('GetSelectedText', null, function (selText) {
            var query = selText && selText.trim()
                ? selText.trim()
                : null;

            if (!query) {
                // Получить весь текст документа
                window.Asc.plugin.callCommand(function () {
                    var oDoc  = Api.GetDocument();
                    var lines = [];
                    var count = oDoc.GetElementsCount();
                    for (var i = 0; i < count; i++) {
                        var el = oDoc.GetElement(i);
                        if (el && el.GetText) lines.push(el.GetText());
                    }
                    return lines.join('\n');
                }, false, function (docText) {
                    if (!docText || !docText.trim()) {
                        ui.toast('⚠ Документ пустой');
                        return;
                    }
                    runAnalysis(docText.trim());
                });
            } else {
                runAnalysis(query);
            }
        });
    }

    function runAnalysis(docText) {
        state.loading  = true;
        state.aiAnswer = '';
        state.abortCtrl = new AbortController();
        ui.setLoading(true);
        ui.clearResult();
        ui.appendResult('⏳ Анализ документа…\n\n');

        var risks  = [];
        var answer = '';

        fetch(BACKEND_URL + '/api/chat', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                message:   'Проведи юридический аудит следующего документа по законодательству КР:\n\n' + docText.slice(0, 8000),
                mode:      'thinking',
                agentMode: false
            }),
            signal: state.abortCtrl.signal
        })
        .then(function (r) { return r.body.getReader(); })
        .then(function (reader) {
            var dec = new TextDecoder();
            var buf = '';
            function pump() {
                return reader.read().then(function (chunk) {
                    if (chunk.done) {
                        state.loading = false;
                        ui.setLoading(false);
                        // Парсим tableRow из накопленного ответа
                        if (risks.length > 0) annotateRisks(risks);
                        else ui.showActions(true);
                        return;
                    }
                    buf += dec.decode(chunk.value, { stream: true });
                    var lines = buf.split('\n');
                    buf = lines.pop();
                    lines.forEach(function (line) {
                        if (!line.startsWith('data: ')) return;
                        var raw = line.slice(6).trim();
                        try {
                            var d = JSON.parse(raw);
                            if (d.type === 'text' && d.content) {
                                answer += d.content;
                                state.aiAnswer += d.content;
                                ui.appendResult(d.content);
                            }
                            if (d.type === 'tableRow' && d.data) {
                                risks.push(d.data);
                            }
                        } catch (_) {}
                    });
                    return pump();
                });
            }
            return pump();
        })
        .catch(function (err) {
            if (err.name !== 'AbortError') {
                state.loading = false;
                ui.setLoading(false);
                ui.appendResult('\n⚠ ' + err.message);
            }
        });
    }

    // ════════════════════════════════════════════════════════════════
    // BRIDGE — обработчик команд от App.jsx (через backend relay)
    // Полный список cmd.type: insert, comment, replace_smart,
    // replace_selection, insert_end, replace_all, annotate
    // ════════════════════════════════════════════════════════════════

    function applyBridgeCmd(cmd) {
        var type    = cmd.type    || '';
        var text    = cmd.text    || '';
        var oldText = cmd.oldText || '';
        var anchor  = cmd.anchor  || '';

        if (type === 'insert' || type === 'replace_selection') {
            state.aiAnswer = text;
            insertAnswer();

        } else if (type === 'insert_end') {
            Asc.scope = { text: text };
            window.Asc.plugin.callCommand(function () {
                var oDoc  = Api.GetDocument();
                var oPara = Api.CreateParagraph();
                oPara.AddText(Asc.scope.text);
                oDoc.Push(oPara);
            }, false, function () { ui.toast('✅ Вставлено в конец'); });

        } else if (type === 'replace_smart') {
            var searchFor = oldText || anchor;
            if (searchFor) {
                Asc.scope = { searchText: searchFor, newText: text };
                window.Asc.plugin.callCommand(function () {
                    var results = Api.GetDocument().Search(Asc.scope.searchText);
                    if (results && results.length > 0) {
                        results[0].SetText(Asc.scope.newText);
                    }
                }, false, function () { ui.toast('✅ Заменено'); });
            } else {
                state.aiAnswer = text;
                insertAnswer();
            }

        } else if (type === 'replace_all') {
            var needle = oldText || anchor;
            if (needle) {
                Asc.scope = { needle: needle, newText: text };
                window.Asc.plugin.callCommand(function () {
                    var results = Api.GetDocument().Search(Asc.scope.needle);
                    for (var i = 0; i < (results || []).length; i++) {
                        results[i].SetText(Asc.scope.newText);
                    }
                }, false, function () { ui.toast('✅ Заменено везде'); });
            }

        } else if (type === 'comment') {
            state.aiAnswer = text;
            addCommentAnswer();

        } else if (type === 'annotate' && Array.isArray(cmd.risks)) {
            annotateRisks(cmd.risks);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // UI — управление интерфейсом
    // ════════════════════════════════════════════════════════════════

    var ui = {
        setSelection: function (text) {
            if (!el.selectionBox) return;
            el.selectionBox.textContent = text || '(нет выделения)';
            el.selectionBox.style.color = text ? '#222' : '#999';
            if (el.queryInput && state.mode === 'agent') {
                el.queryInput.value = text || '';
            }
        },
        setLoading: function (on) {
            if (!el.spinner) return;
            el.spinner.style.display   = on ? 'block' : 'none';
            el.sendBtn.disabled        = on;
            el.sendBtn.textContent     = on ? 'Думаю…' : 'Отправить';
            el.actions.style.display   = on ? 'none' : (state.aiAnswer ? 'flex' : 'none');
        },
        clearResult: function () {
            if (!el.result) return;
            el.result.textContent = '';
        },
        appendResult: function (text) {
            if (!el.result) return;
            el.result.textContent += text;
            el.result.scrollTop = el.result.scrollHeight;
        },
        setStep: function (name, status) {
            if (!el.stepLine) return;
            var icons = { loading: '⏳', success: '✅', warning: '⚠' };
            el.stepLine.textContent = (icons[status] || '•') + ' ' + name;
        },
        setSources: function (sources) {
            if (!el.sources || !sources.length) return;
            el.sources.innerHTML = '<strong style="font-size:11px;color:#888">Источники:</strong><br>' +
                sources.slice(0, 5).map(function (s) {
                    return '<span style="font-size:11px;color:#0069ff">' + (s.npa_title || s.article_title || '') + '</span>';
                }).join(' · ');
        },
        showActions: function (show) {
            if (!el.actions) return;
            el.actions.style.display = show ? 'flex' : 'none';
        },
        toast: function (msg) {
            if (!el.toast) return;
            el.toast.textContent = msg;
            el.toast.style.opacity = '1';
            setTimeout(function () { el.toast.style.opacity = '0'; }, 3000);
        }
    };

    // ════════════════════════════════════════════════════════════════
    // ИНИЦИАЛИЗАЦИЯ DOM
    // ════════════════════════════════════════════════════════════════

    document.addEventListener('DOMContentLoaded', function () {
        el.selectionBox = document.getElementById('selection-box');
        el.queryInput   = document.getElementById('query-input');
        el.sendBtn      = document.getElementById('send-btn');
        el.result       = document.getElementById('result');
        el.spinner      = document.getElementById('spinner');
        el.actions      = document.getElementById('actions');
        el.sources      = document.getElementById('sources');
        el.stepLine     = document.getElementById('step-line');
        el.toast        = document.getElementById('toast');

        // Кнопка «Отправить»
        el.sendBtn.addEventListener('click', function () {
            var query = (el.queryInput.value || state.selectedText || '').trim();
            if (!query) { ui.toast('⚠ Введите вопрос или выделите текст'); return; }
            sendToChat(query, state.mode);
        });

        // Enter в поле ввода
        el.queryInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                el.sendBtn.click();
            }
        });

        // Кнопки режимов
        document.querySelectorAll('[data-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.mode = btn.dataset.mode;
                document.querySelectorAll('[data-mode]').forEach(function (b) {
                    b.classList.toggle('active', b.dataset.mode === state.mode);
                });
                // В режиме Агент — prefill запрос выделенным текстом
                if (state.mode === 'agent' && state.selectedText) {
                    el.queryInput.value = state.selectedText;
                }
                // В режиме Анализ — очистить поле
                if (state.mode === 'analyze') {
                    el.queryInput.value = '';
                    el.queryInput.placeholder = 'Оставьте пустым для анализа всего документа';
                } else {
                    el.queryInput.placeholder = 'Задайте вопрос по праву КР…';
                }
            });
        });

        // Кнопка «Анализировать документ» (только в режиме analyze)
        var analyzeDocBtn = document.getElementById('analyze-doc-btn');
        if (analyzeDocBtn) {
            analyzeDocBtn.addEventListener('click', analyzeFullDocument);
        }

        // Кнопка «Вставить» — заменяет выделение
        document.getElementById('insert-btn').addEventListener('click', insertAnswer);

        // Кнопка «Комментарий» — добавляет комментарий
        document.getElementById('comment-btn').addEventListener('click', addCommentAnswer);

        // Кнопка «Отмена» (прерывает запрос)
        var stopBtn = document.getElementById('stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', function () {
                state.abortCtrl && state.abortCtrl.abort();
                state.loading = false;
                ui.setLoading(false);
                ui.toast('⛔ Остановлено');
            });
        }

        // Bridge: поллинг backend-relay (App.jsx и plugin.js — разные origin,
        // localStorage между ними не шарится). App.jsx пишет в /bridge/push,
        // плагин забирает здесь каждые 600мс.
        var _bridgeTs = Date.now() - 3000;
        setInterval(function () {
            fetch(BACKEND_URL + '/api/onlyoffice/bridge/poll?since=' + _bridgeTs)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!data) return;
                    _bridgeTs = data.ts || _bridgeTs;
                    (data.cmds || []).forEach(applyBridgeCmd);
                })
                .catch(function () {});
        }, 600);
    });

}(window));
