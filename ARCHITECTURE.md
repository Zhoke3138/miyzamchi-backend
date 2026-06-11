# Miyzamchi 2.0 — Архитектура (Stateful Multi-Agent RAG)

> ⚠️ **УСТАРЕЛО ЧАСТИЧНО (11.06.2026, Этап 1 Backend Pivot):** микросервис парсинга
> Docling на Cloud Run **СНЕСЁН**. Парсинг теперь локальный в Node
> (`services/parserService.js`: pdf-parse/mammoth/fs). Разделы ниже про `parser-service/`,
> Cloud Run, OIDC ID-token, `GCP_SA_KEY_JSON`/`PARSER_SERVICE_URL` — НЕАКТУАЛЬНЫ.
> Тяжёлые/сканированные PDF — до внедрения Gemini Vision (Этап 2, см. `BACKEND_PIVOT_PLAN.md`).

> Версия пайплайна `/api/analyze-document` после перехода на микросервисную
> архитектуру (июнь 2026). Документ для новых сессий чата и онбординга.
> Старый монолитный пайплайн (Selective Reasoning v2.0) описан в `REFACTOR_ROADMAP.md`.

## 1. Зачем микросервисы
Основной Node-бэкенд живёт на **Render Free (512MB RAM)** — этого мало для тяжёлого
парсинга PDF (IBM Docling грузит ML-модели). Поэтому парсинг вынесен в отдельный
**бессерверный Python-контейнер на Google Cloud Run (2GB RAM)**.

```
┌────────────────────────┐        HTTPS + OIDC ID-token        ┌──────────────────────────┐
│  Node.js / Express     │ ──────────────────────────────────▶ │  Python FastAPI          │
│  Render Free (512MB)    │   multipart (стрим файла из /tmp)   │  Cloud Run (2GB, private)│
│  ОРКЕСТРАТОР            │ ◀────────────────────────────────── │  IBM Docling — ПАРСЕР    │
└────────────────────────┘        { markdown, pages }          └──────────────────────────┘
        │                                                              ▲
        │ Gemini (embed+lite) / Pinecone (Read-Only) / DeepSeek         │ модели запечены в Docker-образ
        ▼                                                              │ (нет загрузки в рантайме)
   3-фазный конвейер                                          concurrency=1, min-instances=0
```

## 2. Карта новых файлов
| Файл | Роль |
|------|------|
| `parser-service/main.py` | FastAPI + Docling. `/parse` (PDF→Markdown в памяти), `/health`. ZDR: диск не трогает |
| `parser-service/Dockerfile` | Модели Docling **запечены в образ** (`docling-tools models download` на build) |
| `parser-service/requirements.txt`, `.dockerignore` | Сборка Cloud Run |
| `services/parserService.js` | Node→Cloud Run: OIDC ID-token (google-auth-library), **стрим** файла, `fs.unlink` в `finally`, таймаут + 1 ретрай. Также локально DOCX (mammoth) / TXT |
| `services/llmClients.js` | Низкоуровневые клиенты из `.env`: `getNextKey` (ротация Gemini), `getEmbedding` (768d), `queryPinecone`, `geminiJson` (lite), `deepseekReason` (reasoner) |
| `services/legalAgents.js` | 5 боевых deps: `extractGlossary`, `expandQuery`, `pineconeSearch`, `validate`, `judge` |
| `lib/waveThrottle.js` | Волновой троттлер (20/волна, шаг 50ms, пауза 1000ms), settle-семантика |
| `routes/analyzeV2.js` | Оркестратор 3 фаз. `createAnalyzeV2Router(deps)` — default deps из legalAgents, можно мокать |

