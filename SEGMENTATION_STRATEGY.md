# Hybrid Document Segmentation Strategy
**Версия:** 1.0
**Дата:** 2026-05-29
**Автор:** Senior AI Systems Architect (claude-opus-4-7)
**Цель:** превратить любой кыргызский юридический документ в 15-30 смысловых блоков с lossless-гарантией, не залипая на нестандартной разметке.

---

## 1. Контекст и проблема

### 1.1 Что было
- **v1 (Greedy Merge по `\n\n`)** — работала только на документах с чёткими двойными переносами. Word→TXT экспорт без `\n\n` слипался в 1-3 гигантских блока.
- **v2 (Split-by-markers на каждой строке)** — починила Word→TXT, но дала **64 микро-чанка** на жалобу Аскарова. Каждый буллит `– статья 7 — запрет пыток` стал отдельным чанком, оторванным от вводного `В части МПГПП...:`. Агенты искали `статью 7` в Гражданском кодексе.
- **v3 (Smart Chunking с listMode)** — сейчас даёт 23 чанка на ту же жалобу, lossless ✓. Но всё ещё regex-based — упирается в edge cases на договорах (77 чанков на 14kB шаблон трудового договора) и реквизитных блоках.

### 1.2 Что хочет юрист
> «Система должна *глотать* любой документ, который я кину, превращая его в 15-30 смысловых блоков, без единой потери смысла».

### 1.3 Анализ test_corpus (16 непустых документов)
После фикса LOSSY в Layer A:

| Состояние | Кол-во | Документы |
|-----------|--------|-----------|
| ✅ Идеально (10-30 чанков, lossless) | 11 | Жалобы, претензии, заявления, иски |
| ⚠️ TOO_MANY (60-77 чанков) | 3 | Шаблоны договоров оказания услуг / теплоснабжения / трудовой |
| ⚠️ DOMINANT (топ-3 > 70%) | 1 | Маленькая претензия |
| ⚠️ TOO_FEW (< 5) | 1 | Расписка о займе |

**Top-5 сложных кейсов** (приоритет для Layer B):

1. **Шаблон трудового договора** — 14087 байт, 77 чанков, max=1155. Каждый подпункт `4.2.1`, `4.2.2`... отдельный чанк. Нужно групировать в `4.2 Обязанности работодателя` как один блок.
2. **Шаблон договора теплоснабжения** — 19406 байт, 74 чанка. Та же проблема, плюс длинные пункты с описанием на 1000+ chars.
3. **Шаблон договора оказания услуг** — 11485 байт, 65 чанков. Реквизиты сторон в конце разбиты на 8-10 микро-чанков (`ЗАКАЗЧИК`, `ОсОО ...`, `ИНН ...`, `р/с ...`).
4. **Претензия от ОсОО Бишкектеплосервис** — 1384 байт, 6 чанков, top3Ratio=0.8. Длинный список тире-маркеров `— увеличение суммы долга` / `— возможное начисление штрафных санкций` склеился с интро в один 433ch блок (норма), но шапка адресата + ПРЕТЕНЗИЯ слиплись.
5. **Расписка о получении денежных средств** — 926 байт, 6 чанков. Прочерки `_____________` создают шумные блоки, реальный смысл (займ, сумма, срок) размазан.

### 1.4 Почему чистый regex не справится
Регулярки знают только синтаксис (буллит, маркер, заглавная, длина). Они **не понимают смысл**: что `4.2.1`, `4.2.2`, `4.2.3` все принадлежат разделу `4.2`. Что `ЗАКАЗЧИК / ОсОО / ИНН / р/с / БИК` — это один блок реквизитов одной стороны. Это **семантика**, а не синтаксис.

LLM это понимает. Но запускать LLM на ВЕСЬ документ — дорого (~$0.02 за документ × тысячи документов в месяц) и медленно (~5-15 секунд latency).

Решение: **гибрид**. Regex делает 80% работы быстро (200ms), AI чинит 20% патологий точечно.

---

## 2. Архитектура гибридного сегментатора

