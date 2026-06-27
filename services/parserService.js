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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server'); // File API (Gemini Vision)

// Модель для Vision-парсинга (OCR сканов). gemini-2.5-pro — лучший OCR в Gemini API
// (ELO #7, 66.4% побед над Flash в OCR-бенчмарках). Override через env.
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ленивая ротация Gemini-ключей из llmClients (тот же GEMINI_API_KEY).
function geminiKey() { return require('./llmClients').getNextKey(); }

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

const VISION_PROMPT =
  'Извлеки ВЕСЬ текст этого документа в Markdown, сохраняя структуру: заголовки (##), ' +
  'списки, таблицы, нумерацию пунктов и статей. Верни ТОЛЬКО содержимое документа — ' +
  'без своих комментариев, пояснений и ограждений ```.';

/**
 * Парсинг тяжёлого/сканированного PDF через Gemini Vision (Google AI File API).
 * Грузим файл в File API → ждём ACTIVE → просим модель извлечь Markdown →
 * удаляем файл из File API (ZDR). Ключи — общая ротация getNextKey().
 * Этап 2 Backend Pivot (заменяет снесённый Docling/Cloud Run для тяжёлых PDF).
 */
async function parseViaGemini(filePath, originalName) {
  const fileManager = new GoogleAIFileManager(geminiKey());
  let uploaded = null;
  try {
    const up = await fileManager.uploadFile(filePath, {
      mimeType: 'application/pdf',
      displayName: originalName || 'document.pdf',
    });
    uploaded = up.file;

    // File API обрабатывает файл асинхронно: PROCESSING → ACTIVE (для PDF обычно быстро).
    let info = uploaded;
    for (let i = 0; i < 15 && info.state === 'PROCESSING'; i++) {
      await sleep(1500);
      info = await fileManager.getFile(uploaded.name);
    }
    if (info.state !== 'ACTIVE') {
      throw new Error(`Gemini File API: файл в состоянии ${info.state} (ожидался ACTIVE)`);
    }

    const genAI = new GoogleGenerativeAI(geminiKey());
    const model = genAI.getGenerativeModel({ model: VISION_MODEL });
    const res = await model.generateContent([
      { fileData: { mimeType: 'application/pdf', fileUri: info.uri } },
      { text: VISION_PROMPT },
    ]);
    const markdown = String((res && res.response && res.response.text && res.response.text()) || '').trim();
    if (!markdown) throw new Error('Gemini Vision вернул пустой текст');

    console.log(`[parseViaGemini] PDF → Gemini Vision (${VISION_MODEL}), ${markdown.length} симв.`);
    return {
      markdown,
      source: 'gemini-vision',
      structure_confidence: detectStructureConfidence(markdown),
      pages: null,
      needsFragmentation: false,
    };
  } finally {
    // ZDR: удаляем загруженный файл из Gemini File API.
    if (uploaded && uploaded.name) {
      fileManager.deleteFile(uploaded.name).catch(() => { /* игнор */ });
    }
  }
}

/**
 * Локальный парсинг файла → { markdown, source, structure_confidence, pages, needsFragmentation }.
 * ZDR: временный файл удаляется в finally.
 */
async function smartParse(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    const stat = await fs.promises.stat(filePath).catch(() => ({ size: Infinity }));

    // ── PDF ──
    if (ext === '.pdf') {
      // Тяжёлый PDF (>8МБ) — не буферим локально (риск OOM на 512MB) → Gemini Vision.
      if (stat.size > MAX_PDF_BYTES) {
        console.log(`[smartParse] PDF ${Math.round(stat.size / 1024 / 1024)}МБ > лимита → Gemini Vision`);
        return await parseViaGemini(filePath, originalName);
      }
      const buffer = await fs.promises.readFile(filePath);
      let pdf = null;
      try { pdf = await pdfParse(buffer); } catch (_) { pdf = null; }
      const pages = pdf ? pdf.numpages : null;
      const text = pdf ? String(pdf.text || '').trim() : '';
      if (!text) {
        // Нет текстового слоя (скан) → OCR через Gemini Vision.
        console.log(`[smartParse] PDF pages=${pages}, текст пуст (скан) → Gemini Vision (OCR)`);
        return await parseViaGemini(filePath, originalName);
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
