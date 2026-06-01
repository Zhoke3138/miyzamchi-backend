// ═══════════════════════════════════════════════════════════════════════
//  lib/agenticVerifier.js
//  Agentic RAG для Verifier — модель сама вызывает search_legislation_kg.
//  Selective Reasoning v2.0  ·  2026-05-30
// ═══════════════════════════════════════════════════════════════════════
//
//  ЗАЧЕМ:
//   Старый runVerifierAgent: бэкенд делает Pinecone search → склеивает 3-10
//   статей в userPrompt → модель пишет вердикт по всему, что притащили,
//   включая нерелевантный мусор ("Заявитель ссылается на Закон о рекламе"
//   когда документ — жалоба в Комитет ООН).
//
//   Новый flow (Agentic RAG):
//   1) Модель получает Паспорт + Топологию + текст пункта (HCR-контекст).
//   2) Модель САМА формулирует семантический запрос и вызывает функцию
//      search_legislation_kg(query, reason).
//   3) Бэкенд исполняет: Pinecone TopK=5, возвращает массив статей в
//      multi-turn chat history.
//   4) Модель оценивает 5 статей, отбрасывает false positives (другая
//      отрасль), при необходимости делает ещё 1 уточняющий поиск.
//   5) Возвращает финальный JSON-вердикт.
//
//  ОГРАНИЧЕНИЯ:
//   • MAX_TOOL_TURNS = 3 (защита от бесконечного loop).
//   • Watchdog 45 секунд на весь tool-loop одного task'а.
//   • Function calling работает только на Gemini-tier'ах (1, 2 каскада).
//     Tier 3 (DeepSeek V4 Flash) в нашей реализации tools не поддерживает →
//     graceful fallback в legacy single-shot режим: бэкенд сам делает
//     один Pinecone search и кормит модель напрямую.
//
//  ТЕЛЕМЕТРИЯ:
//   На каждый turn: telemetry.recordCascadeAttempt + addTokens.
//   На каждый tool call: onSearchEvent({ query, reason, turn, found }) —
//   caller использует для SSE-события "agent_search" во фронте.
//
//  THROTTLE (Smooth Burst 20 RPS):
//   Если caller передал throttle, каждый turn внутри одного task'а
//   проходит через throttle.submit() повторно. Это значит throttle сам
//   распределит ВСЕ LLM-вызовы (turn 1, turn 2, turn 3) с 50ms интервалом.
//   Один task с 3 turns занимает 3 слота, но они распределены во времени.
//   Очередь других task'ов не блокируется — пока turn 2 task'а A ждёт
//   слот, task B стартует.
//
//  API:
//   const { createAgenticVerifier } = require('./agenticVerifier');
//   const verifier = createAgenticVerifier({
//       getNextKey, searchPinecone, getEmbedding,
//       deepseekJsonCall, deepseekEnabled,
//       buildHCREmbeddingQuery,  // из hierarchicalContext.js
//       throttle,                // опционально, из smoothBurstThrottle
//       logger
//   });
//
//   const { result, articles, toolCalls, tier, model } = await verifier.run({
//       baseSystemPrompt,        // HCR-обогащённый prompt (caller строит)
//       userPrompt,              // первый user message
//       passport, topology,      // для embedding query
//       targetType, targetArticle, articleGroup,  // для fallback context
//       telemetry, stageLabel,
//       maxToolTurns: 3,
//       topK: 5,
//       watchdogMs: 45000,
//       aborted: { value: false },
//       onSearchEvent: ({ query, reason, turn, found }) => sendStep(...)
//   });
// ═══════════════════════════════════════════════════════════════════════

const { performance } = require('perf_hooks');
const {
    callGeminiSingle,
    callDeepSeekSingle,
    withTimeout,
    classifyCascadeError,
    TIERS
} = require('./llmCascade');

