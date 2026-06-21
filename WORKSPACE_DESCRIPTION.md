# Мыйзамчы — Описание воркспейса (Legal IDE)

> Актуально на 21.06.2026. Фронтенд: `src/App.jsx` (~8 700 строк). Бэкенд: `server.js` + `routes/`.

---

## 1. Общая структура

Приложение — это **юридическая IDE** с двумя главными разделами:

| Раздел | Переключение | Описание |
|---|---|---|
| **Чат** | Левая панель навигации | Консультационный AI-чат с RAG по базе НПА |
| **Документы** | Левая панель навигации | Редактор + 3 вкладки: Анализ, Создать, Инструменты |

Состояние переключения сохраняется в `localStorage` (`miyzamchi_ide_mode`).

---

## 2. Редактор документов (SuperDoc)

**Технология:** `@superdoc-dev/react` — WYSIWYG-редактор Word-уровня, встроенный в React.

**Что умеет:**
- Открывает `.docx`, `.txt`, `.html`, `.md` через File System Access API (`showOpenFilePicker`) или fallback `<input type="file">`
- Множественные вкладки (tabs) — каждый файл = отдельная вкладка, состояние в `useState([])` массиве `tabs`
- Модификационный маркер (`tab.mod = true`) — звёздочка рядом с именем вкладки
- Экспорт `.docx` через `window.docEngine.exportDocx()` → `Blob` → скачивание
- Экспорт `.pdf` через `html2pdf.js` — рендерит HTML из редактора в A4-PDF
- Разделённый экран (Split Editor) — `splitActive` state, два экземпляра SuperDoc рядом
- Превью оригинала DOCX — `DocxPreview` компонент, `tab.buffer` хранит `ArrayBuffer`
- Горячие клавиши: Ctrl+S (сохранить/скачать), Ctrl+P (PDF), Ctrl+W (закрыть вкладку)

**Как открывается DOCX:**
```
showOpenFilePicker → handle.getFile() → file.arrayBuffer()
→ { id, name, buffer, handle } добавляется в tabs[]
→ SuperDocEditor монтируется с key={activeTab + buffer.byteLength}
→ при remount: onEditorCreate callback регистрирует window.docEngine
```

**Find & Replace:** `showFind` state → накладной оверлей поверх редактора.

---

## 3. Левая панель

Два режима через `sideMode` state:
- **`tree`** — файловый проводник (вкладки, недавние файлы, открытые файлы)
- **`law`** — Библиотека НПА (`NPALibraryTree`)

**NPALibraryTree** — дерево из 150+ НПА КР с пагинацией, поиском, избранным. Клик по статье → `onAction('openNPA', article)` → открывает NPA Viewer в правой панели.

---

## 4. Правая панель (NPA Viewer + Deep Analysis)

- **NPA Viewer** — вкладки с открытыми статьями НПА. Каждая статья из Pinecone-контекста открывается здесь для быстрого цитирования.
- **Deep Analysis Results** — результаты Premium-анализа (4 вкладки внутри: Аудит, Стратегия, Проекты, Симулятор).

---

## 5. Раздел «Документы» — три вкладки

### 5.1 Вкладка «Анализ» (`AnalyzeDocsMode`)

**Два режима в одном компоненте:**

#### Режим 1: Одиночный аудит (1 файл)
```
Drag & Drop / загрузка DOCX/PDF/TXT
→ POST /api/upload-document (Shadow Pipeline — прогрев в фоне)
→ POST /api/analyze-document (SSE-стриминг)
    ├── Phase 1: normalizeText
    ├── Phase 2: segmentDocumentRegex (63с → 10мс, regex-сегментация)
    ├── Phase 3: runTriage → skip | rag_audit для каждого чанка
    │   ├── emitSafeTriageRows (мгновенный tableRow для типовых сегментов)
    │   ├── runSplitter (извлечение citations[] из чанков)
    │   └── runAdaptiveRetrieval (simple/heavy path в Pinecone)
    └── Phase 4: verifySegmentsSmart (Ищейки) + runFinalJudge (DCR Executive Summary)
```

**Frontend получает SSE-события:**
- `step` → обновляет степпер (пошаговый индикатор прогресса)
- `tableRow` → добавляет строку в таблицу рисков (`tableRows[]`)
- `safe_triage_segment` → добавляет строку без ожидания Phase 4
- `text` → Executive Summary (финальное заключение)
- `sources`, `metadata` → chip-бейджи с цитируемыми НПА
- `telemetry` → статистика под ответом (время, модели, токены)
- `[DONE]` → останавливает анализ

