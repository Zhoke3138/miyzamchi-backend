# Мыйзамчы

> 🗺️ **ПЕРЕД ЛЮБОЙ ПРАВКОЙ КОДА — сверься с [`claude_architecture.md`](claude_architecture.md)** (единая карта монорепо: активный фронт/бэк, AI-роутинг, что игнорировать).

> 📝 **ПРАВИЛО ОБНОВЛЕНИЯ:** После добавления любой новой функции, маршрута (route), компонента или модуля — **сразу обновить этот файл**: добавить в таблицу файлов, описать пайплайн, обновить «Текущий статус» и «Открытые задачи». CLAUDE.md — живой документ, не допускать расхождения с кодом.

> 🚀 **ПРАВИЛО ДЕПЛОЯ:** После завершения каждой задачи с правками кода — напомнить пользователю: **«Залейте изменённые файлы на GitHub → Render задеплоит бэкенд автоматически → пересоберите фронт (`npm run build`) и залейте `dist/` на Netlify вручную».** Указывать конкретно какие файлы изменились.

Кыргызский юридический AI-ассистент. Юрист загружает документ (договор, жалобу, иск) → система ищет противоречия с НПА КР через RAG (Pinecone) + мультиагентный аудит. Деплой на Render. Заливка кода через GitHub веб-интерфейс.

## Профиль пользователя

Юрист, **не программист**. Терминалом не пользуется. Все правки кода я делаю инструментами (Edit/Write), пользователь смотрит и заливает на GitHub. Скорость деплоя и качество анализа важнее красоты архитектуры.

## Стек

- **Backend:** Node.js / Express (`server.js` ~4375 строк, `routes/analyze.js` ~2258 строк, `routes/analyzeV2.js` ~1049 строк, `routes/compare.js`)
- **Векторная БД:** Pinecone (768d embeddings, dimension/namespace/index в .env)
- **LLM:**
  - **DeepSeek V4 Flash** ($0.14/M input, KVCache $0.0028/M) — primary для агентов-верификаторов и Final Judge
  - **DeepSeek V4 Pro** — heavy Final Judge
  - **Gemini 2.5 Flash** — fallback для агентов
  - **Gemini 3.1 Flash Lite + 2.5 Flash + DeepSeek V4 Flash** — каскад для лёгких задач Phase 3
- **Frontend:** Vite + React 19 + SuperDoc. `src/App.jsx` (~9252 строк — ВСЯ логика IDE)

---

## 🗂️ ПОЛНАЯ КАРТА ФАЙЛОВ ПРОЕКТА

### ► FRONTEND (деплой: Netlify, вручную через drag-and-drop `dist/`)

| Файл/Папка | Роль |
|---|---|
| `index.html` | Точка входа Vite: `<div id="root">` + `<script src="/src/main.jsx">` |
| `vite.config.js` | Vite-конфиг, react() плагин |
| `src/main.jsx` | Bootstrap React: `createRoot().render(<App/>)` |
| `src/App.jsx` | **ВСЯ логика IDE** (~9252 строк): чат, агент, редактор SuperDoc, режим Документы, режим Создать, инструменты, экспорт |
| `src/ide-styles.css` | CSS всего UI: тулбар, вкладки, чат, SuperDoc, документы (~181 КБ) |
| `src/translations.js` | i18n: KY/RU/EN строки для UI |
| `src/i18n-chat.js` | Вспомогательный i18n для чата |
| `src/components/landing/` | Компоненты лендинга (Aceternity UI) |
| `src/landing.css` | Стили лендинга |
| `src/landing-main.jsx` | Bootstrap лендинга |
| `public/superdoc-fonts/` | Шрифты SuperDoc (Liberation Sans и др., .woff2) |
| `netlify.toml` | Редирект `/api/*` → Render. Автосборка ОТКЛЮЧЕНА — только drag-and-drop |

### ► BACKEND (деплой: Render, авто-деплой с push в `main`)

| Файл | Роль |
|---|---|
| `server.js` (~4375 строк) | Главный сервер Express: middleware, rate-limit, маршруты `/api/chat`, `/api/edit`, `/api/deep-analyze-document`. RotationGemini ключей, SSE-стриминг, CORS, Pinecone конфиг |
| `routes/analyze.js` (~2258 строк) | `/api/upload-document` + `/api/analyze-document` (Selective Reasoning v2.0) + `/api/traces` |
| `routes/analyzeV2.js` (~1049 строк) | `/api/v2/analyze-document`, `/api/v2/draft-intake` (интервьюер документов), `/api/v2/draft-document` (мультиагентная генерация) |
| `routes/compare.js` | `/api/compare-documents` — Semantic Legal Redlining (Align→Map→Reduce) |
| `services/parserService.js` | Локальный парсинг: PDF (pdf-parse ≤8МБ), DOCX (mammoth), TXT (fs). Тяжёлые/сканированные PDF → Gemini Vision (File API) |
| `services/legalAgents.js` | Юридические агенты (верификаторы, судья) |
| `services/llmClients.js` | Клиенты LLM: Gemini + DeepSeek |
| `services/compareService.js` | Логика сравнения редакций документов |

