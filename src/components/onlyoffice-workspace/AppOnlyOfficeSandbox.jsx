// ═══════════════════════════════════════════════════════════════════
// AppOnlyOfficeSandbox.jsx — Тестовый клон App.jsx с ONLYOFFICE
// Этап 2+4 миграции: изолированная песочница, App.jsx не трогаем.
//
// Чтобы переключиться на этот компонент для тестирования,
// в src/main.jsx замените <App /> на <AppOnlyOfficeSandbox />.
// ═══════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useEffect } from 'react';
import { OnlyOfficeEditor } from './OnlyOfficeEditor.jsx';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://miyzamchi-backend.onrender.com';

// ── Toast (уведомления) ────────────────────────────────────────────
let _tid = 0;
function useToasts() {
    const [toasts, setToasts] = useState([]);
    const add = useCallback((icon, text, dur = 3) => {
        const id = ++_tid;
        setToasts(p => [...p.slice(-4), { id, icon, text }]);
        setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), dur * 1000);
    }, []);
    return [toasts, add];
}

const ICONS = { file:'📄', plus:'➕', save:'💾', trash:'🗑', warning:'⚠️', law:'⚖️', ok:'✅', spin:'⏳' };

// ── Генерация документа через /api/v2/draft-document (SSE) ────────
// Возвращает {docxFileId} через событие done.docxFileId
function useDocGeneration(addToast) {
    const [genStatus, setGenStatus] = useState('idle'); // idle|loading|done
    const [genProgress, setGenProgress] = useState('');
    const abortRef = useRef(null);

    const generate = useCallback(async (docType, messages, onReady) => {
        setGenStatus('loading');
        setGenProgress('Собираю досье…');
        abortRef.current?.abort();
        abortRef.current = new AbortController();

        try {
            // Шаг 1: интервьюер (собрать summary)
            const intakeResp = await fetch(`${BACKEND_URL}/api/v2/draft-intake`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docType, messages }),
                signal: abortRef.current.signal,
            });
            if (!intakeResp.ok) throw new Error(`intake: ${intakeResp.status}`);
            const intake = await intakeResp.json();
            if (!intake.ready) {
                setGenStatus('idle');
                addToast('warning', 'Необходима дополнительная информация');
                return null;
            }

            // Шаг 2: генерация SSE
            setGenProgress('Генерирую документ…');
            const draftResp = await fetch(`${BACKEND_URL}/api/v2/draft-document`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docType, summary: intake.summary, plan: intake.plan }),
                signal: abortRef.current.signal,
            });
            if (!draftResp.ok) throw new Error(`draft: ${draftResp.status}`);

            const reader  = draftResp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    try {
                        const d = JSON.parse(raw);
                        if (d.block?.kind) {
                            setGenProgress(`Блок: ${d.block.kind}`);
                        }
                        if (d.done && d.docxFileId) {
                            setGenStatus('done');
                            setGenProgress('');
                            addToast('ok', 'Документ готов — открываю в редакторе');
                            onReady(d.docxFileId);
                            return d.docxFileId;
                        }
                    } catch (_) {}
                }
            }
            setGenStatus('idle');
            addToast('warning', 'Документ создан, но ONLYOFFICE-файл не получен');
            return null;
        } catch (e) {
            if (e.name !== 'AbortError') {
                setGenStatus('idle');
                addToast('warning', 'Ошибка генерации: ' + e.message);
            }
            return null;
        }
    }, [addToast]);

    return { genStatus, genProgress, generate };
}

