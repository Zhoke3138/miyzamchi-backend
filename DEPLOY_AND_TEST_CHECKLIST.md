# Deploy & Prod-Test Checklist — Selective Reasoning v2.0

Документ-компаньон. Держи открытым во время заливки и первых прогонов.

---

## 1. Что заливать на GitHub

### Файлы для коммита (5 файлов кода + 2 опционально)

```
lib/llmCascade.js           ── НОВЫЙ (Phase 0)
lib/segmentRegex.js         ── НОВЫЙ (Phase 2)
lib/npaAliases.js           ── НОВЫЙ (Phase 3)
lib/phase3.js               ── НОВЫЙ (Phase 3)
routes/analyze.js           ── МОДИФИЦИРОВАН (Phase 1, 2, 4)
```

Опционально (полезно для регрессий на будущее, но не критично):
```
lib/_smokeTestSegmentRegex.js   ── 20 локальных тестов
lib/_smokeTestPhase3.js         ── 78 локальных тестов
REFACTOR_ROADMAP.md             ── архитектурный артефакт
DEPLOY_AND_TEST_CHECKLIST.md    ── этот файл
```

**НЕ заливать (не тронуты):**
- `server.js` — никаких изменений
- `.env` — никаких изменений
- `script.js`, `index.html`, `style.css` — фронт
- `scripts/seed.js` — индексация

### Куда заливать

Через GitHub веб-интерфейс:
1. В корне репозитория должна появиться папка `lib/` (если её ещё нет — GitHub создаст автоматически при загрузке первого файла).
2. Все 4 новых `lib/*.js` — в эту папку.
3. `routes/analyze.js` — заменить существующий файл (GitHub предложит "replace").

### Перед заливкой — СТРАХОВКА

В терминале GitHub Desktop ИЛИ через веб (через "Tags" в репо):
```
git tag pre-selective-reasoning-v2
git push origin pre-selective-reasoning-v2
```

Или через веб: Repo → Releases → "Draft a new release" → Tag: `pre-selective-reasoning-v2` → Target: `main`. Это создаст точку отката.

**Откат при катастрофе**: на Render Dashboard → Manual Deploy → выбрать предыдущий commit или указать тэг `pre-selective-reasoning-v2`.

---

## 2. Прогон в проде — что искать в логах

После заливки и редеплоя, открой Render → Logs (live tail).

### 2.1 Стартап (должен пройти чисто)

Ищи:
```
[INFO] upload-doc-shadow-start | {...}      ← старая логика жива
==========================================
Мыйзамчи запущен на порту ...
Загружено ключей Gemini: N
```

**Тревога**, если видишь:
- `Error: Cannot find module '../lib/...'` → файл не загрузился в `lib/`. Проверь GitHub.
- `TypeError: createPhase3Pipeline is not a function` → один из файлов битый.
- `[Phase3] getNextKey() обязателен` → DI-проблема, пинг разработчика.

### 2.2 Первый реальный анализ — что должно появиться

Загрузи **типичный договор** (15-30 пунктов с явными ссылками на УК/ГК/ТК). Лог должен идти примерно так:

```
[INFO] upload-doc-shadow-start | {"rawLen":12450,"normLen":12380,"hashPrefix":"a7f4d2c1b9e0"}
[Phase3 Splitter] batch 0/0 done in 2340ms (15 chunks)         ← Phase 3 батч
[Phase3 Retrieval] simple=14 heavy=1                            ← классификация
[Verifier] CACHE HIT for п.2 ...  (не на первом прогоне)
[analyze-document] DONE in 22.3s | shadow=HIT | total=15 | skip=3 | audit=12 | risks=4 | aborted=false

========== TELEMETRY REPORT ==========
[ОБЩИЕ МЕТРИКИ]
Total Execution Time: 22.34s
Router Time: 1.50s
Segmentation Time: 0.01s                  ← было ~63с !
Triage Time: 1.20s
Final Judge Time: 6.80s

[АГЕНТЫ (Параллельная работа)]
Всего обработано пунктов: 12
Pinecone Search: Min 0.40s, Max 0.85s, Avg 0.55s
Agent LLM Audit: Min 1.20s, Max 4.30s, Avg 2.80s

[ТОКЕНОМЕТРИКА]
Total Prompt Tokens (est.): 45000
Total Completion Tokens (est.): 8500

[LLM CASCADE (Phase 3 light models)]
Total cascade calls: 2
  Tier 1 (Gemini 3.1 Flash Lite): 2 (100.0%)   ← норма
  Tier 2 (Gemini 2.5 Flash):      0 (0.0%)
  Tier 3 (DeepSeek V4 Flash):     0 (0.0%)
  All failed (degraded):          0 (0.0%)

[COUNTERS]
  simple_path_chunks: 14
  heavy_path_chunks: 1
  pinecone_simple_queries: 23
  pinecone_heavy_pass1_queries: 12
  phase3_splitter_batches: 1
======================================
```

