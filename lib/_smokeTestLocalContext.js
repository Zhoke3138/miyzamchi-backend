// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestLocalContext.js
//  Smoke-test для lib/localContext.js (sticky section + npa).
//  Запуск: node lib/_smokeTestLocalContext.js
// ═══════════════════════════════════════════════════════════════════════

const {
    extractSectionHeading,
    extractNpaMentions,
    buildChunkContexts,
    injectLocalContext,
    buildLocalContextBlock
} = require('./localContext');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

console.log('=== TEST 1: extractSectionHeading ===');
{
    // Heading: короткое, no terminal, upper, ≤10 words, no colon, не цифра/буллит
    assert(extractSectionHeading('Нарушения Конституции КР') === 'Нарушения Конституции КР',
        'короткий heading распознан');
    assert(extractSectionHeading('Нарушения Конституции КР\nЧасть 4, статьи 56 ...') === 'Нарушения Конституции КР',
        'heading из первой строки многострочного чанка');
    assert(extractSectionHeading('1. Предмет договора.') === null,
        'начинается с цифры — не heading');
    assert(extractSectionHeading('Заявитель: Иванов И.И.') === null,
        'содержит ":" — paragraph, не heading');
    assert(extractSectionHeading('Это длинная преамбула с точкой в конце.') === null,
        'есть терминатор — не heading');
    assert(extractSectionHeading('– статья 1 — запрет пыток') === null,
        'буллит — не heading');
    assert(extractSectionHeading('') === null, 'пустая строка → null');
    assert(extractSectionHeading(null) === null, 'null → null');
}

console.log('\n=== TEST 2: extractNpaMentions — материальные кодексы ===');
{
    const uk = extractNpaMentions('Часть 2 статьи 9 УК КР закрепляет принцип');
    assert(uk.includes('Уголовный кодекс КР'), 'УК КР найден');
    const gk = extractNpaMentions('согласно статье 222 Гражданского кодекса Кыргызской Республики');
    assert(gk.includes('Гражданский кодекс КР'), 'Гражданский кодекс КР найден');
    const tk = extractNpaMentions('по Трудовому кодексу');
    assert(tk.includes('Трудовой кодекс КР'), 'Трудовой кодекс найден');
}

console.log('\n=== TEST 3: extractNpaMentions — процессуальные приоритетнее материальных ===');
{
    // "Уголовно-процессуального кодекса" НЕ должно матчиться сначала на "Уголовного кодекса"
    const upk = extractNpaMentions('статья 50 Уголовно-процессуального кодекса КР');
    assert(upk.includes('УПК КР'), 'УПК распознан');
    assert(!upk.includes('Уголовный кодекс КР'), 'УК НЕ false-positive на УПК-тексте');
    const gpk = extractNpaMentions('статья 12 Гражданского процессуального кодекса');
    assert(gpk.includes('ГПК КР'), 'ГПК распознан');
}

console.log('\n=== TEST 4: extractNpaMentions — Конституция и международные акты ===');
{
    const konst = extractNpaMentions('Часть 4, статьи 56 Конституции Кыргызской Республики');
    assert(konst.includes('Конституция КР'), 'Конституция КР найдена');
    const conv = extractNpaMentions('статья 1 Конвенции против пыток');
    assert(conv.includes('Конвенция против пыток (ООН)'), 'Конвенция против пыток найдена');
    const mp = extractNpaMentions('статья 7 Международного пакта о гражданских и политических правах');
    assert(mp.includes('МПГПП'), 'МПГПП найден');
}

console.log('\n=== TEST 5: extractNpaMentions — пустой/мусорный вход ===');
{
    assert(extractNpaMentions('').length === 0, 'пустая строка → []');
    assert(extractNpaMentions(null).length === 0, 'null → []');
    assert(extractNpaMentions('просто текст без НПА').length === 0,
        'текст без упоминаний → []');
}

