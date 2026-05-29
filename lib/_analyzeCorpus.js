// Аналитический скрипт по test_corpus/.
// Проходит по всем .txt файлам, прогоняет через segmentDocumentRegex,
// ищет citations паттернами, выдаёт отчёт.
//
// Запуск: node lib/_analyzeCorpus.js

const fs = require('fs');
const path = require('path');
const { segmentDocumentRegex, wrapAsAnalyzeSegments } = require('./segmentRegex');
const { normalizeNpaName } = require('./npaAliases');

const CORPUS_DIR = path.join(__dirname, '..', 'test_corpus');

// Citation patterns — что считаем явной ссылкой на НПА
const CITATION_PATTERNS = [
    /ст(?:\.|атья|атьи|атьями?|атьей|атьею)\s*\d+/giu,
    /часть\s+\d+\s+стать[яеи]\s*\d+/giu,
    /части\s+\d+(?:\s*,\s*\d+)*\s+стать[яеи]\s*\d+/giu,
    /пункт[ауеом]*\s+\d+\s+стать[яеи]\s*\d+/giu,
];

// NPA mention patterns — какие НПА упоминаются (для оценки покрытия словаря)
const NPA_MENTIONS = [
    { re: /уголовн[а-я]+\s+кодекс/giu, name: 'УК КР' },
    { re: /угол[а-я.]+-процессуальн[а-я]+\s+кодекс/giu, name: 'УПК КР' },
    { re: /гражданск[а-я]+\s+кодекс/giu, name: 'ГК КР' },
    { re: /гражданск[а-я.]+\s+процессуальн[а-я]+\s+кодекс/giu, name: 'ГПК КР' },
    { re: /трудов[а-я]+\s+кодекс/giu, name: 'ТК КР' },
    { re: /семейн[а-я]+\s+кодекс/giu, name: 'СК КР' },
    { re: /налогов[а-я]+\s+кодекс/giu, name: 'НК КР' },
    { re: /жилищн[а-я]+\s+кодекс/giu, name: 'ЖК КР' },
    { re: /земельн[а-я]+\s+кодекс/giu, name: 'ЗК КР' },
    { re: /кодекс[а-я.\s]+«?\s*о\s+нарушениях\s*»?/giu, name: 'Кодекс КР «О нарушениях»' },
    { re: /конституц[а-я]+\s+кыргызск/giu, name: 'Конституция КР' },
    { re: /закон[а-я.]*\s+кр[а-я.\s]*«[^»]+»/giu, name: 'Закон КР [специальный]' },
    { re: /конвенц[а-я]+\s+против\s+пыток/giu, name: 'Конвенция против пыток' },
    { re: /пакт[а-я.]*\s+о\s+гражданских\s+и\s+политических\s+правах/giu, name: 'Международный пакт о гражданских и политических правах' },
    { re: /постановл[а-я.]+\s+правительства/giu, name: 'Постановление Правительства КР' },
];

function walkDir(dir) {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...walkDir(full));
        else if (entry.name.endsWith('.txt')) result.push(full);
    }
    return result;
}

function countCitations(text) {
    let total = 0;
    for (const re of CITATION_PATTERNS) {
        const m = text.match(re);
        if (m) total += m.length;
    }
    return total;
}

function detectNpaMentions(text) {
    const found = new Set();
    for (const { re, name } of NPA_MENTIONS) {
        if (re.test(text)) found.add(name);
    }
    return Array.from(found);
}

function analyze() {
    const files = walkDir(CORPUS_DIR);
    const byCategory = {};

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const category = path.basename(path.dirname(file));
        if (!byCategory[category]) byCategory[category] = [];

        if (text.trim().length < 100) {
            byCategory[category].push({
                name: path.basename(file),
                empty: true,
                rawLen: text.length
            });
            continue;
        }

        const segments = wrapAsAnalyzeSegments(segmentDocumentRegex(text));
        const citationCount = countCitations(text);
        const npaMentioned = detectNpaMentions(text);

        byCategory[category].push({
            name: path.basename(file),
            rawLen: text.length,
            segmentsCount: segments.length,
            avgChunkLen: Math.round(segments.reduce((s, x) => s + x.text.length, 0) / segments.length),
            maxChunkLen: Math.max(...segments.map(s => s.text.length)),
            citationCount,
            phase3Worthwhile: citationCount >= 2,
            npaMentioned,
            firstSegHeading: segments[0]?.heading?.slice(0, 60) || ''
        });
    }

    // Output report
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  АНАЛИЗ test_corpus/ — данные для тюнинга Selective Reasoning v2.0');
    console.log('═══════════════════════════════════════════════════════════════════\n');

    const stats = { total: 0, phase3Yes: 0, phase3No: 0, empty: 0 };
    const allNpas = new Map();

    for (const cat of Object.keys(byCategory).sort()) {
        console.log(`\n■ ${cat} (${byCategory[cat].length} файлов)`);
        for (const f of byCategory[cat]) {
            stats.total++;
            if (f.empty) {
                stats.empty++;
                console.log(`    ◯ ${f.name} — ПУСТОЙ (${f.rawLen}ch, skip)`);
                continue;
            }
            const verdict = f.phase3Worthwhile ? '✓ keep Phase 3' : '✗ skip Phase 3';
            if (f.phase3Worthwhile) stats.phase3Yes++; else stats.phase3No++;
            console.log(`    ${f.phase3Worthwhile ? '🎯' : '🚦'} ${f.name}`);
            console.log(`        длина=${f.rawLen}ch | сегм.=${f.segmentsCount} | avg=${f.avgChunkLen}ch | max=${f.maxChunkLen}ch`);
            console.log(`        citations≈${f.citationCount} | ${verdict}`);
            if (f.npaMentioned.length > 0) {
                console.log(`        НПА: ${f.npaMentioned.join(', ')}`);
                for (const n of f.npaMentioned) {
                    allNpas.set(n, (allNpas.get(n) || 0) + 1);
                }
            }
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('  СВОДКА');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`Всего файлов:       ${stats.total}`);
    console.log(`Пустых:             ${stats.empty} (placeholder'ы)`);
    console.log(`Phase 3 нужна:      ${stats.phase3Yes}  (citations ≥ 2)`);
    console.log(`Phase 3 бесполезна: ${stats.phase3No}  (citations < 2 → skip — экономия ~24с)`);

    console.log('\n■ Топ упоминаемых НПА (по числу документов):');
    const sortedNpas = [...allNpas.entries()].sort((a, b) => b[1] - a[1]);
    for (const [npa, count] of sortedNpas) {
        const inDict = normalizeNpaName(npa) !== npa;
        const dictStatus = inDict ? '✓ в словаре' : '⚠ ОТСУТСТВУЕТ в npaAliases.js';
        console.log(`  ${count}× ${npa.padEnd(55)} ${dictStatus}`);
    }

    console.log('\n■ Smart-skip Phase 3 — экономия:');
    const skipSec = stats.phase3No * 24;
    console.log(`  Если внедрить smart-skip → ${stats.phase3No} документов из ${stats.total} пропустят Phase 3`);
    console.log(`  Гипотетическая экономия: ~${skipSec}с total (при условии что все эти доки реально будут анализироваться)`);
}

analyze();
