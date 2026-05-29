# Архитектурный план рефакторинга Miyzamchy (Сервер + Legal IDE)

Этот план описывает процесс разделения монолитного сервера (`server.js`) и гигантского HTML-файла Legal IDE (`ide/MIyzamchy Legal IDE.html`) на чистые, изолированные модули. Все изменения оптимизированы под сохранение единого репозитория GitHub и единого развертывания на Render.

---

## Важные архитектурные решения

> [!NOTE]
> **Производительность:** Чтение файлов промптов с диска будет происходить **один раз** при запуске Node.js (синхронно). Вся дальнейшая работа с текстом промптов идет из оперативной памяти. Это гарантирует нулевую задержку при обработке запросов.

> [!IMPORTANT]
> **Единый хостинг Render:** Мы сохраняем единую Express-аппликацию. Главный файл `server.js` останется легким диспетчером, который раздает статику и распределяет API-запросы по подключаемым файлам маршрутов (Express Routers).

---

## 1. Вынос системных инструкций (промптов) ИИ

Создадим папку `prompts/` в корне проекта и вынесем туда длинные строковые литералы:

*   **`prompts/general_chat.txt`**: Инструкция для быстрого режима чата (`systemInstruction`).
*   **`prompts/base_consultant.txt`**: Главный промпт думающего режима (`BASE_CONSULTANT_PROMPT`).
*   **`prompts/academic_addon.txt`**: Академическое дополнение (`ACADEMIC_PROMPT_ADDON`).
*   **`prompts/l4_warning_addon.txt`**: Предупреждение о судебных документах (`L4_WARNING_ADDON`).
*   **`prompts/agent_system.txt`**: Промпт для IDE AI-редактора (`AGENT_SYSTEM_PROMPT`).
*   **`prompts/judge_system.txt`**: Промпт финального судебного анализа (`JUDGE_SYSTEM_PROMPT`).

---

## 2. Разделение серверного кода (`server.js`)

Мы создадим папку `routes/` и разделим 4200+ строк серверного кода на следующие модули:

### A. Общие утилиты и конфигурация (`routes/common.js`)
*   Инициализация ключей Gemini и Pinecone из `process.env`.
*   Умная ротация и блокировка API-ключей (`blockKey`, `isKeyBlocked`, `getActiveKey`, `getNextKey`).
*   Кэширование и получение векторных эмбеддингов (`getEmbedding`).
*   Поиск в Pinecone (`searchPinecone`).
*   Логгер, статистика и вспомогательные функции для SSE-стриминга (`sendStatus`, `sendStep`).
*   Подсчет токенов и стоимости телеметрии (`calculateCost`, `MODEL_PRICING`).

### B. Прокси Минюста (`routes/minjust.js`)
*   Кэш запросов к CBD Minjust с LRU-вытеснением.
*   Единый маршрут `app.all('/api/minjust/*', ...)` для проксирования запросов и обхода CORS.

### C. Основной чат и Редактор IDE (`routes/chat.js`)
*   Проверки сообщений (`isCasualMessage`, `isAcademicRequest`, `detectL4Request`).
*   Логика быстрого режима чата (`handleFast`).
*   Логика думающего режима (`handleSimpleConsultation`, `handleDeepThinking`, классификатор `classifyQuery`).
*   Маршрут `/api/chat` со стримингом SSE.
*   Маршрут `/api/edit` (редактирование выделенного текста).

### D. Анализ документов (`routes/analyze.js`)
*   Маршрут `/api/analyze-document` (обычный анализ на базе RAG).
*   Маршрут `/api/deep-analyze-document` (параллельный мультиагентный анализ).
*   Логика отдельных агентов: Аудитор (`auditRedFlags`, `auditCollisions`, `auditProcKiller`), Стратег (`strategyHeatmap`, `strategyCounterargs`), Драфтер (`drafterGenerate`), Ментор (`mentorOpponentSim`, `mentorJudgeSim`), Старший партнер (`seniorPartnerSynthesis`).

### E. Главный файл (`server.js`)
Будет содержать только:
*   Подключение CORS, Helmet, Rate Limiters.
*   Раздачу статических файлов (`index.html`, `/ide`).
*   Подключение роутеров:
    ```javascript
    const minjustRouter = require('./routes/minjust');
    const chatRouter = require('./routes/chat');
    const analyzeRouter = require('./routes/analyze');
    
    app.use(minjustRouter);
    app.use(chatRouter);
    app.use(analyzeRouter);
    ```
