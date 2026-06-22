# План миграции: SuperDoc → ONLYOFFICE Document Server

> Статус: 🔴 В процессе | Начат: 22.06.2026
> Жёсткое правило: переходить к следующему этапу только после [x] на всех задачах текущего.
> После каждой задачи — обновить статус здесь + `git commit`.

---

## Аудит текущей системы (выполнен 22.06.2026)

### Точки интеграции SuperDoc (требуют замены)

| Файл | Строки | Что делает |
|---|---|---|
| `src/App.jsx:1` | `import { SuperDocEditor }` | Импорт пакета `@superdoc-dev/react` |
| `src/App.jsx:8533-8552` | `<SuperDocEditor ...>` | Монтирование редактора в DOM |
| `src/App.jsx:8546-8547` | `window.superdoc`, `window.docEngine` | Глобальные API-хуки редактора |
| `src/App.jsx:2258-2515` | `applyAgentCommand()` | 30+ вызовов `window.docEngine.*` (агент-режим) |
| `src/App.jsx:1153-1259` | `injectDocumentContent()` | Вставка HTML в SuperDoc при генерации |
| `routes/analyzeV2.js:27` | `buildSuperDocBlocks` | Генерация JSON-блоков для SuperDoc |
| `routes/analyzeV2.js:944` | `/draft-document` | Возвращает SuperDoc-блоки, не .docx |
| `lib/superDocBlocks.js` | весь файл | Рендерер блоков → SuperDoc JSON |

### Что НЕ меняется (AI-бэкенд остаётся)

- `server.js` — маршруты `/api/chat`, `/api/analyze-document`, `/api/deep-analyze-document`
- `routes/analyze.js` — Selective Reasoning v2.0, все 4 фазы
- `lib/` — все модули RAG, агенты, LLM-каскады
- `services/` — Pinecone, Qdrant, parserService
- Все SSE-события (`step`, `tableRow`, `text`, `sources`, `telemetry`, `[DONE]`)

### Риски миграции

| Риск | Уровень | Митигация |
|---|---|---|
| `window.docEngine` — 30+ вызовов | 🔴 Высокий | Этап 2: адаптер `window.docEngine` → ONLYOFFICE Plugin API |
| `/draft-document` → JSON, не .docx | 🔴 Высокий | Этап 4: `lib/docxGenerator.js` через `docx` npm пакет |
| Нет серверного хранилища файлов | 🟡 Средний | Этап 1: `storage/documents/` + маршрут `/api/files/:id` |
| callbackUrl требует публичный URL | 🟡 Средний | ONLYOFFICE должен достучаться до бэкенда (Render URL — ОК) |
| ONLYOFFICE нужен отдельный сервер | 🟡 Средний | Docker на VPS / локальной машине |

---

## ЭТАП 1: Инфраструктурная обвязка (Docker + Node.js)

**Цель:** Поднять DocServer, создать серверное хранилище файлов, реализовать callback-обработчик.

### 1.1 Docker-конфигурация
- [x] Создать `docker-compose.yml` с образом `onlyoffice/documentserver`
  - JWT_ENABLED=true, JWT_SECRET (≥32 символа), JWT_HEADER=Authorization
  - Volume-маунты: Data, logs, lib, postgresql
  - Порт: 8080:80
  - restart: unless-stopped
  - ✅ Создан: `docker-compose.yml` в корне проекта (22.06.2026)
- [ ] Добавить `ONLYOFFICE_JWT_SECRET` и `ONLYOFFICE_URL` в `.env` (локально) и Render Dashboard
- [ ] Проверить: `curl http://localhost:8080/healthcheck` возвращает `{"status":"OK"}`

### 1.2 Серверное хранилище файлов
- [x] Создать папку `storage/documents/` (добавить в `.gitignore`)
  - ✅ Создана папка `storage/documents/` + `.gitkeep`
  - ✅ В `.gitignore` добавлены `storage/documents/*.docx` и `*.pdf`
- [x] Реализовать в `routes/onlyoffice.js` маршрут `GET /api/files/:fileId/download`
  - ✅ Читает файл из `storage/documents/:fileId.docx`, стримит с нужным Content-Type
- [x] Реализовать `POST /api/files/upload` — принимает DOCX от клиента, сохраняет на диск, возвращает `{fileId, documentKey, config}`
  - ✅ Multer (уже в зависимостях): фильтр .docx, лимит 50МБ, случайный fileId
- [x] Добавить `routes/onlyoffice.js` в `server.js` через `app.use('/api', require('./routes/onlyoffice'))`
  - ✅ Вставлена одна строка в `server.js:4120` (после analyzeV2, перед запуском)

### 1.3 CallbackUrl-обработчик
- [x] Реализовать `POST /api/onlyoffice/callback/:fileId` в `routes/onlyoffice.js`:
  - ✅ JWT-верификация через встроенный `crypto` (HS256, без внешних зависимостей)
  - ✅ `status === 2 || status === 6`: немедленный ответ `{error:0}`, скачивание async
  - ✅ Обновление `documentKey` в памяти (Map `fileRegistry`)
