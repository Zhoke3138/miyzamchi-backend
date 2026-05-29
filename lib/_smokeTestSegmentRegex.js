// Smoke-test для segmentDocumentRegex. Запускается один раз руками,
// потом этот файл можно удалить (или оставить для регресса).
// Запуск: node lib/_smokeTestSegmentRegex.js
const { segmentDocumentRegex, wrapAsAnalyzeSegments, _internal } = require('./segmentRegex');

let pass = 0, fail = 0;
function assert(cond, name, extra = '') {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, extra); }
}

console.log('=== TEST 1: документ с маркерами (договор) ===');
const t1 = `Договор аренды нежилого помещения

1. Предмет договора.
Арендодатель передаёт, а арендатор принимает во временное пользование помещение.

2. Срок аренды.
Срок аренды устанавливается на 12 месяцев с даты подписания.

3. Арендная плата.
Размер арендной платы составляет 50000 сом в месяц.`;

const chunks1 = segmentDocumentRegex(t1);
assert(chunks1.length === 4, '4 чанка (преамбула + 3 пункта)', `got ${chunks1.length}`);
assert(chunks1[0].includes('Договор аренды'), 'преамбула в чанке 0');
assert(chunks1[1].startsWith('1.'), 'чанк 1 начинается с 1.');
assert(chunks1[2].startsWith('2.'), 'чанк 2 начинается с 2.');
assert(chunks1[3].startsWith('3.'), 'чанк 3 начинается с 3.');

console.log('\n=== TEST 2: маркеры кодексов (Статья / Глава) ===');
const t2 = `Глава 1. Общие положения

Статья 1. Основные понятия.
В настоящем кодексе используются следующие понятия.

Статья 2. Сфера применения.
Настоящий кодекс применяется ко всем гражданам.`;
const chunks2 = segmentDocumentRegex(t2);
assert(chunks2.length === 3, '3 чанка', `got ${chunks2.length}`);
assert(chunks2[0].startsWith('Глава'), 'чанк 0 — Глава');
assert(chunks2[1].startsWith('Статья 1'), 'чанк 1 — Статья 1');
assert(chunks2[2].startsWith('Статья 2'), 'чанк 2 — Статья 2');

console.log('\n=== TEST 3: сокращения не рвут предложения ===');
// Большой непрерывный текст с сокращениями. Принудительно делаем длиннее 3000ch,
// чтобы запустить sentence-split. Должен резаться только на ИСТИННЫХ концах
// предложений, не на "ст. 123" или "п. 4".
const longBase = `В соответствии со ст. 14 ч. 2 Гражданского кодекса КР, ` +
    `при возникновении спора стороны обязаны провести переговоры. ` +
    `В случае недостижения соглашения спор подлежит передаче в суд. ` +
    `При этом п. 1 ст. 15 устанавливает срок исковой давности 3 г. ` +
    `См. также ст. 50 указанного кодекса. Таким образом, истец имеет право требовать. `;
const t3 = longBase.repeat(20); // ~3000+ символов
const chunks3 = segmentDocumentRegex(t3);
const joinedBack = chunks3.join(' ').replace(/\s+/g, ' ');
assert(chunks3.length >= 2, 'разрезался хотя бы на 2 части', `got ${chunks3.length}, totalLen=${t3.length}`);
const brokenAt = chunks3.some(c => /ст$/.test(c.trim()) || /п$/.test(c.trim()) || /ч$/.test(c.trim()));
assert(!brokenAt, 'НЕ рвётся посреди сокращений ст./п./ч.');
const lossless = joinedBack.replace(/\s/g, '').length === t3.replace(/\s/g, '').length;
assert(lossless, 'lossless: все символы сохранены (whitespace-insensitive)', `${joinedBack.replace(/\s/g, '').length} vs ${t3.replace(/\s/g, '').length}`);