// ── Tool declaration ────────────────────────────────────────────────────
// Function declaration в формате Gemini (тип параметров заглавными).
const SEARCH_TOOL = {
    name: 'search_legislation_kg',
    description: 'Семантический поиск по векторной базе нормативно-правовых актов Кыргызской Республики. Возвращает до 5 наиболее релевантных статей. Используй СЕМАНТИЧЕСКИЕ запросы на русском языке (например, "неустойка в договоре оказания услуг" вместо "ст. 333"), это даёт точные попадания. Можешь сделать 1-2 поиска подряд для уточнения.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'Семантический запрос на русском, описывающий что именно ищешь. Например: "кабальные условия неустойки в потребительском договоре" или "пытки и расследование жалоб на сотрудников милиции".'
            },
            reason: {
                type: 'STRING',
                description: 'Кратко (до 80 символов) — зачем этот запрос. Будет показано юристу в UI.'
            }
        },
        required: ['query']
    }
};

const TOOLS_PAYLOAD = [{ functionDeclarations: [SEARCH_TOOL] }];

// ── Константы ───────────────────────────────────────────────────────────
const DEFAULT_MAX_TOOL_TURNS = 3;
const DEFAULT_TOP_K = 5;
const DEFAULT_WATCHDOG_MS = 45000;
const ARTICLE_TEXT_LIMIT = 800;