**Таблица рисков** — каждая строка содержит:
- Номер пункта, текст фрагмента, выявленный риск/замечание, цитата нормы НПА, оценка серьёзности

#### Режим 2: Сравнение редакций (2 файла)
```
Два Drag & Drop слота (старая + новая редакция)
→ POST /api/compare-documents (SSE)
    ├── Align: выравниваем структуру двух документов
    ├── Map: семантический diff по абзацам (Gemini)
    └── Reduce: Executive Summary изменений
```

**Frontend показывает:**
- `pairs[]` — список изменённых пар абзацев (было/стало)
- Executive Summary сравнения

---

### 5.2 Вкладка «Создать» (`CreateDocMode`)

**12 типов документов** (`DOC_TYPES`):

| Ключ | Документ |
|---|---|
| `isk` | Исковое заявление |
| `pretenziya` | Претензия |
| `zayavlenie` | Заявление |
| `zhaloba` | Жалоба |
| `vozrazhenie` | Возражение на иск |
| `hodataistvo` | Ходатайство |
| `apellyaciya` | Апелляционная жалоба |
| `raspiska` | Расписка |
| `doverennost` | Доверенность |
| `pismo` | Официальное письмо |
| `dogovor` | Договор (bilateral engine) |
| `custom` | Прочее (свободное описание) |

**Пайплайн в 3 шага:**

```
Шаг 1: pick — выбор типа документа
Шаг 2: chat — диалог с интервьюером
    POST /api/v2/draft-intake
    body: { docType, messages[] }
    → { ready: bool, questions: string[], summary: string }
    Интервьюер задаёт уточняющие вопросы пока досье не собрано (ready=true)

Шаг 3: generate — мультиагентная генерация
    POST /api/v2/draft-document (SSE)
    → агенты параллельно ищут нормы по 4 группам (материальные/процессуальные/подзаконные/специальные)
    → драфтер генерирует блоки по мере готовности (block-by-block streaming)
    → Final Judge: самопроверка { ok, issues[] }
    → если issues → патч конкретных блоков (patchBusy)
    → рендер в SuperDoc через lib/superDocBlocks.js
```

**Блоки SuperDoc** (`lib/superDocBlocks.js`):
- `heading` — заголовок
- `paragraph` — абзац с форматированием
- `list_items` — нумерованный/маркированный список
- `table` — таблица
- `signature` — блок подписей
- `requisites_table` — двухколоночная таблица реквизитов (для договоров)

**После генерации:** кнопки «Скачать DOCX» / «Скачать PDF» + опциональная «Глубокая проверка» (отправляет готовый документ обратно в `/api/analyze-document`).

---

### 5.3 Вкладка «Инструменты» (`LegalToolsMode`)

Три встроенных инструмента без бэкенда — чистый JS:

#### DeadlineCalculator — Калькулятор сроков
- Вводишь начальную дату + тип срока (гражданский, процессуальный, исковая давность)
- Считает конечную дату с учётом выходных/праздников КР
- Показывает оставшиеся дни и предупреждение если срок истёк

#### GosposhlinaCalculator — Калькулятор госпошлины
- Цена иска → автоматически считает госпошлину по шкале НК КР
- Редактируемая ставка (пользователь может скорректировать вручную)
- Показывает расчёт по формуле пошагово

#### ClauseLibrary — Библиотека клауз
- Каталог типовых юридических формулировок (форс-мажор, неустойка, конфиденциальность, арбитраж и т.д.)
- Клик → копирует клаузу в буфер (`navigator.clipboard.writeText`)
- Toast-уведомление: «Скопировано»

---

## 6. Раздел «Чат»

Два подрежима (переключатель в шапке чата):

### Fast (Быстрый) — `/api/chat` mode=fast
```
isCasualMessage(message)
  → true: handleFast без retrieval (болтовня, приветствия)
  → false: classifyQuerySource → 'pinecone'|'qdrant'|'both'
           adaptiveRetrieval (embedding → Pinecone/Qdrant/оба)
           → handleFast (Gemini, стриминг текста)
```

**Frontend:** просто стримит `text` события, показывает Sources chip-бейджи.

### Thinking (Глубокий) — `/api/chat` mode=thinking
```
classifyQuery(query) → 'simple' | 'complex'
  simple:  handleSimpleConsultation (1 retrieval, 1 LLM-вызов)
  complex: handleDeepThinking (5-этапная цепочка)
    ├── Шаг 1: Снайперский поиск (topK=5, специальная норма)
    ├── Шаг 2: Общие положения (topK=10, фундамент кодекса)
    ├── Шаг 3: Процессуальные нормы (topK=8, сроки/подсудность/госпошлина)
    ├── Шаг 4: Подзаконные акты (topK=5, правила/инструкции)
    └── Шаг 5: Синтез (Consultant с иерархическим контекстом из 4 слоёв)
```

