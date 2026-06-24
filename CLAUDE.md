# Мыйзамчы

> 🗺️ **ПЕРЕД ЛЮБОЙ ПРАВКОЙ КОДА — сверься с [`claude_architecture.md`](claude_architecture.md)** (единая карта монорепо: активный фронт/бэк, AI-роутинг, что игнорировать).

> 📝 **ПРАВИЛО ОБНОВЛЕНИЯ:** После добавления любой новой функции, маршрута (route), компонента или модуля — **сразу обновить этот файл**: добавить в таблицу файлов, описать пайплайн, обновить «Текущий статус» и «Открытые задачи». CLAUDE.md — живой документ, не допускать расхождения с кодом.
>
> 🔄 **ПРАВИЛО АРХИТЕКТУРЫ:** Любое изменение архитектуры (новый роут, новый компонент, новый DocBlock, новый MCP-сервер, изменение пайплайна) → **кратко но понятно** дописать в CLAUDE.md в соответствующий раздел. Структура и «Текущий статус» всегда синхронны с кодом.
>
> 📍 **ПРАВИЛО ЧЕКПОИНТА:** В конце каждой рабочей сессии (или при риске сброса контекста) — обновить секцию «Последняя сессия / где остановились» ниже, чтобы следующий Claude знал с чего начать.

> 🚀 **ПРАВИЛО ДЕПЛОЯ:** После завершения каждой задачи с правками кода — **Claude сам делает `git add + git commit + git push origin main`** через PowerShell/Bash инструменты. Push в `main` → Render авто-деплоит **оба** сервиса (бэк + фронт). Сообщить пользователю какие файлы попали в коммит и дать ссылку на прод для проверки.

Кыргызский юридический AI-ассистент. Юрист загружает документ (договор, жалобу, иск) → система ищет противоречия с НПА КР через RAG (Pinecone) + мультиагентный аудит. Деплой на Render (бэк + фронт). Заливка кода через `git push` из терминала (Claude делает сам).

## Профиль пользователя

Юрист, **не программист**. Терминалом не пользуется. Все правки кода Claude делает инструментами (Edit/Write), коммитит и пушит сам через PowerShell (`git add → git commit → git push origin main`). Render авто-деплоит оба сервиса. Скорость деплоя и качество анализа важнее красоты архитектуры.

## Стек

- **Backend:** Node.js / Express (`server.js` ~4375 строк, `routes/analyze.js` ~2258 строк, `routes/analyzeV2.js` ~1049 строк, `routes/compare.js`)
- **Векторная БД:** Pinecone (768d embeddings, dimension/namespace/index в .env)
- **LLM:**
  - **DeepSeek V4 Flash** ($0.14/M input, KVCache $0.0028/M) — primary для агентов-верификаторов и Final Judge
  - **DeepSeek V4 Pro** — heavy Final Judge
  - **Gemini 2.5 Flash** — fallback для агентов
  - **Gemini 3.1 Flash Lite + 2.5 Flash + DeepSeek V4 Flash** — каскад для лёгких задач Phase 3
- **Frontend:** Vite + React 19 + SuperDoc. `src/App.jsx` (~8659 строк — ВСЯ логика IDE, все inline `<style>` убраны в `src/ide-styles.css`)

---

## 🗂️ ПОЛНАЯ КАРТА ФАЙЛОВ ПРОЕКТА

### ► FRONTEND (деплой: Render Web Service, авто с push в `main`)

**Сервис:** `srv-d8lc3je7r5hc739snrf0`
**URL:** https://miyzamchi-web.onrender.com
**Домен:** https://miyzamchy-ceo.com.kg
**Build command:** `npm run build` (Render запускает сам)
**Publish dir:** `dist/`

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
| `netlify.toml` | Устарел — остался в репо, но деплой перенесён на Render |

### ► BACKEND (деплой: Render, авто-деплой с push в `main`)

