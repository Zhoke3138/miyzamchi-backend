'use strict';
/**
 * Регресс-тест для services/compareService.js
 * Запуск:  node lib/_smokeTestCompareService.js
 * Покрывает: redline/ratio, «числовой страж», XSS-экранирование, filterHits,
 *            legalAudit с замоканными deps (без сети).
 */
const assert = require('assert');
const svc = require('../services/compareService');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('compareService smoke:');

// ── 1. Полное добавление / удаление ─────────────────────────────────
{
  const add = svc.classifyChange('', 'Новый пункт об ответственности.');
  ok('добавление: ratio=1', add.ratio === 1);
  ok('добавление: <ins> в html', add.html.includes('<ins'));
  ok('добавление: не косметика', add.isCosmetic === false);

  const del = svc.classifyChange('Старый пункт.', '');
  ok('удаление: ratio=1', del.ratio === 1);
  ok('удаление: <del> в html', del.html.includes('<del'));
}

// ── 2. Косметика (опечатка) → isCosmetic, LLM пропускается ───────────
{
  const base = 'Исполнитель обязуется выполнить работы в установленный договором срок надлежащего качества согласно технической документации и приложениям.';
  const typo = base.replace('качества', 'качествa'); // одна буква (лат a)
  const c = svc.classifyChange(base, typo);
  ok('опечатка: ratio мал', c.ratio < svc.COSMETIC_RATIO);
  ok('опечатка: isCosmetic=true', c.isCosmetic === true);
}

// ── 3. КИЛЛЕР-ФИЧА: «числовой страж» — смена % не косметика ──────────
{
  const oldT = 'За просрочку начисляется пеня в размере 0,1% за каждый день, но не более 25% от суммы.';
  const newT = 'За просрочку начисляется пеня в размере 10% за каждый день.';
  const c = svc.classifyChange(oldT, newT);
  ok('числовой страж: numericFlag=true', c.numericFlag === true);
  ok('числовой страж: НЕ косметика даже при малом ratio', c.isCosmetic === false);
}

// ── 4. XSS-экранирование текста документа ───────────────────────────
{
  const c = svc.classifyChange('обычный текст пункта договора', '<script>alert(1)</script> внедрение');
  ok('xss: нет сырого <script>', !c.html.includes('<script>'));
  ok('xss: экранировано в &lt;script&gt;', c.html.includes('&lt;script&gt;'));
}

// ── 5. filterHits: относительный+абсолютный порог ───────────────────
{
  const hits = [
    { id: 'a', score: 0.90 }, { id: 'b', score: 0.80 },
    { id: 'c', score: 0.40 }, { id: 'd', score: 0.10 },
  ];
  const kept = svc.filterHits(hits);
  ok('filterHits: отсёк низкие score', kept.every(h => h.score >= 0.40));
  ok('filterHits: топ остался', kept[0].id === 'a');

  ok('filterHits: пустой вход → []', svc.filterHits([]).length === 0);

  const weak = [{ id: 'x', score: 0.20 }, { id: 'y', score: 0.15 }];
  ok('filterHits: всё слабое → подстраховка (не пусто)', svc.filterHits(weak).length > 0);
}

// ── 6. legalAudit: короткий пункт → skipped (без сети) ───────────────
(async () => {
  const short = await svc.legalAudit('г. Бишкек, 2026 г.');
  ok('legalAudit: короткий пункт → skipped', short.status === 'skipped');

  // ── 7. legalAudit: нарушение НПА через замоканные deps ─────────────
  const mockDeps = {
    expandQuery: async () => ({ npa: 'ГК КР', article: '310', queries: ['q'] }),
    pineconeSearch: async () => ([{ id: '1', score: 0.9, metadata: { npa_title: 'ГК', full_text: 'норма' } }]),
    validate: async () => ({ status: 'error', marker: '🔴 ОШИБКА', detail: 'противоречит ст.310', cited_articles: ['ГК КР, ст.310'] }),
  };
  const longClause = 'Сторона полностью освобождается от любой ответственности за неисполнение обязательств при любых обстоятельствах без исключений и оговорок.';
  const viol = await svc.legalAudit(longClause, mockDeps);
  ok('legalAudit: вернул error', viol.status === 'error');
  ok('legalAudit: прокинул cited_articles', viol.cited_articles[0] === 'ГК КР, ст.310');
  ok('legalAudit: прокинул npa', viol.npa === 'ГК КР');

  // ── 8. legalAudit: нет релевантных норм → no_base ──────────────────
  const noBaseDeps = {
    expandQuery: async () => ({ npa: null, article: null, queries: ['q'] }),
    pineconeSearch: async () => ([]),
    validate: async () => { throw new Error('не должно вызываться'); },
  };
  const nb = await svc.legalAudit(longClause, noBaseDeps);
  ok('legalAudit: пустой Pinecone → no_base', nb.status === 'no_base');

  // ── 9. legalAudit: сбой deps → graceful skipped ───────────────────
  const boomDeps = { expandQuery: async () => { throw new Error('boom'); } };
  const boom = await svc.legalAudit(longClause, boomDeps);
  ok('legalAudit: сбой → graceful skipped', boom.status === 'skipped');

  console.log(`\ncompareService: ${passed}/${passed} проверок прошли ✅`);
})().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
