// Smoke-test для segmentDocumentRegex (Smart Chunking v3, 2026-05-29).
// Запуск: node lib/_smokeTestSegmentRegex.js
const { segmentDocumentRegex, wrapAsAnalyzeSegments, _internal } = require('./segmentRegex');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

console.log('=== TEST 1: договор с пунктами и описанием ===');
// "1. Предмет договора." — короткий subheading с маркером, тащит за собой
// текст пункта. "Договор аренды нежилого помещения" — заголовок документа,
// выделяется в отдельный блок.
const t1 = `Договор аренды нежилого помещения

1. Предмет договора.
Арендодатель передаёт, а арендатор принимает во временное пользование помещение.

2. Срок аренды.
Срок аренды устанавливается на 12 месяцев с даты подписания.

3. Арендная плата.
Размер арендной платы составляет 50000 сом в месяц.`;

const chunks1 = segmentDocumentRegex(t1);
assert(chunks1.length === 4, '4 чанка (преамбула + 3 пункта)', `got ${chunks1.length}: ${chunks1.map(c => c.slice(0, 30)).join(' | ')}`);
assert(chunks1[0].includes('Договор аренды'), 'преамбула в чанке 0');
assert(chunks1[1].startsWith('1.') && chunks1[1].includes('Арендодатель'), 'чанк 1: 1. + описание');
assert(chunks1[2].startsWith('2.') && chunks1[2].includes('Срок аренды устанавливается'), 'чанк 2: 2. + описание');
assert(chunks1[3].startsWith('3.') && chunks1[3].includes('Размер арендной'), 'чанк 3: 3. + описание');

console.log('\n=== TEST 2: кодекс с Главой и Статьями ===');
const t2 = `Глава 1. Общие положения

Статья 1. Основные понятия.
В настоящем кодексе используются следующие понятия.

Статья 2. Сфера применения.
Настоящий кодекс применяется ко всем гражданам.`;
const chunks2 = segmentDocumentRegex(t2);
assert(chunks2.length === 3, '3 чанка (Глава + 2 Статьи с описанием)', `got ${chunks2.length}`);
assert(chunks2[0].startsWith('Глава'), 'чанк 0 — Глава 1');
assert(chunks2[1].startsWith('Статья 1') && chunks2[1].includes('используются'), 'чанк 1: Статья 1 + описание');
assert(chunks2[2].startsWith('Статья 2') && chunks2[2].includes('применяется'), 'чанк 2: Статья 2 + описание');

console.log('\n=== TEST 3: сокращения не рвут предложения ===');
const longBase = `В соответствии со ст. 14 ч. 2 Гражданского кодекса КР, ` +
    `при возникновении спора стороны обязаны провести переговоры. ` +
    `В случае недостижения соглашения спор подлежит передаче в суд. ` +
    `При этом п. 1 ст. 15 устанавливает срок исковой давности 3 г. ` +
    `См. также ст. 50 указанного кодекса. Таким образом, истец имеет право требовать. `;
const t3 = longBase.repeat(20);
const chunks3 = segmentDocumentRegex(t3);
const joinedBack = chunks3.join(' ').replace(/\s+/g, ' ');
assert(chunks3.length >= 2, 'разрезался хотя бы на 2 части', `got ${chunks3.length}, totalLen=${t3.length}`);
const brokenAt = chunks3.some(c => /ст$/.test(c.trim()) || /п$/.test(c.trim()) || /ч$/.test(c.trim()));
assert(!brokenAt, 'НЕ рвётся посреди сокращений ст./п./ч.');
const lossless3 = joinedBack.replace(/\s/g, '').length === t3.replace(/\s/g, '').length;
assert(lossless3, 'lossless: все символы сохранены', `${joinedBack.replace(/\s/g, '').length} vs ${t3.replace(/\s/g, '').length}`);

console.log('\n=== TEST 4: сканированный документ без переносов ===');
const t4 = 'аб'.repeat(2000);
const telemetryStub = { counters: {}, incrementCounter(k) { this.counters[k] = (this.counters[k] || 0) + 1; } };
const chunks4 = segmentDocumentRegex(t4, { telemetry: telemetryStub });
assert(chunks4.every(c => c.length <= 3000), 'все чанки <= 3000 ch');
assert(telemetryStub.counters.segment_hard_split_warnings > 0, 'hard-split warning в телеметрии');