```
┌─────────────────────────────────────────────────────────────────┐
│  segmentHybrid(text, deps)                                       │
│  ────────────────────────                                        │
│                                                                  │
│  ┌──────────────┐                                                │
│  │  Layer A     │  segmentDocumentRegex(text)                    │
│  │  (regex)     │  Быстро (200ms), синхронно, lossless ✓         │
│  └──────┬───────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                                │
│  │  Quality     │  assessQuality(chunks, text)                   │
│  │  Assessor    │  → {issues, action: pass|escalate, problemZones}│
│  └──────┬───────┘                                                │
│         │                                                        │
│    ┌────┴────┐                                                   │
│    │         │                                                   │
│  pass     escalate                                               │
│    │         │                                                   │
│    │         ▼                                                   │
│    │  ┌──────────────┐                                           │
│    │  │  Layer B     │  AI corrector (lightLLMCascade)           │
│    │  │  (AI)        │  Работает ТОЛЬКО на problemZones           │
│    │  │              │  Lossless-guard: reject если loss > 5%    │
│    │  └──────┬───────┘                                           │
│    │         │                                                   │
│    │      success?                                               │
│    │      ┌──┴──┐                                                │
│    │     yes    no (cascade all-failed / lossy response)         │
│    │      │     │                                                │
│    │      │     fallback на Layer A                              │
│    │      ▼     ▼                                                │
│    └──→ merge results                                            │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                                │
│  │  Layer C     │  (extension point — пока пусто)                │
│  │  (future)    │  Идея: doc-type aware reranking,               │
│  │              │  TipTap-aware ide split, и т.д.                │
│  └──────────────┘                                                │
│                                                                  │
│  Return: { chunks, layers, quality, telemetry }                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 Layer A — Regex Smart Chunking (фундамент)

**Модуль:** `lib/segmentRegex.js` (уже работает, версия v3).
**Контракт:** `segmentDocumentRegex(text, opts) → string[]`.
**Гарантии:**
- Синхронно, без сетевых вызовов.
- Lossless: сумма не-whitespace символов на выходе == входе.
- Цепочки headings (Дата → Подпись → Печать) сохраняются через `flushPendingHeading()`.
- Intro:list pairs склеиваются (`...нарушения:` + 5 буллетов = 1 чанк).
- Section headings становятся prefix следующего параграфа.
- Subheading-склейка: `1. Предмет договора.` тащит следующий параграф.

**Когда достаточно:** документы с чётким маркером структуры (жалобы, иски, претензии, заявления). Целевой случай: жалоба Аскарова → 23 чанка ✓.

**Где ломается:** длинные шаблоны договоров с глубокой вложенностью (`4.2.1.3`), реквизитные блоки в конце документа (8+ микро-строк).

### 2.2 Quality Assessor — детерминированный gatekeeper

**Функция:** `assessQuality(chunks, text) → { issues, action, problemZones, metrics }`.

**Метрики:**
```javascript
{
  totalChunks: 23,
  totalBytes: 8171,
  avgChunkLen: 351,
  maxChunkLen: 910,
  minChunkLen: 56,
  top3Ratio: 0.27,           // доля контента в топ-3 чанков
  loss: 0,                    // raw - chunks (без whitespace)
  density: 23 / 8171 * 1000   // чанков на kB
}
```

**Триггеры (с приоритетом):**

| Issue | Условие | Приоритет | Action |
|-------|---------|-----------|--------|
| `LOSSY` | `loss > 0` | 🔴 critical | escalate full doc (Layer A потерял) |
| `GIANT_CHUNK` | любой `chunk.length > 2500` | 🟠 high | escalate этот chunk |
| `TOO_MANY_SMALL` | `totalChunks > 50 && avgChunkLen < 200` | 🟡 medium | escalate группы мелких соседей |
| `DOMINANT_CHUNK` | `chunk.length / totalText > 0.5` | 🟡 medium | escalate этот chunk |
| `TOO_FEW` | `totalChunks < 5 && totalBytes > 2000` | 🟡 medium | escalate full doc |

**Когда `action = 'pass'`:** ни один триггер не сработал. Layer B не вызывается. Latency = 200ms.

**Когда `action = 'escalate'`:** есть problem zones. Layer B зовётся точечно.

### 2.3 Layer B — AI Corrector

**Модель:** `lightLLMCascade` (Gemini 3.1 Flash Lite → 2.5 Flash → DeepSeek V4 Flash). Per-attempt timeout, graceful degradation.

**Промпт:**
```
SYSTEM:
Ты — Senior юрист Кыргызской Республики. Разбей текст на смысловые
блоки по правилам юридической структуры:

