'use strict';
/**
 * Miyzamchi 2.0 — Parser Service (Node, локальный парсинг)
 * =======================================================
 * Этап 1 Backend Pivot (11.06.2026): микросервис Docling/Cloud Run УДАЛЁН
 * (хрупкая OIDC-аутентификация, холодные старты, отдельный контейнер 2GB).
 * Парсинг теперь нативно в Node:
 *   • PDF с текстовым слоем  → pdf-parse (лимит ~8МБ во избежание OOM на 512MB Render)
 *   • DOCX                    → mammoth
 *   • TXT / MD                → fs
 * Сканы (PDF без текста), слишком большие/экзотические файлы → ошибка
 * PDF_PARSE_UNAVAILABLE до внедрения Gemini Vision (Этап 2 Backend Pivot).
 *
 * ZERO DATA RETENTION: временный файл из /tmp удаляется в finally сразу после
 * обработки — независимо от успеха/ошибки.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse'); // извлечение текста + счётчик страниц PDF
const mammoth = require('mammoth');    // извлечение текста DOCX

const SMALL_PAGE_LIMIT = 3;                 // ≤3 страниц = «короткий» документ
const SMALL_CHAR_LIMIT = 9000;              // ~3 страницы юр-текста (DOCX/TXT)
const MAX_PDF_BYTES = 8 * 1024 * 1024;      // выше — риск OOM на 512MB; ждём Gemini Vision (Этап 2)

/** Graceful Degradation: есть ли '##'-заголовки → уверенность структуры. */
function detectStructureConfidence(markdown) {
  return /^\s{0,3}#{2,}\s/m.test(markdown) ? 'high' : 'low';
}

/** Формат пока не поддерживается локально — роут покажет это юристу через SSE. */
function unsupported(msg) {
  const e = new Error(`PDF_PARSE_UNAVAILABLE: ${msg}`);
  e.code = 'PARSE_UNSUPPORTED';
  return e;
}

/**
 * Локальный парсинг файла → { markdown, source, structure_confidence, pages, needsFragmentation }.
 * ZDR: временный файл удаляется в finally.
 */
async function smartParse(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    const stat = await fs.promises.stat(filePath).catch(() => ({ size: Infinity }));

    // ── PDF (только текстовый слой, до лимита размера) ──
    if (ext === '.pdf') {
      if (stat.size > MAX_PDF_BYTES) {
        throw unsupported(`PDF ${Math.round(stat.size / 1024 / 1024)}МБ слишком большой для локального парсинга. Будет доступно после внедрения Gemini Vision (Этап 2). Пока — DOCX/TXT или текстовый PDF до 8 МБ.`);
      }
      const buffer = await fs.promises.readFile(filePath);
      let pdf = null;
      try { pdf = await pdfParse(buffer); } catch (_) { pdf = null; }
      const pages = pdf ? pdf.numpages : null;
      const text = pdf ? String(pdf.text || '').trim() : '';
      if (!text) {
        throw unsupported('PDF без текстового слоя (скан). Распознавание (OCR) будет доступно после Gemini Vision (Этап 2).');
      }
      console.log(`[smartParse] PDF pages=${pages} → pdf-parse (локально, ${text.length} симв.)`);
      return {
        markdown: text,
        source: 'pdf-parse',
        structure_confidence: detectStructureConfidence(text),
        pages,
        needsFragmentation: !(pages && pages > SMALL_PAGE_LIMIT),
      };
    }

    // ── DOCX ──
    if (ext === '.docx' || ext === '.doc') {
      const buffer = await fs.promises.readFile(filePath);
      let text = '';
      try { const r = await mammoth.extractRawText({ buffer }); text = String(r.value || '').trim(); } catch (_) { text = ''; }
      if (!text) throw unsupported('Не удалось извлечь текст из DOCX (возможно, документ состоит из изображений-сканов).');
      console.log(`[smartParse] DOCX → mammoth (локально, ${text.length} симв.)`);
      return {
        markdown: text,
        source: 'mammoth',
        structure_confidence: detectStructureConfidence(text),
        pages: Math.ceil(text.length / 3000),
        needsFragmentation: text.length <= SMALL_CHAR_LIMIT,
      };
    }

    // ── TXT / MD ──
    if (ext === '.txt' || ext === '.md') {
      const text = (await fs.promises.readFile(filePath, 'utf8')).trim();
      return {
        markdown: text,
        source: 'txt',
        structure_confidence: detectStructureConfidence(text),
        pages: Math.ceil(text.length / 3000),
        needsFragmentation: text.length <= SMALL_CHAR_LIMIT,
      };
    }

    throw unsupported(`Формат ${ext || '(неизвестный)'} пока не поддерживается. Используйте DOCX, TXT или текстовый PDF.`);
  } finally {
    // ZDR: гарантированно удаляем временный файл сразу после обработки.
    fs.promises.unlink(filePath).catch(() => { /* файл мог не создаться — игнор */ });
  }
}

/** LEGACY-совместимость: делегирует в smartParse (старый прямой Docling-путь удалён). */
async function extractMarkdown(filePath, originalName) {
  return smartParse(filePath, originalName);
}

module.exports = {
  smartParse,
  extractMarkdown,
  _internals: { detectStructureConfidence, SMALL_PAGE_LIMIT, SMALL_CHAR_LIMIT, MAX_PDF_BYTES },
};
