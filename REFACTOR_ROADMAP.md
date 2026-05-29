# Refactor Roadmap: Selective Reasoning & Map-Reduce RAG v2.0

**Цель:** `/api/analyze-document` 99с → 20-25с.
**Подход:** Regex-сегментация + Batched Issue Splitter + каскад лёгких LLM + адаптивный Two-Pass RAG.
**Файл-оркестратор:** `routes/analyze.js`
**Глобальные инварианты:** сохранить `TelemetryCollector`, SSE-контракт (`step`, `tableRow`, `text`, `purityIndex`, `sources`, `telemetry`, `[DONE]`), session-store, abort-handling.

---

## Чек-лист по фазам

### Фаза 0 — Подготовка инфраструктуры (Cascade Utility) ✅

- [x] Создать модуль `lib/llmCascade.js`.
- [x] Функция `cascade.call({ systemPrompt, userPrompt, jsonMode, telemetry, stageLabel, timeouts, skipTiers })`:
  - [x] Primary: Gemini 3.1 Flash Lite (`gemini-3.1-flash-lite`), timeout 10s.
  - [x] Fallback 1: Gemini 2.5 Flash, timeout 15s.
  - [x] Fallback 2: DeepSeek V4 Flash (через `deepseekJsonCall` с `maxRetries: 0`), timeout 20s.
  - [x] Per-attempt timeout через `Promise.race` (Google SDK не везде поддерживает AbortSignal — race надёжнее).
  - [x] Без задержек между tier'ами (моментальный fallback).
  - [x] `classifyCascadeError` различает `timeout / 429 / 5xx / 4xx / 404 / network / other`.
  - [x] Каждая попытка пишет в `telemetry.metrics.cascade.attempts[]` + инкремент `tier{N}_hits` или `all_failed`.
  - [x] При полном провале — throw с `.allFailed = true` и `.cascade.errors[]` для graceful degradation в вызывающем коде.
