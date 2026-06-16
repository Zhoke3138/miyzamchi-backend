// ═══════════════════════════════════════════════════════════════════════
//  lib/_smokeTestSuperDocBlocks.js — регресс Super Doc Шаги 2+3
//  Запуск: node lib/_smokeTestSuperDocBlocks.js
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const {
    buildSuperDocBlocks, classifyBlocks, splitAtomicTables,
    applySemanticLeadIn, looksLikeTable, heuristicType
} = require('./superDocBlocks');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };
const nonWs = (s) => String(s || '').replace(/\s/g, '').length;

(async () => {
    // ── 1. Эвристические типы ───────────────────────────────────────────
    ok(heuristicType('Статья 5. Основные понятия. Текст нормы.') === 'article', 'heuristic: article');
    ok(heuristicType('3.1. Стороны обязуются...') === 'clause', 'heuristic: clause');
    ok(heuristicType('Заказчик обязан оплатить:\n- сумму А\n- сумму Б') === 'list_group', 'heuristic: list_group');
    ok(looksLikeTable('| Имя | Сумма |\n|---|---|\n| А | 10 |\n| Б | 20 |'), 'looksLikeTable: markdown true');
    ok(!looksLikeTable('Обычный абзац без таблицы.'), 'looksLikeTable: prose false');

    // ── 2. Lossless (классификатор без каскада, не-табличные блоки) ──────
    const chunks = [
        'Договор оказания услуг.',
        '1. Предмет договора.\nИсполнитель оказывает услуги согласно ГК КР.',
        'Заявитель обязан уплатить пеню.',
    ];
    const ctxs = [{ section: null, npa: null }, { section: null, npa: 'Гражданский кодекс КР' }, { section: null, npa: 'Гражданский кодекс КР' }];
    const blocks = await buildSuperDocBlocks(chunks, ctxs, { cascade: null });
    const inNw = chunks.reduce((a, c) => a + nonWs(c), 0);
    const outNw = blocks.reduce((a, b) => a + nonWs(b.text), 0);
    ok(inNw === outNw, `lossless text (no cascade): ${inNw} == ${outNw}`);
    ok(blocks.length === 3, `no table → no split (got ${blocks.length})`);
    ok(blocks.every((b) => b.leadIn === null), 'no continues_prev → no lead-in');

    // ── 3. Атомарная таблица: дробление с дублированием header ───────────
    const header = '| Статья | Нарушение |';
    const sep = '|---|---|';
    const rows = [];
    for (let i = 1; i <= 40; i++) rows.push(`| ст.${i} | нарушение пункта ${i} с достаточно длинным описанием для объёма |`);
    const bigTable = [header, sep, ...rows].join('\n');
    const tblBlocks = splitAtomicTables(
        [{ text: bigTable, type: 'table', continues_prev: false, context: null }],
        { maxTableChars: 800 }
    );
    ok(tblBlocks.length > 1, `big table split into parts (got ${tblBlocks.length})`);
    ok(tblBlocks.every((b) => b.text.startsWith(header)), 'each table part starts with duplicated header');
    ok(tblBlocks.every((b) => b.type === 'table'), 'all parts keep type=table');
    ok(tblBlocks.slice(1).every((b) => b.continues_prev === true), 'parts 2..N continues_prev=true');
    ok(tblBlocks[0].tablePart === '1/' + tblBlocks.length, `tablePart label (got ${tblBlocks[0].tablePart})`);
    // Ни одна строка тела не разорвана: каждая строка целиком в каком-то парте
    const bodyRow = '| ст.20 | нарушение пункта 20';
    ok(tblBlocks.some((b) => b.text.includes(bodyRow)), 'row stays intact across split');

    // ── 4. Семантический lead-in ────────────────────────────────────────
    const li = applySemanticLeadIn([
        { text: 'Первое предложение. Второе и последнее предложение блока.', type: 'paragraph', continues_prev: false },
        { text: 'продолжение мысли без своего заголовка.', type: 'paragraph', continues_prev: true },
    ]);
    ok(li[0].leadIn === null, 'lead-in: первый блок без lead-in');
    ok(li[1].leadIn && li[1].leadIn.includes('последнее предложение'), `lead-in: блок-продолжение получил последнее предложение (got: ${li[1].leadIn})`);

    // ── 5. Lossless-guard классификатора: «вредный» каскад не портит текст ─
    const evilCascade = {
        call: async () => ({ text: JSON.stringify({ labels: [{ i: 0, type: 'clause', continues_prev: false, text: 'ХАКНУТЫЙ ТЕКСТ' }] }) }),
    };
    const guarded = await classifyBlocks(['Оригинальный текст блока.'], { cascade: evilCascade });
    ok(guarded.length === 1 && guarded[0].type === 'clause', 'classifier applied label by index');
    // text не из классификатора — buildSuperDocBlocks хранит наш текст
    const guardedBlocks = await buildSuperDocBlocks(['Оригинальный текст блока.'], [null], { cascade: evilCascade });
    ok(guardedBlocks[0].text === 'Оригинальный текст блока.', 'classifier CANNOT mutate text (lossless by design)');

    // ── 6. Откат батча на битом JSON ────────────────────────────────────
    const brokenCascade = { call: async () => ({ text: 'не-JSON мусор {{{' }) };
    const rb = await classifyBlocks(['Статья 7. Запрет.'], { cascade: brokenCascade });
    ok(rb[0].type === 'article' && rb[0]._src === 'heuristic', 'broken JSON → heuristic fallback for batch');

    console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1); });
