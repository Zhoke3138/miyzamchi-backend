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

### Сессия 24.06.2026 (вечер) — чеклист запуска юристов:
✅ **CLIENT_TOKEN** — фронт шлёт `X-Client-Token` на все запросы (хелперы `jsonHeaders()` / `tokenHeaders()` в `App.jsx`). Значение задать в Render env: `VITE_CLIENT_TOKEN` (фронт) + `CLIENT_TOKEN` (бэк).
✅ **Rate limits** — `apiLimiter` поднят до 60/min; добавлен `v2Limiter` (15/min) на `/api/v2/*` (раньше без лимита); `/api/edit` добавлен в `apiLimiter`.
✅ **CJK-артефакты** — `stripCJK()` в `routes/analyze.js`: срезает китайские иероглифы из вывода DeepSeek Final Judge перед отправкой клиенту.
✅ **Нормы «процитировано верно»** — переименовано в «соответствует закону» + уточнение что нормы найдены системой через RAG (`services/legalAgents.js`).
✅ **Секции по центру + отступы** — `section_heading`, `demand_heading`, `attachment_heading` → `text-align:center` в `LEGAL_KIND_ALIGN`. `injectSpacers` добавляет пустую строку ДО и ПОСЛЕ таких заголовков (streaming path тоже).
✅ **Times New Roman 12pt везде** — `_runToHtml`, `_linesToCellHtml`, `_blockToHtml`, вставка клауз — все оборачивают текст в `<span style="font-family:'Times New Roman',serif;font-size:12pt;">`. CSS-дефолт на `.ProseMirror` в `ide-styles.css`.
✅ **Статусы генерации** — прогрессивные фазы: нашёл N норм (с разбивкой по категориям), reasoning phase 1/2/3 (по кол-ву символов), счётчик блоков.
✅ **Graceful recovery** — если стриминг прошёл но финальный JSON.parse упал → не выдаём ошибку, а используем уже отрендеренные блоки.
✅ **Структура docTemplates** — все 12 типов: `paragraph: ПРАВОВОЕ ОБОСНОВАНИЕ` разбито на `section_heading:` + `paragraph:` для раздельных блоков.

### Сессия 29.06.2026 — DocGen + SuperDoc layout fix:
✅ **DocGen Генератор документов** — новая вкладка в ActBar (иконка copy). Компонент `DocGenPanel` в `src/App.jsx:3870`. Пайплайн: загрузить .docx шаблон → выделить текст в SuperDoc → переменная добавляется → загрузить Excel → генерировать ZIP или единый DOCX. Зависимости: `xlsx` (Excel) + `jszip` (уже был). Вспомогательные функции: `cleanWordXmlDG`, `createWordReplaceRegexDG`, `processZipDocDG`, `replaceHFDG` — встроены в `App.jsx` до компонента ActBar.
✅ **SuperDoc layout исправлен** — добавлен `contained` prop на `<SuperDocEditor>` (официально описан в типах как «fit within parent»). Удалён конфликтующий `overflow-y: auto` (заменён на `overflow: hidden`) с `.myz-editor-wrapper`. Удалён широкий `.superdoc-workspace-wrapper > div > div` override. Добавлена CSS-цепочка для `.superdoc-wrapper / .superdoc-toolbar-container / .superdoc-editor-container / .superdoc` чтобы заполняли flex-родителя корректно.
✅ **DocGen selection** — выделение текста в SuperDoc: `mouseup+30ms` для показа кнопки «+ Переменная» (ждём синхронизации ProseMirror), `selectionchange` только для скрытия кнопки.

### SuperDoc — правильная flex-цепочка (критично для contained mode):
```
#superdoc-wrapper (myz-editor-wrapper): flex:1, height:100%, flex-direction:column, overflow:hidden
  .superdoc-wrapper [SuperDoc React wrapper]: flex:1, min-height:0
    .superdoc-toolbar-container: flex-shrink:0
    .superdoc-editor-container: flex:1, min-height:0, display:flex, flex-direction:column
      .superdoc / .superdoc--contained [Vue root]: flex:1, min-height:0, height:100%!important
        .superdoc__sub-document: height:100%, overflow:auto  ← ЕДИНСТВЕННЫЙ SCROLL
```
Без этой цепочки Vue-обёртка схлопывалась (нет explicit height) → SuperDoc рендерился криво.