- [x] Расширить `TelemetryCollector`:
  - [x] Новые методы: `recordCascadeAttempt`, `incrementCascadeCounter`, `incrementCounter`.
  - [x] Поля: `metrics.cascade.{counters, attempts}` + универсальный `metrics.counters`.
  - [x] `generateReport` отображает cascade-секцию (распределение tier'ов в %) и список произвольных counters.
  - [ ] Таймеры конкретных стадий (`normalize`, `segment_regex`, `splitter_batches_total`, `adaptive_selector_total`, `pinecone_simple`, `pinecone_heavy_pass1`, `pinecone_heavy_pass2`, `agents_total`, `final_judge`) — стартуются в фазах 1-4 (инфраструктура `startTimer`/`endTimer` уже была).
- [x] Wire-up в `routes/analyze.js`: `lightLLMCascade` инстанс создан через factory из переданных deps (server.js не тронут).

### Фаза 1 — Cache-Hit Fix через `normalizeText` ✅

- [x] В `routes/analyze.js` добавлена чистая функция `normalizeText(text)` (рядом с `sessionHashDoc`):
  ```js
  function normalizeText(text) {
      return String(text || '')
          .replace(/\r\n/g, '\n')      // CRLF (Windows) → LF
          .replace(/\r/g, '\n')         // одиночные CR → LF
          .replace(/[ \t]+/g, ' ')      // пробелы и табы
          .replace(/\n{3,}/g, '\n\n')   // 3+ переносов → 2 (граница абзаца)
          .trim();
  }
  ```
- [x] `normalizeText` применяется ДО `sessionHashDoc` во всех точках:
  - [x] `/api/upload-document` (Shadow Pipeline) — rawDocumentText → normalizeText → documentText далее везде
  - [x] `/api/analyze-document` (main route) — то же самое
  - [x] `/api/compare` — НЕ ТРОГАЕМ: compare.js не использует `sessionHashDoc` и не имеет cache-логики (проверено grep'ом).
- [x] Verification logging: оба роута логируют `{ rawLen, normLen, hashPrefix }` в `logger.info` — за несколько прогонов будет видно, что hashPrefix у /upload и /analyze совпадает для одного и того же файла.
- [x] `normalizeClauseText` НЕ затронут — он остаётся отдельной функцией (с lowercase + замена кавычек), используется только для clause cache. Разные слои нормализации не конфликтуют.
- [x] Бонус: добавлен фикс `.replace(/\r/g, '\n')` для одиночных CR (старые Mac / битые скан-импорты).
- [x] Валидация `length < 50` теперь работает на нормализованном тексте — документ из одних пробелов с 10 символами больше не пройдёт (баг pre-Phase 1: проходил из-за `.trim().length` на raw).

### Фаза 2 — Детерминированная Regex-сегментация ✅

- [x] Создан модуль `lib/segmentRegex.js` с синхронной `segmentDocumentRegex(text, opts)`, возвращает `string[]`.
- [x] Маркеры начала нового chunk (один комбинированный regex с unicode-флагом `u`):
  - [x] `\d+[.)]` — нумерованные пункты (включая 1., 2., 3., 1.1, 2.3.4 — `\d+\.` матчит начало любой вложенности)
  - [x] `Стать[яеи]\s+\d+` (любая форма склонения: Статья / Статье / Статьи)
  - [x] `Глава\s+\d+`
  - [x] `Част[ьи]\s+\d+` (Часть / Части)
  - [x] `Раздел\s+\d+`
  - [x] `§\s*\d+` (бонус — параграфы)
- [x] Алгоритм Greedy Merge:
  1. `text.split(/\n{2,}/)` → массив параграфов
  2. Первый параграф → открывает чанк (даже если без маркера → преамбула)
  3. Следующие: если начинается с маркера → push old, open new; иначе → склеить через `\n\n`
- [x] **Safe Fallback** (`safeSplitLongChunk`) для чанков >3000 ch:
  - [x] `sentenceSplit` ищет `[.!?]+ <whitespace> <Большая буква>`, но проверяет последнее слово ДО точки
  - [x] Список из 30+ юр. сокращений (`ст, стт, п, пп, ч, чч, абз, г, гг, т, тыс, млн, млрд, руб, сом, см, напр, проч, др, рис, табл, кр, рф, рк, ул, пр, пер...`) — если последнее слово в списке → не разрываем
  - [x] Greedy merge предложений до maxLen
  - [x] **Hard Fallback** (`hardSplit`): если после safe ещё длинно — режем по `\n`, потом по символам; пишем warn в `telemetry.incrementCounter('segment_hard_split_warnings')`
- [x] Старая `segmentDocument` НЕ удалена из server.js (revert-safety). В analyze.js destructure deps закомментирован с инструкцией "раскомментировать при откате".
- [x] Контракт сохранён: `segments` остаётся `string[]`, `chunk_index` = индекс в массиве.
- [x] **Smoke-test [lib/_smokeTestSegmentRegex.js](lib/_smokeTestSegmentRegex.js): 20/20 PASS:**
  - Договор с нумерацией 1./2./3.
  - Кодекс с маркерами Глава/Статья
  - Длинный текст с сокращениями ст./п./ч./г. — НЕ рвётся посреди сокращения, lossless по символам
  - OCR-документ из 4000 ch без пунктуации — успешно проходит до hardSplit без падений
  - Пустой / null / whitespace-only вход → `[]`
  - Вложенная нумерация 1.1, 1.2
  - Преамбула без маркера сохраняется как чанк 0
- [x] Latency: было ~63с (LLM) → теперь <10мс синхронно. **Главный буст по скорости.**

### Фаза 3 — Batched Issue Splitter + Adaptive RAG ✅ (модуль готов, интеграция — в Фазе 4)

- [x] Концепт утверждён, decision points зафиксированы (см. Open Questions).
- [x] Создан `lib/npaAliases.js`: словарь из 15 НПА КР, `normalizeNpaName()` с lowercase + whitespace + trailing-dot нормализацией. 17 PASS.
- [x] Создан `lib/phase3.js` — factory `createPhase3Pipeline(deps)` с тремя API: `run`, `runSplitter`, `runAdaptiveRetrieval`.
- [x] **Конфигурируемые константы** в шапке `phase3.js`:
  - `SPLITTER_BATCH_SIZE = 25` (между 20-30 из ТЗ)
  - `SPLITTER_BATCH_CHAR_LIMIT = 45000` (защита контекста Flash Lite)
  - `HEAVY_THRESHOLD_CITATIONS = 10`
  - `HEAVY_SELECT_TOP_N = 5` ← конфигурируемая, как просил
  - `HEAVY_PASS1_TOP_K = 15`
  - `SIMPLE_PINECONE_CONCURRENCY = 8`
- [x] **`buildBatches`** — синхронный, dual-guard (count + chars). Гигант-чанк уходит в свой батч.
- [x] **`runSplitter`** — батчи **последовательно** (как решили), каскад с jsonMode, safeJsonParseStrict, validateCitations + normalizeNpaName. Per-batch graceful degradation: `cascade.allFailed` → empty citations + degraded flag + один SSE warning.
- [x] **Simple path** (`runSimplePath`) — flatten всех citations → `runWithConcurrency(8)` → Pinecone TOP_K=1, дедуп по `citationKey(npa, article)`.
- [x] **Heavy path** (`runHeavyForChunk`):
  - pass1: `runWithConcurrency(8)` на 15 кандидатов/citation
  - дедуп кандидатов по `(npa, article)`, max score wins
  - Adaptive Selector через `lightLLMCascade` (`adaptive_selector_c{N}` stageLabel)
  - fallback: top-N по score если selector упал или вернул <5
  - **pass2 не делаем** — `searchPinecone` всегда возвращает полное metadata, fullText уже есть из pass1 (экономия N запросов на heavy-chunk). Отклонение от ТЗ задокументировано в шапке файла.
- [x] **Degraded mode SSE**: `sendStep(res, { id: 'phase3_degraded', status: 'warning', text: 'Переход в режим базового анализа (внешний сервис временно недоступен).' })` — отправляется **только один раз** через `emitDegradedWarningOnce` независимо от того, сколько раз сработала деградация.
- [x] Wire-up в `routes/analyze.js`: инстанс `phase3Pipeline` создан в DI-factory (рядом с `lightLLMCascade`). **Не интегрируется в роуты** — интеграция намечена на Фазу 4 после перевода Ищеек на structured JSON.
- [x] **Smoke-test [lib/_smokeTestPhase3.js](lib/_smokeTestPhase3.js): 78/78 PASS:**
  - normalizeNpaName: 17 тестов (УК/ГК/СК/КоАО полные/короткие/регистр/мусор)
  - buildBatches: 9 тестов (count, char-guard, edge cases)
  - classifyComplexity / buildSearchQuery / citationKey / validateCitations: 18 тестов
  - **Integration (7 сценариев):**
    - 7A: happy simple path → relevant_articles из Pinecone, source=simple
    - 7B: cascade allFailed → degraded=true + ровно 1 SSE warning
    - 7C: 12 citations → heavy → selector вызван 1 раз → relevant_articles ровно 5
    - 7D: Pinecone пустой → не degraded, relevant_articles=[]
    - 7E: битый JSON от LLM → пустые citations, без падения
    - 7F: 30 чанков с failing-каскадом → 2 батча упали → SSE warning отправлен **ровно 1 раз** (дедуп через `degradedState.warned`)

### Что не покрыто smoke-тестом (нужен real-call regression)

- Реальный latency Gemini 3.1 Flash Lite на батче 25 чанков (ожидаем 1-3с, проверим в проде)
- Реальная конверсия `npa_title` из метаданных Pinecone — мок предполагает поле `npa_title`. Если в проде окажется другое имя поля, потребуется правка `runSimplePath` и `runHeavyForChunk`.
- Реальный rate-limit под нагрузкой 30+ батчей подряд — на этот случай у нас каскад с fallback на 2.5 Flash и DeepSeek.

### Фаза 4 — Интеграция Phase 3 + Structured Agent Audit ✅

> Откровение: существующие Ищейки УЖЕ возвращали structured JSON через `safeJsonParseStrict`
> (`{status, confidence, finding, rationale, suggestion, articles, provider}`). Семантически
> это эквивалент TZ-схемы (`risk_type≈finding`, `severity≈status`, `reasoning≈rationale`,
> `law_reference≈articles[0]`). SSE-контракт `tableRow` от этого зависит — поэтому Path A:
> **сохраняем существующую схему, добавляем Phase 3 как точный RAG-источник**.

- [x] **Фикс совместимости Phase 2**: `lib/segmentRegex.js` отдаёт `string[]`, но downstream
  ждёт `{id, number, heading, text}`. Адаптер добавлен в `preparePipelineState` — извлекает
  номер из маркера (`Статья N`, `1.1`, `Глава N`, `§ N`), heading = первая строка (до 120ch).
  Lib остаётся pure, оборачивание — в analyze.js.
- [x] **Реальные ключи Pinecone metadata** проброшены в `lib/phase3.js`:
  - `npa_title` — название НПА (для `normalizeNpaName`)
  - `article_title` — название статьи (попадает в `articleTitle` поле relevant_articles)
  - `full_text` — полный текст статьи (попадает в `fullText`)
  - Mock в smoke-test обновлён, 78/78 PASS подтверждают совместимость.
- [x] **Phase 3 интеграция** в `/api/analyze-document`:
  - Вызов `phase3Pipeline.run({ chunks, telemetry, res, aborted })` ПОСЛЕ Triage и ДО verifier-пула.
  - Прогоняем только audit-пункты (не skip — экономия LLM-токенов).
  - Отправляем SSE-step `phase3` с loading/success/warning + счётчиком привязанных статей.
  - Phase 3 сам шлёт `phase3_degraded` warning через emitDegradedWarningOnce — мы НЕ дублируем.
  - Защитный `try/catch` вокруг `phase3Pipeline.run` — даже если случится неожиданный throw,
    Ищейки уходят в legacy путь без потери ответа.
- [x] **`runVerifierAgent` принимает `task.preFetchedArticles`**:
  - Если есть — берём готовые articles от Phase 3, **пропускаем `getEmbedding` + `searchPinecone`**.
  - Это и есть structured RAG: один точный запрос на статью, один точный ответ.
  - Clause cache отключён для phase3-задач (контекст может отличаться → нельзя кэшировать).
- [x] **`verifySegmentsSmart` строит task с `preFetchedArticles`** когда Phase 3 дал articles.
  Если `relevant_articles = []` (пункт без явных НПА-ссылок ИЛИ Phase 3 degraded) — fallback
  на legacy путь (`extractArticleMentions` + adaptive Pinecone), как раньше.
- [x] **p-limit сохранён**: `SEGMENTS_CONCURRENCY=12` для пула сегментов, `HOUNDS_PER_SEG_CONCURRENCY=3`
  для агентов внутри сегмента (без изменений).
- [x] **`safeJsonParseStrict` + degraded fallback** Ищеек — было и до Phase 4. При неудаче парсинга
  возвращается `{status: 'warning', finding: 'Ответ модели не распарсился', ...}` — это и есть
  TZ-эквивалент `risk_type: 'parse_error'`. tableRow строится корректно.
- [x] **Final Judge** не тронут — получает тот же `allResultsForJudge` (skip-результаты + finalResults).
  DCR-логика, judgeModel, judgeReasoning, KVCache user_id — всё в продакшен-состоянии.
- [x] **SSE-контракт СВЯТОЕ** — сохранено: `step`, `tableRow`, `text`, `safe_triage_segment`,
  `sources`, `metadata`, `protocolStatus`, `purityIndex` (см. далее), `telemetry`, `[DONE]`.
  **Новые** SSE-события: `step` с `id: 'phase3'` (loading/success/warning) и `id: 'phase3_degraded'`
  (warning, из Phase 0 emitDegradedWarningOnce) — фронт может их безопасно игнорировать (нет
  обязательной реакции), либо отрендерить как информационные.

### Фаза 5 — Регресс и деплой

- [x] Smoke-test покрытие: 78 (Phase 3) + 20 (Phase 2 segmentRegex) + 0 регрессий на синтаксисе.
- [ ] **Прогнать в проде на 5 реальных кейсах**: договор, претензия, кодекс, иск, кривой скан.
- [ ] **Сверить latency**: target 20-25с medium, до 35с heavy. Снять telemetry-отчёт.
- [ ] **Сверить SSE-контракт** на проде: фронт получает все ожидаемые события без поломок.
- [ ] **Cache hit verification**: повторный анализ того же документа → session-store hit + clause cache hit.
- [ ] **Cascade распределение**: ожидаем >85% `tier1_hits` (Gemini 3.1 Flash Lite). Если меньше —
  проверить timeouts (сейчас 10/15/20).
- [ ] **Бэкап старого `analyze.js`** перед заливкой (git tag `pre-selective-reasoning-v2`).

### Фаза 5 — Регресс и деплой

- [ ] Прогнать 5 реальных кейсов: договор, претензия, кодекс, иск, скан.
- [ ] Сверить latency: target 20-25с medium, до 35с heavy.
- [ ] Сверить SSE-контракт (фронт не должен сломаться).
- [ ] Проверить session-store cache hit на повторном анализе.
- [ ] Снять telemetry-отчёт: распределение `cascade_primary_hits` (ожидаем >85%).
- [ ] Бэкап старого `analyze.js` перед заливкой.

---

## Phase 3 Design (Concept — без кода)

### A. Иерархия модулей

```
runIssueSplitterPipeline(chunks, telemetry, opts)
 ├── buildBatches(chunks)                          ── чисто синхронно
 ├── for each batch (последовательно или p-limit 2):
 │    ├── callLightLLMCascade(prompt, jsonMode)    ── Фаза 0
 │    ├── parseAndValidate(rawJson, batch)         ── строгая валидация
 │    └── normalizeCitations(chunkAnalyses)        ── алиасы НПА
 └── runAdaptiveRetrieval(allChunkAnalyses, telemetry, opts)
       ├── classifyComplexity(chunkAnalysis)       ── simple vs heavy
       ├── simplePathRetrieve(chunk)               ── TOP_K=1 параллельно
       ├── heavyPathRetrieve(chunk)
       │    ├── pass1: TOP_K=15 metadata-only
       │    ├── callLightLLMCascade (Adaptive Selector — "выбери 5")
       │    └── pass2: TOP_K=1 для выбранных 5
       └── mergeContextIntoChunks(chunks, retrieved)
```

### B. Точки отказа и стратегия

| Уровень | Сбой | Действие |
|--------|------|---------|
| Cascade Primary timeout | Gemini 3.1 Lite не ответил за N мс | Сразу Fallback 1 (Gemini 2.5 Flash) |
| Cascade Fallback 1 | 2.5 Flash 5xx / rate-limit | Fallback 2 (DeepSeek V4) |
| Cascade Fallback 2 | DeepSeek упал | Возвращаем `{ chunks_analysis: [], degraded: true }` — батч идёт в Phase 4 БЕЗ контекста (агенты работают на голом chunk, без relevant_articles) |
| Splitter JSON parse fail | Кривой JSON | `safeJsonParseStrict` → пустые citations для батча, telemetry warn |
| Один chunk вернул мусор (нет citations array) | — | Этот chunk → simple path с пустым массивом, без падения |
| Adaptive Selector упал | На heavy path не выбрал 5 | Деградация: берём первые 5 из pass1 metadata по score |
| Pinecone query 1 citation упала | сетевой сбой | Skip этой статьи, остальные в чанке — продолжают |
| Pinecone весь упал | — | `relevant_articles: []` для всех chunks, Phase 4 идёт degraded |

**Принцип:** ни одна точка отказа не должна валить весь request. Деградация всегда **в сторону "меньше контекста — но ответ есть"**, никогда не throw.

### C. Структура данных между шагами

После Splitter:
```js
chunkAnalyses = [
  {
    chunk_index: 0,
    chunk_text: "...",                // оригинал из Phase 2
    citations: [
      { npa: "УК КР", article: "10", parts: [] },
      ...
    ],
    complexity: "simple" | "heavy",   // выставляется в classifyComplexity
    degraded: false
  }
]
```

После Adaptive Retrieval:
```js
chunkAnalyses[i].relevant_articles = [
  { npa, article, parts, fullText, pineconeScore, source: "simple"|"heavy_selected" }
]
```

### D. Batching policy

- Базовый размер: **25 chunks/batch** (между 20-30 из ТЗ).
- Дополнительный guard: суммарный char-count батча не должен превышать ~40-50K символов (защита от перегрузки контекста Flash Lite). Если превышает — резать батч пополам.
- Батчи запускать **последовательно** (или p-limit 2) — параллельность даст rate-limit, а выигрыш по latency меньше выигрыша от батчинга самого по себе.

### E. Adaptive Selector (heavy path)

- Промпт принимает: текст chunk + список кандидатов (npa+article+title из metadata, 15 шт).
- Возвращает JSON: `{ "selected": [{"npa":"...", "article":"..."}, ...] }` — ровно 5 элементов.
- При <5 selected — добиваем из кандидатов по убыванию score.
- При >5 selected — обрезаем до 5.

### F. Telemetry-таймеры (для будущей отладки)

- `phase3_splitter_total`
- `phase3_splitter_batch_avg`
- `phase3_cascade_breakdown` (счётчики по моделям)
- `phase3_adaptive_pass1_avg`
- `phase3_adaptive_selector_avg`
- `phase3_adaptive_pass2_avg`
- `phase3_pinecone_queries_total`

### G. Open Questions (требуется решение перед кодом)

1. **Точные ID моделей.** Gemini 3.1 Flash Lite — какой exact model name использовать в SDK? (Если пока недоступна — стартуем с 2.5 Flash как Primary, добавим 3.1 Lite через env-флаг.)
2. **Heavy-path threshold.** ТЗ: `citations > 10`. Подтвердить или сменить (12 / 15)?
3. **Сколько статей выбирает Adaptive Selector.** ТЗ: 5. Оставляем или делаем конфигурируемым (`HEAVY_SELECT_TOP_N=5`)?
4. **Cascade timeouts.** Per-attempt timeout — сколько даём Primary до Fallback? Предлагаю: 8с Primary, 12с Fallback 1, 15с Fallback 2.
5. **Degraded mode UX.** Если каскад полностью лёг — фронту слать `step: "degraded_mode"` или продолжать молча?
6. **NPA normalization.** Делаем карту алиасов (УК КР / Уголовный кодекс / УК Кыргызской Республики → одна форма) или доверяем LLM? Если карту — где её хранить?
7. **Batching parallelism.** Запускать батчи последовательно или p-limit 2? (Зависит от rate-limit Gemini Flash Lite.)
8. **Pinecone simple-path concurrency.** Сейчас в `runWithConcurrency` есть глобальный лимит. Какой использовать для simple-path citations? Предлагаю 8.

---

## Что НЕ меняем (закреплено CLAUDE.md)

- `script.js`, `scripts/seed.js`, `.env`
- SSE-парсинг и контракт событий
- localStorage `miyzamchi_chats`
- Маршруты `/api/chat`, `/ping`
- Ротация Gemini ключей (трогаем только добавлением 3.1 Lite, без слома существующей)
- DCR-логика финального Judge

---

## Порядок исполнения

1. ✅ Утвердить этот roadmap (текущий шаг).
2. ⏸ Утвердить Phase 3 Design (раздел выше) + ответы на Open Questions.
3. ▶ Кодим Фазу 0 (Cascade utility + telemetry-расширение).
4. ▶ Кодим Фазу 1 (`normalizeText` + интеграция).
5. ▶ Кодим Фазу 2 (Regex-сегментация + safe fallback).
6. ▶ Кодим Фазу 3 (Splitter + Adaptive RAG) — самый большой PR.
7. ▶ Кодим Фазу 4 (Structured agents + Judge).
8. ▶ Регресс + деплой.