| Файл | Роль |
|---|---|
| `server.js` (~4375 строк) | Главный сервер Express: middleware, rate-limit, маршруты `/api/chat`, `/api/edit`, `/api/deep-analyze-document`. RotationGemini ключей, SSE-стриминг, CORS, Pinecone конфиг |
| `routes/analyze.js` (~2258 строк) | `/api/upload-document` + `/api/analyze-document` (Selective Reasoning v2.0) + `/api/traces` |
| `routes/analyzeV2.js` (~1049 строк) | `/api/v2/analyze-document`, `/api/v2/draft-intake` (интервьюер документов), `/api/v2/draft-document` (мультиагентная генерация) |
| `routes/compare.js` | `/api/compare-documents` — Semantic Legal Redlining (Align→Map→Reduce) |
| `services/parserService.js` | Локальный парсинг: PDF (pdf-parse ≤8МБ), DOCX (mammoth), TXT (fs). Тяжёлые/сканированные PDF → Gemini Vision (File API) |
| `services/legalAgents.js` | Юридические агенты (верификаторы, судья) |
| `services/qdrantService.js` | Qdrant FAQ-ретривер: `searchQdrant(vector, {url, apiKey, topK})` → Pinecone-совместимый формат |
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
| `запустить-телеграм.bat` | Лаунчер Telegram remote-control (копирует токен → запускает `claude`) |
| `запустить-телеграм.ps1` | PowerShell-версия того же лаунчера |
| `.telegram-state/` | **НЕ В GIT** — токен бота, паринг, inbox. Путь без кириллицы: `%USERPROFILE%\.claude\channels\telegram\` |

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
- `feat(documents): full structure overhaul all 12 types` — полный пересмотр `lib/docTemplates.js`

**Блок работ (20.06.2026):**
- `refactor(styles): move all inline <style> JSX blocks to ide-styles.css` — убраны 3 inline `<style>` из `App.jsx` (NPALibraryTree, NPA viewer, animation), CSS перенесён в `src/ide-styles.css`. App.jsx сократился с ~9252 до ~8659 строк.
- `feat(telegram): Claude Code remote control via Telegram` — плагин `telegram@claude-plugins-official` (v0.0.6) установлен глобально. Бот: `@miyzamchi_work_bot`. Токен в `%USERPROFILE%\.claude\channels\telegram\.env`. Паринг: написать боту → ввести код командой `/telegram:access pair CODE` в VS Code сессии. Состояние хранится в `%USERPROFILE%\.claude\channels\telegram\`.

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

| Сервис | URL | Render ID | Триггер |
|---|---|---|---|
| **Бэкенд** | https://miyzamchi-backend.onrender.com | — | push в `main` → авто |
| **Фронтенд** | https://miyzamchi-web.onrender.com | `srv-d8lc3je7r5hc739snrf0` | push в `main` → авто (`npm run build`) |
| **Домен** | https://miyzamchy-ceo.com.kg | — | указывает на фронтенд-сервис |

| Тип задачи | Команда |
|---|---|
| Задеплоить изменения | `git add <файлы> && git commit -m "..." && git push origin main` |
| Smoke-тесты | `node lib/_smokeTest*.js` (локально) |

**Поток правок (Claude делает сам):**
1. Правит код инструментами Edit/Write
2. `git add <изменённые файлы>` — только конкретные файлы, без `-A`
3. `git commit -F <temp_msg_file>` — через временный файл (обход проблем с кириллицей в PowerShell here-string)
4. `git push origin main` — Render авто-деплоит оба сервиса (~2-3 мин)
5. Сообщает пользователю какие файлы в коммите и даёт ссылку для проверки

**Важно про `git commit` с кириллицей:** PowerShell here-string `@'...'@` ломается на кириллице. Решение: `Set-Content -Path __commit_msg.txt -Encoding utf8 -Value "..."`, затем `git commit -F __commit_msg.txt`, затем удалить файл.

---

## Текущий статус (24 июня 2026)

✅ **В проде:** Selective Reasoning v2.0, все 4 фазы. Telemetry с cascade-секцией.
✅ **Режим Документы:** 12 типов, интервьюер + мультиагентная генерация + bilateral contract engine + самопроверка + экспорт .docx/.pdf
✅ **Инструменты:** калькулятор сроков, госпошлины, библиотека клауз
✅ **CSS рефактор:** все inline `style={}` и `<style>` блоки из `App.jsx` перенесены в `src/ide-styles.css`. Все UI-классы — `myz-*` префикс.
✅ **Telegram remote-control:** бот `@miyzamchi_work_bot` работает через `--channels` флаг. Запуск: `запустить-телеграм.bat`.
✅ **Multi-RAG (Qdrant):** `services/qdrantService.js` + роутинг `classifyQuerySource()` в `server.js`. Env: `QDRANT_URL`, `QDRANT_API_KEY`. Коллекция: `tunduk_guides_collection` (3567 FAQ/инструкций ЦОН+ГНС).

### Multi-RAG роутинг (server.js)
- `classifyQuerySource(query)` → `'pinecone'` | `'qdrant'` | `'both'`
- `adaptiveRetrieval(..., { source })` — поддерживает все три режима, дефолт `'pinecone'`
- `handleSimpleConsultation`, `handleAgent`, `/api/chat fast` — используют роутинг
- Env без `QDRANT_URL`/`QDRANT_API_KEY` → Qdrant пропускается, Pinecone работает как раньше

---

## 📍 Последняя сессия / где остановились (24.06.2026)

### Контекст: задача сессии
Полная миграция функций SuperDoc в ONLYOFFICE Document Server (локальный Docker, порт 8080). Основная цель — команды ИИ-агента должны применяться прямо в документе ONLYOFFICE через bridge-relay.

### Что сделано в этой сессии (коммиты d5db366, f9d82b0)

**1. `routes/onlyoffice.js`**
- Добавлен `DOCSERVER_BACKEND_URL`: если `OO_URL` содержит `localhost` → DocServer получает `http://host.docker.internal:3000` (чтобы Docker мог достучаться до локального бэкенда)
- Исправлен `BROWSER_URL`: аналогичная логика — если DocServer локальный → браузер получает `http://localhost:3000`
- `buildEditorConfig()`: `document.url` и `callbackUrl` теперь используют `DOCSERVER_BACKEND_URL`, `pluginsData` — `BROWSER_URL`
- Добавлены endpoints: `POST/GET /api/onlyoffice/bridge/doctext` — плагин пушит живой текст документа каждые 8с