### ► LIB/ (вспомогательные модули бэкенда)

| Файл | Роль |
|---|---|
| `lib/llmCascade.js` | Каскад: Gemini 3.1 Lite (10с) → 2.5 Flash (15с) → DeepSeek V4 (20с). Возвращает `{text,model,tier}` |
| `lib/segmentRegex.js` | Синхронная regex-сегментация + `wrapAsAnalyzeSegments` (адаптер string[] → segments) |
| `lib/phase3.js` | Batched Issue Splitter + Adaptive RAG. Factory `createPhase3Pipeline(deps)` |
| `lib/npaAliases.js` | Словарь 15 канонических НПА КР + `normalizeNpaName()` |
| `lib/docTemplates.js` | Шаблоны и метаданные для всех 12 типов документов (используется в генерации) (~35 КБ) |
| `lib/hybridSegmenter.js` | Гибридный сегментер документов |
| `lib/agentDispatcher.js` | Диспетчер агентов |
| `lib/agenticVerifier.js` | Агентический верификатор (~63 КБ) |
| `lib/waveThrottle.js` | Волновой троттлер для конкурентных LLM-запросов |
| `lib/superDocBlocks.js` | Рендеринг блоков SuperDoc из JSON |
| `lib/documentPassport.js` | Паспорт документа (extractDocumentContext) |
| `lib/traceLogger.js` | Логгер трасс для отладки |
| `lib/globalContext.js`, `localContext.js`, `hierarchicalContext.js` | Контекстные уровни для RAG |
| `lib/topology.js` | Топологический анализ структуры документа |
| `lib/smoothBurstThrottle.js` | Плавный burst-троттлер SSE |
| `lib/smartSkipPhase3.js` | Эвристика умного пропуска Phase 3 |
| `lib/_smokeTest*.js` | Регресс-тесты (запуск: `node lib/_smokeTest*.js`) |

### ► SCRIPTS / ПРОЧЕЕ

| Файл/Папка | Роль |
|---|---|
| `scripts/seed.js` | Утилита индексации НПА в Pinecone. **НЕ ТРОГАТЬ** |
| `script.js` + `style.css` | Легаси-фронтенд автономного веб-чата (не Vite). SSE-парсинг «святое», менять только с явного «да» |
| `telegram/` | Телеграм-бот (telegraf). Периферия, не часть Legal IDE |
| `games/`, `logic/`, `logo/` | Периферийные/служебные, к ядру не относятся |
| `test_corpus/` | Тестовые документы TXT для тюнинга эвристик (собирает пользователь) |
| `scratch/` | Черновики SDK-проб, игнорировать |
| `.env` | Секреты: API-ключи, Pinecone config. **АБСОЛЮТНЫЙ ЗАПРЕТ** |

---

## Архитектура /api/analyze-document (Selective Reasoning v2.0)

```
/api/upload-document (Shadow Pipeline: фоновый прогрев)
  → возвращает sessionId с предзаготовленными context+segment+triage

/api/analyze-document
  ├── normalizeText (Phase 1)            ── CRLF + whitespace, до hash
  ├── preparePipelineState
  │    ├── extractDocumentContext        ── паспорт документа (Gemini)
  │    ├── segmentDocumentRegex (Phase 2) ── regex-сегментация (63с→10мс)
  │    └── runTriage                     ── skip vs rag_audit (LLM)
  ├── emitSafeTriageRows (skip)          ── мгновенный tableRow для типовых
  ├── phase3Pipeline.run (Phase 3)       ── на audit-чанках:
  │    ├── runSplitter                   ── каскад извлекает citations[] батчами
  │    └── runAdaptiveRetrieval          ── simple/heavy path в Pinecone
  ├── verifySegmentsSmart (Phase 4)      ── Ищейки + preFetchedArticles от Phase 3
  │    └── runVerifierAgent              ── structured JSON через safeJsonParseStrict
  └── runFinalJudge                      ── DCR Executive Summary
```

---

## Архитектура Документы / Создать (последнее что делали — июнь 2026)

Режим **Документы** в `src/App.jsx` — три вкладки: **Анализ | Создать | Инструменты**

### Вкладка «Создать» — компонент `CreateDocMode`

**12 типов документов** (`DOC_TYPES` в App.jsx:1327):
- `isk` — Исковое заявление
- `pretenziya` — Претензия
- `zayavlenie` — Заявление
- `zhaloba` — Жалоба
- `vozrazhenie` — Возражение на иск
- `hodataistvo` — Ходатайство
- `apellyaciya` — Апелляционная жалоба
- `raspiska` — Расписка
- `doverennost` — Доверенность
- `pismo` — Официальное письмо
- `dogovor` — Договор (двусторонний, bilateral engine)
- `custom` — Прочее (свободное описание)

**Пайплайн генерации (routes/analyzeV2.js):**
```
Шаг 1: POST /api/v2/draft-intake
  → Интервьюер (Gemini 3.1 Flash Lite): диалог до сбора досье
  → Возвращает {ready, questions[], summary}

Шаг 2: POST /api/v2/draft-document (SSE)
  → Параллельный legal research board (один агент на тип норм)
  → Генерация блоками (block-by-block стриминг)
  → Final Judge: самопроверка {ok, issues[]}
  → Рендеринг в SuperDoc через lib/superDocBlocks.js
```