console.log('\n=== TEST 4: сканированный документ без переносов и без точек ===');
// OCR-кейс — одно гигантское "предложение" без пунктуации, без \n\n.
// Должен дойти до hardSplit и не упасть.
const t4 = 'аб'.repeat(2000); // 4000 ch одной строкой без пробелов
const telemetryStub = { counters: {}, incrementCounter(k) { this.counters[k] = (this.counters[k] || 0) + 1; } };
const chunks4 = segmentDocumentRegex(t4, { telemetry: telemetryStub });
assert(chunks4.every(c => c.length <= 3000), 'все чанки <= 3000 ch', `lens=${chunks4.map(c=>c.length).join(',')}`);
assert(telemetryStub.counters.segment_hard_split_warnings > 0, 'hard-split warning записан в телеметрию');

console.log('\n=== TEST 5: пустой / мусорный вход ===');
assert(segmentDocumentRegex('').length === 0, 'пустая строка → []');
assert(segmentDocumentRegex(null).length === 0, 'null → []');
assert(segmentDocumentRegex('   \n\n   ').length === 0, 'один whitespace → []');

console.log('\n=== TEST 6: нумерация с вложенностью 1.1, 2.3.4 ===');
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
// 8.1 — порядковая нумерация уникальна даже на чанках с маркерами
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
    assert(out.length === 7, '7 сегментов на 7 чанков');
    assert(out[0].number === '1' && out[6].number === '7', 'нумерация 1..7');
    const numbers = out.map(s => s.number);
    assert(new Set(numbers).size === 7, 'все номера УНИКАЛЬНЫ (нет дублей п.1)');
    assert(out[0].id === 'seg_0' && out[6].id === 'seg_6', 'id формата seg_{i} (0-индекс)');
    assert(out[1].heading === 'Часть 4, статьи 56 Конституции КР...', 'heading = первая строка');
    assert(out[0].heading === 'В Комитет против пыток ООН', 'heading первого чанка без хвоста');
    assert(out[0].text === chunks[0], 'text сохранён as-is');
}
// 8.2 — heading обрезается на 120 символов
{
    const longLine = 'А'.repeat(200);
    const out = wrapAsAnalyzeSegments([longLine + '\n\nостаток']);
    assert(out[0].heading.length === 120, 'heading обрезан до 120 ch');
    assert(out[0].text.length > 120, 'text НЕ обрезан');
}
// 8.3 — пустой / null вход
{
    assert(wrapAsAnalyzeSegments([]).length === 0, 'пустой массив → []');
    assert(wrapAsAnalyzeSegments(null).length === 0, 'null → []');
    assert(wrapAsAnalyzeSegments(undefined).length === 0, 'undefined → []');
}
// 8.4 — defensive: чанк с null/undefined/число внутри
{
    const out = wrapAsAnalyzeSegments(['нормальный', null, undefined, 42, '']);
    assert(out.length === 5, '5 сегментов даже на мусорный вход');
    assert(out[0].number === '1' && out[4].number === '5', 'нумерация продолжается');
    assert(out[1].text === '' && out[2].text === '', 'null/undefined → пустая строка');
    assert(out[3].text === '42', 'число → строка');
}
// 8.5 — комбинация с реальным segmentDocumentRegex (end-to-end)
{
    const doc = `Преамбула документа.

Статья 1. Первое.
Текст первой статьи.

Статья 2. Второе.
Текст второй статьи.`;
    const rawChunks = segmentDocumentRegex(doc);
    const segments = wrapAsAnalyzeSegments(rawChunks);
    assert(segments.length === 3, 'преамбула + 2 статьи = 3 сегмента');
    assert(segments[0].number === '1', 'преамбула → п.1');
    assert(segments[1].number === '2' && segments[2].number === '3', 'статьи → п.2, п.3');
    assert(segments[1].heading.startsWith('Статья 1'), 'heading сохраняет смысл маркера');
}
// 8.6 — основной кейс жалобы Аскарова: 4 чанка на "Часть N..." не дают дублей
{
    // Этот кейс реально упал на проде (см. отчёт от 2026-05-26)
    const realCase = [
        'В Комитет против пыток ООН',
        'Часть 4, статьи 56 Конституции КР',
        'Часть 5, статьи 56 гарантирует',
        'Части 1, 3, 5 и 6, статьи 59',
        'Части 1 и 2, статьи 56 — презумпция',
        'Часть 1, статьи 61 гарантирует',
        'Часть 2, статьи 9 УК КР'
    ];
    const out = wrapAsAnalyzeSegments(realCase);
    const tableRowLabels = out.map(s => `п.${s.number}`);
    const uniqueLabels = new Set(tableRowLabels);
    assert(uniqueLabels.size === 7,
        `Phase 4 UX-bug regression test: все 7 п.N УНИКАЛЬНЫ (got ${uniqueLabels.size}: ${[...uniqueLabels].join(', ')})`);
}

