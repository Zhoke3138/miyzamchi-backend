function expandCyrillicAbbreviation(text, abbrPattern, replacement) {
    const regex = new RegExp(`(^|[^a-zа-яё0-9])(${abbrPattern})([^a-zа-яё0-9]|$)`, 'gi');
    return text.replace(regex, (match, p1, p2, p3) => {
        return p1 + replacement + p3;
    });
}

function expandQueryAbbreviations(query) {
    let expandedQuery = query;
    const replacements = [
        { pattern: 'гк\\s*кр|гк', replacement: 'Гражданский кодекс Кыргызской Республики' },
        { pattern: 'ук\\s*кр|ук', replacement: 'Уголовный кодекс Кыргызской Республики' },
        { pattern: 'тк\\s*кр|тк', replacement: 'Трудовой кодекс Кыргызской Республики' },
        { pattern: 'упк\\s*кр|упк', replacement: 'Уголовно-процессуальный кодекс Кыргызской Республики' },
        { pattern: 'гпк\\s*кр|гпк', replacement: 'Гражданский процессуальный кодекс Кыргызской Республики' },
        { pattern: 'коап\\s*кр|коап|коао\\s*кр|коао', replacement: 'Кодекс об административной ответственности Кыргызской Республики' },
        { pattern: 'нк\\s*кр|нк', replacement: 'Налоговый кодекс Кыргызской Республики' },
        { pattern: 'ск\\s*кр|ск', replacement: 'Семейный кодекс Кыргызской Республики' },
        { pattern: 'зк\\s*кр|зк', replacement: 'Земельный кодекс Кыргызской Республики' },
        { pattern: 'жк\\s*кр|жк', replacement: 'Жилищный кодекс Кыргызской Республики' },
        { pattern: 'бк\\s*кр|бк', replacement: 'Бюджетный кодекс Кыргызской Республики' }
    ];

    for (const r of replacements) {
        expandedQuery = expandCyrillicAbbreviation(expandedQuery, r.pattern, r.replacement);
    }
    return expandedQuery;
}

console.log(expandQueryAbbreviations("статья 245 ГК Кр?"));
console.log(expandQueryAbbreviations("ст 10 тк кр"));
console.log(expandQueryAbbreviations("ГК статья 1"));