### Multi-RAG роутинг (server.js)
- `classifyQuerySource(query)` → `'pinecone'` | `'qdrant'` | `'both'`
- `adaptiveRetrieval(..., { source })` — поддерживает все три режима, дефолт `'pinecone'`
- `handleSimpleConsultation`, `handleAgent`, `/api/chat fast` — используют роутинг
- Env без `QDRANT_URL`/`QDRANT_API_KEY` → Qdrant пропускается, Pinecone работает как раньше

---

## 🔒 СТРАТЕГИЧЕСКОЕ РЕШЕНИЕ (24.06.2026)

**ONLYOFFICE — ЗАМОРОЖЕН до версии 2.0.**
- Весь наработанный код сохранён в `ONLYOFFICE_STATE.md` (детальный freeze-документ)
- Все OO-вызовы в `App.jsx` обёрнуты в `if (OO_MODE)` / `if (window.__ooMode)` — не выполняются в продакшне
- На Render `VITE_ONLYOFFICE_URL` не задан → `OO_MODE = false` → SuperDoc работает как раньше
- **Не трогать `routes/onlyoffice.js`, `docker-compose.yml`, `onlyoffice-plugin/`** — это задел на v2.0

**Текущий приоритет: стабильный релиз на SuperDoc для юристов.**

---

## 📋 ЧТО ОСТАЛОСЬ ДО ЗАПУСКА ЮРИСТОВ (чеклист)

### 🔴 Критично (без этого нельзя запускать)
1. ~~**CLIENT_TOKEN**~~ ✅ СДЕЛАНО — фронт шлёт `X-Client-Token`. Осталось: задать `VITE_CLIENT_TOKEN` в Render env фронтенда (значение — любая строка, совпадающая с `CLIENT_TOKEN` бэка).
2. ~~**Проверить лимиты**~~ ✅ СДЕЛАНО — `apiLimiter` 60/min, `v2Limiter` 15/min добавлен.
3. **Smoke-тест продакшена** — загрузить реальный кыргызский договор на https://miyzamchy-ceo.com.kg → убедиться что анализ проходит до конца (все 4 фазы, Final Judge, telemetry).

### 🟡 Важно (мешает работе, но можно запустить)
4. **Режим Создать** — проверить все 12 типов документов end-to-end: интервьюер → генерация → рендер в SuperDoc. Особенно `dogovor` (bilateral engine, requisites_table).
5. **Экспорт .docx/.pdf** — проверить что кнопки Скачать работают для сгенерированных документов.
6. **Мобильная версия** — UI адаптирован (`isMobile` флаг есть), но не тестировался. Юристы могут заходить с телефона.
7. **Калькуляторы (Инструменты)** — проверить калькулятор сроков и госпошлины на актуальность ставок.

### 🟢 Желательно (повышает доверие)
8. ~~**CJK-артефакты**~~ ✅ СДЕЛАНО — `stripCJK()` в `routes/analyze.js`.
9. **Лендинг** — проверить что `https://miyzamchy-ceo.com.kg` открывается корректно и ведёт на IDE.
10. **Onboarding** — нет auth/регистрации. Если юристов несколько — как разграничить доступ? Пока только через `CLIENT_TOKEN` (один токен на всех).

### ℹ️ Технический долг (после запуска)
11. **Параллельный Triage + Phase 3** — экономия 15-20с на анализ. Правка в `routes/analyze.js`.
12. **Smart-skip Phase 3** — экономия ~24с для простых документов.
13. **Test corpus** — папка `test_corpus/` с реальными KG документами для регрессии.

---

## 📍 Последняя сессия / где остановились (01.07.2026)