console.log('\n=== TEST 5: пустой / мусорный вход ===');
assert(segmentDocumentRegex('').length === 0, 'пустая строка → []');
assert(segmentDocumentRegex(null).length === 0, 'null → []');
assert(segmentDocumentRegex('   \n\n   ').length === 0, 'whitespace → []');

console.log('\n=== TEST 6: нумерация с вложенностью 1.1, 1.2 ===');
const t6 = `1. Общие положения.
Текст пункта 1.

1.1 Подпункт первый.
Текст подпункта.

1.2 Подпункт второй.
Текст другого подпункта.

2. Заключительные положения.`;
const chunks6 = segmentDocumentRegex(t6);
assert(chunks6.length === 4, '4 чанка (1., 1.1, 1.2, 2.)', `got ${chunks6.length}: ${chunks6.map(c => c.slice(0, 20)).join(' | ')}`);

console.log('\n=== TEST 7: преамбула без маркера не теряется ===');
const t7 = `Это длинная преамбула документа без номеров.

Статья 1. Первая статья.`;
const chunks7 = segmentDocumentRegex(t7);
assert(chunks7.length === 2, '2 чанка', `got ${chunks7.length}`);
assert(chunks7[0].includes('преамбула'), 'преамбула сохранена');

console.log('\n=== TEST 8: wrapAsAnalyzeSegments — Phase 4 UX fix ===');
{
    const chunks = [
        'В Комитет против пыток ООН\n\nнекий текст',
        'Часть 4, статьи 56 Конституции КР...',
        'Часть 5, статьи 56 гарантирует каждому...',
        'Части 1, 3, 5 и 6, статьи 59...',
        'Части 1 и 2, статьи 56 — презумпция...',
        'Часть 1, статьи 61 гарантирует...',
        'Часть 2, статьи 9 УК КР закрепляет...'
    ];
    const out = wrapAsAnalyzeSegments(chunks);
    assert(out.length === 7, '7 сегментов');
    assert(out[0].number === '1' && out[6].number === '7', 'нумерация 1..7');
    assert(new Set(out.map(s => s.number)).size === 7, 'все номера УНИКАЛЬНЫ');
    assert(out[0].id === 'seg_0' && out[6].id === 'seg_6', 'id формата seg_{i}');
    assert(out[1].heading === 'Часть 4, статьи 56 Конституции КР...', 'heading = первая строка');
    assert(out[0].heading === 'В Комитет против пыток ООН', 'heading первого чанка без хвоста');
    assert(out[0].text === chunks[0], 'text сохранён as-is');
}
{
    const longLine = 'А'.repeat(200);
    const out = wrapAsAnalyzeSegments([longLine + '\n\nостаток']);
    assert(out[0].heading.length === 120, 'heading обрезан до 120 ch');
    assert(out[0].text.length > 120, 'text НЕ обрезан');
}
{
    assert(wrapAsAnalyzeSegments([]).length === 0, 'пустой массив → []');
    assert(wrapAsAnalyzeSegments(null).length === 0, 'null → []');
    assert(wrapAsAnalyzeSegments(undefined).length === 0, 'undefined → []');
}
{
    const out = wrapAsAnalyzeSegments(['нормальный', null, undefined, 42, '']);
    assert(out.length === 5, '5 сегментов на мусорный вход');
    assert(out[0].number === '1' && out[4].number === '5', 'нумерация продолжается');
    assert(out[1].text === '' && out[2].text === '', 'null/undefined → ""');
    assert(out[3].text === '42', 'число → строка');
}
{
    const doc = `Преамбула документа.

Статья 1. Первое.
Текст первой статьи.

Статья 2. Второе.
Текст второй статьи.`;
    const segments = wrapAsAnalyzeSegments(segmentDocumentRegex(doc));
    assert(segments.length === 3, 'преамбула + 2 статьи = 3 сегмента');
    assert(segments[0].number === '1', 'преамбула → п.1');
    assert(segments[1].number === '2' && segments[2].number === '3', 'статьи → п.2, п.3');
    assert(segments[1].heading.startsWith('Статья 1'), 'heading сохраняет смысл');
}

console.log('\n=== TEST 9: Smart Chunking — intro:list склеиваются (v3) ===');
// Главная семантика v3: "...нарушения:" + буллет-список = 1 чанк,
// а не N отдельных микро-чанков (как в v2).