**Блоки SuperDoc (`lib/superDocBlocks.js`):**
- `heading`, `paragraph`, `list_items`, `table`, `signature`, `requisites_table` (новый — двухколоночная таблица реквизитов для договоров, добавлен 19.06.2026)

**Последний блок работ (19.06.2026):**
- `feat(contracts): two-column requisites via table block` — `requisites_table {left, right}` для реквизитов договоров
- `feat(documents): full structure overhaul all 12 types` — полный пересмотр `lib/docTemplates.js`: форс-мажор как отдельный раздел, конфиденциальность, приёмка, предупреждение о суде в претензии, расчёт суммы, все spacer'ы; `routes/analyzeV2.js`: auto-spacer injection (streaming + fallback), усиленный промпт договора

### Вкладка «Инструменты»
- Калькулятор сроков/исковой давности
- Калькулятор госпошлины (Госпошлина — редактируемая ставка)
- Библиотека клауз (вставка типовых формулировок в документ)

---

## Запрещено менять

### Абсолютный запрет
- **`.env`** — секреты
- **`scripts/seed.js`** — утилита индексации, не трогать

### Только с явного согласия
- **`server.js`**: ротация Gemini ключей, версии моделей, Pinecone конфиг, SSE стриминг, маршруты `/api/chat`, `/ping`
- **`script.js`**: SSE-парсинг (`response.body.getReader()`), localStorage `miyzamchi_chats`, формат запросов на `/api/chat`, переключение режимов, markdown-рендеринг

### SSE-контракт (СВЯТОЕ)
Фронт ожидает события: `step`, `tableRow`, `text`, `safe_triage_segment`, `sources`, `metadata`, `protocolStatus`, `purityIndex`, `telemetry`, `[DONE]`. Любое изменение этих форматов = ломка фронта.

### Pinecone metadata keys
- `full_text` — полный текст статьи (для агентов)
- `npa_title` — название НПА (для `normalizeNpaName`)
- `article_title` — название статьи

---

## Деплой

| Цель | Команда | Куда |
|---|---|---|
| Бэкенд (авто) | `npm start` → `node server.js` | Render (`miyzamchi-backend.onrender.com`), авто с push в `main` |
| Фронтенд (вручную) | `npm run build` → `dist/` → drag-and-drop | Netlify (автосборка ОТКЛЮЧЕНА) |
| Smoke-тесты | `node lib/_smokeTest*.js` | локально |

**Поток правок:** Claude меняет код (Edit/Write) → пользователь заливает в GitHub → Render авто-деплоит бэк → фронт собирает `dist/` и перетаскивает в Netlify вручную.

---

## Текущий статус (июнь 2026)

✅ **В проде:** Selective Reasoning v2.0, все 4 фазы. Telemetry с cascade-секцией.
✅ **Режим Документы:** 12 типов, интервьюер + мультиагентная генерация + bilateral contract engine + самопроверка + экспорт .docx/.pdf
✅ **Инструменты:** калькулятор сроков, госпошлины, библиотека клауз
✅ **Последнее:** `requisites_table` DocBlock для двусторонних договоров (19.06.2026)

### Открытые задачи (по убыванию ROI)
1. **Параллельный Triage + Phase 3** — экономия 15-20с. Правка в `routes/analyze.js preparePipelineState`.
2. **Smart-skip Phase 3** — regex-эвристика "документ содержит явные `ст. N`". Если нет → пропускаем Splitter, экономия ~24с.
3. **Очистка CJK-артефактов в Final Judge** — DeepSeek вставляет китайские иероглифы. 5-строчная правка в server.js (с согласия).
4. **Test corpus** — папка `test_corpus/` с шаблонами реальных кыргызских документов (TXT). После сбора — тюнинг marker regex и Splitter-промпта.
5. **Проверить UX-fix `wrapAsAnalyzeSegments`** на проде — должны быть `п.1...п.71` без дублей.

## Что НЕ надо предлагать
- Перейти на ESM (проект CJS, всё работает)
- Добавлять TypeScript
- Менять модели LLM (бюджет фиксирован)
- Трогать `server.js`, `.env`, `scripts/seed.js` без явного "да"

---

## Документация архитектуры
- `claude_architecture.md` — **🗺️ ЕДИНАЯ КАРТА**: активный фронт vs бэк, AI-роутинг (`classifyUserIntent`), кладбище кода
- `ARCHITECTURE.md` — Miyzamchi 2.0 (Stateful Multi-Agent RAG), детали новых модулей
- `DEPLOY_AND_TEST_CHECKLIST.md` — гайд деплоя, prod-тестирования, расшифровки telemetry
- `HANDOFF_BRIEFING.md` — компактный брифинг для нового чата
- `REFACTOR_ROADMAP.md` — чек-лист всех 5 фаз с design decisions
- `DEPLOY_CLOUD_RUN.md` — деплой парсера (устарел: Cloud Run снесён 11.06.2026)