## 3. Поток `/api/analyze-document` (V2)
```
upload (multer -> /tmp, crypto.randomUUID имя)
  ├── ФАЗА 1: Pre-computation & Hybrid Chunking
  │     ├── extractMarkdown (PDF→Cloud Run | DOCX→mammoth | TXT→fs)  ── ZDR: unlink в finally
  │     ├── chunkDocument: '##'-заголовки → семантика; нет → Flat (1200с, overlap 150) + structure_confidence:low
  │     └── buildGlobalState: extractGlossary (Gemini lite) → { header, terms(Set), crossRefs, N }
  ├── ФАЗА 2: Validation Pipeline (волновой троттлер)
  │     └── runInWaves(validateChunk):
  │           ├── buildInjectedContext: шапка + кросс-ссылки + ТОЛЬКО релевантные термины (Set/substring)
  │           ├── expandQuery (3-4 синонима) → pineconeSearch (multi-query merge)
  │           ├── twoStagePineconeFilter: abs ≥0.70, хвост ≥ maxScore-0.15
  │           └── validate (Gemini lite, strict JSON): { verdict, reason, cited_articles[] }
  │                 • Blind Spot: риск есть, статей нет → cited_articles: []
  └── ФАЗА 3: Judgment (DeepSeek reasoner)
        ├── pickReasoningEffort: low (N<15, нет critical/blind) | high (N>100 ИЛИ blind/N>0.3) | medium
        ├── judge (Pure Synthesizer, 2 секции): переквалифицирует critical с пустыми статьями в «Слепая зона»
        └── computeMetrics: confidenceScore = 1 - Слепые/N; purityIndex = 1 - Риски/N
```

## 4. Zero Data Retention (ZDR)
1. Файл на Node сохраняется в `/tmp` **только** на время отправки HTTP-запроса.
2. `fs.unlink()` в блоке `finally` (`services/parserService.js`) — удаление при любом исходе.
3. Большой PDF **стримится** с диска (`fs.createReadStream`), не читается в Buffer (защита 512MB).
4. Python обрабатывает PDF **в памяти** (`io.BytesIO`), на диск не пишет.
5. Pinecone — **Read-Only** (только законы КР).

## 5. Аутентификация Cloud Run (OIDC ID-token)
- Render **не внутри GCP** → metadata-сервер недоступен → стандартный identity-token из коробки не работает.
- Решение: JSON-ключ сервис-аккаунта в `GCP_SA_KEY_JSON`; `google-auth-library` минтит ID-token
  с `audience = URL сервиса`; Cloud Run (IAM) валидирует токен сам (роль `roles/run.invoker`).
- Деплой и настройка — см. `DEPLOY_CLOUD_RUN.md`.

## 6. Модели и env
| Назначение | Модель | ENV |
|-----------|--------|-----|
| Embeddings (768d) | `gemini-embedding-001` | `GEMINI_API_KEY` (через запятую, ротация) |
| Экстрактор/Валидатор/Query Expansion | `gemini-3.1-flash-lite` | `GEMINI_API_KEY` |
| Финальный Судья | `deepseek-reasoner` (fallback Gemini 2.5) | `DEEPSEEK_API_KEY` |
| Векторная БД | Pinecone (Read-Only) | `PINECONE_API_KEY`, `PINECONE_HOST` |
| Парсер | IBM Docling @ Cloud Run | `PARSER_SERVICE_URL`, `GCP_SA_KEY_JSON`, `PARSER_TIMEOUT_MS` |

Pinecone metadata keys (фиксированы): `full_text`, `npa_title`, `article_title`.

## 7. Динамический `reasoning_effort` (Фаза 4.1)
| Уровень | Условие | Бюджет вывода |
|---------|---------|---------------|
| `low` | N < 15, нет critical, нет Слепых зон | 1500 |
| `medium` | warning/critical с найденными статьями | 3000 |
| `high` | N > 100 ИЛИ Слепые зоны / N > 0.3 | 6000 |

> Примечание: `deepseek-reasoner` может игнорировать поле `reasoning_effort`; реальный рычаг —
> `max_tokens` по уровню (`llmClients.EFFORT_MAX_TOKENS`). Поле всё равно пробрасывается (OpenAI SDK форвардит).

## 8. npm-зависимости (добавить в package.json)
`google-auth-library`, `form-data`, `multer` — помимо уже имеющихся `axios`, `mammoth`, `openai`, `@google/generative-ai`.

## 9. Чего НЕ трогать
- `server.js`, `.env`, `scripts/seed.js` — без явного согласия (см. `CLAUDE.md`).
- V2-модули **изолированы** от прод-монолита: `analyzeV2.js` не импортирует `server.js`,
  а реплицирует паттерны embed/Pinecone в `services/llmClients.js`.
- SSE-контракт фронта: события `step`, `tableRow`, `text`, `metadata`, `[DONE]` и др.

## 10. Тесты
- Чистые функции (троттлер, фильтр Pinecone, effort, метрики, чанкинг) тестируются без сети
  через `routes/analyzeV2.js`#`_internals` и `lib/waveThrottle.js`.
- Боевые вызовы (`services/llmClients.js`, `legalAgents.js`) требуют ключей из `.env`.