**Что сделано в сессии 29.06.2026:**
- DocGen Генератор документов — интегрирован в левый сайдбар.
- SuperDoc layout — исправлен (`contained` prop + CSS flex-цепочка).
- DocGen selection — `mouseup+30ms` (надёжно с ProseMirror).

**Что сделано в сессии 01.07.2026 (chat RAG + Sniper RAG):**
- `feat(chat): thinking mode` — `thinkingBudget: -1` для `detectMultiQuestion`, `handleMultiQuestionRAG` и `handleDeepThinking`. Коммит `6eca1f4`.
- `supabaseService.js` — log display slice 45→80.
- Согласована и задокументирована архитектура **Sniper RAG 3.0** (см. секцию выше).

**Ожидаем от Антигравити:**
1. SQL-миграция в Supabase (5 новых колонок + индексы — скрипт в секции Sniper RAG выше)
2. Парсинг 138 НПА с новой схемой + загрузка в Supabase (1536d, `gemini-embedding-2`)
3. После сидинга — сообщить Claude → он реализует `detectArticlePart()` в `server.js`

**Pending баги chat RAG (не срочно, после Sniper RAG):**
- `generateExceptionQueries` генерирует FAQ-стиль → `kept=0` в exception retrieval. Нужно переписать промпт на NPA-стиль.

**ONLYOFFICE:** заморожен. Детали в `ONLYOFFICE_STATE.md`.

---

## 🔬 SNIPER RAG 3.0 — Новая архитектура индексации (в разработке, 01.07.2026)

**Статус:** Антигравити парсит и сеет. Claude ждёт — после сидинга реализует `detectArticlePart()` в `server.js`.

**Суть:** уходим от article-level чанков к part/item/subitem-level. Вместо всей статьи 117 НК КР (3 страницы) → мелкие осмысленные части. Точечный SQL-перехват без векторного поиска для прямых запросов типа «статья 117 пункт 1 НК КР».

### Базы данных

| База | Модель | Размерность | Назначение |
|---|---|---|---|
| **Pinecone** | `gemini-embedding-001` | **768d** | Старый индекс (article-level). Пока работает. |
| **Supabase** | `gemini-embedding-2` | **1536d** | Новый Sniper RAG индекс (part/item-level). Таблица `documents`. |

### Схема таблицы `documents` в Supabase (SQL-миграция)

```sql
-- Запустить в Supabase → SQL Editor ДО загрузки данных
ALTER TABLE documents ADD COLUMN IF NOT EXISTS article_num_str TEXT;     -- "117", "101-1", NULL для подзаконных
ALTER TABLE documents ADD COLUMN IF NOT EXISTS article_base    INT;       -- 117, 101 (только число, для range-запросов)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS part_base       INT;       -- 2, NULL если нет частей
ALTER TABLE documents ADD COLUMN IF NOT EXISTS item_base       INT;       -- 1, NULL если нет пунктов
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subitem_base    TEXT;      -- "а", "б", NULL если нет подпунктов

CREATE INDEX IF NOT EXISTS idx_docs_article_num  ON documents (article_num_str);
CREATE INDEX IF NOT EXISTS idx_docs_article_base ON documents (article_base);
CREATE INDEX IF NOT EXISTS idx_docs_part_base    ON documents (part_base);
CREATE INDEX IF NOT EXISTS idx_docs_item_base    ON documents (item_base);
```

### Эталонный чанк (JSON)

```json
{
  "id": "kg_nk_art-117_part-2_item-1",
  "category": "npa",
  "article_num_str": "117",
  "article_base": 117,
  "part_base": 2,
  "item_base": 1,
  "subitem_base": null,
  "content": "1. Путем уплаты:\nа) в национальной валюте;\nб) в безналичной форме.",
  "embedding": [...1536d...],
  "metadata": {
    "npa_title": "НАЛОГОВЫЙ КОДЕКС КЫРГЫЗСКОЙ РЕСПУБЛИКИ",
    "npa_abbrev": "НК КР",
    "domain": "tax",
    "hierarchy_path": "Раздел III. Налоговое обязательство > Глава 17. Исполнение",
    "article_title": "Статья 117. Способы исполнения налогового обязательства",
    "parent_context": "Статья 117 > Часть 2. Исполнение в следующих формах:",
    "element_type": "пункт",
    "part_total": 4,
    "full_text": "1. Путем уплаты:\nа) в национальной валюте;\nб) в безналичной форме."
  }
}
```