- [x] Реализовать вспомогательный `GET /api/files/:fileId/config` — возвращает подписанный JWT-конфиг для инициализации ONLYOFFICE редактора
  - ✅ `buildEditorConfig()` подписывает payload через `signOoJWT()`, возвращает `{...config, token, _ooUrl}`
- [ ] Smoke-тест: открыть docx в DocServer → отредактировать → закрыть → убедиться что файл обновился в `storage/`
  - ⏳ Ожидает: поднятия Docker-контейнера и добавления env vars

**Критерий перехода к Этапу 2:** `storage/documents/` пополняется при закрытии редактора, callbackUrl отвечает `{error:0}`.

---

## ЭТАП 2: Интеграция во Frontend (React)

**Цель:** Заменить `<SuperDocEditor>` на ONLYOFFICE, сохранить логику вкладок.

### 2.1 Новый компонент OnlyOfficeEditor
- [ ] Создать `src/components/OnlyOfficeEditor.jsx`:
  - `useEffect`: динамически загружает `<script src="${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js">`
  - После загрузки: `new window.DocsAPI.DocEditor(containerRef.current.id, config)`
  - `config.document.key` = `documentKey` из пропа (уникальный на каждую версию)
  - `config.document.url` = `https://backend/api/files/:fileId/download`
  - `config.editorConfig.callbackUrl` = `https://backend/api/onlyoffice/callback/:fileId`
  - `config.editorConfig.lang = 'ru'`
  - `config.token` = JWT, полученный от `/api/files/:fileId/config`
  - Cleanup: `editorRef.current.destroyEditor()` при размонтировании
- [ ] Добавить `VITE_ONLYOFFICE_URL` в `vite.config.js` / `.env`

### 2.2 Замена SuperDocEditor в App.jsx
- [ ] В `App.jsx:8533-8552` заменить `<SuperDocEditor ...>` на `<OnlyOfficeEditor fileId=... documentKey=... />`
- [ ] Удалить `import { SuperDocEditor } from '@superdoc-dev/react'` (строка 1)
- [ ] Удалить `import '@superdoc-dev/react/style.css'` (строка 2)
- [ ] Адаптировать `handleAction('openFromDisk')`: вместо ArrayBuffer в state → POST `/api/files/upload` → получить `{fileId, documentKey}` → открыть ONLYOFFICE
- [ ] Адаптировать `handleAction('save')`: вместо `window.docEngine.exportDocx()` → ONLYOFFICE forcesave через Plugin SDK или прямой API
- [ ] Адаптировать `handleAction('exportPdf')`: ONLYOFFICE конвертация через DocServer API `/ConvertService`

### 2.3 Адаптация агент-режима (window.docEngine → Plugin API)
- [ ] Зафиксировать все места использования `window.docEngine` (аудит показал 30+ вызовов)
- [ ] Создать адаптерный модуль `src/onlyofficeAdapter.js`:
  - `insertText(text)` → `window.Asc.plugin.callCommand(() => Api.GetDocument().GetRangeBySelect().SetText(text))`
  - `addComment(text)` → `window.Asc.plugin.callCommand(() => Api.GetDocument().GetRangeBySelect().AddComment(text, 'Мыйзамчы'))`
  - `getSelectedText()` → через `plugin.callCommand(() => Api.GetDocument().GetRangeBySelect().GetText())`
  - `undo()` / `redo()` → через `window.Asc.plugin.callCommand`
- [ ] Заменить все вызовы `window.docEngine.*` в `applyAgentCommand()` на адаптер

**Критерий перехода к Этапу 3:** ONLYOFFICE открывается в Workspace, документы открываются/сохраняются, AI-агент вставляет текст в документ.

---

## ЭТАП 3: Кастомный ИИ-плагин «Мыйзамчы AI»

**Цель:** AI-функциональность прямо в интерфейсе ONLYOFFICE (боковая панель).

### 3.1 Структура плагина
- [ ] Создать папку `onlyoffice-plugin/miyzamchi-ai/`:
  ```
  config.json     — манифест (guid, isInsideMode:true, initDataType:'text')
  index.html      — боковая панель: textarea выделения, кнопки, результат
  plugin.js       — логика: перехват текста, /api/chat, вставка ответа
  icon.png        — иконка 40x40px
  ```
- [ ] Написать `config.json`: `initOnSelectionChanged: true`, `EditorsSupport: ["word"]`, `isModal: false`

### 3.2 plugin.js — три ключевых функции
- [ ] **Перехват выделенного текста:**
  - `window.Asc.plugin.init(text)` — получает текст при запуске
  - `window.Asc.plugin.onExternalMouseUp` → `callCommand(() => Api.GetDocument().GetRangeBySelect().GetText())`
- [ ] **Отправка на `/api/chat` (SSE):**
  - `fetch('https://miyzamchi-backend.onrender.com/api/chat', { method:'POST', body: JSON.stringify({message, mode:'thinking'}) })`
  - Читать SSE-стрим: `response.body.getReader()` → `TextDecoder` → парсинг `data: {type:'text', content}` событий
  - Показывать ответ в боковой панели в реальном времени