// 9.1 — Конвенция против пыток: intro + 3 буллета = 1 чанк
{
    const text =
`Применительно к Конвенции против пыток нами установлены следующие нарушения:
–	статья 1 — запрет пыток: факт применения пыток подтверждается.
–	статья 2 — обязанность государства принимать эффективные меры.
–	статья 12 — обязанность проводить расследование.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 1,
        `intro + 3 буллета = 1 чанк (got ${chunks.length})`);
    assert(chunks[0].includes('Применительно') && chunks[0].includes('статья 1') && chunks[0].includes('статья 12'),
        'все 3 буллета внутри одного чанка с intro');
}

// 9.2 — два разных списка ("Конвенции..." и "МПГПП...") = 2 чанка
{
    const text =
`Применительно к Конвенции против пыток нами установлены следующие нарушения:
–	статья 1 — запрет пыток.
–	статья 2 — обязанность государства.
В части Международного пакта о гражданских и политических правах:
–	статья 7 — запрет пыток и жестокого обращения;
–	статья 9 — право на свободу.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 2,
        `два списка = 2 чанка (got ${chunks.length}: ${chunks.map(c => c.slice(0, 30)).join(' | ')})`);
    assert(chunks[0].includes('Конвенции против пыток') && chunks[0].includes('статья 1'),
        'чанк 0 — список Конвенции');
    assert(chunks[1].includes('Международного пакта') && chunks[1].includes('статья 7'),
        'чанк 1 — список МПГПП');
}

// 9.3 — буллит-список с тире
{
    const text =
`Истец обязан:
- предоставить документы;
- явиться на заседание;
- уведомить ответчика.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 1,
        `тире-список = 1 чанк с intro (got ${chunks.length})`);
    assert(chunks[0].includes('Истец обязан') && chunks[0].includes('предоставить') && chunks[0].includes('уведомить'),
        'все пункты внутри одного чанка');
}

// 9.4 — буллит • Word-стиль
{
    const text =
`Стороны договорились:
•	Поставлять товар вовремя.
•	Принимать оплату наличными.
•	Не разглашать сведения.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 1,
        `буллит • список = 1 чанк (got ${chunks.length})`);
}

// 9.5 — нижний регистр "статья N —" в перечне иска
{
    const text =
`Руководствуясь статьями 7, 10, 11, 222 Гражданского кодекса:
статья 7 — основания возникновения прав;
статья 10 — принцип разумности;
статья 11 — судебная защита.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 1,
        `нижний регистр "статья N —" = 1 чанк (got ${chunks.length})`);
}

// 9.6 — нормы Конституции (Часть N, статьи M) — каждая отдельный чанк
// (это полноценные правовые блоки, не subheading'и)
{
    const text =
`Нарушения Конституции Кыргызской Республики

Часть 4, статьи 56 Конституции КР устанавливает абсолютный запрет на пытки.
Часть 5, статьи 56 гарантирует гуманное обращение.
Части 1, 3, 5 и 6, статьи 59 закрепляют право на неприкосновенность.
Часть 1, статьи 61 гарантирует право на судебную защиту.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length === 4,
        `4 отдельных нормы (got ${chunks.length}: ${chunks.map(c => c.slice(0, 30)).join(' | ')})`);
    assert(chunks[0].includes('Нарушения Конституции') && chunks[0].includes('Часть 4'),
        'чанк 0: section heading + первая норма');
    assert(chunks[3].startsWith('Часть 1, статьи 61'), 'чанк 3 — отдельная Часть 1, статьи 61');
}

