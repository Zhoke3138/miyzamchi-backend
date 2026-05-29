// Smoke-test для smartSkipPhase3 + расширенного npaAliases.
// Запуск: node lib/_smokeTestSmartSkip.js
const { shouldRunPhase3, countCitations, MIN_CITATIONS_FOR_PHASE3 } = require('./smartSkipPhase3');
const { normalizeNpaName } = require('./npaAliases');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

console.log('=== TEST 1: countCitations — базовые формы ===');
assert(countCitations('ст. 14 ГК КР') >= 1, 'ст. 14 → ≥1');
assert(countCitations('статья 14') >= 1, 'статья 14 → ≥1');
assert(countCitations('статьи 14 и 15') >= 1, 'статьи 14 и 15 → ≥1');
assert(countCitations('статьёй 137 УК КР') >= 1, 'статьёй 137 → ≥1');
assert(countCitations('статьями 7, 10, 11, 222, 296') >= 1, 'перечень статей → ≥1');
assert(countCitations('Часть 4, статьи 56') >= 1, 'Часть 4, статьи 56 → ≥1');
assert(countCitations('часть 5 статьи 56') >= 1, 'часть 5 статьи 56 → ≥1');
assert(countCitations('пункт 1 статьи 7') >= 1, 'пункт 1 статьи 7 → ≥1');

console.log('\n=== TEST 2: countCitations — пустые случаи ===');
assert(countCitations('') === 0, 'пустая строка → 0');
assert(countCitations(null) === 0, 'null → 0');
assert(countCitations('в соответствии с законодательством') === 0, 'generic-ссылка → 0');
assert(countCitations('Закон КР Об электроэнергетике') === 0, 'закон без статьи → 0');

console.log('\n=== TEST 3: shouldRunPhase3 — решения ===');
{
    // Договор без явных ссылок — skip
    const d = shouldRunPhase3('Договор на оказание услуг. Стороны несут ответственность в соответствии с законодательством КР.');
    assert(d.run === false, 'договор без citations → skip');
    assert(d.citationCount === 0, 'citation count = 0');
    assert(/без явных ссылок|не содержит/.test(d.reason), 'reason описывает причину');
}
{
    // Жалоба с явными ссылками — keep
    const d = shouldRunPhase3('Согласно ст. 14 УК КР и ст. 15 УК КР, а также статьи 9 УПК КР...');
    assert(d.run === true, 'жалоба с 3+ citations → keep');
    assert(d.citationCount >= 3, 'citation count >= 3');
    assert(/точный RAG|Phase 3/.test(d.reason), 'reason описывает точный RAG');
}
{
    // Один citation — на грани, по умолчанию skip (порог 2)
    const d = shouldRunPhase3('Согласно ст. 176 Гражданского кодекса КР.');
    assert(d.run === false, '1 citation < порог 2 → skip');
    assert(d.citationCount === 1, 'citation count = 1');
}
{
    // Override порога — можно понизить
    const d = shouldRunPhase3('Согласно ст. 176 ГК КР.', { minCitations: 1 });
    assert(d.run === true, 'с порогом 1 — 1 citation достаточно');
}

console.log('\n=== TEST 4: MIN_CITATIONS_FOR_PHASE3 константа ===');
assert(MIN_CITATIONS_FOR_PHASE3 === 2, 'дефолтный порог = 2');

console.log('\n=== TEST 5: расширенный npaAliases — новые НПА ===');
assert(normalizeNpaName('Кодекс КР «О нарушениях»') === 'Кодекс КР о нарушениях', 'Кодекс о нарушениях → канонический');
assert(normalizeNpaName('кодекс о нарушениях') === 'Кодекс КР о нарушениях', 'lowercase кодекс о нарушениях → канонический');
assert(normalizeNpaName('Закон КР «О защите прав потребителей»') === 'Закон КР «О защите прав потребителей»', 'ЗоЗПП → канонический');
assert(normalizeNpaName('закон о защите прав потребителей') === 'Закон КР «О защите прав потребителей»', 'lowercase ЗоЗПП → канонический');
assert(normalizeNpaName('Конвенция против пыток') === 'Конвенция против пыток', 'Конвенция против пыток → канонический');
assert(normalizeNpaName('КПП') === 'Конвенция против пыток', 'КПП аббревиатура → Конвенция');
assert(normalizeNpaName('Международный пакт о гражданских и политических правах') === 'Международный пакт о гражданских и политических правах', 'МПГПП полное → канонический');
assert(normalizeNpaName('МПГПП') === 'Международный пакт о гражданских и политических правах', 'МПГПП аббревиатура → канонический');

console.log('\n=== TEST 6: shouldRunPhase3 на реальных кейсах из test_corpus ===');
{
    // Аналог трудового договора (citations: 0)
    const trud = 'ТРУДОВОЙ ДОГОВОР. Работник обязуется выполнять трудовые обязанности в соответствии с Трудовым кодексом Кыргызской Республики.';
    assert(shouldRunPhase3(trud).run === false, 'трудовой договор → skip');
}
{
    // Аналог жалобы (citations: 18+)
    const zhal = `статьёй 22 Конвенции против пыток
    Часть 4, статьи 56 Конституции КР устанавливает запрет на пытки.
    Часть 5, статьи 56 гарантирует гуманное обращение.
    Части 1, 3, 5 и 6, статьи 59 закрепляют право на личную неприкосновенность.
    статьёй 137 УК КР (Пытки), статьёй 191 УК КР (Незаконное задержание),
    статья 192 УК КР, статья 1, статья 2, статья 12, статья 13 Конвенции.`;
    const d = shouldRunPhase3(zhal);
    assert(d.run === true, 'жалоба ООН → keep');
    assert(d.citationCount >= 5, `жалоба ООН ≥5 citations (got ${d.citationCount})`);
}
{
    // Аналог возражения (citations: 10+)
    const vozr = `статьи 1 Гражданского кодекса. статье 2 Жилищного кодекса.
    статье 74 Жилищного кодекса. статью 299 Гражданского кодекса.
    статьями 63, 65, 152 Гражданского процессуального кодекса.`;
    const d = shouldRunPhase3(vozr);
    assert(d.run === true, 'возражение → keep');
    assert(d.citationCount >= 4, `возражение ≥4 citations (got ${d.citationCount})`);
}

console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
process.exit(fail === 0 ? 0 : 1);