**2. `onlyoffice-plugin/miyzamchi-ai/plugin.js`**
- Bridge poll: 600ms → **300ms**
- Периодический push текста документа через `callCommand` каждые 8с → `POST /api/onlyoffice/bridge/doctext`
- `replace_smart` / `replace_all`: `Search()` теперь возвращает кол-во найденных; если 0 → user-visible toast `⚠ Не найдено: «...»` + console.warn
- SDK CDN: заменён путь `localhost:8080/sdkjs/...` на официальный `https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js` + `plugins-ui.js`

**3. `src/App.jsx`**
- Async refresh `window.__ooDocText` из bridge (`GET /api/onlyoffice/bridge/doctext`) ПЕРЕД каждым вызовом ИИ-агента (guard: `window.__ooMode`)
- Обновляет `__ooDocText` только если `ts > 0` (т.е. плагин уже пушил текст)

**4. `src/components/onlyoffice-workspace/OnlyOfficeEditor.jsx`**
- Диагностическое логирование в `onAppReady`: логирует `typeof createConnector/serviceCommand/executeMethod/destroyEditor` — чтобы видеть что доступно в Community Edition

### Текущее состояние ONLYOFFICE — ЧТО НЕ РАБОТАЕТ ❌

**Симптом:** При загрузке `.docx` файла показывается ошибка в компоненте редактора:
```
⚠ Загрузка не удалась.
Убедитесь что DocServer доступен: http://localhost:8080
```

**Что проверено и исключено:**
- `api.js` доступен: `GET http://localhost:8080/web-apps/apps/api/documents/api.js` → 200 OK, 65KB ✅
- Все три сервиса запущены: backend :3000 ✅, frontend :5173 ✅, DocServer :8080 (healthy) ✅
- `document.url` и `callbackUrl` теперь правильные (`host.docker.internal:3000`) ✅
- `pluginsData` теперь правильный (`localhost:3000`) ✅

