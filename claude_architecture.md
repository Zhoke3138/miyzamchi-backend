# 🗺️ claude_architecture.md — Единая точка истины (Мыйзамчы)

> **Назначение:** карта монорепозитория после миграций TipTap → SuperDoc и Vite-рефакторинга.
> **Правило:** перед ЛЮБОЙ правкой кода сверяйся с этим файлом. Не редактируй код в разделе 🗑️ Deprecated / Sandbox.
> **Сгенерировано:** 2026-06-09 по результатам deep scan (git-tracked файлы, конфиги, маршруты).

---

## TL;DR (одним абзацем)

Это **гибридный монорепозиторий**: один `package.json` обслуживает и бэкенд, и фронтенд.
- **Бэкенд** (Node/Express) — `server.js` + `routes/` + `services/` + `lib/` + `parser-service/` (Python). Деплой на **Render** (`npm start` → `node server.js`).
- **Фронтенд** (Vite/React 19/SuperDoc) — `index.html` → `src/main.jsx` → `src/App.jsx`. Деплой на **Netlify** (`npm run build` → `dist/`, прокси `/api/*` → Render).
- **Песочницы-кладбища**: `ide/`, `ide_bak/`, `ide-vite/`, `scratch/` — НЕ участвуют в активной сборке. Игнорировать.

---

## 📁 Frontend Architecture (АКТИВНЫЙ UI)

Vite + React 19 + SuperDoc. Точка входа собирается из **корня** проекта.

| Что | Путь | Роль |
|-----|------|------|
| HTML-входная точка | [index.html](index.html) | `<div id="root">` + `<script src="/src/main.jsx">` |
| Vite-конфиг | [vite.config.js](vite.config.js) | `react()` плагин, `optimizeDeps.entries: ['index.html']` |
| React bootstrap | [src/main.jsx](src/main.jsx) | `createRoot(...).render(<App/>)` |
| **Главный компонент** | [src/App.jsx](src/App.jsx) | ВСЯ логика IDE: чат, агент, редактор, экспорт (~8000+ строк) |
| Стили IDE | [src/ide-styles.css](src/ide-styles.css) | тулбар, скролл, позиционирование SuperDoc |
| Шрифты SuperDoc | [public/superdoc-fonts/](public/superdoc-fonts/) | `.woff2` (Liberation Sans и др.), `assetBaseUrl='/superdoc-fonts/'` |
| Деплой | [netlify.toml](netlify.toml) | `publish = "dist"`, редирект `/api/*` → `https://miyzamchi-backend.onrender.com` |

