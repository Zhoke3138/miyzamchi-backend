// ═══════════════════════════════════════════════════════════════════════
//  lib/traceLogger.js
//  Full debug-trace logger для пайплайна анализа документа.
//  Selective Reasoning v2.0  ·  2026-05-31
// ═══════════════════════════════════════════════════════════════════════
//
//  ЗАЧЕМ:
//  Ловим плавающие галлюцинации (ИИ выдумывает статьи). Нужен 100%
//  прозрачный "чёрный ящик" каждого сеанса: входной текст, паспорт,
//  каждый prompt каждому агенту, каждый tool_call, каждая выдача Pinecone,
//  каждый вердикт, плюс полный prompt+response Final Judge.
//
//  АРХИТЕКТУРА:
//  • Один сеанс анализа = один файл traces/trace_<ts>_<rand>.md
//  • Append-only writes через fs.promises.appendFile.
//  • Очередь записей (writeChain) — гарантирует порядок без блокировки
//    Event Loop. Каждый log* возвращает Promise; вызывать без await
//    безопасно — следующий append встанет в очередь.
//  • Graceful: любая ошибка fs не валит пайплайн, только logger.warn.
//  • Включается через env TRACE_ENABLED (default: true). Чтобы выключить
//    на проде — выставить TRACE_ENABLED=false.
//  • Авто-очистка файлов старше TRACE_TTL_DAYS (default: 7) при init.
//
//  СОЗДАНИЕ:
//    const { createTraceLogger } = require('../lib/traceLogger');
//    const trace = createTraceLogger({ docHash, docHashPrefix });
//    await trace.logHeader({ docLength, ... });
//    ...
//    await trace.flush();   // дождаться очереди перед SSE [DONE]
//
//  СКАЧИВАНИЕ:
//    Бэкенд регистрирует GET /api/trace/:filename (см. routes/analyze.js).
//    Фронт получает SSE { trace_ready: { id, url } } → рендерит кнопку
//    "📥 Скачать debug-отчёт".
//
//  БЕЗОПАСНОСТЬ:
//  Trace содержит ПОЛНЫЙ текст документа пользователя. Не коммитить!
//  В .gitignore добавить `traces/`.
//  При публичном деплое — выставить TRACE_ENABLED=false ИЛИ закрыть
//  /api/trace/* через basic-auth/токен.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TRACES_DIR = path.join(__dirname, '..', 'traces');
const TRACE_ENABLED_DEFAULT = process.env.TRACE_ENABLED !== 'false';
const TRACE_TTL_DAYS = Number(process.env.TRACE_TTL_DAYS) || 7;
const TRACE_FILENAME_RE = /^trace_[A-Za-z0-9_-]+\.md$/;

// ── Утилиты ─────────────────────────────────────────────────────────────
function _ts() {
    return new Date().toISOString();
}

function _safeTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function _rand(n = 6) {
    return Math.random().toString(36).slice(2, 2 + n);
}