console.log('\n=== TEST 6: buildChunkContexts — sticky section ===');
{
    const chunks = [
        'Преамбула документа без специальных маркеров.',
        'Нарушения Конституции КР\nЧасть 4, статьи 56 устанавливает запрет на пытки.',
        'Часть 5, статьи 56 гарантирует гуманное обращение.',
        'Часть 1, статьи 61 гарантирует право на судебную защиту.'
    ];
    const ctxs = buildChunkContexts(chunks);
    assert(ctxs.length === 4, '4 контекста на 4 чанка');
    assert(ctxs[0].section === null, 'чанк 0: section=null (нет heading)');
    assert(ctxs[1].section === 'Нарушения Конституции КР', 'чанк 1: section распознан');
    assert(ctxs[2].section === 'Нарушения Конституции КР',
        'чанк 2: section STICKY унаследован');
    assert(ctxs[3].section === 'Нарушения Конституции КР',
        'чанк 3: section всё ещё унаследован');
}

console.log('\n=== TEST 7: buildChunkContexts — sticky npa наследуется через orphan chunks ===');
{
    const chunks = [
        'По Уголовному кодексу КР: государство уклонилось от расследования.',
        'Часть 2 статьи 9 УК КР закрепляет принцип гуманизма.',
        // ⚠️ Orphan chunk: "статья 137" БЕЗ упоминания кодекса — должна наследовать УК
        'В частности, статья 137 криминализирует пытки.',
        'Статья 191 относится к незаконному задержанию.'
    ];
    const ctxs = buildChunkContexts(chunks);
    assert(ctxs[0].npa === 'Уголовный кодекс КР', 'чанк 0: УК распознан');
    assert(ctxs[1].npa === 'Уголовный кодекс КР', 'чанк 1: УК подтверждён');
    assert(ctxs[2].npa === 'Уголовный кодекс КР',
        '⭐ orphan chunk: статья 137 наследует УК (не дрейфует в Воздушный кодекс)');
    assert(ctxs[3].npa === 'Уголовный кодекс КР',
        '⭐ orphan chunk: статья 191 тоже наследует УК');
}

console.log('\n=== TEST 8: buildChunkContexts — переключение npa между разделами ===');
{
    const chunks = [
        'Нарушения Конституции КР\nЧасть 4, статьи 56 Конституции устанавливает запрет.',
        'Часть 5, статьи 56 гарантирует гуманное обращение.',
        'Нарушения УК КР\nЧасть 2 статьи 9 Уголовного кодекса КР закрепляет принцип.',
        'Статья 137 предусматривает наказание.'
    ];
    const ctxs = buildChunkContexts(chunks);
    assert(ctxs[0].npa === 'Конституция КР', 'чанк 0: Конституция');
    assert(ctxs[1].npa === 'Конституция КР', 'чанк 1: Конституция unchanged');
    assert(ctxs[2].npa === 'Уголовный кодекс КР', 'чанк 2: переключились на УК');
    assert(ctxs[3].npa === 'Уголовный кодекс КР', 'чанк 3: УК остаётся (orphan)');
    assert(ctxs[2].section === 'Нарушения УК КР', 'чанк 2: section тоже переключился');
}

console.log('\n=== TEST 9: buildChunkContexts — пустой / мусорный вход ===');
{
    assert(buildChunkContexts([]).length === 0, '[] → []');
    assert(buildChunkContexts(null).length === 0, 'null → []');
    const r = buildChunkContexts(['нормальный', null, undefined, '', 'снова текст']);
    assert(r.length === 5, '5 элементов на мусорный вход');
    assert(r[0].section === null && r[0].npa === null, 'первый чанк без контекста');
}

console.log('\n=== TEST 10: injectLocalContext — формат префикса ===');
{
    const text = 'в частности, статья 330 и 331';
    const global = { summary: 'Жалоба в ООН против пыток' };
    const local = { section: 'Нарушения УК КР', npa: 'Уголовный кодекс КР' };
    const out = injectLocalContext(text, global, local);
    assert(out.includes('[Контекст документа: Жалоба в ООН против пыток]'),
        'global summary в префиксе');
    assert(out.includes('[Раздел: Нарушения УК КР]'), 'section в префиксе');
    assert(out.includes('[Кодекс: Уголовный кодекс КР]'), 'npa в префиксе');
    assert(out.endsWith(text), 'оригинальный текст в хвосте');
    // Lossless: оригинал всегда присутствует
    assert(out.includes(text), 'lossless: оригинал внутри');
}