console.log('\n=== TEST 9: regression от 2026-05-27 — Word→TXT без \\n\\n ===');
// Реальная жалоба ООН сохранена Word'ом с одиночными \n между абзацами
// (нет \n\n). Раньше segmentDocumentRegex давал 3 гигантских слипшихся
// блока по ~2700ch каждый. Теперь split-by-markers внутри одного "параграфа"
// должен разделить документ на ~20+ структурированных чанков.
{
    const fakeUNComplaint =
`В Комитет против пыток ООН
через Управление Верховного комиссара ООН
ЖАЛОБА
в соответствии со статьёй 22 Конвенции против пыток
Часть 4, статьи 56 Конституции КР устанавливает абсолютный запрет.
Часть 5, статьи 56 гарантирует гуманное обращение.
Применительно к Конвенции против пыток нами установлены следующие нарушения:
–	статья 1 — запрет пыток: факт применения пыток подтверждается.
–	статья 2 — обязанность государства принимать эффективные меры.
–	статья 12 — обязанность проводить расследование.
В части Международного пакта о гражданских и политических правах:
–	статья 7 — запрет пыток и жестокого обращения;
–	статья 9 — право на свободу и личную неприкосновенность;
–	статья 14 — право на справедливое судебное разбирательство.`;
    const chunks = segmentDocumentRegex(fakeUNComplaint);
    assert(chunks.length >= 8,
        `жалоба без \\n\\n: разрезана хотя бы на 8 чанков (got ${chunks.length})`);
    // Каждая "статья N — ..." должна быть отдельным чанком
    const articleChunks = chunks.filter(c => /^[–\-—•]\s*статья\s+\d+/i.test(c.trim()));
    assert(articleChunks.length >= 5,
        `≥5 чанков начинаются с "– статья N" (got ${articleChunks.length})`);
    // Lossless: все не-whitespace символы должны быть сохранены
    const rawNonWs = fakeUNComplaint.replace(/\s/g, '');
    const chunksNonWs = chunks.join('').replace(/\s/g, '');
    assert(rawNonWs.length === chunksNonWs.length,
        `lossless: ${chunksNonWs.length} == ${rawNonWs.length} не-whitespace символов`);
    // Часть N статьи M не должны слипаться
    const partChunks = chunks.filter(c => /^Часть\s+\d/.test(c.trim()));
    assert(partChunks.length >= 2,
        `≥2 чанка начинаются с "Часть N" (got ${partChunks.length})`);
}
// 9.2 — буллит-маркеры (типичный Word-export)
{
    const text =
`Стороны договорились:
•	Поставлять товар вовремя.
•	Принимать оплату наличными.
•	Не разглашать сведения.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length >= 4,
        `буллиты разрезались на ≥4 чанка (got ${chunks.length}: ${chunks.map(c => c.slice(0, 20)).join(' | ')})`);
}
// 9.3 — тире-список
{
    const text =
`Истец обязан:
- предоставить документы;
- явиться на заседание;
- уведомить ответчика.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length >= 4,
        `тире-список разрезался на ≥4 чанка (got ${chunks.length})`);
}
// 9.4 — нижний регистр "статья N" в перечнях (как в исках)
{
    const text =
`Руководствуясь статьями 7, 10, 11, 222 Гражданского кодекса:
статья 7 — основания возникновения прав;
статья 10 — принцип разумности;
статья 11 — судебная защита;
статья 222 — содержание имущества.`;
    const chunks = segmentDocumentRegex(text);
    assert(chunks.length >= 4,
        `нижний регистр "статья N" разрезался на ≥4 чанка (got ${chunks.length})`);
}

console.log(`\n========== ИТОГ: ${pass} pass, ${fail} fail ==========`);
process.exit(fail === 0 ? 0 : 1);
