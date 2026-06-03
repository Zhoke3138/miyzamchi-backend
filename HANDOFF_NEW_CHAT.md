# Брифинг для нового чата — Мыйзамчы

> Краткая выжимка состояния на 2026-06-03. Подробности — в `CLAUDE.md` (project rules), `REFACTOR_ROADMAP.md` (история фаз), `DEPLOY_AND_TEST_CHECKLIST.md` (деплой/тесты).

## Кто пользователь
Юрист (КР), **не программист**. Терминалом не пользуется. Все правки кода делает ассистент (Edit/Write), пользователь смотрит и заливает на GitHub → деплой Render.

## Запреты (СВЯТОЕ)
- **Не трогать:** `.env`, `scripts/seed.js`
- **Только с явного согласия:** `server.js`, `script.js`, SSE-контракт (события: `step`, `tableRow`, `text`, `safe_triage_segment`, `sources`, `metadata`, `protocolStatus`, `purityIndex`, `telemetry`, `[DONE]`, `agent_search`, `trace_ready`)
- **Pinecone metadata keys фиксированные:** `full_text`, `npa_title`, `article_title`
- **Не предлагать:** ESM, TypeScript, смену LLM моделей
- **Никогда не пушить в remote без явного "да"**

## Стек
- Node.js/Express, `server.js` (~3700 строк), `routes/analyze.js`, `routes/compare.js`
- Pinecone (768d), `.env` хранит ключи
- LLM: Gemini 3.1 Flash Lite → 2.5 Flash → DeepSeek V4 Flash (каскад). Final Judge — DeepSeek V4 Pro
- Frontend: HTML/CSS/JS + IDE на TipTap (`ide/`)

## Архитектура `/api/analyze-document`
```
upload-document (shadow prefetch) → sessionId
analyze-document
  ├── normalizeText → preparePipelineState (passport + segmentRegex + triage)
  ├── emitSafeTriageRows (skip-сегменты)
  ├── phase3Pipeline (Splitter + Adaptive RAG на rag_audit чанках)
  ├── verifySegmentsSmart → runVerifierAgent
  │     • Ветка 1 (preFetched / targetType=phase3): RAG уже сделан Phase 3, plain LLM-вызов с готовым контекстом, без tool-loop
  │     • Ветка 2 (Agentic RAG): agenticVerifier.run() с search_legislation_kg multi-turn
  └── runFinalJudge (Pure Synthesizer на DeepSeek V4 Pro, dynamic reasoning_effort)
```

## Карта модулей `lib/`
| Файл | Что делает |
|------|-----------|
| `llmCascade.js` | 3-tier каскад с per-attempt timeout. Экспорт: `createLightLLMCascade`, `callGeminiSingle`, `callDeepSeekSingle`. Критичный фикс: contents оборачиваются как `{contents}` |
| `agenticVerifier.js` | Multi-turn tool loop. Gemini Tier1/2 + DeepSeek Tier3 (через `deepseekToolCall` dep). `SYSTEM_PROMPT` содержит `TOOL_PROTOCOL_BLOCK` с 3 железными правилами (изоляция юрисдикций, маршрутизация, презумпция правоты + запрет стилистики) |
| `phase3.js` | Batched Issue Splitter + Adaptive RAG. Factory `createPhase3Pipeline(deps)`. Graceful degradation |
| `smartSkipPhase3.js` | Эвристика "запускать ли Phase 3" по количеству citation в документе (≥2 → run) |
| `segmentRegex.js` | Синхронная regex-сегментация. `wrapAsAnalyzeSegments` адаптирует `string[] → [{id,number,heading,text}]` |
| `npaAliases.js` | 15 канонических НПА КР + `normalizeNpaName()` |
| `agentDispatcher.js` | Smooth Burst Throttle (20 RPS, 50ms интервалы) + onResult streaming |
| `hierarchicalContext.js` | HCR: Passport (Macro) + Topology (Mezzo) + Micro. `buildHCRSystemPrompt`, `buildHCRUserPromptLine` |
| `documentPassport.js` | Извлечение паспорта документа (Gemini) |
| `topology.js` | Mezzo-уровень — `buildChunkTopology({chunks, chunkIndex, chunkContexts})` |
| `localContext.js` | prev/next контекст соседних чанков |
| `traceLogger.js` | Append-only markdown trace. APIs: `logHeader/Passport/Triage/Segments/PipelineState/VerifierStart/VerifierTurn/VerifierVerdict/JudgeStart/JudgeUserPrompt/JudgeResponse/Footer`. TTL 7 дней, `TRACE_ENABLED` env |
| `smoothBurstThrottle.js` | Token bucket для агентов |
| `_smokeTest*.js` | Регресс-тесты, ~597 assertions. Запуск: `node lib/_smokeTest*.js` |

## Текущее состояние (на 2026-06-03)