console.log('\n=== TEST 11: injectLocalContext — graceful fallback на missing ===');
{
    const text = 'статья 330';
    assert(injectLocalContext(text, null, null) === 'статья 330',
        'оба null → текст as-is');
    const onlyGlobal = injectLocalContext(text, { summary: 'X' }, null);
    assert(onlyGlobal === '[Контекст документа: X] статья 330',
        'только global');
    const onlyLocal = injectLocalContext(text, null, { npa: 'УК КР' });
    assert(onlyLocal === '[Кодекс: УК КР] статья 330', 'только npa');
}

console.log('\n=== TEST 12: buildLocalContextBlock — для system prompt ===');
{
    const block = buildLocalContextBlock({ section: 'Нарушения УК', npa: 'Уголовный кодекс КР' });
    assert(block.includes('ТЕКУЩИЙ РАЗДЕЛ'), 'section block есть');
    assert(block.includes('КОДЕКС РАЗДЕЛА'), 'npa block есть');
    assert(block.includes('Уголовный кодекс КР'), 'имя НПА в блоке');
    assert(block.includes('false positive'),
        'есть инструкция отвергать чужие НПА');

    assert(buildLocalContextBlock(null) === '', 'null → пустая строка');
    assert(buildLocalContextBlock({}) === '', 'пустой объект → пустая строка');
    const onlySection = buildLocalContextBlock({ section: 'Глава 1' });
    assert(onlySection.includes('ТЕКУЩИЙ РАЗДЕЛ'), 'только section');
    assert(!onlySection.includes('КОДЕКС РАЗДЕЛА'), 'нет КОДЕКС блока');
}

console.log('\n=== TEST 13: end-to-end — реальный кейс из жалобы Аскарова ===');
{
    // Это упрощённая структура реального бага (orphan chunk "статья 330 и 331")
    const chunks = [
        'В Комитет против пыток ООН.\nЖАЛОБА от Аскарова Азимжана.',
        'Нарушения Конституции Кыргызской Республики',
        'Часть 4, статьи 56 Конституции КР устанавливает абсолютный запрет на пытки.',
        'Часть 1, статьи 61 Конституции гарантирует право на судебную защиту.',
        'Нарушения национального законодательства КР',
        'По Уголовному кодексу Кыргызской Республики',
        'Часть 2, статьи 9 Уголовного кодекса закрепляет принцип гуманизма.',
        // ⚠️ ORPHAN: эти статьи БЕЗ упоминания кодекса — раньше бы потащили
        // Воздушный кодекс / Закон о рекламе. Теперь должны наследовать УК.
        'Государство фактически уклонилось от расследования по статье 330 и статье 331.',
        'Также проигнорированы статьи 137 и 191.'
    ];
    const ctxs = buildChunkContexts(chunks);
    console.log('  → ctxs:', JSON.stringify(ctxs.map(c => ({s: c.section, n: c.npa})), null, 2).slice(0, 500));

    // ⭐ Самое важное: orphan-чанки (7,8) должны иметь npa='УК КР'
    assert(ctxs[7].npa === 'Уголовный кодекс КР',
        '⭐ orphan "статья 330 и 331" → УК КР (не Воздушный кодекс!)');
    assert(ctxs[8].npa === 'Уголовный кодекс КР',
        '⭐ orphan "статьи 137 и 191" → УК КР');
    assert(ctxs[7].section === 'Нарушения национального законодательства КР'
        || ctxs[7].section === 'По Уголовному кодексу Кыргызской Республики',
        'section orphan-чанков унаследован разумно');
}

console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
process.exit(fail === 0 ? 0 : 1);
