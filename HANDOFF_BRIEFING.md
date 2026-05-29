# Handoff Briefing — Мыйзамчы (Selective Reasoning v2.0)

> Скопируй ВСЁ ниже в первое сообщение нового чата. Это даст AI полный контекст без необходимости перечитывать историю.

---

Привет. Я — юрист (НЕ программист), деплою через GitHub веб-интерфейс на Render. Проект **Мыйзамчы** — кыргызский юридический AI-ассистент. Юрист загружает документ → система ищет противоречия с НПА КР через RAG (Pinecone) + мультиагентный аудит.

## Текущее состояние: Selective Reasoning v2.0 в проде (май 2026)

Только что закончили большой рефакторинг `/api/analyze-document` (4 фазы):

- **Phase 1**: `normalizeText()` — CRLF + whitespace нормализация до hash. Фикс cache-hit между Shadow Pipeline и /analyze.
- **Phase 2**: `segmentDocumentRegex()` — синхронная regex-сегментация. Заменила LLM-сегментацию (63с → 10мс).
- **Phase 3**: `phase3Pipeline` — Batched Issue Splitter + Adaptive RAG. Каскад Gemini 3.1 Lite → 2.5 Flash → DeepSeek V4 Flash с per-attempt timeout (10/15/20s). Извлекает точные citations, делает Pinecone-запросы (simple TOP_K=1 или heavy 15→selector→5).
- **Phase 4**: интеграция Phase 3 в legacy verifier-pool через `preFetchedArticles`. Ищейки получают готовые статьи вместо собственного Pinecone-поиска.

## Стек
- Node.js / Express (server.js, routes/analyze.js, routes/compare.js)
- Pinecone (768d, metadata keys: `full_text`, `npa_title`, `article_title`)
- LLM: DeepSeek V4 Flash (primary для агентов) + Gemini 2.5/3.1 (fallback и cascade)
- Frontend: HTML/CSS/JS + IDE на TipTap

## Новые файлы (всё уже задеплоено)
- `lib/llmCascade.js` — каскад с graceful degradation
- `lib/segmentRegex.js` — regex-сегментатор + `wrapAsAnalyzeSegments` адаптер
- `lib/npaAliases.js` — 15 канонических НПА + `normalizeNpaName()`
- `lib/phase3.js` — Splitter + Adaptive RAG, factory pattern с DI
- `lib/_smokeTest*.js` — регрессионные тесты (98+ passing)

## Что трогать НЕЛЬЗЯ
- `.env`, `scripts/seed.js` — абсолютный запрет
- `server.js`, `script.js` — только с моего явного согласия (бэкенд работает, не ломать)
- SSE-контракт: `step`, `tableRow`, `text`, `safe_triage_segment`, `sources`, `metadata`, `purityIndex`, `telemetry`, `[DONE]` — фронт зависит от формата

## Боевые результаты
- Жалоба в Комитет ООН (7 пунктов): **19.8с**, поймали 2 реальных бага в Конституции КР
- Договор теплоснабжения (71 пункт, cold start): **100с**. Тяжёлый кейс. Каскад реально включил Tier 2/3 fallback и спас batch.

## Открытые задачи (по убыванию ROI)
1. **Проверить UX-fix `wrapAsAnalyzeSegments` на проде** — должны быть `п.1, п.2, ..., п.N` без дублей. Если в таблице "п.1" повторяется — Render не подхватил коммит.
2. **Параллельный Triage + Phase 3** в `preparePipelineState` — экономия 15-20с cold start.
3. **Smart-skip Phase 3** на документах без явных "ст. N" (regex pre-check) — экономия 24с на коммерческих договорах.
4. **CJK-фильтр** для Final Judge — DeepSeek иногда вставляет китайские иероглифы (`合同中` вместо "в договоре"). 5-строк правки в server.js.
5. **Test corpus** — собираю папку `test_corpus/` с шаблонами реальных кыргызских документов в TXT. После сбора — тюнинг marker regex, smart-skip эвристик, словаря НПА, Splitter-промпта на реальных данных.

## Документация в репо
- `CLAUDE.md` — полный контекст проекта (грузится автоматически)
- `REFACTOR_ROADMAP.md` — чек-лист всех 5 фаз с design decisions
- `DEPLOY_AND_TEST_CHECKLIST.md` — деплой, prod-тесты, имитация падения каскада, расшифровка telemetry

## Прошу
Прочитай `CLAUDE.md` и `REFACTOR_ROADMAP.md` для полного контекста. Не предлагай переход на ESM, TypeScript или смену моделей LLM — всё фиксировано. Жду конкретное ТЗ.