### 2.3 На что обращать внимание

| Сигнал | Что значит | Что делать |
|--------|-----------|------------|
| `Segmentation Time: 0.01s` | Phase 2 работает | ✅ норма |
| `Segmentation Time: > 1s` | Regex не справляется (огромный документ?) | посмотреть `segment_hard_split_warnings` |
| `Tier 1 hits: < 70%` | Gemini 3.1 Flash Lite лагает / 429 | посмотреть `Failed attempts breakdown` |
| `All failed > 0` | Каскад полностью лёг ХОТЯ БЫ раз | проверить квоты ключей + DeepSeek API |
| `phase3_splitter_batches: 0` | Phase 3 НЕ запустился | проверить что есть audit-пункты (не все skip) |
| `pinecone_simple_queries: 0` | Citation массив пустой у всех | проверить что Splitter не возвращает empty |
| `segment_hard_split_warnings: > 0` | OCR-скан или кривой текст | возможно надо добавить маркер в regex |

### 2.4 Hash-проверка для cache-fix (Phase 1)

Сравни два лог-сообщения на ОДНОМ И ТОМ ЖЕ документе:
```
[INFO] upload-doc-shadow-start | {..., "hashPrefix":"a7f4d2c1b9e0"}
[INFO] analyze-doc-pipeline    | {..., "hashPrefix":"a7f4d2c1b9e0", "hasSession":true}
                                            ↑↑↑↑↑↑↑↑↑↑↑↑
                                  Должны совпадать → cache hit работает
```

Если расходятся — фронт делает с текстом что-то ещё (например, добавляет BOM или конвертирует кодировку). Тогда стоит ловить отдельно.

---

## 3. Как сымитировать падение Gemini 3.1 Flash Lite

Прямого env-флага нет, поэтому делаем через временную правку константы. Это безопасно — изменение в одной строке, легко откатить.

### Сценарий A: Tier 1 не отвечает → должен включиться Tier 2 (Gemini 2.5 Flash)

1. Открой [lib/llmCascade.js](lib/llmCascade.js) через GitHub веб-редактор.
2. Найди строку:
   ```js
   { tier: 1, kind: 'gemini',   model: 'gemini-3.1-flash-lite', defaultTimeoutMs: 10000 },
   ```
3. Замени `gemini-3.1-flash-lite` на `gemini-NONEXISTENT-test`:
   ```js
   { tier: 1, kind: 'gemini',   model: 'gemini-NONEXISTENT-test', defaultTimeoutMs: 10000 },
   ```
4. Commit с сообщением `TEST: force tier1 failure` → Render редеплоит.
5. Запусти анализ любого документа.

**Ожидаемые логи:**
```
[Cascade splitter_batch_0] tier1 gemini-NONEXISTENT-test 404 (123ms) → next tier
[DeepSeek cascade:splitter_batch_0] ... (или сразу tier 2 если Gemini жив)
```

**В telemetry-отчёте:**
```
[LLM CASCADE]
  Tier 1 (Gemini 3.1 Flash Lite): 0 (0.0%)
  Tier 2 (Gemini 2.5 Flash):      2 (100.0%)   ← переключился сюда
Failed attempts breakdown: t1:404=2
```

6. **ОТКАТ**: верни строку как было и закоммить `Revert: restore tier1 model`.

### Сценарий B: Tier 1 + Tier 2 оба легли → должен включиться Tier 3 (DeepSeek)

Шаги те же, но меняем ОБЕ строки:
```js
{ tier: 1, kind: 'gemini',   model: 'gemini-NONEXISTENT-test',  defaultTimeoutMs: 10000 },
{ tier: 2, kind: 'gemini',   model: 'gemini-NONEXISTENT-test2', defaultTimeoutMs: 15000 },
```

Ожидание:
```
[Cascade splitter_batch_0] tier1 ... 404 → next tier
[Cascade splitter_batch_0] tier2 ... 404 → next tier
[DeepSeek cascade:splitter_batch_0] recovered on attempt 1 (model=deepseek-v4-flash)
```

В telemetry: `Tier 3 (DeepSeek V4 Flash): N (100.0%)`.

### Сценарий C: Полная деградация (вся троица легла)

Опасный сценарий — DeepSeek сложно "сломать" с нашей стороны без отключения API ключа. Альтернатива — установить таймауты в 1мс:

В [lib/llmCascade.js](lib/llmCascade.js) меняем все три `defaultTimeoutMs`:
```js
{ tier: 1, kind: 'gemini',   model: 'gemini-3.1-flash-lite', defaultTimeoutMs: 1 },
{ tier: 2, kind: 'gemini',   model: 'gemini-2.5-flash',      defaultTimeoutMs: 1 },
{ tier: 3, kind: 'deepseek', model: 'deepseek-v4-flash',     defaultTimeoutMs: 1 },
```