function _fenceLang(s) {
    if (!s) return '';
    return String(s).replace(/```/g, '` ` `');
}

function _truncate(s, max) {
    if (!s) return '';
    const str = String(s);
    if (str.length <= max) return str;
    return str.slice(0, max) + `\n\n[…trace-truncate: ${str.length - max} chars omitted]`;
}

function _isFilenameSafe(name) {
    return TRACE_FILENAME_RE.test(String(name || ''));
}

function _ensureDirSync(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (e) {
        return false;
    }
}

// Автоочистка старых трейсов (best-effort, без await).
function _gcOldTraces(logger = console) {
    if (!TRACE_TTL_DAYS || TRACE_TTL_DAYS < 0) return;
    fs.promises.readdir(TRACES_DIR).then(files => {
        const cutoff = Date.now() - TRACE_TTL_DAYS * 24 * 60 * 60 * 1000;
        return Promise.all(files.map(async f => {
            if (!_isFilenameSafe(f)) return;
            const full = path.join(TRACES_DIR, f);
            try {
                const st = await fs.promises.stat(full);
                if (st.mtimeMs < cutoff) {
                    await fs.promises.unlink(full);
                    logger.info?.(`[trace] gc removed ${f}`);
                }
            } catch (_) {}
        }));
    }).catch(() => {});
}

// ── Главный entry: factory логгера для одного сеанса ────────────────────
function createTraceLogger(opts = {}) {
    const {
        enabled = TRACE_ENABLED_DEFAULT,
        requestId = null,
        docHashPrefix = null,
        logger = console
    } = opts || {};

    if (!enabled) {
        return _makeNoopLogger();
    }

    if (!_ensureDirSync(TRACES_DIR)) {
        logger.warn?.('[trace] mkdir failed — trace disabled');
        return _makeNoopLogger();
    }

    const id = requestId || `trace_${_safeTimestamp()}_${_rand()}${docHashPrefix ? '_' + String(docHashPrefix).slice(0, 8) : ''}`;
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeId}.md`;
    const filePath = path.join(TRACES_DIR, fileName);
    const startedAt = Date.now();
    let bytesWritten = 0;
    let writeChain = Promise.resolve();
    let errorCount = 0;

    // GC при первом создании логгера в процессе (раз в сутки максимум).
    if (!global.__miyzamchi_trace_gc_at || Date.now() - global.__miyzamchi_trace_gc_at > 24 * 60 * 60 * 1000) {
        global.__miyzamchi_trace_gc_at = Date.now();
        _gcOldTraces(logger);
    }

    function _enqueue(text) {
        const chunk = String(text);
        bytesWritten += Buffer.byteLength(chunk, 'utf8');
        writeChain = writeChain.then(() =>
            fs.promises.appendFile(filePath, chunk, 'utf8')
        ).catch(e => {
            errorCount++;
            if (errorCount <= 3) {
                logger.warn?.(`[trace ${fileName}] append failed: ${e.message}`);
            }
        });
        return writeChain;
    }

    // ── Высокоуровневые API ─────────────────────────────────────────────

    function logHeader(meta = {}) {
        const lines = [
            `# Debug Trace — ${safeId}`,
            '',
            `**Started:** ${_ts()}`,
            `**Pipeline:** \`${meta.pipeline || '/api/analyze-document'}\``,
            `**Doc length:** ${meta.docLength || 0} chars`,
            `**Doc hash (prefix):** \`${meta.docHashPrefix || docHashPrefix || '-'}\``,
            `**Session ID:** \`${meta.sessionId || '-'}\``,
            `**Trace file:** \`${fileName}\``,
            '',
            '---',
            '',
            '## STEP 1: Входные данные',
            '',
            '### Первые 4000 символов документа',
            '```text',
            _fenceLang(_truncate(meta.docHead || '', 4000)),
            '```',
            ''
        ];
        return _enqueue(lines.join('\n') + '\n');
    }

    function logPassport(passport) {
        if (!passport) {
            return _enqueue('### Паспорт документа\n\n_Не сформирован (passport=null)_\n\n');
        }
        const lines = [
            '### Паспорт документа',
            '',
            `- **title:** ${passport.title || '-'}`,
            `- **docType:** \`${passport.docType || '-'}\``,
            `- **summary:** ${passport.summary || '-'}`,
            `- **parties:** ${passport.parties || '-'}`,
            `- **branches:** ${(passport.branches || []).join(', ')}`,
            `- **expectedNpas:** ${(passport.expectedNpas || []).join(', ')}`,
            `- **semanticHints:** ${(passport.semanticHints || []).join(', ')}`,
            `- **totalChunks:** ${passport.totalChunks || '-'}`,
            `- **model:** ${passport.model || '-'} (tier ${passport.tier || '-'})`,
            '',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logTriage(triage) {
        if (!triage) return _enqueue('### Triage\n\n_Не запускался_\n\n');
        const lines = [
            '### Triage',
            '',
            '```json',
            _fenceLang(JSON.stringify(triage, null, 2)),
            '```',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logSegments(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
            return _enqueue('### Сегменты\n\n_Пусто_\n\n');
        }
        const lines = [`### Сегменты (${segments.length} штук)`, ''];
        for (let i = 0; i < segments.length; i++) {
            const s = segments[i] || {};
            const heading = (s.heading || '').slice(0, 80);
            const len = (s.text || '').length;
            lines.push(`${i + 1}. **п.${s.number || i + 1}** ${heading} — ${len} chars`);
        }
        lines.push('', '');
        return _enqueue(lines.join('\n'));
    }

    function logPipelineState(meta) {
        const lines = [
            '### Состояние pipeline',
            '',
            `- audit segments: ${meta.auditCount ?? '-'}`,
            `- skip segments: ${meta.skipCount ?? '-'}`,
            `- meta_context: ${meta.metaContext || '-'}`,
            `- fromCache: ${meta.fromCache ? 'HIT' : 'MISS'}`,
            '',
            '---',
            '',
            '## STEP 2: Agentic Verifier — по каждому пункту',
            '',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    // ── Verifier (один сегмент) ─────────────────────────────────────────
    function logVerifierStart({ segmentRef, originalIdx, targetType, targetArticle, articleGroup, topology, textHead }) {
        const lines = [
            `### 🧠 ${segmentRef} (originalIdx=${originalIdx})`,
            '',
            `- **targetType:** \`${targetType || '-'}\``
        ];
        if (targetArticle) lines.push(`- **targetArticle:** ст.${targetArticle.number} ${targetArticle.act || ''}`);
        if (articleGroup) lines.push(`- **articleGroup:** ${articleGroup.map(a => `ст.${a.number} ${a.act || ''}`).join(', ')}`);
        if (topology) {
            lines.push(`- **topology:** chunk ${topology.chunkIndex}/${topology.totalChunks}, section: ${topology.section || '-'}`);
            if (topology.prevHeading) lines.push(`  - prev: ${topology.prevHeading}`);
            if (topology.nextHeading) lines.push(`  - next: ${topology.nextHeading}`);
        }
        lines.push('', '<details><summary>📝 Текст фрагмента</summary>', '', '```text', _fenceLang(_truncate(textHead || '', 3000)), '```', '', '</details>', '');
        return _enqueue(lines.join('\n'));
    }

    function logVerifierSystemPrompt(systemPrompt) {
        const lines = [
            '<details><summary>⚙️ System prompt (полный)</summary>',
            '',
            '```text',
            _fenceLang(systemPrompt || ''),
            '```',
            '',
            '</details>',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logVerifierUserPrompt(userPrompt) {
        const lines = [
            '<details><summary>👤 User prompt (полный)</summary>',
            '',
            '```text',
            _fenceLang(userPrompt || ''),
            '```',
            '',
            '</details>',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logVerifierTurn({ turn, tier, model, kind, payload }) {
        // kind: 'tool_call' | 'tool_response' | 'final_text' | 'tier_error'
        const lines = [`#### Turn ${turn} · tier ${tier} · \`${model}\` · ${kind}`];
        if (kind === 'tool_call') {
            lines.push('',
                `- **query:** \`${(payload.query || '').slice(0, 300)}\``,
                `- **reason:** ${(payload.reason || '').slice(0, 200)}`,
                '');
        } else if (kind === 'tool_response') {
            const arts = payload.articles || [];
            lines.push('', `**Pinecone вернул ${arts.length} статей:**`, '');
            for (let i = 0; i < arts.length; i++) {
                const a = arts[i];
                lines.push(
                    `<details><summary>${i + 1}. **${a.npa_title || '?'} · ${a.article_title || '?'}** (score: ${a.similarity != null ? a.similarity : '?'})</summary>`,
                    '',
                    '```text',
                    _fenceLang(_truncate(a.full_text || '', 2000)),
                    '```',
                    '',
                    '</details>',
                    ''
                );
            }
            if (payload.error) lines.push(`> ⚠️ Pinecone error: \`${payload.error}\``, '');
        } else if (kind === 'final_text') {
            lines.push('',
                '<details open><summary>📤 Финальный ответ модели</summary>',
                '',
                '```json',
                _fenceLang(_truncate(payload.text || '', 5000)),
                '```',
                '',
                '</details>',
                '');
        } else if (kind === 'tier_error') {
            lines.push('',
                `> ❌ Tier failed: \`${payload.errorKind || '?'}\` — ${(payload.message || '').slice(0, 300)}`,
                '');
        }
        return _enqueue(lines.join('\n'));
    }

    function logVerifierVerdict({ verdict, durationMs, toolCalls, articlesCount }) {
        const lines = [
            '#### ✅ Финальный вердикт сегмента',
            '',
            '```json',
            _fenceLang(JSON.stringify({
                status: verdict?.status,
                confidence: verdict?.confidence,
                finding: verdict?.finding,
                rationale: verdict?.rationale,
                suggestion: verdict?.suggestion,
                provider: verdict?.provider
            }, null, 2)),
            '```',
            '',
            `- **elapsed:** ${durationMs ? (durationMs / 1000).toFixed(2) + 's' : '-'}`,
            `- **tool_calls:** ${toolCalls ?? '-'}`,
            `- **articles_used:** ${articlesCount ?? '-'}`,
            '',
            '---',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    // ── Final Judge ─────────────────────────────────────────────────────
    function logJudgeStart({ path: pathLabel, model, reasoning, total, critical, warning, ok, purityIndex }) {
        const lines = [
            '',
            '---',
            '',
            '## STEP 3: Final Judge',
            '',
            `- **path:** ${pathLabel}`,
            `- **model:** \`${model}\``,
            `- **reasoning_effort:** \`${reasoning}\``,
            `- **total / critical / warning / ok:** ${total} / ${critical} / ${warning} / ${ok}`,
            `- **purityIndex:** ${purityIndex}%`,
            '',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logJudgeSystemPrompt(systemPrompt) {
        const lines = [
            '### ⚙️ System prompt Final Judge',
            '',
            '```text',
            _fenceLang(systemPrompt || ''),
            '```',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logJudgeUserPrompt(userPrompt) {
        const lines = [
            '### 👤 User prompt Final Judge (полный)',
            '',
            '```text',
            _fenceLang(userPrompt || ''),
            '```',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logJudgeResponse(responseText, durationMs) {
        const lines = [
            '### 📤 Финальный ответ Final Judge',
            '',
            '```markdown',
            _fenceLang(responseText || ''),
            '```',
            '',
            `- **elapsed:** ${durationMs ? (durationMs / 1000).toFixed(2) + 's' : '-'}`,
            '',
            ''
        ];
        return _enqueue(lines.join('\n'));
    }

    function logFooter(meta = {}) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
        const lines = [
            '---',
            '',
            '## SUMMARY',
            '',
            `- **Total elapsed:** ${elapsed}s`,
            `- **Trace bytes written:** ${bytesWritten}`,
            `- **Trace errors:** ${errorCount}`
        ];
        if (meta.telemetry) {
            const t = meta.telemetry;
            lines.push(
                `- **LLM calls:** ${t.calls || '-'}`,
                `- **Tokens:** in ${t.input || '-'} / out ${t.output || '-'}`,
                `- **Cost:** $${(t.cost || 0).toFixed(5)}`
            );
        }
        lines.push('', `_Trace closed at ${_ts()}_`, '');
        return _enqueue(lines.join('\n'));
    }

    // ── Ad-hoc раздел для произвольных событий (Phase 3 / Hybrid и пр.) ─
    function logSection(title, body) {
        return _enqueue(`### ${title}\n\n${body}\n\n`);
    }

    // ── Дождаться очередь (использовать перед SSE [DONE]) ───────────────
    function flush() {
        return writeChain;
    }

    return {
        isNoop: false,
        id: safeId,
        fileName,
        filePath,
        relativePath: `traces/${fileName}`,
        downloadUrl: `/api/trace/${encodeURIComponent(fileName)}`,
        startedAt,
        logHeader, logPassport, logTriage, logSegments, logPipelineState,
        logVerifierStart, logVerifierSystemPrompt, logVerifierUserPrompt,
        logVerifierTurn, logVerifierVerdict,
        logJudgeStart, logJudgeSystemPrompt, logJudgeUserPrompt, logJudgeResponse,
        logSection, logFooter, flush
    };
}

// ── No-op версия (когда trace disabled) ─────────────────────────────────
function _makeNoopLogger() {
    const noop = async () => {};
    return {
        isNoop: true,
        id: null, fileName: null, filePath: null, relativePath: null, downloadUrl: null,
        startedAt: Date.now(),
        logHeader: noop, logPassport: noop, logTriage: noop, logSegments: noop, logPipelineState: noop,
        logVerifierStart: noop, logVerifierSystemPrompt: noop, logVerifierUserPrompt: noop,
        logVerifierTurn: noop, logVerifierVerdict: noop,
        logJudgeStart: noop, logJudgeSystemPrompt: noop, logJudgeUserPrompt: noop, logJudgeResponse: noop,
        logSection: noop, logFooter: noop, flush: noop
    };
}

// ── Безопасное чтение для GET /api/trace/:filename ──────────────────────
async function readTraceFile(filename) {
    if (!_isFilenameSafe(filename)) {
        const err = new Error('invalid filename');
        err.code = 'INVALID_FILENAME';
        throw err;
    }
    const full = path.join(TRACES_DIR, filename);
    // Защита от path traversal: окончательный путь должен начинаться с TRACES_DIR
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(TRACES_DIR) + path.sep) && resolved !== path.resolve(TRACES_DIR)) {
        const err = new Error('path traversal blocked');
        err.code = 'PATH_TRAVERSAL';
        throw err;
    }
    return fs.promises.readFile(resolved, 'utf8');
}

module.exports = {
    createTraceLogger,
    readTraceFile,
    TRACES_DIR,
    TRACE_ENABLED_DEFAULT,
    TRACE_FILENAME_RE
};