console.log('\n=== TEST 10: жалоба ООН (regression от 2026-05-29) ===');
// Реальная структура жалобы Аскарова. ОЖИДАЕМЫЙ диапазон: 15-30 чанков.
// v1 давала 3 слипшихся блока. v2 — 64 микро-чанка. v3 должна дать
// смысловые блоки с сохранением intro:list пар.
{
    const fakeUNComplaint =
`В Комитет против пыток ООН
через Управление Верховного комиссара ООН
по правам человека
tb-petitions@ohchr.org

Представители заявителя по доверенности:
Акунова Гүлдөсүн,
Асиров Жаныбек.

ЖАЛОБА
в соответствии со статьёй 22 Конвенции против пыток
Заявитель: Аскаров Азимжан, гражданин Кыргызской Республики, правозащитник.
Государство-участник: Кыргызская Республика
Обстоятельства дела
Настоящая жалоба подаётся в интересах нашего доверителя, правозащитника и журналиста.
В июне 2010 года Аскаров А. был задержан в связи с событиями на юге Кыргызстана.
Изложенные обстоятельства свидетельствуют о грубом нарушении международных обязательств.
Нарушения Конституции Кыргызской Республики
Часть 4, статьи 56 Конституции КР устанавливает абсолютный запрет на пытки.
Часть 5, статьи 56 гарантирует право на гуманное обращение.
Части 1, 3, 5 и 6, статьи 59 закрепляют право на личную неприкосновенность.
Часть 1, статьи 61 гарантирует право на судебную защиту.
Нарушения международных договоров
Применительно к Конвенции против пыток нами установлены следующие нарушения:
–	статья 1 — запрет пыток: факт применения подтверждается доказательствами;
–	статья 2 — обязанность государства принимать эффективные меры;
–	статья 12 — обязанность проводить незамедлительное расследование;
–	статья 13 — право на подачу жалобы и защиту от давления;
–	статья 14 — право на компенсацию и реабилитацию.
В части Международного пакта о гражданских и политических правах:
–	статья 7 — запрет пыток и жестокого обращения;
–	статья 9 — право на свободу и личную неприкосновенность;
–	статья 10 — право лиц, лишённых свободы, на гуманное обращение;
–	статья 14 — право на справедливое судебное разбирательство.
Просьба к Комитету
На основании изложенного, действуя в интересах нашего доверителя, просим Комитет:
–	признать нарушения Конвенции против пыток;
–	обязать государство провести независимое расследование;
–	обязать обеспечить компенсацию причинённого вреда.`;
    const chunks = segmentDocumentRegex(fakeUNComplaint);
    console.log('  → got', chunks.length, 'чанков. Превью:');
    chunks.forEach((c, i) => console.log(`     [${i}] (${c.length}ch) ${c.slice(0, 60).replace(/\n/g, ' / ')}...`));

    // Для fake-фрагмента из 35 строк ожидаем 10-20 смысловых блоков.
    // Реальная жалоба ~150 строк → пропорционально ~20-30 чанков.
    assert(chunks.length >= 10 && chunks.length <= 25,
        `Smart-chunking диапазон 10-25 чанков (got ${chunks.length})`);

    // Lossless: все не-whitespace символы сохранены
    const rawNonWs = fakeUNComplaint.replace(/\s/g, '');
    const chunksNonWs = chunks.join('').replace(/\s/g, '');
    assert(rawNonWs.length === chunksNonWs.length,
        `lossless: ${chunksNonWs.length} == ${rawNonWs.length}`);

    // Intro:list pair для Конвенции — 1 чанк с 5 буллетами
    const convChunk = chunks.find(c => c.includes('Применительно к Конвенции против пыток'));
    assert(convChunk && convChunk.includes('статья 1') && convChunk.includes('статья 14'),
        'Intro Конвенции + 5 буллетов в ОДНОМ чанке');

    // Intro:list pair для МПГПП — отдельный 1 чанк с 4 буллетами
    const mpgppChunk = chunks.find(c => c.includes('Международного пакта') && c.includes('статья 7'));
    assert(mpgppChunk && mpgppChunk.includes('статья 14'),
        'Intro МПГПП + 4 буллета в ОДНОМ чанке');
    assert(convChunk !== mpgppChunk,
        'Конвенция и МПГПП — РАЗНЫЕ чанки');

    // "Просьба к Комитету" — list мерж: intro + 3 буллета
    const requestChunk = chunks.find(c => c.includes('На основании изложенного'));
    assert(requestChunk && requestChunk.includes('признать') && requestChunk.includes('компенсацию'),
        'Просьба к Комитету — 1 чанк с буллетами');

    // Каждая "Часть N, статьи M" Конституции — отдельный чанк
    // Регекс: "Часть" / "Части" в начале (с опциональным section heading сверху)
    const partChunks = chunks.filter(c => /^(?:Нарушения Конституции.*\n)?Част[ьи]\s+\d/.test(c));
    assert(partChunks.length >= 4,
        `≥4 чанка с "Часть/Части N" (отдельные нормы Конституции, got ${partChunks.length})`);
}

console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
process.exit(fail === 0 ? 0 : 1);