Ожидаемое:
- В консоли: `[Cascade ...] tier1 ... timeout (1ms) → next tier` × 3
- В telemetry: `All failed (degraded): N (100.0%)`
- **Во фронтенд** прилетит SSE:
  ```json
  {"step":{"id":"phase3_degraded","status":"warning","text":"Переход в режим базового анализа (внешний сервис временно недоступен)."}}
  ```
- Анализ **не упадёт**, Ищейки уйдут в legacy путь (старая Pinecone-логика).

После теста — верни таймауты на 10000/15000/20000.

### Сценарий D: Symbol-level — `skipTiers` без правки констант

Если будет желание управлять каскадом без commit'а (например, через query-параметр или env-var) — это уже отдельная фича, можно сделать в Phase 6. Сейчас простейший путь — правка константы.

---

## 4. Расшифровка новых метрик в TelemetryCollector

### 4.1 Секция `[LLM CASCADE]`

```
Total cascade calls: 5
  Tier 1 (Gemini 3.1 Flash Lite): 4 (80.0%)
  Tier 2 (Gemini 2.5 Flash):      1 (20.0%)
  Tier 3 (DeepSeek V4 Flash):     0 (0.0%)
  All failed (degraded):          0 (0.0%)
Failed attempts breakdown: t1:timeout=1
```

**Норма (зелёная зона):**
- `Tier 1 hits > 85%` — Gemini 3.1 Flash Lite надёжно работает
- `All failed = 0` — каскад ни разу не лёг до конца
- `Failed attempts breakdown` — пустая строка или 1-2 редких сбоя

**Жёлтая зона (присмотреться):**
- `Tier 1 hits = 60-85%` — 3.1 Flash Lite часто отваливается, но fallback ловит
- `Failed attempts breakdown: t1:5xx=10` — Google нестабильно отвечает на этом аккаунте
- `Tier 2 hits > 30%` — ненормально много fallback'ов, проверь лимиты ключей

**Красная зона (alarm):**
- `Tier 1 hits < 60%` ИЛИ `All failed > 0` — что-то реально не так
- `Failed attempts breakdown: t1:404=N (большой)` — модель 3.1 Lite недоступна на этом аккаунте → надо понизить Primary до 2.5 Flash в `lib/llmCascade.js`
- `t1:timeout=N (большой)` — 10с не хватает, увеличить `defaultTimeoutMs[0]` до 15000

### 4.2 Секция `[COUNTERS]`

```
simple_path_chunks: 14         ← пунктов с ≤10 ссылками на статьи
heavy_path_chunks: 1            ← пунктов с >10 ссылками (нужен Selector)
pinecone_simple_queries: 23     ← всего Pinecone-запросов на simple-path
pinecone_heavy_pass1_queries: 12 ← запросов pass1 на heavy chunks
phase3_splitter_batches: 1      ← сколько батчей было в Splitter'е
segment_hard_split_warnings: 0  ← кейсы где regex не нашёл предложения (OCR/скан)
```

**Норма:**
- `simple : heavy` ≈ 90:10 для договоров, 70:30 для исков/постановлений
- `pinecone_simple_queries` ≈ `simple_path_chunks × 2-5` (citations per chunk)
- `phase3_splitter_batches` ≈ `audit_count / 25` (округление вверх)
- `segment_hard_split_warnings = 0`

**Жёлтая зона:**
- `heavy_path_chunks > 30%` — документ очень "ссылочный" (кодекс?), это нормально, но latency будет выше
- `segment_hard_split_warnings > 0` — попался OCR-скан, статьи могут плохо извлекаться

**Красная зона:**
- `phase3_splitter_batches = 0` при `audit_count > 0` — Phase 3 НЕ запустился, посмотри ошибки в логах рядом
- `pinecone_simple_queries = 0` при `simple_path_chunks > 0` — Splitter не вернул ни одной citation, проверь промпт и cascade attempts

### 4.3 Секция `[ОБЩИЕ МЕТРИКИ]` — таймеры

```
Total Execution Time: 22.34s
Router Time: 1.50s              ← extractDocumentContext
Segmentation Time: 0.01s        ← было ~63с до Phase 2 !
Triage Time: 1.20s              ← runTriage (без изменений)
Final Judge Time: 6.80s         ← runFinalJudge (без изменений)
```

**Норма** (по target из roadmap):
- Total: **20-25с medium**, до **35с heavy**, до **8с cache hit**
- Segmentation: **< 0.1с** (раньше было 30-90с в зависимости от длины)
- Final Judge: **5-10с** (как раньше, не оптимизировали)