*   Запуск Express на порту `PORT` и инициализацию Telegram-бота.

---

## 3. Разделение фронтенда IDE (`MIyzamchy Legal IDE.html`)

Вместо одного файла в 8300 строк, мы выделим логику в папку `ide/js/`:

*   **`ide/MIyzamchy Legal IDE.html`**: Только HTML каркас, ссылки на CDN библиотеки (React, TipTap, marked), общие стили и подключение скриптов:
    ```html
    <script type="text/babel" src="js/utils.js"></script>
    <script type="text/babel" src="js/components/UI.js"></script>
    <script type="text/babel" src="js/components/Sidebar.js"></script>
    <script type="text/babel" src="js/components/Editor.js"></script>
    <script type="text/babel" src="js/components/AIChat.js"></script>
    <script type="text/babel" src="js/app.js"></script>
    ```

*   **`ide/js/utils.js`**: Вспомогательный JS:
    *   Функции автоопределения `BACKEND_URL`.
    *   Загрузка и сохранение чатов из `localStorage` (`loadIdeChats`, `saveIdeChats`).
    *   Парсинг команд агента (`parseAgentCommands`, `applyAgentCommand`).
    *   Вспомогательные хуки (например, `useFocusTrap`).

*   **`ide/js/components/UI.js`**: Служебные компоненты интерфейса:
    *   SVG-глифы и иконки (`Glyph`, `Ico`, `splitGlyph`, `LogoIcon`, `ICONS`).
    *   Компоненты оформления (`EmojiBubble`, `StatusDot`, `GradBadge`, `AvatarRing`, `EmptyIllust`).
    *   Модалка оригинального docx (`DocxPreview`) и оверлей горячих клавиш (`ShortcutOverlay`).
    *   Контекстное меню (`CtxMenu`) и всплывающие уведомления (`ToastContainer`).

*   **`ide/js/components/Sidebar.js`**: Левая панель Legal IDE:
    *   Дерево документов (`TREE`, рендеринг папок/файлов).
    *   Библиотека НПА и живой поиск по законам.

*   **`ide/js/components/Editor.js`**: Текстовый редактор:
    *   Адаптер редактора (`editorAdapter`), связывающий TipTap и Quill.
    *   Интеграция TipTap с пользовательскими расширениями (`FontSize`, `LineHeight`, `ParagraphSpacing`).
    *   Инструменты экспорта в PDF и Word.

*   **`ide/js/components/AIChat.js`**: Правая панель ИИ-помощника:
    *   Лента сообщений, индикатор размышлений (stepper).
    *   SSE-клиенты (`streamChat`, `streamAnalyzeDocument`, `streamDeepAnalyze`).
    *   Интерфейс глубокого анализа документов (выбор ролей, прогресс-бар).

*   **`ide/js/app.js`**: Главный компонент `App`, связывающий все части интерфейса в единую IDE, управляющий состоянием вкладок документов, темой оформления (светлая/темная) и боковыми панелями.

---

## План тестирования и проверки (Verification Plan)

### Автоматические тесты и запуск
1.  **Локальный запуск сервера**: запустить `npm start` и проверить, что сервер успешно считывает все промпты, подключает роутеры и запускает Telegram-бота.
2.  **Проверка доступности**: открыть `http://localhost:3000/` (простой чат) и `http://localhost:3000/ide` (Legal IDE) в браузере.

### Ручная проверка функций
1.  **Чат и ИИ**: Отправить приветственный и юридический вопросы в IDE-чат, проверить, что стриминг ответов, степпер размышлений (Thinking Box) и вывод источников работают без ошибок.
2.  **Редактор**: Проверить вставку статей в TipTap редактор, экспорт в PDF и Word.
3.  **Анализ документа**: Загрузить тестовый юридический документ и запустить "Глубокий анализ", проверив параллельную работу Аудитора, Стратега и финальный синтез от Старшего партнера.
4.  **Минюст**: Убедиться, что автодополнение статей и поиск по базе НПА (проксирование Минюста) работают стабильно.