// ── Tool-блок инструкций (вшивается в systemPrompt caller'ом) ───────────
// Экспортируем — caller (routes/analyze.js) добавляет его в baseSystemPrompt
// между HCR-блоком и schema-описанием.
//
// 2026-05-30 (правки v2): добавлены жёсткие правила против двух паттернов:
//   (1) Робот-помощник: модель НИКОГДА не должна обвинять пользователя в
//       нерелевантных статьях, притащенных RAG. Это ошибка робота, а не
//       пользователя.
//   (2) Искусственная нарезка: модель НИКОГДА не должна критиковать
//       чанки за неполноту — текст был разбит скриптом, не автором.
const TOOL_PROTOCOL_BLOCK = `📚 ТВОЙ ИНСТРУМЕНТ ПОИСКА:
У тебя есть функция search_legislation_kg(query, reason). Используй её 1-2 раза, чтобы получить из векторной базы НПА КР до 5 статей, релевантных проверяемому пункту. Запросы формулируй СЕМАНТИЧЕСКИ (например, "неустойка 1% в день в договоре оказания услуг" вместо "статья 333 ГК"), это даёт точные попадания.

⚖️ ПРОТОКОЛ РАБОТЫ:
1. Прочитай Паспорт документа и Топологию пункта.
2. Сформулируй ОДИН точный семантический запрос к search_legislation_kg.
3. Получив 5 статей, КРИТИЧНО оцени каждую:
   • Если статья из ОЖИДАЕМЫХ НПА (см. Паспорт) — она релевантна.
   • Если статья из ДРУГОЙ отрасли — игнорируй её (false positive RAG).
   • Если ни одна не релевантна — допускается второй уточняющий вызов search_legislation_kg с другой формулировкой.
4. По релевантным статьям выдай финальный JSON-вердикт.

🚨 КРИТИЧЕСКИ ВАЖНО — ПРИРОДА ИНСТРУМЕНТА:
Ты оцениваешь ТОЛЬКО текст пользователя из секции "Фрагмент". Результаты функции search_legislation_kg — это автоматическая справка от ТУПОГО РОБОТА-ПОМОЩНИКА, который ищет по векторному сходству и часто притаскивает мусор не по теме.

Если робот принёс "Закон о рекламе", "ГПК", "Кодекс этики" для уголовного дела — РОБОТ ОШИБСЯ. Если робот принёс "Семейный кодекс" для договора поставки — РОБОТ ОШИБСЯ. Просто проигнорируй эту справку. Молча. Без упоминания.

⛔ КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать в отчёте фразы вроде:
• "В предоставленном фрагменте ссылка на закон о рекламе"
• "Вы сослались на ГПК"
• "Заявитель упоминает Кодекс этики"
• "Автор ошибочно опирается на ст. X"
если этой ссылки НЕТ в исходном тексте пользователя.

✅ Пользователь видит только финальный вердикт. Он НЕ ВИДИТ что притащил RAG. Если ты обвинишь его в чужом мусоре — он подумает что ты сумасшедший.

Оценивай текст пользователя опираясь на Паспорт документа, отрасль права из Паспорта, и свои знания КР. RAG-выдача — это только подсказка для поиска точной формулировки нормы.

📐 ПРИРОДА ФРАГМЕНТА:
Помни: исходный текст был ИСКУССТВЕННО разрезан скриптом на N фрагментов. Ты видишь ОДИН фрагмент из N. Если фрагмент — это просто заголовок ("Нарушенные права"), обрывок фразы, реквизиты сторон, нумерация ("3.") или техническая разметка — это НЕ ошибка автора, это нарезка скрипта.

⛔ ЗАПРЕЩЕНО писать замечания вида:
• "В пункте нет фактов"
• "Это неполный текст"
• "Здесь только заголовок без содержания"
• "Пункт обрывается"
• "Недостаточно информации в этом фрагменте"

✅ Если фрагмент — заголовок/реквизиты/обрывок: верни status="ok", finding="Технический фрагмент — рисков не выявлено", rationale="", suggestion="".

🛑 АЛГОРИТМ ПРИ ОШИБКАХ ЦИТИРОВАНИЯ (ЗАПРЕТ НА УГАДАЙКУ):
Если ты видишь, что пользователь сослался на НЕВЕРНУЮ статью (например, назвал статью о пытках "презумпцией невиновности", или перепутал номер статьи Конституции, ГК, УК), действуй СТРОГО по алгоритму:

1. ⛔ ТЕБЕ КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО подсказывать "правильный" номер статьи из своей памяти. Законы Кыргызской Республики регулярно меняются (Конституция 2010 → 2021 → редакции, новые ГК, новые УК), и в своих весах ты держишь старые редакции. Любой номер из памяти = ГАЛЛЮЦИНАЦИЯ.

2. ✅ Ты ОБЯЗАН сделать ДОПОЛНИТЕЛЬНЫЙ вызов search_legislation_kg по СУТИ вопроса. Не по номеру — по смыслу:
   • НЕПРАВИЛЬНО: search_legislation_kg("статья 26 Конституции КР")
   • ПРАВИЛЬНО:  search_legislation_kg("презумпция невиновности Конституция КР")
   • НЕПРАВИЛЬНО: search_legislation_kg("статья 137 УК КР")
   • ПРАВИЛЬНО:  search_legislation_kg("ответственность за пытки УК КР")

3. ✅ Только ПОСЛЕ того, как инструмент вернёт тебе текст актуальной статьи, ты имеешь право написать в отчёте:
   "Указанная пользователем статья регулирует другой вопрос. Согласно актуальной редакции, этот принцип закреплён в статье [номер ТОЛЬКО из выдачи инструмента]."

4. ⛔ Если ты НЕ сделал уточняющий запрос или инструмент ничего не вернул — просто укажи на ошибку пользователя:
   "Указанная статья регулирует другой вопрос; рекомендуется уточнить актуальный номер по официальному источнику."
   Но НЕ НАЗЫВАЙ правильный номер из памяти. У тебя есть лимит до 2-х вызовов инструмента — используй второй ИМЕННО на такую перепроверку.

⛔ Остальные запреты:
- Цитировать статью, которой нет в выдаче search_legislation_kg.
- Писать "согласно ст.N", если эта ст.N не была возвращена инструментом.
- Делать более 2 вызовов инструмента подряд.`;

// ── Helpers ─────────────────────────────────────────────────────────────

function _normArticle(c) {
    if (!c || typeof c !== 'object') return null;
    const md = c.metadata || {};
    const full = String(md.full_text || '').slice(0, ARTICLE_TEXT_LIMIT);
    if (!full) return null;
    return {
        npa_title: String(md.npa_title || ''),
        article_title: String(md.article_title || ''),
        full_text: full,
        similarity: typeof c.score === 'number' ? Math.round(c.score * 1000) / 1000 : null
    };
}