**Простые статьи без подчастей:**
```json
{ "part_base": null, "part_total": 1, "element_type": "статья_целиком", "item_base": null }
```
`part_base: null` (не 1) — у статьи без "Часть N" части нет фактически. Так производит парсер.

**Подзаконные акты (без статей — Правила, Уставы):**
```json
{ "article_num_str": null, "article_base": null, "item_base": 14 }
```

**Примечание по `full_text`:** парсер кладёт его в `content.full_text` (промежуточный JSON). Uploader маппит в плоскую колонку `content` (для GIN-индекса). В `metadata` JSONB `full_text` не дублируется — это нормально.

### Формула text_to_embed (что идёт в gemini-embedding-2)

```python
text_to_embed = f"[{npa_abbrev}] {hierarchy_path}\n{article_title}\n{parent_context}\nТип: {element_type} {part_base} из {part_total}\nТекст: {full_text}"
```

### 5 критических правил для парсера (Антигравити)

**1. Порог чанкинга — 120 символов:**
Не создавать отдельный чанк если его `full_text` < 120 символов. Мелкие подпункты («а) в национальной валюте» — 25 символов) объединять с соседними в чанк родительского уровня.

**2. Нормализация суперскриптов (КРИТИЧНО):**
PDF парсит «статью 101¹» как `1011`, «109¹» как `1091`. Обязательный regex:
```python
# Паттерн: длинное число где последняя цифра — это реально надстрочный индекс
# Список известных: 1011→101-1, 1091→109-1, 2301→230-1, 1971→197-1
# Лучше: словарь всех статей-прим из НПА + regex для нормализации
article_num_str = normalize_superscript(raw_number)  # "1011" → "101-1"
```
Без этого SQL-перехватчик по `article_num_str = '101-1'` ничего не найдёт.

**3. Таблицы → строгий Markdown:**
Любая таблица (ставки акцизов, коэффициенты, штрафы) парсится в Markdown:
```
| Товар | Ставка |
|-------|--------|
| Электронные сигареты | 100 сом/шт |
```
Иначе LLM галлюцинирует с цифрами.

**4. hierarchy_path — полная цепочка:**
Захватывать все уровни: `"Раздел VII > Глава 65 > Параграф 1"`. Для ГК КР бывает 4 уровня (Раздел > Глава > Параграф > Статья).

**5. domain — значения:**
`tax` | `civil` | `labor` | `criminal` | `admin` | `other`

### Формат ID

```
Кодексы:       kg_nk_art-117_part-2_item-1_sub-a
Без подпункта: kg_nk_art-117_part-2_item-1
Без пункта:    kg_nk_art-117_part-2
Без части:     kg_nk_art-117   (статья_целиком)
Подзаконные:   kg_rules-thermal_item-14
```

### Что Claude реализует в server.js после сидинга

Функция `detectArticlePart(query)` — regex-перехватчик:
```
"статья 117 пункт 1 НК КР"  → { article_num_str:'117', item_base:1, npa_hint:'НК КР' }
"часть 2 статьи 117"         → { article_num_str:'117', part_base:2 }
"статья 101-1"               → { article_num_str:'101-1' }
"пункт 14 Правил"            → { item_base:14 }
```

SQL-запрос перехватчика (без векторного поиска, мгновенно):
```sql
SELECT * FROM documents
WHERE article_num_str = '117'
  AND item_base = 1;
-- domain-фильтр НЕ нужен: article_num_str+item_base уже уникальны
```

Для семантических запросов («в какой валюте платить налоги») — обычный векторный поиск как сейчас.

---

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