**Редактор документа:** SuperDoc. Инстанс кладётся в `window.docEngine` в колбэке `onEditorCreate` ([src/App.jsx:8145](src/App.jsx#L8145)). `window.superdoc` — корневой клиент SuperDoc (для `dispatchTool`).

---

## ⚙️ Backend Architecture (АКТИВНЫЙ сервер)

Express-сервер, единый файл `server.js` (~4000 строк) + подключаемые роуты.

| Что | Путь | Роль |
|-----|------|------|
| **Главный сервер** | [server.js](server.js) | middleware, rate-limit, маршруты `/api/chat`, `/api/edit`, `/api/deep-analyze-document`, вся LLM-логика |
| Анализ документов | [routes/analyze.js](routes/analyze.js) | `/api/upload-document` (L1809), `/api/analyze-document` (L1894), `/api/traces` (L2171) |
| Сравнение редакций | [routes/compare.js](routes/compare.js) | `/api/compare-documents` (L362) — Semantic Legal Redlining (Align→Map→Reduce) |
| Pipeline v2 (Stateful) | [routes/analyzeV2.js](routes/analyzeV2.js) | монтируется на `/api/v2` (server.js:3987) → `/api/v2/analyze-document` |
| Сервисы | [services/](services/) | `parserService.js` (клиент Docling), `llmClients.js`, `legalAgents.js`, `compareService.js` |
| Микросервис парсинга | [parser-service/](parser-service/) | **Python/Docling** на Cloud Run (`main.py`, `Dockerfile`) — извлечение текста из DOCX/PDF |

### Карта подключения роутов в server.js
- `require('./routes/compare')({...})` → [server.js:3940](server.js#L3940)
- `require('./routes/analyze')({...})` → [server.js:3960](server.js#L3960)
- `app.use('/api/v2', require('./routes/analyzeV2').createAnalyzeV2Router())` → [server.js:3987](server.js#L3987)

### ⚠️ Легаси-маршрут на бэкенде
`server.js` всё ещё отдаёт старый одностраничный IDE:
- `GET /ide` → `ide/MIyzamchy Legal IDE.html` ([server.js:177-181](server.js#L177))

Это **реликт**. Активный UI деплоится на Netlify из `src/`, а не отсюда. Не развивать `/ide`.

---

## 🧠 AI & RAG Pipeline (МОЗГ)

### Где живёт роутинг запросов
| Эндпоинт | Файл | Что делает |
|----------|------|-----------|
| `POST /api/chat` | [server.js:3824](server.js#L3824) | главный роутер: `mode` = fast / thinking + `agentMode`. SSE-стриминг |
| `POST /api/edit` | [server.js:736](server.js#L736) | **Split Execution**: выбирает SuperDoc-инструменты через `@superdoc-dev/sdk`, возвращает `tool_calls` на фронт |
| `POST /api/deep-analyze-document` | [server.js:3770](server.js#L3770) | премиум мульти-агентный разбор |

### 🎯 Интеллектуальный роутинг намерений (EDITOR / RAG_AGENT / CLARIFY)
**Файл: [server.js](server.js) (бэкенд).** Это серверная логика, на фронте её НЕТ.

| Функция | Строка | Роль |
|---------|--------|------|
| `quickIntent(query)` | [server.js:2308](server.js#L2308) | regex-эвристика, 0 токенов (приоритет: правовые маркеры → правки) |
| `llmIntent(query)` | [server.js:2331](server.js#L2331) | лёгкий LLM-фолбэк (Gemini Flash через `callOnce`) когда regex не уверен |
| `classifyUserIntent(query)` | [server.js:2354](server.js#L2354) | обёртка `quick → llm`, отдаёт `EDITOR` / `RAG_AGENT` / `CLARIFY` |
| Точка вызова | внутри `handleAgent` ([server.js:2047](server.js#L2047)) | классифицирует ПЕРЕД RAG; `EDITOR` пропускает Pinecone, `CLARIFY` задаёт уточняющий вопрос |

**Логика режимов:**
- `EDITOR` → техническая правка (опечатка/сумма/дата/формат) → RAG (Pinecone) **пропускается**.
- `RAG_AGENT` → правовая задача (соответствие норме, выбор статьи) → полный adaptiveRetrieval.
- `CLARIFY` → намерение размыто → агент возвращает уточняющий вопрос в JSON-контракте (`reasoning`=вопрос, `insertion_text=""`).
- Fail-safe: любая ошибка классификатора → `RAG_AGENT` (старое поведение).

### Системные промпты агентов
- `AGENT_SYSTEM_PROMPT` ([server.js:1203](server.js#L1203)) — IDE-агент, строгий JSON (`reasoning`/`anchor_text`/`insertion_text`) + блок «понимание корявых инструкций».
- `JUDGE_SYSTEM_PROMPT`, `BASE_CONSULTANT_PROMPT` и др. — там же в server.js.

### RAG / векторная база
- **Pinecone** (768d embeddings). Конфиг в `.env` (index/namespace/dimension). Эмбеддинги — Gemini `gemini-embedding-001`.
- `adaptiveRetrieval(query, mode, res, opts)` ([server.js:600](server.js#L600)) — адаптивный topK + elbow-фильтр.
- Метаданные чанков: `full_text`, `npa_title`, `article_title` (см. CLAUDE.md — менять нельзя).

### Selective Reasoning v2.0 (модули в lib/)
`lib/llmCascade.js` (каскад 3.1 Lite → 2.5 Flash → DeepSeek V4), `lib/segmentRegex.js`, `lib/phase3.js` (Batched Splitter + Adaptive RAG), `lib/npaAliases.js`, `lib/hybridSegmenter.js`, `lib/agentDispatcher.js`, `lib/agenticVerifier.js`, `lib/waveThrottle.js`. Smoke-тесты — `lib/_smokeTest*.js`.

### Как фронтенд ПРИМЕНЯЕТ ИИ-правки к документу
Есть **ДВА** пути, оба в [src/App.jsx](src/App.jsx):

1. **Agent JSON-путь** (через `/api/chat`, `agentMode`):
   - `streamChat(...)` ([src/App.jsx:111](src/App.jsx#L111)) → копит текст →
   - `parseAgentCommands(text)` ([src/App.jsx:1336](src/App.jsx#L1336)) — парсит ` ```json ` блок (`insertion_text`/`anchor_text`) →
   - `applyAgentCommand(cmd)` ([src/App.jsx:1388](src/App.jsx#L1388)) — команда `insert_smart` применяется к `window.docEngine`.

2. **Split Execution / SuperDoc tools** (через `/api/edit`):
   - `executeAIEdit({instruction, text, doc})` ([src/App.jsx:386](src/App.jsx#L386)) — dispatch-loop до 10 итераций.
   - Бэкенд возвращает `tool_calls` (`superdoc_*`), фронт исполняет их:
     `window.superdoc.dispatchTool(name, args)` (или фолбэк `doc.commands[name](args)`).
   - Включает Track Changes от имени «Miyzamchi AI».

> ❗ **`dispatchSuperDocTool` как функция в активном коде НЕ существует.** Это имя встречается только в legacy-HTML (`ide/`, `ide_bak/`) и доках. Его роль сейчас выполняет фронтовый `window.superdoc.dispatchTool` внутри `executeAIEdit`. Бэкенд инструменты сам не исполняет — только выбирает их и отдаёт на клиент.

---

## 🗑️ Deprecated / Sandbox (ИГНОРИРОВАТЬ при написании кода)

Эти директории НЕ собираются root-Vite, НЕ импортируются `src/`, и (кроме `/ide`) не отдаются сервером. **Не редактировать, не брать за образец.**

| Папка/файл | Статус | Почему мёртвое |
|------------|--------|----------------|
| `ide-vite/` | 🧪 **Песочница миграции** | Здесь делали миграцию TipTap→SuperDoc. Завалена скриптами-костылями (`fix_*.cjs`, `build_app.cjs`, `*.ps1`, `inject.cjs`), имеет СВОИ `package.json` + `node_modules`. Результат скопирован в `src/`. Песочница мертва. |
| `ide/` | 🪦 **Легаси-IDE** | Старый одностраничный IDE на Babel-standalone (TipTap). Всё ещё отдаётся по `GET /ide`, но это не активный UI. Только как исторический реликт. |
| `ide_bak/` | 🪦 **Бэкап `ide/`** | Полная мёртвая копия. Игнорировать. |
| `scratch/` | 🗑️ Черновики | `test_sdk*.js` — одноразовые пробы SDK. |
| `routes/analyze.js.bak` | 🗑️ Бэкап | Старая версия `routes/analyze.js`. |
| `package.json.bak`, `server.err`, `server.log`, `segmentation_errors.json` | 🗑️ Артефакты | Логи/бэкапы, не код. |
| `РЕЖИМЫ.{html,md,pdf,docx}`, `*.md` в корне | 📄 Документация | `ARCHITECTURE.md`, `HANDOFF_*.md`, `REFACTOR_ROADMAP.md`, `AGENT_DISPATCHER_REDESIGN.md` и т.д. — читать можно, это не исполняемый код. |

### ⚠️ Особый статус (НЕ deprecated, но и не часть Vite-IDE)
- [script.js](script.js) + [style.css](style.css) — фронтенд **старого автономного веб-чата** (не React). По CLAUDE.md его SSE-парсинг и формат `/api/chat` — «святое», менять без явного согласия нельзя. В текущий `index.html` (Vite) он НЕ подключён. Статус: защищён, проверять перед касанием.
- `telegram/` — телеграм-бот (зависимость `telegraf`). Периферия, не часть Legal IDE. Проверять отдельно.
- `games/`, `logic/`, `logo/`, `compile_docs.py`, `make_transparent.ps1`, `test-opendata.js` — периферийные/служебные, к ядру Legal IDE отношения не имеют. Уточнять перед правкой.

---

## 🚀 Деплой и команды

| Цель | Команда | Куда |
|------|---------|------|
| Запуск бэкенда | `npm start` (`node server.js`) | Render (`miyzamchi-backend.onrender.com`) |
| Дев-сервер фронта | `npm run dev` (`vite`) | локально |
| Сборка фронта | `npm run build` (`vite build` → `dist/`) | Netlify |
| Smoke-тесты | `node lib/_smokeTest*.js` | локально |

**Поток деплоя пользователя:** правки делаются инструментами (Claude), пользователь смотрит diff и заливает через веб-интерфейс GitHub. Терминалом пользователь не пользуется.

---

## 🔒 Чего НЕ трогать без явного «да» (из CLAUDE.md)
- `.env`, `scripts/seed.js` — абсолютный запрет.
- `server.js`: ротация Gemini-ключей, версии моделей, Pinecone-конфиг, SSE-стриминг, `/api/chat`, `/ping`.
- `script.js`: SSE-парсинг, localStorage `miyzamchi_chats`, формат запросов `/api/chat`.
- **SSE-контракт** (события `step`, `tableRow`, `text`, `sources`, `metadata`, `telemetry`, `[DONE]` и др.) — изменение ломает фронт.
- Pinecone metadata keys: `full_text`, `npa_title`, `article_title`.