### Что недавно сделано
1. **Agentic RAG** — multi-turn function calling через `search_legislation_kg`, тред разделён на Tier1 Gemini Lite / Tier2 Gemini 2.5 / Tier3 DeepSeek (через OpenAI-compatible tool format)
2. **Three iron rules** в `TOOL_PROTOCOL_BLOCK` (изоляция юрисдикций, маршрутизация с полным именем акта, презумпция правоты)
3. **Final Judge → Pure Synthesizer** на DeepSeek V4 Pro с динамическим reasoning_effort:
   - `low` если 0 critical и ≤2 warning
   - `medium` если 3-5 warning
   - `high` если ≥1 critical OR ≥6 рисков
   - Формат строго 2 секции (`Краткий вывод` + `Ключевые риски`). Никакой "Общих рекомендаций"
   - 6 запретов: изобретение рисков, hedging, стилистика, угадывание номеров статей, упоминание чанков, RAG false positives
4. **Trace Logger** — `lib/traceLogger.js`, постоянный `🗃️ Debug-архив` в UI через `/api/traces` + `/api/trace/:filename`
5. **UI**: Executive Summary first, accordion `<details>` с seg-steps внутри, head-steps в верхней панели

### Последний цикл (Trace de-bloating, 2026-06-02)
**Проблема:** trace.md разрастался до десятков тысяч строк из-за дублирования System prompt и User prompt для каждого чанка.

**Что убрали:**
- `agenticVerifier.js` — удалили вызовы `logVerifierSystemPrompt` + `logVerifierUserPrompt` (Ветка 2). `tracePromptsLogged` параметр оставлен как legacy guard для обратной совместимости сигнатуры
- `routes/analyze.js` Ветка 1 (preFetched) — удалили те же 2 вызова
- `routes/analyze.js` Judge — удалили `logJudgeSystemPrompt` (статичный блок, не меняется между прогонами)

**Что осталось в trace.md (по чанку):**
- `logVerifierStart` — заголовок, targetType, topology, textHead
- `📝 Текст фрагмента` (полный)
- `tool_call` (если Ветка 2 делала search)
- `tool_response` (предзагруженные/найденные статьи с full_text)
- `final_text` (сырой JSON от Ищейки)
- `✅ Финальный вердикт сегмента`

**По Финальному Судье:**
- `logJudgeStart` — маршрутизация (path, model, reasoning, totals)
- `logJudgeUserPrompt` — отчёт агентов (variable input)
- `logJudgeResponse` — выход + durationMs

## Архитектурные открытия (важно для нового чата)

### Ветка 1 (preFetched / `targetType: 'phase3'`) — НЕ ОЗНАЧАЕТ "пропуск RAG"
В одной из сессий пользователь предположил, что чанки с `targetType: 'phase3'` минуют агентов и идут к Judge. **Это неверно.** Реальная семантика: "Phase 3 уже сделал RAG-поиск, статьи предзагружены, агент работает с готовым контекстом без своего tool-loop". Различия Веток 1 и 2:

| Ветка | Trigger | Tools | LLM call |
|-------|---------|-------|----------|
| 1 (preFetched) | Phase 3 вернул `relevant_articles` для чанка | НЕТ (statьи уже в prompt) | Один shot через `callAgentCascade` |
| 2 (Agentic RAG) | Phase 3 не дал статей | `search_legislation_kg` | Multi-turn loop через `agenticVerifier.run` |

**Слабость Ветки 1:** агент не может «доискать» если Phase 3 предзагрузил неполный набор. Возможный TODO — дать ей опциональный search tool с порогом по confidence.

## SSE-события (фронтенд парсит)
`step`, `tableRow`, `text`, `safe_triage_segment`, `sources`, `metadata`, `protocolStatus`, `purityIndex`, `telemetry`, `agent_search`, `trace_ready`, `[DONE]`

## Документация
- `CLAUDE.md` — правила проекта, абсолютные запреты
- `REFACTOR_ROADMAP.md` — детальный чек-лист всех 5 фаз refactor'а
- `DEPLOY_AND_TEST_CHECKLIST.md` — гайд по деплою + расшифровка telemetry-зон
- `HANDOFF_BRIEFING.md` — старый брифинг (сейчас этот файл новее)

## Регресс
`for f in lib/_smokeTest*.js; do node "$f"; done` → ожидается 597/597 PASS (agentDispatcher 61, agenticVerifier 133, hierarchicalContext 88, hybrid 40, llmCascade 15, localContext 57, phase3 78, segmentRegex 59, smartSkip 35, smoothBurst 31).

## Не сделано / открытые задачи
1. Параллельный Triage + Phase 3 — экономия 15-20с cold start (правка в `preparePipelineState`)
2. Smart-skip Phase 3 для коммерческих договоров (regex-эвристика)
3. Очистка CJK-артефактов в Final Judge (DeepSeek иногда вставляет иероглифы)
4. Test corpus — пользователь собирает `test_corpus/` с реальными КР документами
5. **Возможно:** дать Ветке 1 опциональный search tool (если новая архитектура из следующего чата этого требует)
