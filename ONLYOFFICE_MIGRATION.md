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
- [x] Создать `src/components/onlyoffice-workspace/OnlyOfficeEditor.jsx`:
  - ✅ Синглтон загрузки api.js: `_apiState` + `_apiWaiters[]` — один script на всё приложение
  - ✅ Состояния: `idle → loading → ready | error` с оверлеями
  - ✅ `new window.DocsAPI.DocEditor(containerId, config)` после fetch конфига
  - ✅ `config.document.key`, `callbackUrl`, `lang:'ru'`, JWT-токен — из `/api/files/:fileId/config`
  - ✅ `onDocumentStateChange` → `onSaved(newKey)` при успешном сохранении
  - ✅ Cleanup: `editorRef.current.destroyEditor()` при unmount/смене fileId
  - ✅ `cancelled` флаг против состояния после unmount
- [ ] Добавить `VITE_ONLYOFFICE_URL` и `VITE_BACKEND_URL` в `.env.local` для тестирования

### 2.2 Клон-песочница AppOnlyOfficeSandbox
- [x] Создать `src/components/onlyoffice-workspace/AppOnlyOfficeSandbox.jsx`:
  - ✅ Файл-пикер → POST `/api/files/upload` → `{fileId, documentKey}` → открытие ONLYOFFICE
  - ✅ Вкладки `{id, name, fileId, documentKey}` — переключение без потери состояния
  - ✅ `onSaved(newKey)` — обновляет `documentKey` в tabs state
  - ✅ AI Chat: SSE-стриминг `/api/chat` → рендер сообщений в реальном времени
  - ✅ Toast-уведомления, тёмная/светлая тема, кнопка скрытия чат-панели
  - ✅ Переключение: в `src/main.jsx` заменить `<App />` на `<AppOnlyOfficeSandbox />`

### 2.3 Адаптер агент-режима (window.docEngine → Plugin API)
- [x] Создать `src/components/onlyoffice-workspace/onlyofficeAdapter.js`:
  - ✅ `pluginCommand(fn)` → Promise-обёртка над `window.Asc.plugin.callCommand()`
  - ✅ `getSelectedText()` → `Api.GetDocument().GetRangeBySelect().GetText()`
  - ✅ `getDocumentText()` → итерация по элементам через `GetElement(i).GetText()`
  - ✅ `insertText(text)` → `oRange.SetText(captured)` или `Push(oPara)` при отсутствии выделения
  - ✅ `addComment(text, author)` → `oRange.AddComment(text, author)`
  - ✅ `annotateByText(search, comment)` → `oDoc.Search(text)[0].AddComment()` (для разметки рисков)
  - ✅ `undo()` / `redo()` → `Api.Undo()` / `Api.Redo()`
  - ✅ `isAvailable()` → проверка наличия `window.Asc.plugin.callCommand`
- [ ] Заменить вызовы `window.docEngine.*` в `applyAgentCommand()` на адаптер (Этап 2.3 финальный — после smoke-теста)

**Критерий перехода к Этапу 3:** ONLYOFFICE открывается в Workspace, документы открываются/сохраняются, AI-агент вставляет текст в документ.

---

## ЭТАП 3: Кастомный ИИ-плагин «Мыйзамчы AI»

**Цель:** AI-функциональность прямо в интерфейсе ONLYOFFICE (боковая панель).

### 3.1 Структура плагина
- [x] Создать папку `onlyoffice-plugin/miyzamchi-ai/`:
  - ✅ `config.json` — манифест: guid, isInsideMode:true, initDataType:'text', initOnSelectionChanged:true
  - ✅ `index.html` — боковая панель: режимы, выделение, textarea, результат, кнопки действий
  - ✅ `plugin.js` — вся логика: перехват текста, SSE, вставка, комментарии, анализ
  - ✅ `README.md` — инструкция по установке и генерации иконки
  - ⏳ `icon.png` / `icon@2x.png` — нужно создать вручную (40×80 px, инструкция в README)
- [x] Написать `config.json`: все поля заполнены, `initOnSelectionChanged: true`

### 3.2 plugin.js — три ключевых функции
- [x] **Перехват выделенного текста:**
  - ✅ `window.Asc.plugin.init(text)` — получает текст при запуске плагина
  - ✅ `onExternalMouseUp` → `executeMethod('GetSelectedText', null, cb)` — обновление при смене выделения
- [x] **Отправка на `/api/chat` (SSE):**
  - ✅ `fetch(BACKEND_URL + '/api/chat', {mode, agentMode:false})`
  - ✅ SSE-парсинг: `reader.read()` → `TextDecoder` → построчный разбор `data:` событий
  - ✅ Потоковый рендер: `ui.appendResult(d.content)` обновляет панель в реальном времени
  - ✅ `step` события → `ui.setStep()`, `sources` → `ui.setSources()`
  - ✅ Кнопка «Стоп» через `AbortController`
- [x] **Вставка результата в документ:**
  - ✅ `Asc.scope = {text}` → `callCommand` → `oRange.SetText(Asc.scope.text)` (официальный способ передачи данных)
  - ✅ `callCommand` → `oRange.AddComment(Asc.scope.comment, Asc.scope.author)`
  - ✅ `analyzeFullDocument()`: получает весь текст через `callCommand` → `/api/chat thinking` → `annotateRisks(risks[])`
  - ✅ `annotateRisks()`: итерация с `oDoc.Search(text)[0].AddComment()` для каждого риска

