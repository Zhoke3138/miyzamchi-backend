# Agent Dispatcher Redesign
**Версия:** 1.0
**Дата:** 2026-05-30
**Цель:** убрать RAG-галлюцинации через Global Context Injection + увеличить throughput Verifier'ов через Smooth Burst Throttle (20 RPS).

---

## 1. Две корневые проблемы

### 1.1 RAG-галлюцинации из-за «амнезии» микро-чанков

**Что происходит сейчас:**

В `routes/analyze.js:676` функция `runVerifierAgent` получает chunk вида `"– статья 7 — запрет пыток"` (после Smart Chunking v3 это уже не отдельный микро-чанк, а часть intro:list блока — но в части кодовых путей сегмент всё ещё может быть короткий пункт жалобы вида «Часть 4, статьи 56 Конституции КР устанавливает запрет на пытки»).

Затем в кодовом пути `targetType === 'article'`:
```javascript
const ctxPrefix = docContextStr ? `[Контекст: ${docContextStr.slice(0, 150)}] ` : '';
const q = `Статья ${targetArticle.number} ${targetArticle.act} ` + textHead;
const v = await getEmbedding(ctxPrefix + q);
```

`docContextStr.slice(0, 150)` — это **слабый сигнал**: первые 150 символов паспорта документа, без разметки/иерархии. Embedding выглядит так:
```
[Контекст: Жалоба заявителя в Комитет ООН по правам человека о пытках в местах лишения свободы, статья 22 Конвенции против пыток (далее...] Статья 7 Жестокое обращение Применительно к Конвенции...
```

Это даёт Pinecone подсказку, но не **жёстко** ограничивает отрасль. Если в нашей БД есть «Закон о рекламе» с «Статья 7. Недобросовестная реклама», embedding-сходство по «статья 7» может затащить эту статью в топ-K. Дальше LLM-агент видит её в RAG-контексте и пишет: «Найдена статья 7 Закона о рекламе, нарушений нет».

**Фрагмент промпта агента уже пытается отфильтровать**:
> «Если найденные статьи относятся к ДРУГОЙ отрасли → status="warning" и поясни почему.»

Но это «костыль на стороне ответа» — мы уже потратили Pinecone-вызов и токены агента, а потом просим его признаться что ответ мусорный. Лучше **не доводить до этого**: добавлять контекст так, чтобы Pinecone сам отдавал нужную отрасль в первую очередь.

### 1.2 Underutilization throughput'а

Текущий `runWithConcurrency` (analyze.js:214) — это **пул из N воркеров**, не блокирующий Promise.all. Это уже правильный паттерн. Но `SEGMENTS_CONCURRENCY = 16` × `HOUNDS_PER_SEG_CONCURRENCY = 3` = до 48 параллельных агентов. На практике каждый агент ждёт Pinecone (50-100ms) + Gemini (1500-3000ms) ≈ 3 секунды.

**Реальный throughput:** `48 / 3s ≈ 16 RPS` на пике, но обычно меньше (segments concurrency=16 — это segments, не agents).

**Лимит Gemini 3.1 Flash Lite:** 4000 RPM = **66 RPS**. Мы используем меньше **25% capacity**.

Хуже того: модель «N воркеров пуллят» создаёт **burst-кластеры**. Когда все 16 одновременно дождались Gemini ответа, они одновременно отправляют 16 новых запросов → 16 запросов в одну миллисекунду. Это поведение Google может пометить как DDoS-pattern. Сейчас спасает то, что Gemini-ответы приходят не синхронно, но всё равно нет защиты.