1. ОДНА смысловая единица = ОДИН блок (норма, пункт договора, тезис).
2. intro:list (текст заканчивается на ":") + список — В ОДНОМ блоке.
3. Разные статьи разных НПА — В РАЗНЫХ блоках.
4. Реквизиты ОДНОЙ стороны (ЗАКАЗЧИК + ОсОО + ИНН + р/с + БИК) — В ОДНОМ блоке.
5. Подписи / даты / печати — каждое отдельно.
6. Целевой размер 200-800 символов на блок.
7. ВАЖНО: НИ ОДНОГО символа не теряй. Если копируешь — копируй буквально.

Верни СТРОГО JSON: {"chunks": ["text1", "text2", ...]}

USER:
{fragment}
```

**Контракт:**
- Input: фрагмент текста (один проблемный chunk либо весь документ).
- Output: `string[]` (массив новых чанков).
- Timeout: 10/15/20s per tier.

**Lossless-guard (двухуровневый):**

```javascript
const inputNW = input.replace(/\s/g, '').length;
const outputNW = output.join('').replace(/\s/g, '').length;
const lossRatio = Math.abs(inputNW - outputNW) / inputNW;

if (lossRatio > 0.05) {
    throw new LayerBLossyError(lossRatio);
}
```

Если LLM что-то добавил/удалил > 5% — отвергаем результат, fallback на Layer A.

**Где Layer B используется:**

- `LOSSY` / `TOO_FEW` → весь документ на rebuild.
- `GIANT_CHUNK` / `DOMINANT_CHUNK` → этот конкретный chunk на rebuild, остальные сохраняются.
- `TOO_MANY_SMALL` → группы по `K=10` соседних мелких чанков склеиваются в текст и rebuild.

### 2.4 Layer C — Extension Point (будущее)

Архитектура спроектирована так, чтобы Layer C добавлялся БЕЗ перекраивания Layer A/B:

```javascript
const stages = [
    { name: 'A', run: layerARegex,    sync: true },
    { name: 'B', run: layerBAI,       async: true, condition: q => q.action === 'escalate' },
    // Слот для C:
    // { name: 'C', run: layerCDocTypeAware, async: true, condition: q => q.docType === 'contract' }
];
```

**Идеи для Layer C:**
- **Doc-type aware reranking**: после Layer A/B классифицируем (договор / жалоба / иск) через Gemini Flash и применяем doc-type specific merge rules.
- **TipTap-aware split**: если документ из IDE с TipTap-разметкой — используем `<p>`, `<h1>` теги как авторитативные boundaries.
- **Reflection pass**: второй проход LLM, который оценивает результат и предлагает мержи / сплиты.

### 2.5 Telemetry

Каждый запуск возвращает:
```javascript
{
  chunks: [...],
  layers: ['A'] | ['A', 'B'] | ['A', 'B', 'fallback'],
  quality: { issues, metrics, action, problemZones },
  durations: { layerAMs, layerBMs, totalMs },
  layerB: {
      called: true | false,
      attempts: [{ tier, model, durationMs, status, errorKind }],
      lossRatio: 0.02,
      success: true | false,
      fallbackReason: 'lossy_response' | 'cascade_failed' | null
  }
}
```

Это позволит мониторить:
- Доля документов где B вызвался (target: <30%, иначе пересматриваем Layer A триггеры).
- Median Layer B latency (target: <3s).
- Layer B reject rate (target: <5%).

---

## 3. Что НЕ входит в стратегию

### Не нужно делать
- **Полная замена Layer A на AI**. Layer A работает на 11/16 документов корпуса. Замена удвоит cost и latency.
- **Гибрид через voting** (запускать оба, выбрать лучший). Дорого без выгоды.
- **Streaming chunks**. Это batch API; SSE-стрим уже работает через `routes/analyze.js` на уровне выше.
- **Сохранение position offsets** (start/end в исходнике). Текущие потребители (`runTriage`, `verifySegmentsSmart`) не используют. Можно добавить позже если будет нужно для UI highlight.

### Чего избегаем
- Жёстко **не менять**: SSE-контракт фронта (`tableRow`, `safe_triage_segment`, etc.), `wrapAsAnalyzeSegments` контракт (`{id, number, heading, text}` с `number = String(i+1)`).
- Не трогаем `server.js`, `.env`, `scripts/seed.js`.

---

## 4. Контракт API

```javascript
const { createHybridSegmenter } = require('./lib/hybridSegmenter');

