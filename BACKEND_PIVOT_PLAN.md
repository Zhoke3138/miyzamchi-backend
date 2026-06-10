# 🔭 Backend Pivot — Miyzamchi 2.0 (план следующей сессии)

> Зафиксировано 10.06.2026. Фронтенд завершён (SuperDoc Document API: inline replace,
> Track Changes, чат-флоу accept/reject, чистка legacy IDE). Следующий этап — бэкенд.
> Сверяться с `claude_architecture.md` и `ARCHITECTURE.md` перед правками.

## Цель
Убрать хрупкую и дорогую микросервисную связку парсинга (Node@Render ↔ Python/Docling@Cloud Run)
и упростить пайплайн `/api/analyze-document` (V2, `routes/analyzeV2.js`): парсинг — нативно в Node
через Gemini, маршрутизация чанков — по типу (правовой vs технический).

---

## Этап 1 — Снос Docling / Python (Cloud Run)
**Что:** полностью удалить микросервис парсинга.
- Удалить папку `parser-service/` (FastAPI + Docling, Dockerfile, requirements).
- В `services/parserService.js` вырезать путь Cloud Run (OIDC ID-token через `google-auth-library`,
  стрим файла, `PARSER_SERVICE_URL`). Оставить локальные ветки: DOCX→mammoth, TXT→fs.
- Зависимости-кандидаты на удаление: `google-auth-library`, `form-data` (если больше нигде).
- ENV на вывод: `PARSER_SERVICE_URL`, `GCP_SA_KEY_JSON`, `PARSER_TIMEOUT_MS`.
- Обновить `ARCHITECTURE.md`, `DEPLOY_CLOUD_RUN.md` (пометить как deprecated/удалить).
- ⚠️ `.env` правит пользователь сам (не трогаем). Cloud Run сервис в GCP — снести вручную после деплоя.

## Этап 2 — Переход на Gemini Vision (парсинг PDF в Node)
**Что:** тяжёлые PDF парсить напрямую через **Google AI File API** внутри Node.
- Новый путь в `services/parserService.js` (или новый `services/geminiParser.js`):
  - Загрузка PDF в Gemini File API (`files.upload`), затем `generateContent` с file-part →
    запрос «извлеки чистый текст/Markdown документа».
  - Модель: Gemini Flash (мультимодальная, дешёвая) — сверить актуальный id и ценник.
  - ZDR сохранить: временный файл в `/tmp`, `fs.unlink` в `finally`; удалить файл из File API после.
- Граница: маленькие → текстом; большие/сканы → Gemini Vision. Лимиты File API уточнить.
- Фолбэк при сбое: понятная ошибка в SSE, без 500.

## Этап 3 — Triage-маршрутизация чанков (Chunk Triage, Фаза 2)
**Что:** в `routes/analyzeV2.js` (Фаза 2, валидация) разделять чанки по типу ПЕРЕД RAG:
- Лёгкий классификатор (Gemini lite, batched) метит чанк:
  - **LEGAL** — правовое содержание → текущий путь: `expandQuery` → `pineconeSearch` → `validate` (RAG).
  - **TECHNICAL / GRAMMAR** — опечатки, форматирование, реквизиты, числа → лёгкий **Spell-Checker
    агент БЕЗ Pinecone** (просто проверка грамматики/консистентности).
- Профит: меньше векторных запросов и токенов, быстрее, дешевле; технический шум не засоряет RAG.
- Точка входа: `runInWaves(validateChunk)` — добавить шаг triage перед `expandQuery`.
- Не ломать: волновой троттлер (`lib/waveThrottle.js`), SSE-контракт, метрики (confidence/purity).

---

## Порядок на завтра
1. Этап 1 (снос Docling) — самый безопасный, изолированный. Начать с него.
2. Этап 2 (Gemini Vision парсинг) — заменить вырезанный путь.
3. Этап 3 (Triage) — поверх рабочего парсинга.
Каждый этап — отдельный коммит + smoke-тест (`node lib/_smokeTest*.js`).

## Что НЕ трогать без «да»
`.env`, `scripts/seed.js`; ротация Gemini-ключей и Pinecone-конфиг в `server.js`;
SSE-контракт фронта; Pinecone metadata keys (`full_text`, `npa_title`, `article_title`).