**Frontend:** получает `step` события → рендерит Thinking Box (пошаговый индикатор с иконками и статусами loading/success/warning).

### Agent Mode — `/api/chat` agentMode=true
```
classifyUserIntent(userQuery)
  → EDITOR:    правка документа (JSON-тулзы для SuperDoc, RAG пропускается)
  → RAG_AGENT: правовая задача (retrieval → Gemini → streaming JSON с anchor_text/insertion_text)
  → CLARIFY:   уточнение (возвращает вопрос)
```

Используется когда юрист работает с документом в редакторе и задаёт вопрос через чат-панель — агент видит текст документа и вставляет правки/замечания прямо в SuperDoc.

---

## 7. Premium Deep Analysis (`/api/deep-analyze-document`)

Запускается через кнопку **«Углублённый анализ»** в режиме Документов.

**Модальное окно `DeepAnalyzeModal`** — конфигурация запуска:
- Перспектива: `audit` | `ours` (позиция клиента) | `opponent` (позиция оппонента)
- Модули (чекбоксы):

| Модуль | Что делает |
|---|---|
| **Аудитор** | Риски + нарушения НПА (основной) |
| **Стратег** | Тепловая карта рисков + контраргументы со статьями |
| **Драфтер** | Готовит отзыв / возражение / меморандум |
| **Ментор** | Атаки оппонента + вопросы суда (судебный спарринг) |

**Результат — 4 вкладки в правой панели:**
- `DeepAuditPanel` — findings с тяжестью (critical/high/medium/low)
- `DeepStrategyPanel` — heatmap + counterArgs[]
- `DeepDraftsPanel` — готовый текст черновика с кнопкой «Вставить в документ»
- `DeepMentorPanel` — opponent attacks[] + judge questions[]

---

## 8. Multi-RAG архитектура (с 21.06.2026)

```
classifyQuerySource(query)
    ↓
'pinecone' → searchPinecone (150 НПА КР, юридические нормы)
'qdrant'   → searchQdrant (3567 FAQ/инструкций ЦОН+ГНС)
'both'     → Promise.all([searchPinecone, searchQdrant]) → merge by score
```

**Qdrant коллекция:** `tunduk_guides_collection`
- Размерность: 768d
- Метрика: Cosine
- Контент: инструкции Государственной налоговой службы и ЦОН

---

## 9. Общие технические детали

### Стриминг (SSE)
Все тяжёлые операции используют SSE (Server-Sent Events):
- `Content-Type: text/event-stream`
- Формат: `data: {JSON}\n\n`
- Frontend: `response.body.getReader()` → `TextDecoder` → парсинг событий

### Локализация (i18n)
`src/translations.js` + `src/i18n-chat.js` → хук `useI18n()` → `tr('key')`.
Три языка: KY (кыргызский), RU (русский), EN (английский). Переключатель в шапке.

### Состояние чата
История в `localStorage` ключ `miyzamchi_chats` — сессии восстанавливаются при перезагрузке.

### Embedding
`models/gemini-embedding-001`, 768d, кэш на 200 последних запросов (`embeddingCache` Map в памяти).

### LLM каскад (lib/llmCascade.js)
Для лёгких задач Phase 3:
```
Gemini 3.1 Flash Lite (10с таймаут)
    → Gemini 2.5 Flash (15с)
        → DeepSeek V4 Flash (20с)
```
Возвращает `{text, model, tier}`.

### Тост-уведомления
`addToast(type, text)` → `toasts[]` state → накладные уведомления внизу экрана, auto-dismiss 3с.

---

## 10. URL-архитектура

| Endpoint | Тип | Назначение |
|---|---|---|
| `POST /api/chat` | SSE | Чат (fast/thinking/agent) |
| `POST /api/upload-document` | JSON | Shadow Pipeline (прогрев) |
| `POST /api/analyze-document` | SSE | Аудит документа (4 фазы) |
| `POST /api/deep-analyze-document` | SSE | Premium-анализ (4 модуля) |
| `POST /api/compare-documents` | SSE | Сравнение редакций |
| `POST /api/v2/draft-intake` | JSON | Интервьюер (диалог) |
| `POST /api/v2/draft-document` | SSE | Генерация документа |
| `POST /api/edit` | SSE | Агент-редактор (agent mode) |
| `GET /ping` | JSON | Health check |