// Инициализация (один раз, в startup)
const hybridSegmenter = createHybridSegmenter({
    cascade: lightCascade,  // от createLightLLMCascade
    logger: console,
    telemetry: telemetryStub,
    layerBEnabled: process.env.HYBRID_LAYER_B !== 'off',
    layerBTimeouts: [10000, 15000, 20000],  // override per-tier
    qualityThresholds: {                     // override триггеры
        giantChunkChars: 2500,
        tooManySmallCount: 50,
        tooManySmallAvg: 200,
        dominantRatio: 0.5,
        tooFewCount: 5,
        tooFewMinBytes: 2000,
        lossyTolerance: 0
    }
});

// Использование (в analyze.js, асинхронно)
const result = await hybridSegmenter.segment(text, {
    docType: 'complaint',  // hint для Layer B/C, optional
    stageLabel: 'analyze_doc_segments'
});

// result:
// {
//   chunks: ["chunk 1", "chunk 2", ...],
//   layers: ['A', 'B'],
//   quality: { issues, metrics, action, problemZones },
//   durations: { layerAMs, layerBMs, totalMs },
//   layerB: { called, attempts, lossRatio, success, fallbackReason }
// }
```

---

## 5. План внедрения

### Этап 1 (этот PR)
- ✅ Layer A lossless fix (уже в `segmentRegex.js`).
- 🔄 `lib/hybridSegmenter.js` с Layer A + Quality Assessor + Layer B + DI factory.
- 🔄 `lib/_smokeTestHybrid.js` с error-tracker → `segmentation_errors.json`.
- 🔄 Документация (этот файл).

### Этап 2 (после прод-теста)
- Интеграция в `routes/analyze.js` через `preparePipelineState`. Замена прямого вызова `segmentDocumentRegex` на `hybridSegmenter.segment()`. SSE-событие `step` с `text='Сегментация (гибрид)...'`.
- Telemetry-секция `hybrid` в `routes/analyze.js`-собираемом отчёте.

### Этап 3 (по результатам)
- Если Layer B reject rate > 5% → тюнинг промпта (более жёсткие правила копирования).
- Если Layer B вызывается > 30% документов → пересматриваем триггеры (возможно слишком чувствительны).
- Если нужны новые типы документов (рукописные расписки от ML-OCR) → Layer C.

---

## 6. Открытые вопросы для будущего обсуждения

1. **Кэширование Layer B**. Хешировать problemZone'у и кэшировать ответ LLM — те же шаблоны договоров будут переанализированы тысячу раз. Возможна экономия 80% Layer B бюджета. Подумать после прод-теста.
2. **doc-type detection**. Сейчас `docType` — это hint от вызывающего кода (опционально). Можно добавить автоматический детектор на основе шапки документа.
3. **partial AI**. Сейчас Layer B либо принимает весь зон, либо отвергает. Можно реализовать "AI suggested splits для отдельных границ" — micro-Layer B.

---

## 7. Acceptance criteria

Перед мержем этой архитектуры в продакшен:

- [ ] `lib/_smokeTestHybrid.js` зелёный.
- [ ] Прогон по `test_corpus/` — 100% документов получают 10-35 чанков (target window). Текущие 11/16 → должно стать 16/16.
- [ ] Lossless invariant: 0 потерянных символов на корпусе.
- [ ] Layer B call rate < 50% (для нашего корпуса с большим количеством шаблонов).
- [ ] Median Layer B latency < 5s.
- [ ] Все 59 текущих regression тестов `_smokeTestSegmentRegex.js` остаются зелёными.
- [ ] `segmentation_errors.json` после прогона корпуса — пустой массив `[]`.