// ── Загрузка файла на бэкенд ───────────────────────────────────────
async function uploadDocx(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    const resp = await fetch(`${BACKEND_URL}/api/files/upload`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    return resp.json(); // { fileId, documentKey, filename, config }
}

// ── AI Chat (SSE) ─────────────────────────────────────────────────
function useMiyzamchiChat() {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef(null);

    const send = useCallback(async (text, selectedText = '') => {
        const userMsg = selectedText
            ? `Контекст из документа:\n"${selectedText}"\n\nВопрос: ${text}`
            : text;

        setMessages(p => [...p, { role: 'user', content: text }]);
        setLoading(true);

        let answer = '';
        setMessages(p => [...p, { role: 'ai', content: '', loading: true }]);

        try {
            abortRef.current?.abort();
            abortRef.current = new AbortController();

            const resp = await fetch(`${BACKEND_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMsg, mode: 'fast', agentMode: false }),
                signal: abortRef.current.signal
            });

            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const line of decoder.decode(value).split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d.type === 'text') {
                            answer += d.content;
                            setMessages(p => p.map((m, i) =>
                                i === p.length - 1 ? { ...m, content: answer } : m
                            ));
                        }
                        if (d.type === '[DONE]' || d === '[DONE]') break;
                    } catch (_) {}
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                setMessages(p => p.map((m, i) =>
                    i === p.length - 1 ? { ...m, content: '⚠ Ошибка: ' + e.message, loading: false } : m
                ));
            }
        } finally {
            setLoading(false);
            setMessages(p => p.map((m, i) =>
                i === p.length - 1 ? { ...m, loading: false } : m
            ));
        }
    }, []);

    return { messages, loading, send };
}

// ── Главный компонент ─────────────────────────────────────────────
export default function AppOnlyOfficeSandbox() {
    const [toasts, addToast] = useToasts();
    const [dark, setDark]    = useState(false);
    const [tabs, setTabs]    = useState([]); // { id, name, fileId, documentKey }
    const [activeTab, setActiveTab] = useState(null);
    const [rightOpen, setRightOpen] = useState(true);
    const [chatInput, setChatInput] = useState('');
    const { messages, loading: chatLoading, send: sendChat } = useMiyzamchiChat();
    const { genStatus, genProgress, generate } = useDocGeneration(addToast);
    const inputRef = useRef(null);

    const bg   = dark ? '#1a1a2e' : '#f0f2f5';
    const surf  = dark ? '#16213e' : '#ffffff';
    const text  = dark ? '#e0e0e0' : '#222222';
    const border = dark ? '#2a2a4a' : '#e0e0e0';
    const accent = '#0069ff';

    const currentTab = tabs.find(t => t.id === activeTab);

    // ── Открыть DOCX ──────────────────────────────────────────────
    const openFile = useCallback(async () => {
        let file;
        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{ description: 'Word документ', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }]
                });
                file = await handle.getFile();
            } catch (e) {
                if (e.name !== 'AbortError') addToast('warning', 'Не удалось открыть файл');
                return;
            }
        } else {
            file = await new Promise(resolve => {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = '.docx';
                inp.onchange = () => resolve(inp.files?.[0] || null);
                inp.click();
            });
            if (!file) return;
        }

        addToast('spin', 'Загружаем ' + file.name + '…');
        try {
            const { fileId, documentKey } = await uploadDocx(file);
            const id = 'tab_' + fileId;
            setTabs(p => [...p, { id, name: file.name, fileId, documentKey }]);
            setActiveTab(id);
            addToast('ok', 'Открыт: ' + file.name);
        } catch (e) {
            addToast('warning', 'Ошибка загрузки: ' + e.message);
        }
    }, [addToast]);

    // ── Создать пустой документ ───────────────────────────────────
    const newDoc = useCallback(async () => {
        // Создаём пустой .docx в памяти через Blob (минимальный OOXML)
        addToast('spin', 'Создаём документ…');
        try {
            const resp = await fetch(`${BACKEND_URL}/api/files/upload`, {
                method: 'POST',
                body: (() => {
                    const fd = new FormData();
                    // Минимальный валидный .docx — 1 пустой абзац
                    const emptyDocx = new Blob([''], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                    fd.append('file', emptyDocx, 'Новый_документ.docx');
                    return fd;
                })()
            });
            if (!resp.ok) throw new Error(resp.status);
            const { fileId, documentKey } = await resp.json();
            const name = 'Новый_документ_' + tabs.length + '.docx';
            const id   = 'tab_' + fileId;
            setTabs(p => [...p, { id, name, fileId, documentKey }]);
            setActiveTab(id);
            addToast('plus', 'Создан документ');
        } catch (e) {
            addToast('warning', 'Ошибка создания: ' + e.message);
        }
    }, [addToast, tabs.length]);

    const closeTab = useCallback(id => {
        setTabs(p => {
            const next = p.filter(t => t.id !== id);
            if (activeTab === id) setActiveTab(next[next.length - 1]?.id || null);
            return next;
        });
    }, [activeTab]);

    // Открыть файл по fileId (после генерации или аудита)
    const openDocxById = useCallback((fileId, name) => {
        const id = 'tab_' + fileId;
        if (tabs.find(t => t.id === id)) { setActiveTab(id); return; }
        const documentKey = `${fileId}_${Date.now()}`;
        setTabs(p => [...p, { id, name: name || `Документ_${fileId.slice(0,6)}.docx`, fileId, documentKey }]);
        setActiveTab(id);
    }, [tabs]);

    // Демо-запуск генерации искового заявления
    const demoGenerate = useCallback(async () => {
        const demoMessages = [
            { role: 'user', content: 'Исковое заявление о взыскании долга 150000 сом с ответчика ОсОО "Альфа", истец — Иванов Иван Иванович, г. Бишкек' }
        ];
        await generate('isk', demoMessages, (fileId) => openDocxById(fileId, 'Исковое_заявление.docx'));
    }, [generate, openDocxById]);

    const onSaved = useCallback(newKey => {
        if (!newKey || !activeTab) return;
        setTabs(p => p.map(t => t.id === activeTab ? { ...t, documentKey: newKey } : t));
        addToast('save', 'Документ сохранён');
    }, [activeTab, addToast]);

    // ── Task 2.3: localStorage-мост host → ONLYOFFICE plugin ─────────
    // Плагин (plugin.js) читает этот ключ через setInterval и применяет команду.
    const sendCommandToPlugin = useCallback((type, text) => {
        try {
            localStorage.setItem('miyzamchi_plugin_cmd', JSON.stringify({ type, text, ts: Date.now() }));
            addToast('ok', type === 'insert' ? 'Команда «Вставить» отправлена плагину' : 'Команда «Комментарий» отправлена плагину');
        } catch (_) {
            addToast('warning', 'Плагин Мыйзамчы должен быть открыт в ONLYOFFICE');
        }
    }, [addToast]);

    // ── Режим «Аудит документа» (Этап 4) ─────────────────────────────
    const [auditStatus, setAuditStatus] = useState('idle'); // idle|uploading|analyzing|generating|done
    const analyzeDocument = useCallback(async () => {
        // Выбор файла
        let file;
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.docx,.pdf,.txt';
        file = await new Promise(resolve => {
            inp.onchange = () => resolve(inp.files?.[0] || null);
            inp.oncancel  = () => resolve(null);
            inp.click();
        });
        if (!file) return;

        setAuditStatus('uploading');
        addToast('spin', 'Загружаем документ…');

        try {
            // 1. Загрузить файл для ONLYOFFICE (наш маршрут)
            const ooForm = new FormData();
            ooForm.append('file', file, file.name);
            const ooResp = await fetch(`${BACKEND_URL}/api/files/upload`, { method: 'POST', body: ooForm });
            if (!ooResp.ok) throw new Error(`upload: ${ooResp.status}`);
            const { fileId: srcFileId } = await ooResp.json();

            // 2. Загрузить файл для анализа (Shadow Pipeline)
            const anaForm = new FormData();
            anaForm.append('document', file, file.name);
            const uploadResp = await fetch(`${BACKEND_URL}/api/upload-document`, { method: 'POST', body: anaForm });
            const uploadData = uploadResp.ok ? await uploadResp.json().catch(() => ({})) : {};
            const sessionId  = uploadData.sessionId || null;

            setAuditStatus('analyzing');
            addToast('spin', 'Анализируем…', 60);

            // 3. SSE-анализ → собираем риски
            const risks = [];
            const anaBody = sessionId
                ? JSON.stringify({ sessionId })
                : JSON.stringify({ text: await file.text().catch(() => '') });

            const anaResp = await fetch(`${BACKEND_URL}/api/analyze-document`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: anaBody,
            });
            if (!anaResp.ok) throw new Error(`analyze: ${anaResp.status}`);

            const reader  = anaResp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d.type === 'tableRow' && d.data) {
                            risks.push({
                                fragment:  d.data.text        || d.data.fragment || '',
                                risk:      d.data.detail      || d.data.risk     || '',
                                severity:  d.data.severity    || 'medium',
                                norm:      (d.data.cited_articles || []).join(', '),
                            });
                        }
                    } catch (_) {}
                }
            }

            setAuditStatus('generating');
            addToast('spin', `Найдено ${risks.length} замечаний, генерируем отчёт…`, 10);

            // 4. Создать сводный .docx с аннотациями
            const auditResp = await fetch(`${BACKEND_URL}/api/onlyoffice/audit-docx`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ risks, title: `Аудит: ${file.name}` }),
            });
            if (!auditResp.ok) throw new Error(`audit-docx: ${auditResp.status}`);
            const { fileId: auditFileId } = await auditResp.json();

            // 5. Открыть оба файла в ONLYOFFICE
            openDocxById(srcFileId,  file.name);
            openDocxById(auditFileId, `Аудит_${file.name}`);
            setAuditStatus('done');
            addToast('ok', `Аудит готов: ${risks.length} замечаний`);
            setTimeout(() => setAuditStatus('idle'), 3000);

        } catch (e) {
            setAuditStatus('idle');
            addToast('warning', 'Ошибка аудита: ' + e.message);
        }
    }, [addToast, openDocxById]);

    const sendMessage = useCallback(() => {
        const text = chatInput.trim();
        if (!text || chatLoading) return;
        setChatInput('');
        sendChat(text);
    }, [chatInput, chatLoading, sendChat]);

    // ── Render ────────────────────────────────────────────────────
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: bg, color: text, fontFamily: 'system-ui, sans-serif' }}>

            {/* ── TopBar ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 44, background: surf, borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: accent, marginRight: 8 }}>⚖ Мыйзамчы</span>
                <span style={{ fontSize: 11, color: '#888', marginRight: 8 }}>ONLYOFFICE Sandbox</span>
                <button onClick={openFile} style={btnStyle(accent)}>📂 Открыть</button>
                <button onClick={newDoc}  style={btnStyle('#28a745')}>➕ Пустой</button>
                <button onClick={demoGenerate} disabled={genStatus === 'loading'} style={{ ...btnStyle('#7c3aed'), opacity: genStatus === 'loading' ? 0.6 : 1 }}>
                    {genStatus === 'loading' ? `⏳ ${genProgress || 'Генерирую…'}` : '✨ Создать (AI)'}
                </button>
                <button onClick={analyzeDocument} disabled={auditStatus !== 'idle'} style={{ ...btnStyle('#d97706'), opacity: auditStatus !== 'idle' ? 0.6 : 1 }}>
                    {auditStatus === 'idle' ? '🔍 Аудит' : `⏳ ${auditStatus === 'uploading' ? 'Загрузка…' : auditStatus === 'analyzing' ? 'Анализ…' : 'Генерация…'}`}
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={() => setDark(d => !d)} style={btnStyle('#555')}>
                    {dark ? '☀ Светлая' : '🌙 Тёмная'}
                </button>
                <button onClick={() => setRightOpen(p => !p)} style={btnStyle('#555')}>
                    {rightOpen ? '▶ Скрыть чат' : '◀ Чат'}
                </button>
            </div>

            {/* ── Tabs ── */}
            {tabs.length > 0 && (
                <div style={{ display: 'flex', background: surf, borderBottom: `1px solid ${border}`, overflowX: 'auto', flexShrink: 0 }}>
                    {tabs.map(tab => (
                        <div key={tab.id} onClick={() => setActiveTab(tab.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                                borderBottom: tab.id === activeTab ? `2px solid ${accent}` : '2px solid transparent',
                                color: tab.id === activeTab ? accent : text,
                                background: tab.id === activeTab ? (dark ? '#0a0a1e' : '#f0f6ff') : 'transparent' }}>
                            📄 {tab.name}
                            <span onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                                style={{ marginLeft: 4, color: '#999', cursor: 'pointer' }}>×</span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Main area ── */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

                {/* Редактор */}
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                    {currentTab ? (
                        <OnlyOfficeEditor
                            key={currentTab.id}
                            fileId={currentTab.fileId}
                            documentKey={currentTab.documentKey}
                            onSaved={onSaved}
                            onError={msg => addToast('warning', msg)}
                        />
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa' }}>
                            <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
                            <p style={{ fontSize: 14 }}>Откройте или создайте документ</p>
                            <p style={{ fontSize: 12, color: '#bbb' }}>Поддерживается формат .docx</p>
                        </div>
                    )}
                </div>

                {/* AI Chat Panel */}
                {rightOpen && (
                    <div style={{ width: 340, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${border}`, background: surf, flexShrink: 0 }}>

                        {/* Header */}
                        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${border}`, fontWeight: 600, fontSize: 13 }}>
                            ⚖ Мыйзамчы AI
                        </div>

                        {/* Messages */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {messages.length === 0 && (
                                <p style={{ color: '#aaa', fontSize: 12, textAlign: 'center', marginTop: 24 }}>
                                    Задайте вопрос по праву КР или откройте документ для анализа
                                </p>
                            )}
                            {messages.map((msg, i) => (
                                <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                                    <div style={{
                                        padding: '8px 12px', borderRadius: 12,
                                        background: msg.role === 'user' ? accent : (dark ? '#2a2a4a' : '#f0f4ff'),
                                        color: msg.role === 'user' ? '#fff' : text,
                                        fontSize: 13, lineHeight: 1.5
                                    }}>
                                        {msg.loading && !msg.content ? '⏳ Думаю…' : msg.content}
                                    </div>
                                    {msg.role === 'ai' && !msg.loading && msg.content && (
                                        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                            <button onClick={() => sendCommandToPlugin('insert', msg.content)}
                                                style={{ ...btnStyle('#28a745'), fontSize: 11, padding: '2px 8px' }}>
                                                ✏ Вставить
                                            </button>
                                            <button onClick={() => sendCommandToPlugin('comment', msg.content)}
                                                style={{ ...btnStyle(accent), fontSize: 11, padding: '2px 8px' }}>
                                                💬 Комментарий
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Input */}
                        <div style={{ padding: 10, borderTop: `1px solid ${border}`, display: 'flex', gap: 8 }}>
                            <input
                                ref={inputRef}
                                value={chatInput}
                                onChange={e => setChatInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                                placeholder="Вопрос по праву КР…"
                                disabled={chatLoading}
                                style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${border}`, background: dark ? '#0a0a1e' : '#fff', color: text, fontSize: 13, outline: 'none' }}
                            />
                            <button onClick={sendMessage} disabled={chatLoading}
                                style={{ ...btnStyle(accent), padding: '6px 12px', opacity: chatLoading ? 0.6 : 1 }}>
                                →
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Toasts */}
            <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999 }}>
                {toasts.map(t => (
                    <div key={t.id} style={{ background: '#333', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', animation: 'fadeIn 0.2s ease' }}>
                        <span>{ICONS[t.icon] || t.icon}</span>
                        <span>{t.text}</span>
                    </div>
                ))}
            </div>

            <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }`}</style>
        </div>
    );
}

function btnStyle(bg) {
    return {
        padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: bg, color: '#fff', fontSize: 12, fontWeight: 500,
        transition: 'opacity 0.15s',
    };
}