- [ ] **Вставка результата в документ:**
  - Кнопка «Заменить» → `callCommand(() => Api.GetDocument().GetRangeBySelect().SetText(aiAnswer))`
  - Кнопка «Комментарий» → `callCommand(() => Api.GetDocument().GetRangeBySelect().AddComment(aiAnswer, 'Мыйзамчы AI'))`
  - Кнопка «Анализ документа» → POST `/api/analyze-document` → SSE результаты → AddComment на каждый риск

### 3.3 Деплой плагина в DocServer
- [ ] Смонтировать папку плагина в DocServer контейнер:
  ```
  -v /path/to/onlyoffice-plugin:/var/www/onlyoffice/documentserver/sdkjs-plugins/miyzamchi-ai
  ```
- [ ] Проверить: плагин отображается в меню «Плагины» в ONLYOFFICE
- [ ] E2E-тест: выделить текст → «Анализировать» → увидеть SSE-стрим в боковой панели → вставить ответ

**Критерий перехода к Этапу 4:** Плагин запускается, получает текст, стримит ответ от DeepSeek/Gemini, вставляет результат в .docx.

---

## ЭТАП 4: Серверный перенос модулей + генерация .docx

**Цель:** Генерация документов → готовый .docx файл (не JSON-блоки для SuperDoc).

### 4.1 Серверная генерация .docx
- [ ] Установить npm-пакет `docx` (или `officegen`) для программного создания Word-файлов
- [ ] Создать `lib/docxGenerator.js`:
  - Принимает массив блоков `[{type, content}]` (тот же формат что сейчас)
  - Конвертирует каждый блок в `docx` Document API: `Paragraph`, `Table`, `HeadingLevel`
  - Сохраняет в `storage/documents/:fileId.docx`
  - Возвращает `fileId` для открытия в ONLYOFFICE
- [ ] Адаптировать `routes/analyzeV2.js:/draft-document`:
  - Сохранить существующий SSE-стрим блоков (фронтенд видит прогресс)
  - В конце (после Final Judge): вызвать `docxGenerator.buildDocx(blocks)` → файл на диске
  - Последнее SSE-событие: `{type:'ready', fileId}` вместо рендеринга блоков
- [ ] Фронтенд: при получении `{type:'ready', fileId}` → открыть `<OnlyOfficeEditor fileId=...>`

### 4.2 Аудит документа → комментарии в .docx
- [ ] Адаптировать режим «Анализ» (вкладка Анализ в Документах):
  - Загруженный файл → POST `/api/files/upload` → `fileId`
  - `/api/analyze-document` SSE → в конце собрать все `tableRow` с рисками
  - Сгенерировать `docx` с комментариями через `docxGenerator.addComments(fileId, risks[])`
  - Открыть размеченный файл в ONLYOFFICE
- [ ] Перенести `lib/superDocBlocks.js` → `lib/docxGenerator.js` (новый формат, SuperDoc-логику удалить)
- [ ] Удалить `lib/superDocBlocks.js` после переноса всех зависимостей

### 4.3 Финальная очистка SuperDoc
- [ ] Удалить `@superdoc-dev/react` из `package.json`
- [ ] Удалить `public/superdoc-fonts/` (шрифты SuperDoc)
- [ ] Очистить `src/ide-styles.css` от `.superdoc-*` классов
- [ ] Обновить `CLAUDE.md`: убрать все упоминания SuperDoc, добавить ONLYOFFICE-архитектуру

**Критерий завершения Этапа 4 = финал миграции:** Генерация документов создаёт .docx → открывается в ONLYOFFICE → анализ рисков создаёт комментарии в документе → SuperDoc полностью удалён.

---

## Статус по этапам

| Этап | Статус | Завершён |
|---|---|---|
| Аудит системы | ✅ Завершён | 22.06.2026 |
| Этап 1: Docker + Node.js | 🟡 В процессе (6/7) | — |
| Этап 2: Frontend React | 🔴 Не начат | — |
| Этап 3: AI-Плагин | 🔴 Не начат | — |
| Этап 4: Генерация .docx | 🔴 Не начат | — |

---

## Решения принятые в ходе аудита

1. **CLAUDE.md не перезаписывать** — это главный файл инструкций проекта. План миграции — в `ONLYOFFICE_MIGRATION.md`.
2. **Адаптер вместо полной замены** — `window.docEngine` заменяется через адаптерный слой, а не прямым рефакторингом 30+ вызовов.
3. **SSE-стрим генерации сохранить** — фронтенд видит прогресс блоков, в конце получает `fileId` для открытия в ONLYOFFICE.
4. **Хранилище — локальный FS** — `storage/documents/` на сервере Render. При необходимости миграция на S3/MinIO без изменения логики.
5. **Этап 1 первым** — без работающего callbackUrl нельзя протестировать ни Этап 2, ни Этап 3.