**Что хотим:**
- Жёстко 20 RPS (потолок снизу от 66 — оставляем headroom для Tier 2/3 cascade fallback'ов).
- Между запусками — фиксированные **50ms** (1000/20), без burst в одну ms.
- Streaming: caller получает первый ответ как только он готов, не ждёт остальных в батче.

---

## 2. Архитектура (3 модуля)

```
┌────────────────────────────────────────────────────────────────┐
│  routes/analyze.js (не трогаем сейчас, только future PR)        │
│                                                                  │
│   verifySegmentsSmart(...)                                       │
│      └→ agentDispatcher.dispatch(tasks, { onResult, ... })       │
│             │                                                    │
│             ▼                                                    │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  lib/agentDispatcher.js (главный композитор)            │    │
│   │  ──────────────────────                                  │    │
│   │  dispatch(tasks, deps) — для каждой task:               │    │
│   │     1. wrap task через injectGlobalContext(docContext)  │    │
│   │     2. throttle.submit(() => taskRunner(wrappedTask))   │    │
│   │     3. on resolve → onResult({i, result})               │    │
│   │     4. on reject → onResult({i, error})                 │    │
│   │  await throttle.drain()                                  │    │
│   └────┬─────────────────────────┬───────────────────────────┘   │
│        │                         │                              │
│        ▼                         ▼                              │
│   ┌────────────────┐    ┌──────────────────────────┐            │
│   │ lib/global     │    │ lib/smoothBurstThrottle  │            │
│   │   Context.js   │    │  (20 RPS, 50ms tick,     │            │
│   │ ────────────── │    │   maxConcurrent=100,     │            │
│   │ inject(...)    │    │   drift-corrected)       │            │
│   │ buildSystem... │    └──────────────────────────┘            │
│   └────────────────┘                                            │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 `lib/smoothBurstThrottle.js` — очередь

**Концепция:** один tick каждые `intervalMs = 1000 / rps` ms. На каждом tick'е — старт ОДНОЙ задачи (если есть в очереди и есть free slot в maxConcurrent).

**Drift correction:** не используем `setInterval` (накапливает задержку при загруженном event-loop). Используем relative `setTimeout`:
```javascript
let nextAt = performance.now();
function scheduleNext() {
    nextAt += intervalMs;
    const delay = Math.max(0, nextAt - performance.now());
    setTimeout(() => { tick(); scheduleNext(); }, delay);
}
```

**API:**
```javascript
const throttle = createSmoothBurstThrottle({
    rps: 20,                  // запусков/сек (по умолчанию 20)
    maxConcurrent: 100,       // hard cap по live-задачам (защита если упал Gemini и зависли)
    logger: console
});

// Submit returns a promise that resolves когда задача завершилась.
const promise = throttle.submit(async () => {
    return await someAsyncWork();
});

// Drain: ждём пока все queued + active завершатся.
await throttle.drain();

// Stats:
throttle.stats();   // { queued, active, totalLaunched, totalCompleted, totalErrors }

// Stop (для graceful shutdown).
throttle.stop();
```

**Контракты:**
- Submit всегда returns Promise. Caller может делать `.then()/.catch()` сразу.
- Throttle гарантирует **минимум** 50ms между стартами. Может быть больше, если все слоты заняты (maxConcurrent reached) или queue пуст.
- При `submit()` с пустой очередью и idle timer — таймер просыпается мгновенно (первый tick сразу).
- Drain никогда не throws — он просто ждёт когда `queued + active = 0`.
- При `stop()` — все pending promises резолвятся с `{stopped: true}` либо реджектятся (опция). По умолчанию rejected.

**Edge cases:**
- maxConcurrent reached → tick пропускает запуск, ждёт следующего.
- Submit после stop → reject `Error('Throttle stopped')`.
- task throws → промис reject, slot освобождается, totalErrors++.

### 2.2 `lib/globalContext.js` — context injection helpers

**Концепция:** «паспорт документа» — это структурированный объект, который Phase 1 (`extractDocumentContext`) уже строит. Мы формализуем его shape и даём 2 функции для подмешивания.

**Shape:**
```typescript
type DocumentContext = {
    summary: string;       // 1-2 предложения "Жалоба в Комитет ООН против пыток"
    docType?: string;      // 'complaint' | 'contract' | 'lawsuit' | ...
    branchHint?: string;   // 'criminal' | 'civil' | 'administrative' | ...
    npaHints?: string[];   // ['Конвенция против пыток', 'МПГПП', 'Конституция КР']
}
```

**Функция 1: для embedding/Pinecone**
```javascript
function injectGlobalContext(text, docContext) {
    if (!docContext || !docContext.summary) return text;
    return `[Контекст документа: ${docContext.summary}] ${text}`;
}
```

Это сильно поднимает вес паспорта в embedding. Embedding модель (768d Gemini) сходство считает по всему тексту, и при сложении «жалоба в ООН против пыток» в начале вектор сдвигается в сторону «уголовное право, права человека», а не «реклама».

**Функция 2: для system prompt агента**
```javascript
function buildContextualSystemPrompt(basePrompt, docContext) {
    if (!docContext) return basePrompt;
    const parts = [];
    parts.push(`🔴 ТИП ДОКУМЕНТА: ${docContext.summary}`);
    if (docContext.branchHint) {
        parts.push(`🔴 ОТРАСЛЬ ПРАВА: ${docContext.branchHint}.`);
        parts.push(`Если в RAG-результатах попали НПА из ДРУГОЙ отрасли — это false positive: status="warning", в rationale явно укажи что отрасль не та.`);
    }
    if (docContext.npaHints?.length) {
        parts.push(`🟢 ОЖИДАЕМЫЕ НПА: ${docContext.npaHints.join(', ')}.`);
    }
    return parts.join('\n') + '\n\n' + basePrompt;
}
```

**Lossless prompt:** если docContext отсутствует — возвращаем basePrompt как есть. Это гарантирует обратную совместимость с местами где Phase 1 ещё не вычислил паспорт.

### 2.3 `lib/agentDispatcher.js` — главный композитор

**Концепция:** связывает globalContext + throttle + task runner в единый `dispatch()`. Caller передаёт массив задач и опционально `onResult` callback (для streaming в SSE). Возвращает массив результатов в исходном порядке (для случаев когда порядок важен).

**API:**
```javascript
const dispatcher = createAgentDispatcher({
    throttle: smoothBurstThrottle,    // от createSmoothBurstThrottle
    runVerifierAgent,                  // существующая функция из routes/analyze.js
    getEmbedding,                      // существующая
    searchPinecone,                    // существующая
    logger: console
});

const results = await dispatcher.dispatch(tasks, {
    docContext: {
        summary: 'Жалоба в Комитет ООН против пыток',
        branchHint: 'criminal / human rights',
        npaHints: ['Конвенция против пыток', 'МПГПП', 'Конституция КР']
    },
    aborted: { value: false },
    telemetry,
    onResult: ({ index, task, result, error, durationMs }) => {
        // SSE-стрим: отдать результат как только готов
        emitTableRow(index, result);
    }
});
// results[i] = { result?, error? } — индексы соответствуют tasks[i]
```

**Контракт:**
- Caller получает результаты в порядке tasks[] (через массив `results`).
- НО `onResult` callback срабатывает в порядке **завершения**, не запуска. Это позволяет стримить fastest-first.
- Если task throws — попадает в `results[i].error`, НЕ в общий reject. Один сбойный task не валит весь dispatch.
- При `aborted.value = true` — все pending tasks резолвятся с `{aborted: true}` без вызова runner'а.

**Глобально применяемая инъекция контекста:**
- Pinecone embedding — через `injectGlobalContext(text, docContext)`.
- System prompt — через `buildContextualSystemPrompt(basePrompt, docContext)`.

**Применение throttle:**
Каждый task оборачивается в `throttle.submit(() => taskRunner(task))`. Внутренний runner:
```javascript
async function taskRunner(task, index) {
    const t0 = performance.now();
    try {
        const result = await runVerifierAgent(
            task,
            docContext,           // полный объект, не строка
            task.segmentRef,
            task.metaContext,
            aborted,
            telemetry
        );
        const durationMs = performance.now() - t0;
        onResult?.({ index, task, result, durationMs });
        return { result, durationMs };
    } catch (error) {
        const durationMs = performance.now() - t0;
        onResult?.({ index, task, error, durationMs });
        return { error: error.message, durationMs };
    }
}
```

---

## 3. Интеграция в `routes/analyze.js` (БУДУЩИЙ PR, не сейчас)

Этот раздел — спецификация для будущего PR с согласия пользователя.

**Изменения:**

1. **`runVerifierAgent` сигнатура**: добавить параметр `docContext` (объект, не строка). Внутри использовать `injectGlobalContext(textHead, docContext)` для embedding и `buildContextualSystemPrompt(systemPrompt, docContext)` для агента.

2. **`extractDocumentContext`**: возвращает объект `{summary, docType, branchHint, npaHints}` вместо строки. Phase 1 LLM-промпт расширить чтобы возвращал эти поля.

3. **`verifySegmentsSmart`**:
   ```javascript
   // Старый код:
   const results = await runWithConcurrency(segmentsWithIdx, SEGMENTS_CONCURRENCY, processSegment, { aborted });
   // Новый код:
   const results = await dispatcher.dispatch(tasks, {
       docContext,
       aborted, telemetry,
       onResult: ({ index, result }) => {
           // SSE-стрим как сейчас, но fastest-first
           emitTableRow(index, result);
       }
   });
   ```

4. **Telemetry**: добавить секцию `throttle`:
   ```json
   "throttle": {
       "rps_target": 20,
       "rps_actual": 18.5,
       "queued_peak": 47,
       "active_peak": 31,
       "total_launched": 71,
       "total_errors": 2
   }
   ```

5. **Backwards-compat**: пока `dispatcher` опциональный. Если не передан — fallback на `runWithConcurrency`.

---

## 4. Что НЕ делаем сейчас

- ❌ Не трогаем `routes/analyze.js`. Пользователь явно сказал «интеграцию пока ставим на паузу».
- ❌ Не добавляем npm-зависимости (`bottleneck`, `p-throttle`). Кастомная реализация лёгкая (~80 LOC), прозрачнее, тестируется на fake timers.
- ❌ Не реализуем backpressure (queue.length > N → отказ от submit). Можно добавить позже одной строкой если будет нужно.
- ❌ Не меняем `extractDocumentContext` (это Phase 1 в analyze.js). Сейчас даём только helpers + контракт shape.

---

## 5. Acceptance criteria

- [ ] `lib/smoothBurstThrottle.js` — кастомная очередь, drift correction.
- [ ] `lib/globalContext.js` — две функции, lossless prompt fallback.
- [ ] `lib/agentDispatcher.js` — композитор с `dispatch(tasks, opts)` и `onResult` callback.
- [ ] `lib/_smokeTestSmoothBurst.js` — тесты throughput, drain, stop, edge cases.
- [ ] `lib/_smokeTestAgentDispatcher.js` — тесты injection + streaming + abort + ошибки.
- [ ] Все 212 предыдущих регресс-тестов остаются зелёные.
- [ ] **Throughput тест:** 100 mock-tasks по 200ms → завершаются за ~5 секунд (100/20=5s + drain ≈ 5.2s).
- [ ] **Smooth тест:** 20 tasks стартуют с интервалом ≥ 45ms (5ms допуск на drift), НЕ в одну ms.

---

## 6. Открытые вопросы (для будущей синхронизации)

1. **Глобальный throttle или per-tier?** Сейчас Gemini Lite Tier 1 = 4000 RPM, Tier 2 (2.5 Flash) = 1500 RPM, DeepSeek = разные лимиты. Один глобальный 20 RPS подходит для Tier 1, но если каскад уйдёт в Tier 3 (DeepSeek), там лимиты другие. Решение: пока один throttle общий, в будущем — per-tier через несколько throttle инстансов.
2. **Adaptive RPS на основе 429 errors.** Если Gemini вернул 429 «rate limit» → автоматически уменьшить RPS на 25% и восстановить через 30 сек. Сейчас не делаем, можно добавить как фичу в throttle.
3. **Persistent docContext через сессию.** Сейчас docContext вычисляется на каждый /api/analyze-document. Можно кэшировать по `sessionId` (уже есть shadow pipeline). Это вне scope диспетчера — это вопрос к `preparePipelineState`.