**Тревога:**
- Total > 60с → Phase 3 или verifier тормозят, нужен профайлинг
- Segmentation > 1с → regex буксует, документ странный
- Final Judge > 30с → DCR упёрся в heavy path, может быть нормой если документ реально сложный

### 4.4 Новые таймеры Phase 3 (если расширишь generateReport их выводом)

Сейчас они пишутся в `telemetry.metrics.times` но не выводятся в отчёте. В отчёте видны только Router/Segmentation/Triage/Final_Judge. Если хочешь видеть их — нужно добавить в `generateReport` строки (это пункт TODO из чек-листа Фазы 0).

Что внутри `telemetry.metrics.times` после Phase 3:
- `Phase3_Splitter_Total` — суммарное время Splitter (все батчи)
- `Phase3_Adaptive_Total` — Adaptive Retrieval (simple + heavy)
- `Phase3_Simple_Pinecone` — Pinecone simple-path (с concurrency 8)
- `Phase3_Heavy_Pass1_c{N}` — pass1 для конкретного heavy-чанка
- `Phase3_Selector_c{N}` — LLM-селектор для конкретного heavy-чанка

Если хочешь их в репорте — скажи, добавлю 5-строчный апдейт в `generateReport` (3 минуты).

---

## 5. Quick triage таблица (симптом → причина → действие)

| Симптом | Вероятная причина | Что делать |
|--------|-------------------|-----------|
| Анализ работает, но фронт сломан | SSE-контракт изменился? | Открой DevTools → Network → событийный поток. Проверь что `tableRow`, `step`, `text`, `sources` приходят. Если нет — git revert на тэг. |
| Анализ занимает >60с | Phase 3 буксует ИЛИ verifier'ы тормозят | Telemetry → `Phase3_Splitter_Total` (norm: 2-5с) и `Pinecone Search Avg` (norm: <1с). |
| `tier1_hits: 0%` стабильно | 3.1 Flash Lite недоступна на аккаунте | Снижай Primary до 2.5 Flash прямо в [lib/llmCascade.js](lib/llmCascade.js#L26). |
| `All failed: N > 0` иногда | Транзиентный сбой (норма) | Окей если редко (<5% запросов). Часто → проверить квоты ключей. |
| Cache miss на повторном анализе | `hashPrefix` отличается между upload и analyze | Открой логи, сравни `hashPrefix` в `upload-doc-shadow-start` и `analyze-doc-pipeline` той же сессии. |
| `segment_hard_split_warnings > 0` часто | OCR-сканы в проде | Расширь регексп маркеров в [lib/segmentRegex.js](lib/segmentRegex.js#L42) либо добавь pre-OCR этап. |
| Фронт показывает "Переход в режим базового анализа" | Phase 3 каскад полностью лёг | Норма единично. Если массово → проверить статус Gemini API + квоты DeepSeek. |

---

## 6. Тест-кейсы для прогона

Минимум 5 разных типов документа для уверенности:

1. **Договор аренды** (15-25 пунктов, явные ссылки на ГК КР)
   - Ожидание: 100% Tier 1, 0 hard-split, ~22с
2. **Уголовное постановление** (большой документ с УК/УПК)
   - Ожидание: 30% heavy-path, Selector сработает 2-3 раза, ~35с
3. **Трудовая претензия** (короткий документ, 5-8 пунктов)
   - Ожидание: 1 батч, ~12с, cache hit на повторе → 5с
4. **Кодекс-выдержка** (20+ статей в подряд)
   - Ожидание: много citations, heavy_path > 50%, ~40с
5. **OCR-скан старого договора** (битый текст)
   - Ожидание: `segment_hard_split_warnings > 0`, но анализ доходит до конца

После прогона 5 — сделай скриншот telemetry-репорта последнего и сравни с зонами выше.

---

## 7. Что НЕ делать на проде

- ❌ Не запускать smoke-тесты на проде (`node lib/_smokeTest*.js`) — они для локальной разработки.
- ❌ Не менять `lib/phase3.js` константы (`HEAVY_THRESHOLD_CITATIONS` и т.д.) без замера — может убить latency или точность.
- ❌ Не откатывать только часть фаз — система спроектирована как пакет, частичный откат может оставить битые ссылки.
- ❌ Не править `server.js` без явной причины — он работает, оставь как есть.

---

## 8. Контакт-чек после деплоя

Опубликуй мне эти три снимка после первого прогона на проде:

1. **Один полный telemetry-репорт** (5-15 строк блока) из логов после первого анализа.
2. **Время первого реального анализа** в секундах (как покажет ваш фронт + что в логе `DONE in Xs`).
3. **Скриншот фронта** — приходит ли таблица как раньше, нет ли визуальных багов.

После этого я смогу сказать, надо ли тюнить какие-то константы (батч-размер / timeout'ы / threshold).
