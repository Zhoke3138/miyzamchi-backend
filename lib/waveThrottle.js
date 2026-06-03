'use strict';
/**
 * Miyzamchi 2.0 — Волновой Троттлер (Token-Bucket Waves)
 * ======================================================
 * Надёжная защита от HTTP 429 при параллельной валидации N чанков.
 *
 * Логика волны (ТЗ Фаза 2.1):
 *   • до waveSize задач в одной волне (по умолчанию 20)
 *   • внутри волны старты раздвинуты на stepMs (50ms) — сглаживаем burst
 *   • ждём завершения ВСЕЙ волны, затем пауза wavePauseMs (1000ms) перед следующей
 *
 * Контракт: каждая задача «оседает» (settle) — одна ошибка не валит остальные.
 * Возврат — массив той же длины и порядка, что вход:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Array<any>} items                  входные элементы (чанки)
 * @param {(item:any, index:number)=>Promise} worker  обработчик одного элемента
 * @param {object} [opts]
 * @param {number} [opts.waveSize=20]
 * @param {number} [opts.stepMs=50]
 * @param {number} [opts.wavePauseMs=1000]
 * @param {(info:{wave:number, total:number, done:number})=>void} [opts.onWaveDone]
 */
async function runInWaves(items, worker, opts = {}) {
  const waveSize = opts.waveSize ?? 20;
  const stepMs = opts.stepMs ?? 50;
  const wavePauseMs = opts.wavePauseMs ?? 1000;
  const onWaveDone = typeof opts.onWaveDone === 'function' ? opts.onWaveDone : null;

  const results = new Array(items.length);
  const totalWaves = Math.ceil(items.length / waveSize) || 0;

  for (let start = 0, wave = 0; start < items.length; start += waveSize, wave += 1) {
    const end = Math.min(start + waveSize, items.length);
    const launched = [];

    for (let i = start; i < end; i += 1) {
      const idx = i;
      const offset = (i - start) * stepMs; // шаг 50ms между стартами внутри волны
      const p = sleep(offset)
        .then(() => worker(items[idx], idx))
        .then((value) => { results[idx] = { status: 'fulfilled', value }; })
        .catch((reason) => { results[idx] = { status: 'rejected', reason }; });
      launched.push(p);
    }

    await Promise.all(launched); // дожидаемся завершения всей волны

    if (onWaveDone) onWaveDone({ wave: wave + 1, total: totalWaves, done: end });

    if (end < items.length) {
      await sleep(wavePauseMs); // пауза между волнами — защита от 429
    }
  }

  return results;
}

module.exports = { runInWaves };