**Возможные оставшиеся причины (не диагностированы):**
1. **ONLYOFFICE Community Edition JWT**: если `ONLYOFFICE_JWT_SECRET` задан в `.env`, а DocServer не настроен на JWT — он отклоняет конфиг. Либо наоборот — DocServer ожидает JWT, а secret не задан.
2. **DocServer не может достучаться до `host.docker.internal:3000`** — на некоторых Windows-конфигурациях Docker `host.docker.internal` не резолвится. Проверить: `docker exec miyzamchi-docserver curl http://host.docker.internal:3000/api/ping`
3. **CORS от DocServer к браузеру** — `api.js` грузит скрипты, браузер может блокировать из-за CORP/COEP заголовков.
4. **Ошибка в самом `onError` event** — ONLYOFFICE посылает `onError` с `data.errorDescription`, но что именно написано — неизвестно (нужно проверить в DevTools Console вкладку Network или Console на `onError`).

### Что нужно сделать следующему Claude

**Шаг 1 — Диагностика (обязательно перед любыми правками):**

```powershell
# 1. Проверить резолвится ли host.docker.internal из Docker:
docker exec miyzamchi-docserver curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:3000/api/ping

# 2. Проверить логи DocServer в момент открытия файла:
docker logs miyzamchi-docserver --tail 50 -f
# Затем в браузере загрузить docx и смотреть логи

# 3. В браузере DevTools Console найти:
#    - '[OO Diag] onAppReady' — если есть, значит api.js загрузился
#    - Строку с 'onError' или errorDescription
#    - Любые ошибки CORS/CSP
```

**Шаг 2 — Вероятный фикс (по результатам диагностики):**

Если `host.docker.internal` не резолвится → заменить в `routes/onlyoffice.js`:
```js
// Узнать IP хоста из Docker:
// docker exec miyzamchi-docserver cat /etc/hosts | grep host-gateway
// Обычно это 172.17.0.1 или 172.18.0.1
const DOCSERVER_BACKEND_URL = process.env.OO_DOCSERVER_BACKEND_URL
    || (OO_URL.includes('localhost') ? 'http://172.18.0.1:3000' : BACKEND_URL);
```

Если JWT проблема → проверить `.env`: если `ONLYOFFICE_JWT_SECRET` задан — убрать или добавить его в DocServer конфиг.

### Архитектура bridge-relay (для следующего Claude)

```
Пользователь редактирует документ в ONLYOFFICE
         ↕ (каждые 8с)
plugin.js → callCommand(getText) → POST /api/onlyoffice/bridge/doctext { text }
                                            ↓ (backend хранит в _doctextStore)
App.jsx → перед ИИ-запросом: GET /api/onlyoffice/bridge/doctext → window.__ooDocText
                                            ↓
                                   ИИ видит актуальный текст

Команда ИИ (insert/replace) → POST /api/onlyoffice/bridge/push { cmd }
                                            ↓
plugin.js polls GET /api/onlyoffice/bridge/poll (каждые 300ms)
                                            ↓
plugin.js → callCommand(SearchAndReplace / SetText)
                                            ↓
                              Текст меняется в документе
```

### Confirmation: createConnector НЕ ДОСТУПЕН в Community Edition
ONLYOFFICE Automation API (`createConnector()`) — Developer/Enterprise Edition ONLY. В Community 9.4.0 его нет. Вся архитектура построена на bridge-relay через плагин — это правильный путь.

**Открытые задачи (по убыванию ROI):**
1. **[КРИТИЧНО] Починить открытие документа в ONLYOFFICE** — описано выше. Диагностика → фикс.
2. **Параллельный Triage + Phase 3** — экономия 15-20с. Правка в `routes/analyze.js preparePipelineState`.
3. **Smart-skip Phase 3** — regex-эвристика "документ содержит явные `ст. N`". Если нет → пропускаем Splitter, экономия ~24с.
4. **Очистка CJK-артефактов в Final Judge** — DeepSeek вставляет китайские иероглифы. 5-строчная правка в server.js (с согласия).
5. **Test corpus** — папка `test_corpus/` с шаблонами реальных кыргызских документов (TXT).

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