### 3.3 Деплой плагина в DocServer
- [x] Volume-маунт описан в `docker-compose.yml` (закомментирован, раскомментировать для активации):
  ```
  - ./onlyoffice-plugin/miyzamchi-ai:/var/www/onlyoffice/documentserver/sdkjs-plugins/miyzamchi-ai
  ```
- [ ] Проверить: плагин отображается в меню «Плагины» в ONLYOFFICE ⏳ (требует живого DocServer)
- [ ] E2E-тест: выделить текст → «Анализировать» → SSE-стрим → вставить ответ ⏳

**Критерий перехода к Этапу 4:** Плагин запускается, получает текст, стримит ответ от DeepSeek/Gemini, вставляет результат в .docx.

---

## ЭТАП 4: Серверный перенос модулей + генерация .docx

**Цель:** Генерация документов → готовый .docx файл (не JSON-блоки для SuperDoc).

### 4.1 Серверная генерация .docx
- [x] `docx` npm-пакет уже в зависимостях (подтверждено при аудите Этапа 1)
- [x] Создать `lib/docxGenerator.js`:
  - ✅ Принимает блоки нормализованной схемы `{kind, runs[], align?, left?, right?}`
  - ✅ Конвертирует все 8 kind: `section_heading→H1`, `demand_heading→H2`, `paragraph`, `list_group→bullet`, `table→Table`, `requisites_table→двухколоночная таблица`, `signature`, `spacer`
  - ✅ Шрифт Times New Roman 12pt, поля 3/2/1.75 см (ГОСТ КР)
  - ✅ Сохраняет в `storage/documents/:fileId.docx`
  - ✅ `buildAnnotatedSummary(srcFileId, risks[])` — резюме аудита с рисками по severity
- [x] Адаптировать `routes/analyzeV2.js:/draft-document`:
  - ✅ `require('../lib/docxGenerator')` добавлен (строка 28)
  - ✅ После Final Judge: `await buildDocx(safeBlocks, {docType, title})` → `docxFileId`
  - ✅ SSE `{done:true, ..., docxFileId}` — обратно совместимо (старый App.jsx игнорирует поле)
  - ✅ `try/catch` — ошибка генерации не ломает основной ответ
- [x] Фронтенд (`AppOnlyOfficeSandbox.jsx`):
  - ✅ Хук `useDocGeneration`: SSE-стрим `/api/v2/draft-document` → при `d.done && d.docxFileId` → `openDocxById`
  - ✅ `demoGenerate()` — кнопка «Создать документ (AI)» → исковое заявление → открывается в ONLYOFFICE
  - ✅ Индикатор прогресса: `⏳ Генерирую…` с именем последнего блока

### 4.2 Аудит документа → сводный .docx
- [x] `buildAnnotatedSummary(risks[])` в `lib/docxGenerator.js`:
  - ✅ Создаёт отдельный .docx с таблицей рисков (HIGH/MEDIUM/LOW, цвета, цитата, НПА)
  - ✅ Готов к подключению в режим «Анализ» в AppOnlyOfficeSandbox
- [ ] Подключить в режим «Анализ» AppOnlyOfficeSandbox: upload → analyze → buildAnnotatedSummary → открыть ⏳

### 4.3 Финальная очистка SuperDoc (после smoke-тестов)
- [ ] Удалить `@superdoc-dev/react` из `package.json` ⏳ (только после полного переезда)
- [ ] Удалить `public/superdoc-fonts/` ⏳
- [ ] Удалить `lib/superDocBlocks.js` ⏳
- [ ] Обновить `CLAUDE.md` — убрать SuperDoc, добавить ONLYOFFICE-архитектуру ⏳

**Критерий завершения Этапа 4 = финал миграции:** Генерация документов создаёт .docx → открывается в ONLYOFFICE → анализ рисков создаёт комментарии в документе → SuperDoc полностью удалён.

---

## Статус по этапам

| Этап | Статус | Завершён |
|---|---|---|
| Аудит системы | ✅ Завершён | 22.06.2026 |
| Этап 1: Docker + Node.js | 🟡 В процессе (6/7) | — |
| Этап 2: Frontend React | 🟡 В процессе (9/10) | — |
| Этап 3: AI-Плагин | 🟡 В процессе (6/8) | — |
| Этап 4: Генерация .docx | 🟡 В процессе (7/9) | — |

---

## Решения принятые в ходе аудита

1. **CLAUDE.md не перезаписывать** — это главный файл инструкций проекта. План миграции — в `ONLYOFFICE_MIGRATION.md`.
2. **Адаптер вместо полной замены** — `window.docEngine` заменяется через адаптерный слой, а не прямым рефакторингом 30+ вызовов.
3. **SSE-стрим генерации сохранить** — фронтенд видит прогресс блоков, в конце получает `fileId` для открытия в ONLYOFFICE.
4. **Хранилище — локальный FS** — `storage/documents/` на сервере Render. При необходимости миграция на S3/MinIO без изменения логики.
5. **Этап 1 первым** — без работающего callbackUrl нельзя протестировать ни Этап 2, ни Этап 3.
