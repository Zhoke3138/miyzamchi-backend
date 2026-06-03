# Мыйзамчы

Кыргызский юридический AI-ассистент. Юрист загружает документ (договор, жалобу, иск) → система ищет противоречия с НПА КР через RAG (Pinecone) + мультиагентный аудит. Деплой на Render. Заливка кода через GitHub веб-интерфейс.

## Профиль пользователя

Юрист, **не программист**. Терминалом не пользуется. Все правки кода я делаю инструментами (Edit/Write), пользователь смотрит и заливает на GitHub. Скорость деплоя и качество анализа важнее красоты архитектуры.

## Стек

- **Backend:** Node.js / Express (`server.js` ~3700 строк, `routes/analyze.js`, `routes/compare.js`)
- **Векторная БД:** Pinecone (768d embeddings, dimension/namespace/index в .env)
- **LLM:**
  - **DeepSeek V4 Flash** ($0.14/M input, KVCache $0.0028/M) — primary для агентов-верификаторов и Final Judge
  - **DeepSeek V4 Pro** — heavy Final Judge
  - **Gemini 2.5 Flash** — fallback для агентов
  - **Gemini 3.1 Flash Lite + 2.5 Flash + DeepSeek V4 Flash** — каскад для лёгких задач Phase 3 (см. ниже)
- **Frontend:** HTML/CSS/JS + IDE на TipTap (`ide/`)

## Архитектура /api/analyze-document (Selective Reasoning v2.0, май 2026)

Полный конвейер после рефакторинга 4 фаз:

```
/api/upload-document (Shadow Pipeline: фоновый прогрев)
  → возвращает sessionId с предзаготовленными context+segment+triage

/api/analyze-document
  ├── normalizeText (Phase 1)            ── CRLF + whitespace, до hash
  ├── preparePipelineState
  │    ├── extractDocumentContext        ── паспорт документа (Gemini)
  │    ├── segmentDocumentRegex (Phase 2) ── 63с→10мс синхронно, regex
  │    └── runTriage                     ── skip vs rag_audit (LLM)
  ├── emitSafeTriageRows (skip)          ── мгновенный tableRow для типовых
  ├── phase3Pipeline.run (Phase 3)       ── на audit-чанках:
  │    ├── runSplitter                   ── каскад извлекает citations[] батчами
  │    └── runAdaptiveRetrieval          ── simple/heavy path в Pinecone
  ├── verifySegmentsSmart (Phase 4)      ── Ищейки + preFetchedArticles от Phase 3
  │    └── runVerifierAgent              ── structured JSON через safeJsonParseStrict
  └── runFinalJudge                      ── DCR Executive Summary
```

### Новые модули в `lib/`

- `lib/llmCascade.js` — каскад 3.1 Lite (10s) → 2.5 Flash (15s) → DeepSeek V4 (20s). Per-attempt timeout через Promise.race. Без задержек между fallback'ами. Возвращает `{text, model, tier}` или throw `err.allFailed=true`.
- `lib/segmentRegex.js` — синхронная regex-сегментация + `wrapAsAnalyzeSegments` (адаптер string[] → `[{id, number, heading, text}]` с порядковой нумерацией).
- `lib/npaAliases.js` — словарь из 15 канонических НПА КР + `normalizeNpaName()`.
- `lib/phase3.js` — Batched Issue Splitter + Adaptive RAG. Factory `createPhase3Pipeline(deps)`. Graceful degradation на каждом шаге, одноразовый SSE warning `phase3_degraded`.
- `lib/_smokeTestSegmentRegex.js`, `lib/_smokeTestPhase3.js` — регресс-тесты (запуск: `node lib/_smokeTest*.js`).

## Запрещено менять

### Абсолютный запрет
- **`.env`** — секреты
- **`scripts/seed.js`** — утилита индексации, не трогать

### Только с явного согласия (бэкенд работает, не ломать)
- **`server.js`**: ротация Gemini ключей, версии моделей, Pinecone конфиг, SSE стриминг, маршруты `/api/chat`, `/ping`
- **`script.js`**: SSE-парсинг (`response.body.getReader()`), localStorage `miyzamchi_chats`, формат запросов на `/api/chat` (`{message, history, mode}`), переключение режимов, markdown-рендеринг

### SSE-контракт (СВЯТОЕ)
Фронт ожидает события: `step`, `tableRow`, `text`, `safe_triage_segment`, `sources`, `metadata`, `protocolStatus`, `purityIndex`, `telemetry`, `[DONE]`. Любое изменение этих форматов = ломка фронта.

### Pinecone metadata keys
- `full_text` — полный текст статьи (для агентов)
- `npa_title` — название НПА (для `normalizeNpaName`)
- `article_title` — название статьи

## Текущий статус (май 2026)

✅ **В проде:** Selective Reasoning v2.0, все 4 фазы. Telemetry с cascade-секцией.
✅ **Подтверждено боевым тестом:** на жалобе Аскарова 20.8с, поймали 2 реальных бага в Конституции КР. На договоре теплоснабжения 100с (тяжёлый кейс) с реальным cascade fallback (Tier 1 timeout → Tier 2 5xx → DeepSeek спас).

### Открытые задачи (по убыванию ROI)
1. **Проверить UX-fix `wrapAsAnalyzeSegments`** реально на проде — должны быть `п.1, п.2, ..., п.71` без дублей. Если в таблице видны дубли — Render не подхватил коммит.
2. **Параллельный Triage + Phase 3** — экономия 15-20с на cold start. Это правка в `routes/analyze.js preparePipelineState`.
3. **Smart-skip Phase 3 для коммерческих договоров** — regex-эвристика "документ содержит явные `ст. N`". Если нет → пропускаем Splitter, экономия ~24с на договорах без явных цитат.
4. **Очистка CJK-артефактов в Final Judge** — DeepSeek иногда вставляет китайские иероглифы в русский текст (баг модели, не наш). 5-строчная правка в server.js (с согласия).
5. **Test corpus** — пользователь собирает папку `test_corpus/` с шаблонами реальных кыргызских документов (TXT-формат). После сбора — тюнинг marker regex, smart-skip эвристики, словаря НПА и Splitter-промпта на реальных данных.

## Что НЕ надо предлагать
- Перейти на ESM (проект CJS, всё работает)
- Добавлять TypeScript (юрист не хочет усложнения)
- Менять модели LLM (бюджет фиксирован, цены прописаны в `server.js`)
- Touch `server.js`, `.env`, `scripts/seed.js` без явного "да"

## Документация архитектуры
- `ARCHITECTURE.md` — **Miyzamchi 2.0 (Stateful Multi-Agent RAG)**: микросервис парсинга (Node@Render ↔ Python/Docling@Cloud Run), гибридный чанкинг, волновой троттлер, ZDR, динамический reasoning_effort. Новые модули: `parser-service/`, `services/{parserService,llmClients,legalAgents}.js`, `lib/waveThrottle.js`, `routes/analyzeV2.js`
- `DEPLOY_CLOUD_RUN.md` — пошаговый деплой парсера на Cloud Run (для не-программиста): SA, JSON-ключ, права, env на Render
- `REFACTOR_ROADMAP.md` — детальный чек-лист всех 5 фаз с описанием design decisions
- `DEPLOY_AND_TEST_CHECKLIST.md` — гайд по деплою, prod-тестированию, имитации падения каскада, расшифровке telemetry-зон
- `HANDOFF_BRIEFING.md` — компактный брифинг для копипаста в новый чат
