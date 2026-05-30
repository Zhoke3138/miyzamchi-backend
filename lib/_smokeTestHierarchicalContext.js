// ═══════════════════════════════════════════════════════════════════════
//  _smokeTestHierarchicalContext.js
//  Smoke-test для documentPassport + topology + hierarchicalContext.
//  Запуск: node lib/_smokeTestHierarchicalContext.js
// ═══════════════════════════════════════════════════════════════════════

const {
    generateDocumentPassport,
    buildMacroEmbeddingPrefix,
    buildMacroSystemBlock,
    deriveDocTypeHint,
    VALID_DOC_TYPES,
    DOC_TYPE_HINTS
} = require('./documentPassport');

const {
    buildChunkTopology,
    buildMesoEmbeddingPrefix,
    buildMesoSystemBlock
} = require('./topology');

const {
    buildHCREmbeddingQuery,
    buildHCRSystemPrompt,
    buildHCRUserPromptLine
} = require('./hierarchicalContext');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

// ═══════════════════════════════════════════════════════════════════════
//  documentPassport.js
// ═══════════════════════════════════════════════════════════════════════
console.log('=== TEST 1: generateDocumentPassport — graceful degradation ===');
(async () => {
    // Нет cascade → null
    const r1 = await generateDocumentPassport({ text: 'Документ', segmentsCount: 5, cascade: null });
    assert(r1 === null, 'нет cascade → null');

    // Пустой текст → null
    const fakeCascade = { call: async () => ({ text: '{}' }) };
    const r2 = await generateDocumentPassport({ text: '', segmentsCount: 0, cascade: fakeCascade });
    assert(r2 === null, 'пустой текст → null');
    const r3 = await generateDocumentPassport({ text: 'короткий', segmentsCount: 0, cascade: fakeCascade });
    assert(r3 === null, 'текст < 50 chars → null');

    // Cascade throws → null (не пробрасывает)
    const failCascade = { call: async () => { const e = new Error('all failed'); e.allFailed = true; throw e; } };
    const r4 = await generateDocumentPassport({
        text: 'a'.repeat(200), segmentsCount: 10, cascade: failCascade,
        logger: { warn: () => {} }
    });
    assert(r4 === null, 'cascade throw → null (graceful)');

    // Invalid JSON → null
    const badJson = { call: async () => ({ text: 'not json{{', model: 'mock', tier: 1 }) };
    const r5 = await generateDocumentPassport({
        text: 'a'.repeat(200), segmentsCount: 10, cascade: badJson,
        logger: { warn: () => {} }
    });
    assert(r5 === null, 'invalid JSON → null');

    console.log('\n=== TEST 2: generateDocumentPassport — sanitization ===');
    const okCascade = {
        call: async () => ({
            text: JSON.stringify({
                title: 'Жалоба в КПП ООН',
                docType: 'complaint',
                summary: 'Жалоба заявителя Аскарова на применение пыток.',
                branches: ['уголовное право', 'международное право'],
                expectedNpas: ['УК КР', 'Конвенция против пыток', 'МПГПП'],
                semanticHints: ['пытки', 'расследование', 'компенсация'],
                parties: ['Аскаров А.', 'Кыргызская Республика']
            }),
            model: 'gemini-3.1-flash-lite', tier: 1
        })
    };
    const p = await generateDocumentPassport({ text: 'a'.repeat(200), segmentsCount: 23, cascade: okCascade });
    assert(p !== null, 'валидный JSON → паспорт');
    assert(p.title === 'Жалоба в КПП ООН', 'title сохранён');
    assert(p.docType === 'complaint', 'docType валидирован');
    assert(p.totalChunks === 23, 'totalChunks из аргумента');
    assert(p.expectedNpas.length === 3, '3 НПА');
    assert(p.semanticHints.length === 3, '3 hints');
    assert(p.model === 'gemini-3.1-flash-lite', 'model записан');

    const invalidDocType = {
        call: async () => ({ text: JSON.stringify({
            title: 'X', docType: 'made-up-type', summary: 'y',
            branches: [], expectedNpas: ['УК КР'], semanticHints: ['x']
        }), model: 'mock', tier: 1 })
    };
    const p2 = await generateDocumentPassport({ text: 'a'.repeat(200), segmentsCount: 5, cascade: invalidDocType });
    assert(p2.docType === 'other', 'invalid docType → fallback to "other"');

    // Дубликаты в массивах вырезаются
    const dups = {
        call: async () => ({ text: JSON.stringify({
            title: 'X', docType: 'contract', summary: 'y',
            branches: ['гражд.', 'гражд.', 'трудовое'],
            expectedNpas: ['ГК КР', 'ГК КР', 'ТК КР'],
            semanticHints: ['x', 'X', 'y']
        }), model: 'mock', tier: 1 })
    };
    const p3 = await generateDocumentPassport({ text: 'a'.repeat(200), segmentsCount: 5, cascade: dups });
    assert(p3.branches.length === 2, 'дубликаты branches удалены');
    assert(p3.semanticHints.length === 2, 'дубликаты hints (case-insensitive) удалены');

    console.log('\n=== TEST 3: buildMacroEmbeddingPrefix ===');
    assert(buildMacroEmbeddingPrefix(null) === '', 'null → пустая строка');
    assert(buildMacroEmbeddingPrefix({}) === '', 'empty → empty');
    const pre = buildMacroEmbeddingPrefix(p);
    assert(pre.startsWith('[Документ: '), 'префикс начинается правильно');
    assert(pre.endsWith('] '), 'префикс заканчивается пробелом');
    assert(pre.includes('Жалоба в КПП ООН'), 'title в префиксе');
    assert(pre.includes('УК КР'), 'expectedNpas в префиксе');
    assert(pre.includes('пытки'), 'semanticHints в префиксе');

    console.log('\n=== TEST 4: buildMacroSystemBlock ===');
    assert(buildMacroSystemBlock(null) === '', 'null → empty');
    const block = buildMacroSystemBlock(p);
    assert(block.includes('ПАСПОРТ ДОКУМЕНТА'), 'header есть');
    assert(block.includes('Жалоба в КПП ООН'), 'title есть');
    assert(block.includes('Тип: complaint'), 'docType есть');
    assert(block.includes('false positive'), 'есть инструкция про другие НПА');
    assert(block.includes('Всего пунктов: 23'), 'totalChunks отображён');

    console.log('\n=== TEST 5: deriveDocTypeHint — все 9 типов ===');
    for (const dt of VALID_DOC_TYPES) {
        const hint = deriveDocTypeHint({ docType: dt });
        assert(hint && hint.length > 30, `${dt} имеет hint (${hint.slice(0, 40)}...)`);
    }
    assert(deriveDocTypeHint(null).includes('не классифицирован'), 'null → other-hint');

    // ═══════════════════════════════════════════════════════════════
    //  topology.js
    // ═══════════════════════════════════════════════════════════════
    console.log('\n=== TEST 6: buildChunkTopology — invalid input ===');
    assert(buildChunkTopology({}) === null, 'пустые opts → null');
    assert(buildChunkTopology({ chunks: [], chunkIndex: 0 }) === null, 'пустой массив → null');
    assert(buildChunkTopology({ chunks: ['a'], chunkIndex: -1 }) === null, 'отрицательный index → null');
    assert(buildChunkTopology({ chunks: ['a'], chunkIndex: 5 }) === null, 'out-of-range → null');

    console.log('\n=== TEST 7: buildChunkTopology — section sticky из chunkContexts ===');
    {
        const chunks = [
            'Преамбула документа.',
            'Нарушения УК КР\nЧасть 2 статьи 9 УК КР закрепляет принцип.',
            'Статья 137 — пытки.',
            'Статья 191 — незаконное задержание.'
        ];
        const chunkContexts = [
            { section: null, npa: null },
            { section: 'Нарушения УК КР', npa: 'УК КР' },
            { section: 'Нарушения УК КР', npa: 'УК КР' },
            { section: 'Нарушения УК КР', npa: 'УК КР' }
        ];
        const t = buildChunkTopology({ chunks, chunkIndex: 2, chunkContexts });
        assert(t !== null, 'topology создан');
        assert(t.chunkIndex === 3, 'chunkIndex 1-based');
        assert(t.totalChunks === 4, 'totalChunks');
        assert(t.section === 'Нарушения УК КР', 'sticky section из chunkContexts');
        // prevHeading = первая строка предыдущего чанка. chunks[1] начинается с section heading,
        // так что prevHeading будет именно section heading. Это корректное поведение.
        assert(t.prevHeading.includes('Нарушения УК КР'), 'prevHeading = первая строка chunks[1]');
        assert(t.nextHeading.includes('Статья 191'), 'nextHeading from chunks[3]');
        assert(t.position >= 0 && t.position <= 1, 'position в диапазоне');
    }

    console.log('\n=== TEST 8: buildChunkTopology — fallback на extractSectionHeading ===');
    {
        // Без chunkContexts — должен извлечь section своими силами
        const chunks = [
            'Что-то нейтральное',
            'Нарушения Конституции КР\nЧасть 4, статьи 56...',
            'Часть 5, статьи 56 гарантирует...'
        ];
        const t = buildChunkTopology({ chunks, chunkIndex: 1 });
        assert(t.section === 'Нарушения Конституции КР', 'section извлечён из chunks[1] напрямую');
    }

    console.log('\n=== TEST 9: первый и последний чанк — без prev/next ===');
    {
        const chunks = ['Только один.', 'Другой.'];
        const tFirst = buildChunkTopology({ chunks, chunkIndex: 0 });
        assert(tFirst.prevHeading === null, 'первый чанк: prevHeading=null');
        assert(tFirst.nextHeading !== null, 'первый чанк: nextHeading есть');
        const tLast = buildChunkTopology({ chunks, chunkIndex: 1 });
        assert(tLast.prevHeading !== null, 'последний: prevHeading есть');
        assert(tLast.nextHeading === null, 'последний: nextHeading=null');
    }

    console.log('\n=== TEST 10: buildMesoEmbeddingPrefix ===');
    assert(buildMesoEmbeddingPrefix(null) === '', 'null → empty');
    const mesoP = buildMesoEmbeddingPrefix({ chunkIndex: 7, totalChunks: 23, position: 0.3, section: 'X' });
    assert(mesoP.includes('п.7/23'), 'position');
    assert(mesoP.includes('раздел "X"'), 'section');
    assert(mesoP.startsWith('[') && mesoP.endsWith('] '), 'формат скобок и пробел');

    console.log('\n=== TEST 11: buildMesoSystemBlock ===');
    assert(buildMesoSystemBlock(null) === '', 'null → empty');
    const mesoB = buildMesoSystemBlock({
        chunkIndex: 7, totalChunks: 23, position: 0.3,
        section: 'Нарушения УК КР',
        prevHeading: 'Часть 2 статьи 9',
        nextHeading: 'Статья 191'
    });
    assert(mesoB.includes('ТОПОЛОГИЯ ПУНКТА'), 'header');
    assert(mesoB.includes('пункт 7 из 23'), 'позиция текстом');
    assert(mesoB.includes('30%'), 'процент');
    assert(mesoB.includes('«Нарушения УК КР»'), 'section в кавычках');
    assert(mesoB.includes('Часть 2 статьи 9'), 'prevHeading');
    assert(mesoB.includes('Статья 191'), 'nextHeading');

    // ═══════════════════════════════════════════════════════════════
    //  hierarchicalContext.js
    // ═══════════════════════════════════════════════════════════════
    console.log('\n=== TEST 12: buildHCREmbeddingQuery — оригинал в хвосте ===');
    {
        const text = 'статья 137 криминализирует пытки';
        const topology = { chunkIndex: 7, totalChunks: 23, position: 0.3, section: 'Нарушения УК КР' };
        const q = buildHCREmbeddingQuery(text, p, topology);
        assert(q.endsWith(text), 'micro text в хвосте');
        assert(q.includes('[Документ:'), 'macro префикс');
        assert(q.includes('[п.7/23'), 'meso префикс');
        assert(q.includes('УК КР'), 'expectedNpas в строке');

        // Без passport / topology
        assert(buildHCREmbeddingQuery(text, null, null) === text,
            'оба null → текст без изменений');
        const onlyP = buildHCREmbeddingQuery(text, p, null);
        assert(onlyP.includes('[Документ:') && onlyP.endsWith(text), 'только macro');
        const onlyT = buildHCREmbeddingQuery(text, null, topology);
        assert(onlyT.includes('[п.7/23') && onlyT.endsWith(text), 'только meso');
    }

    console.log('\n=== TEST 13: buildHCRSystemPrompt — все блоки ===');
    {
        const basePrompt = 'Ты — юрист. Отвечай JSON.';
        const topology = { chunkIndex: 7, totalChunks: 23, position: 0.3, section: 'Нарушения УК КР' };
        const sp = buildHCRSystemPrompt(basePrompt, p, topology);
        assert(sp.includes('ПАСПОРТ ДОКУМЕНТА'), 'macro block');
        assert(sp.includes('ТОПОЛОГИЯ ПУНКТА'), 'meso block');
        assert(sp.includes('ФОКУС: жалоба'), 'docType hint для complaint');
        assert(sp.endsWith(basePrompt), 'basePrompt в конце');

        // Без passport / topology — basePrompt остаётся как есть
        const onlyBase = buildHCRSystemPrompt(basePrompt, null, null);
        assert(onlyBase === basePrompt, 'без HCR — базовый prompt as-is');
    }

    console.log('\n=== TEST 14: универсальность — расписка vs иск ===');
    {
        const receiptCascade = {
            call: async () => ({ text: JSON.stringify({
                title: 'Расписка о получении займа',
                docType: 'receipt',
                summary: 'Расписка Иванова в получении 50000 сом от Петрова.',
                branches: ['гражданское право'],
                expectedNpas: ['Гражданский кодекс КР'],
                semanticHints: ['заём', 'возврат денежных средств', 'проценты по займу'],
                parties: ['Иванов И.', 'Петров П.']
            }), model: 'mock', tier: 1 })
        };
        const receipt = await generateDocumentPassport({ text: 'a'.repeat(200), segmentsCount: 5, cascade: receiptCascade });
        assert(receipt.docType === 'receipt', 'расписка распознана');
        const hint = deriveDocTypeHint(receipt);
        assert(hint.includes('расписка') || hint.includes('займа'), 'hint для расписки');

        const lawsuitCascade = {
            call: async () => ({ text: JSON.stringify({
                title: 'Исковое заявление о взыскании задолженности',
                docType: 'lawsuit',
                summary: 'Иск ОсОО к гражданину о взыскании 200000 сом по договору теплоснабжения.',
                branches: ['гражданское право', 'процессуальное право'],
                expectedNpas: ['Гражданский кодекс КР', 'ГПК КР'],
                semanticHints: ['исковая давность', 'подсудность', 'судебные расходы'],
                parties: ['ОсОО Бишкектеплосервис', 'Иванов И.']
            }), model: 'mock', tier: 1 })
        };
        const lawsuit = await generateDocumentPassport({ text: 'a'.repeat(200), segmentsCount: 15, cascade: lawsuitCascade });
        assert(lawsuit.docType === 'lawsuit', 'иск распознан');
        const hintL = deriveDocTypeHint(lawsuit);
        assert(hintL.includes('исковая давность') || hintL.includes('подсудность'), 'hint для иска');

        // System prompts должны быть РАЗНЫМИ для разных типов
        const spReceipt = buildHCRSystemPrompt('base', receipt, null);
        const spLawsuit = buildHCRSystemPrompt('base', lawsuit, null);
        assert(spReceipt !== spLawsuit, 'разные документы — разные prompt');
        assert(spReceipt.includes('receipt'), 'receipt в prompt');
        assert(spLawsuit.includes('lawsuit'), 'lawsuit в prompt');
    }

    console.log('\n=== TEST 15: buildHCRUserPromptLine ===');
    assert(buildHCRUserPromptLine(null) === '', 'null → empty');
    const upl = buildHCRUserPromptLine({ chunkIndex: 7, totalChunks: 23, section: 'X' });
    assert(upl.includes('пункт 7/23'), 'позиция');
    assert(upl.includes('раздел «X»'), 'section');
    assert(upl.endsWith('\n'), 'оканчивается на newline для clean prompt концатенации');

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('SMOKE CRASHED:', e);
    process.exit(2);
});