function _dedupArticles(articles) {
    const seen = new Set();
    const out = [];
    for (const a of articles) {
        const key = `${a.npa_title}|${a.article_title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

function _extractFunctionCall(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const parts = candidates[0]?.content?.parts || [];
    for (const p of parts) {
        if (p && p.functionCall && p.functionCall.name) return p.functionCall;
    }
    return null;
}

function _extractText(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const parts = candidates[0]?.content?.parts || [];
    return parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('').trim();
}

// ── Factory ─────────────────────────────────────────────────────────────
function createAgenticVerifier(deps = {}) {
    const {
        getNextKey,
        searchPinecone,
        getEmbedding,
        deepseekJsonCall,
        deepseekEnabled = true,
        buildHCREmbeddingQuery,
        throttle = null,
        logger = console
    } = deps;

    if (typeof getNextKey !== 'function') throw new Error('[AgenticVerifier] getNextKey() обязателен');
    if (typeof searchPinecone !== 'function') throw new Error('[AgenticVerifier] searchPinecone() обязателен');
    if (typeof getEmbedding !== 'function') throw new Error('[AgenticVerifier] getEmbedding() обязателен');
    if (typeof buildHCREmbeddingQuery !== 'function') throw new Error('[AgenticVerifier] buildHCREmbeddingQuery() обязателен');
    if (typeof deepseekJsonCall !== 'function') throw new Error('[AgenticVerifier] deepseekJsonCall() обязателен');

    // Опционально оборачиваем LLM-вызов в throttle. Если throttle нет —
    // выполняем напрямую (например, в тестах).
    function _runThroughThrottle(taskFn) {
        if (throttle && typeof throttle.submit === 'function') {
            return throttle.submit(taskFn);
        }
        return taskFn();
    }

    // ── ОДНА ПОПЫТКА с Gemini-tier'ом (multi-turn tool loop) ────────────
    async function _runGeminiTier(tierCfg, opts) {
        const {
            baseSystemPrompt, userPrompt,
            passport, topology,
            telemetry, stageLabel,
            maxToolTurns, topK,
            aborted,
            onSearchEvent,
            trace = null,           // 2026-06-01: full debug trace
            tracePromptsLogged      // ref-flag: один раз залогировать system+user (между tier'ами не дублировать)
        } = opts;

        // System+user логируем ровно один раз на segment — на первом tier'е
        // или первом успешном входе. Используем переданный ref-объект.
        if (trace && !trace.isNoop && tracePromptsLogged && !tracePromptsLogged.done) {
            try { await trace.logVerifierSystemPrompt(baseSystemPrompt); } catch (_) {}
            try { await trace.logVerifierUserPrompt(userPrompt); } catch (_) {}
            tracePromptsLogged.done = true;
        }

        // Chat history — каждый turn добавляет 1-2 элемента.
        let contents = [{ role: 'user', parts: [{ text: userPrompt }] }];
        const articlesAccum = [];
        const toolCalls = [];
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;

        for (let turn = 0; turn < maxToolTurns; turn++) {
            if (aborted && aborted.value) {
                const err = new Error('aborted');
                err.aborted = true;
                throw err;
            }

            const tStart = performance.now();
            let geminiResult;

            const apiKey = getNextKey();
            const callFn = () => callGeminiSingle({
                apiKey,
                modelName: tierCfg.model,
                systemPrompt: baseSystemPrompt,
                userPrompt: '',
                contents,
                tools: TOOLS_PAYLOAD,
                returnRaw: true,
                jsonMode: false,
                timeoutMs: tierCfg.defaultTimeoutMs,
                temperature: 0.2,
                maxOutputTokens: 1500
            });

            try {
                geminiResult = await _runThroughThrottle(callFn);
            } catch (err) {
                const durationMs = performance.now() - tStart;
                if (telemetry?.recordCascadeAttempt) {
                    telemetry.recordCascadeAttempt({
                        stageLabel: `${stageLabel}_t${turn}`,
                        tier: tierCfg.tier,
                        model: tierCfg.model,
                        durationMs,
                        status: 'fail',
                        errorKind: classifyCascadeError(err)
                    });
                }
                if (trace && !trace.isNoop) {
                    try { await trace.logVerifierTurn({ turn, tier: tierCfg.tier, model: tierCfg.model, kind: 'tier_error', payload: { errorKind: classifyCascadeError(err), message: err.message } }); } catch (_) {}
                }
                throw err;
            }

            const durationMs = performance.now() - tStart;
            totalPromptTokens += geminiResult.usage?.promptTokens || 0;
            totalCompletionTokens += geminiResult.usage?.completionTokens || 0;

            if (telemetry?.recordCascadeAttempt) {
                telemetry.recordCascadeAttempt({
                    stageLabel: `${stageLabel}_t${turn}`,
                    tier: tierCfg.tier,
                    model: tierCfg.model,
                    durationMs,
                    status: 'ok',
                    errorKind: null
                });
            }

            const candidates = geminiResult.candidates || [];
            const functionCall = _extractFunctionCall(candidates);

            if (functionCall) {
                // ── Модель попросила вызвать инструмент ──
                const fnName = functionCall.name;
                const fnArgs = functionCall.args || {};

                if (fnName !== 'search_legislation_kg') {
                    // Неизвестная функция — сообщаем модели и продолжаем.
                    contents.push({ role: 'model', parts: [{ functionCall }] });
                    contents.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: fnName,
                                response: { error: `Неизвестная функция: ${fnName}. Доступна только search_legislation_kg.` }
                            }
                        }]
                    });
                    continue;
                }

                const query = String(fnArgs.query || '').slice(0, 500).trim();
                const reason = String(fnArgs.reason || '').slice(0, 200).trim();

                if (!query) {
                    // Пустой запрос — просим переформулировать.
                    contents.push({ role: 'model', parts: [{ functionCall }] });
                    contents.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: fnName,
                                response: { error: 'Параметр query пустой. Сформулируй семантический запрос.' }
                            }
                        }]
                    });
                    continue;
                }

                // Сообщаем caller'у что агент ищет (для SSE-события agent_search).
                if (typeof onSearchEvent === 'function') {
                    try {
                        onSearchEvent({ query, reason, turn, model: tierCfg.model });
                    } catch (e) {
                        logger.warn?.(`[AgenticVerifier] onSearchEvent threw: ${e.message}`);
                    }
                }

                // Исполняем поиск через Pinecone с HCR-обогащённым embedding.
                let pineconeStart = performance.now();
                let candidates2 = [];
                let pineconeErr = null;
                try {
                    const embedQuery = buildHCREmbeddingQuery(query, passport, topology);
                    const vector = await getEmbedding(embedQuery);
                    candidates2 = await searchPinecone(vector, topK);
                } catch (e) {
                    pineconeErr = e;
                    logger.warn?.(`[AgenticVerifier] pinecone failed: ${e.message}`);
                }
                if (telemetry?.recordAgentTime) {
                    telemetry.recordAgentTime('pineconeSearch', performance.now() - pineconeStart);
                }

                // Дедуп + нормализация.
                const normalized = [];
                const seen = new Set();
                for (const c of candidates2 || []) {
                    const a = _normArticle(c);
                    if (!a) continue;
                    const key = `${a.npa_title}|${a.article_title}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    normalized.push(a);
                    articlesAccum.push(a);
                }

                toolCalls.push({
                    query,
                    reason,
                    turn,
                    found: normalized.length,
                    error: pineconeErr ? pineconeErr.message : null
                });

                if (trace && !trace.isNoop) {
                    try { await trace.logVerifierTurn({ turn, tier: tierCfg.tier, model: tierCfg.model, kind: 'tool_call', payload: { query, reason } }); } catch (_) {}
                    try { await trace.logVerifierTurn({ turn, tier: tierCfg.tier, model: tierCfg.model, kind: 'tool_response', payload: { articles: normalized, error: pineconeErr ? pineconeErr.message : null } }); } catch (_) {}
                }

                // Готовим functionResponse payload.
                let responsePayload;
                if (pineconeErr) {
                    responsePayload = {
                        error: 'Поиск временно недоступен. Сделай вердикт по доступной информации.',
                        found: 0
                    };
                } else if (normalized.length === 0) {
                    responsePayload = {
                        found: 0,
                        articles: [],
                        instructions: 'Ничего не найдено. Если можешь дать вердикт без точной нормы, верни JSON. Иначе попробуй другой запрос (макс. 2 поиска всего).'
                    };
                } else {
                    responsePayload = {
                        found: normalized.length,
                        articles: normalized.map((a, i) => ({
                            index: i + 1,
                            npa: a.npa_title,
                            article: a.article_title,
                            text: a.full_text,
                            similarity: a.similarity
                        })),
                        instructions: 'КРИТИЧНО оцени каждую статью: релевантна (из ожидаемых НПА Паспорта) или false positive (другая отрасль). Игнорируй нерелевантные. Верни финальный JSON-вердикт.'
                    };
                }

                contents.push({ role: 'model', parts: [{ functionCall }] });
                contents.push({
                    role: 'user',
                    parts: [{ functionResponse: { name: fnName, response: responsePayload } }]
                });
                continue;
            }

            // ── Модель вернула текст (финальный JSON-вердикт) ──
            const text = _extractText(candidates);
            if (text) {
                if (trace && !trace.isNoop) {
                    try { await trace.logVerifierTurn({ turn, tier: tierCfg.tier, model: tierCfg.model, kind: 'final_text', payload: { text } }); } catch (_) {}
                }
                return {
                    text,
                    articles: _dedupArticles(articlesAccum),
                    toolCalls,
                    turns: turn + 1,
                    model: tierCfg.model,
                    tier: tierCfg.tier,
                    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens }
                };
            }

            // Пустой ответ — необычно. Считаем это failure для tier'а.
            const err = new Error(`Empty response from ${tierCfg.model} (no tool call, no text)`);
            err.emptyResponse = true;
            throw err;
        }

        // Достигли MAX_TOOL_TURNS без финального ответа.
        const err = new Error(`MAX_TOOL_TURNS=${maxToolTurns} reached on tier ${tierCfg.tier}`);
        err.maxTurnsReached = true;
        err.articlesAccum = _dedupArticles(articlesAccum);
        err.toolCalls = toolCalls;
        throw err;
    }

    // ── DeepSeek-fallback (legacy: один Pinecone search → single shot) ──
    async function _runDeepSeekFallback(tierCfg, opts) {
        const {
            baseSystemPrompt, userPrompt,
            passport, topology,
            targetType, targetArticle, articleGroup, textHead,
            telemetry, stageLabel,
            topK,
            aborted,
            trace = null
        } = opts;

        if (aborted && aborted.value) {
            const err = new Error('aborted');
            err.aborted = true;
            throw err;
        }

        // 1) Один Pinecone search — повторяем поведение старого runVerifierAgent.
        let allCandidates = [];
        let pineconeStart = performance.now();
        try {
            if (targetType === 'multi-article' && Array.isArray(articleGroup) && articleGroup.length > 0) {
                const groups = await Promise.all(articleGroup.map(async (art) => {
                    const q = `Статья ${art.number} ${art.act} ${textHead || ''}`;
                    const v = await getEmbedding(buildHCREmbeddingQuery(q, passport, topology));
                    return searchPinecone(v, Math.min(3, topK));
                }));
                allCandidates = groups.flat();
            } else if (targetType === 'article' && targetArticle) {
                const q = `Статья ${targetArticle.number} ${targetArticle.act} ${textHead || ''}`;
                const v = await getEmbedding(buildHCREmbeddingQuery(q, passport, topology));
                allCandidates = await searchPinecone(v, topK);
            } else {
                const v = await getEmbedding(buildHCREmbeddingQuery(textHead || userPrompt.slice(0, 300), passport, topology));
                allCandidates = await searchPinecone(v, topK);
            }
        } catch (e) {
            logger.warn?.(`[AgenticVerifier/DeepSeek] pinecone failed: ${e.message}`);
        }
        if (telemetry?.recordAgentTime) {
            telemetry.recordAgentTime('pineconeSearch', performance.now() - pineconeStart);
        }

        // Нормализация + дедуп.
        const articles = [];
        const seen = new Set();
        for (const c of allCandidates || []) {
            const a = _normArticle(c);
            if (!a) continue;
            const key = `${a.npa_title}|${a.article_title}`;
            if (seen.has(key)) continue;
            seen.add(key);
            articles.push(a);
        }

        const ragContext = articles.length
            ? articles.map((a, i) => `[${i + 1}] ${a.npa_title} — ${a.article_title}\n${a.full_text}`).join('\n\n')
            : 'Релевантные статьи в базе НПА не найдены.';

        // Логируем legacy Pinecone-выдачу как pseudo tool_response.
        if (trace && !trace.isNoop) {
            try {
                await trace.logVerifierTurn({
                    turn: 0, tier: tierCfg.tier, model: tierCfg.model,
                    kind: 'tool_call',
                    payload: { query: `[DeepSeek legacy: single-shot pre-fetch · ${targetType}]`, reason: 'Tier 3 без function calling' }
                });
                await trace.logVerifierTurn({
                    turn: 0, tier: tierCfg.tier, model: tierCfg.model,
                    kind: 'tool_response',
                    payload: { articles, error: null }
                });
            } catch (_) {}
        }

        // 2) Single shot DeepSeek (без tools) — кормим RAG напрямую.
        const legacyUserPrompt = `${userPrompt}\n\nРелевантные статьи КР:\n${ragContext}`;
        const tStart = performance.now();
        let result;
        try {
            result = await _runThroughThrottle(() => callDeepSeekSingle({
                deepseekJsonCall,
                modelName: tierCfg.model,
                systemPrompt: baseSystemPrompt,
                userPrompt: legacyUserPrompt,
                timeoutMs: tierCfg.defaultTimeoutMs,
                stageLabel: `${stageLabel}_deepseek_fallback`,
                temperature: 0.2,
                maxOutputTokens: 1500
            }));
        } catch (err) {
            const durationMs = performance.now() - tStart;
            if (telemetry?.recordCascadeAttempt) {
                telemetry.recordCascadeAttempt({
                    stageLabel: `${stageLabel}_deepseek`,
                    tier: tierCfg.tier,
                    model: tierCfg.model,
                    durationMs,
                    status: 'fail',
                    errorKind: classifyCascadeError(err)
                });
            }
            if (trace && !trace.isNoop) {
                try { await trace.logVerifierTurn({ turn: 1, tier: tierCfg.tier, model: tierCfg.model, kind: 'tier_error', payload: { errorKind: classifyCascadeError(err), message: err.message } }); } catch (_) {}
            }
            throw err;
        }

        const durationMs = performance.now() - tStart;
        if (telemetry?.recordCascadeAttempt) {
            telemetry.recordCascadeAttempt({
                stageLabel: `${stageLabel}_deepseek`,
                tier: tierCfg.tier,
                model: tierCfg.model,
                durationMs,
                status: 'ok',
                errorKind: null
            });
        }

        if (trace && !trace.isNoop) {
            try { await trace.logVerifierTurn({ turn: 1, tier: tierCfg.tier, model: tierCfg.model, kind: 'final_text', payload: { text: result.text } }); } catch (_) {}
        }

        return {
            text: result.text,
            articles,
            toolCalls: [{
                query: '[legacy single-shot — DeepSeek tier]',
                reason: 'Tier 3 без function calling',
                turn: 0,
                found: articles.length,
                error: null
            }],
            turns: 1,
            model: tierCfg.model,
            tier: tierCfg.tier,
            usage: result.usage || { promptTokens: 0, completionTokens: 0 }
        };
    }

    // ── Главный entry: tier-loop с watchdog ──────────────────────────────
    async function run(opts) {
        const {
            baseSystemPrompt,
            userPrompt,
            passport = null,
            topology = null,
            targetType = 'general',
            targetArticle = null,
            articleGroup = null,
            textHead = '',
            telemetry = null,
            stageLabel = 'agentic_verifier',
            maxToolTurns = DEFAULT_MAX_TOOL_TURNS,
            topK = DEFAULT_TOP_K,
            watchdogMs = DEFAULT_WATCHDOG_MS,
            aborted = { value: false },
            onSearchEvent = null,
            trace = null              // 2026-06-01: full debug trace
        } = opts || {};

        if (!baseSystemPrompt) throw new Error('[AgenticVerifier] baseSystemPrompt обязателен');
        if (!userPrompt) throw new Error('[AgenticVerifier] userPrompt обязателен');

        // ref-флаг: system+user prompt'ы логируем РОВНО ОДИН РАЗ на task,
        // независимо от того сколько tier'ов пробуем (tier1 fail → tier2 →
        // tier3 — повтор не нужен, prompts идентичны).
        const tracePromptsLogged = { done: false };

        const tierOpts = {
            baseSystemPrompt, userPrompt,
            passport, topology,
            targetType, targetArticle, articleGroup, textHead,
            telemetry, stageLabel,
            maxToolTurns, topK,
            aborted, onSearchEvent,
            trace, tracePromptsLogged
        };

        const errors = [];

        // ── Tier 1: Gemini 3.1 Flash Lite + tools ──
        const tier1 = TIERS[0];
        try {
            const out = await withTimeout(_runGeminiTier(tier1, tierOpts), watchdogMs, `agentic:t1:${stageLabel}`);
            if (telemetry?.incrementCascadeCounter) telemetry.incrementCascadeCounter('tier1_hits');
            return out;
        } catch (err) {
            if (err.aborted) throw err;
            errors.push({ tier: 1, kind: classifyCascadeError(err), message: err.message?.slice(0, 200) });
            logger.warn?.(`[AgenticVerifier ${stageLabel}] tier1 failed: ${err.message?.slice(0, 120)} → tier2`);
        }

        if (aborted.value) {
            const e = new Error('aborted');
            e.aborted = true;
            throw e;
        }

        // ── Tier 2: Gemini 2.5 Flash + tools ──
        const tier2 = TIERS[1];
        try {
            const out = await withTimeout(_runGeminiTier(tier2, tierOpts), watchdogMs, `agentic:t2:${stageLabel}`);
            if (telemetry?.incrementCascadeCounter) telemetry.incrementCascadeCounter('tier2_hits');
            return out;
        } catch (err) {
            if (err.aborted) throw err;
            errors.push({ tier: 2, kind: classifyCascadeError(err), message: err.message?.slice(0, 200) });
            logger.warn?.(`[AgenticVerifier ${stageLabel}] tier2 failed: ${err.message?.slice(0, 120)} → tier3 (deepseek legacy)`);
        }

        if (aborted.value) {
            const e = new Error('aborted');
            e.aborted = true;
            throw e;
        }

        // ── Tier 3: DeepSeek V4 Flash legacy (без tools) ──
        if (!deepseekEnabled) {
            const finalErr = new Error(`[AgenticVerifier ${stageLabel}] tier1+tier2 провалены, tier3 (deepseek) disabled`);
            finalErr.allFailed = true;
            finalErr.attempts = errors;
            if (telemetry?.incrementCascadeCounter) telemetry.incrementCascadeCounter('all_failed');
            throw finalErr;
        }

        const tier3 = TIERS[2];
        try {
            const out = await withTimeout(_runDeepSeekFallback(tier3, tierOpts), watchdogMs, `agentic:t3:${stageLabel}`);
            if (telemetry?.incrementCascadeCounter) telemetry.incrementCascadeCounter('tier3_hits');
            return out;
        } catch (err) {
            if (err.aborted) throw err;
            errors.push({ tier: 3, kind: classifyCascadeError(err), message: err.message?.slice(0, 200) });
            const finalErr = new Error(`[AgenticVerifier ${stageLabel}] все 3 tier'а провалились: ${errors.map(e => `t${e.tier}=${e.kind}`).join(', ')}`);
            finalErr.allFailed = true;
            finalErr.attempts = errors;
            if (telemetry?.incrementCascadeCounter) telemetry.incrementCascadeCounter('all_failed');
            throw finalErr;
        }
    }

    return {
        run,
        SEARCH_TOOL,
        TOOL_PROTOCOL_BLOCK,
        // Для тестов
        _internal: { _normArticle, _dedupArticles, _extractFunctionCall, _extractText }
    };
}

module.exports = {
    createAgenticVerifier,
    SEARCH_TOOL,
    TOOL_PROTOCOL_BLOCK,
    DEFAULT_MAX_TOOL_TURNS,
    DEFAULT_TOP_K,
    DEFAULT_WATCHDOG_MS
};
