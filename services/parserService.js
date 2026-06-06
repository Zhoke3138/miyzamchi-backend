'use strict';
/**
 * Miyzamchi 2.0 — Parser Service (Node-сторона оркестратора)
 * ==========================================================
 * Единая точка «файл -> Markdown». ВСЕ форматы (.pdf/.docx/.txt/...) уходят в
 * приватный Cloud Run (IBM Docling) — единый умный ИИ-парсер, понимающий
 * семантику документа. Локальный mammoth/fs-парсинг УБРАН (давал «кашу» при
 * чанкинге, не понимал структуру).
 *
 * АУТЕНТИФИКАЦИЯ Cloud Run (OIDC ID-token):
 *   Render НЕ внутри GCP, поэтому metadata-сервер недоступен. Мы храним JSON-ключ
 *   сервис-аккаунта в env GCP_SA_KEY_JSON и через google-auth-library минтим
 *   ID-token с audience = URL сервиса. Cloud Run (IAM) валидирует токен сам.
 *
 * ZERO DATA RETENTION:
 *   Временный файл из /tmp удаляется в блоке finally СРАЗУ после обработки —
 *   независимо от успеха/ошибки. Большой PDF не читаем в Buffer: стримим с диска
 *   (fs.createReadStream), чтобы не удвоить память на 512MB-инстансе.
 *
 * ENV:
 *   PARSER_SERVICE_URL   — базовый URL Cloud Run (https://miyzamchi-parser-xxx.run.app)
 *   GCP_SA_KEY_JSON      — содержимое JSON-ключа сервис-аккаунта (одной строкой)
 *   PARSER_TIMEOUT_MS    — таймаут запроса, по умолч. 100000 (учёт холодного старта)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleAuth } = require('google-auth-library');
const pdfParse = require('pdf-parse'); // локальный счётчик страниц + текст (дёшево, для роутинга)
const mammoth = require('mammoth');    // локальное извлечение текста DOCX (только короткий путь)

const DEFAULT_TIMEOUT_MS = Number(process.env.PARSER_TIMEOUT_MS || 100000);

// MIME по расширению — для корректного multipart-заголовка к Docling.
// Docling определяет формат по имени файла, но валидный contentType не вредит.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// --- Безопасная загрузка service-account ключа из env ----------------------
// На Render значение многострочного JSON часто приходит «битым»: либо обёрнуто
// внешними кавычками, либо переносы в private_key экранированы как '\\n' (2 символа)
// вместо реальных \n — тогда RSA-подпись OIDC-токена невалидна и Cloud Run даёт 403.
function loadServiceAccount() {
  const raw = process.env.GCP_SA_KEY_JSON;
  if (!raw) throw new Error('GCP_SA_KEY_JSON не задан в env');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e1) {
    // Мягкая чистка: снимаем внешние кавычки и пробуем снова.
    try {
      const cleaned = raw.trim().replace(/^['"]+|['"]+$/g, '');
      creds = JSON.parse(cleaned);
      console.warn('[ParserAuth] GCP_SA_KEY_JSON распарсен после снятия внешних кавычек');
    } catch (e2) {
      console.error('[ParserAuth] JSON.parse(GCP_SA_KEY_JSON) FAILED:', e1.message);
      throw new Error(`GCP_SA_KEY_JSON: невалидный JSON (${e1.message})`);
    }
  }

  // КРИТИЧНО: нормализуем экранированные переносы в private_key (Render-классика).
  if (creds && typeof creds.private_key === 'string' && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    console.log('[ParserAuth] private_key: нормализовал экранированные \\n → реальные переносы');
  }
  return creds;
}

// --- OIDC ID-token client (ленивый синглтон) ------------------------------
let _idTokenClientPromise = null;

function getIdTokenClient(audience) {
  if (!_idTokenClientPromise) {
    const credentials = loadServiceAccount();
    console.log('[ParserAuth] SA-ключ распарсен УСПЕШНО | client_email:',
      credentials.client_email, '| audience:', audience);
    const auth = new GoogleAuth({ credentials });
    // targetAudience = базовый URL сервиса (без /parse) — иначе токен невалиден.
    _idTokenClientPromise = auth.getIdTokenClient(audience);
  }
  return _idTokenClientPromise;
}

async function buildAuthHeaders(audience) {
  const client = await getIdTokenClient(audience);
  // ФИКС 403: в google-auth-library v10 getRequestHeaders() возвращает fetch-style
  // Headers (НЕ plain object). Старый код делал `{ ...authHeaders }` — спред Headers
  // даёт {} → Authorization терялся, Cloud Run видел запрос без токена → 403.
  // Берём заголовок корректно через Headers.get() (работает и для v9 plain-object).
  const h = await client.getRequestHeaders(audience);
  let authorization;
  if (h && typeof h.get === 'function') {
    authorization = h.get('authorization') || h.get('Authorization'); // v10 Headers
  } else if (h) {
    authorization = h.Authorization || h.authorization;                // v9 plain object
  }
  if (!authorization) throw new Error('OIDC Authorization пуст (getRequestHeaders не вернул токен)');

  const token = String(authorization).replace(/^Bearer\s+/i, '');
  console.log('[ParserAuth] idToken получен:', token.substring(0, 10) + '...');
  return { Authorization: `Bearer ${token}` };
}

// --- Вспомогательное -------------------------------------------------------
/** Graceful Degradation: есть ли '##'-заголовки -> уверенность структуры. */
function detectStructureConfidence(markdown) {
  return /^\s{0,3}#{2,}\s/m.test(markdown) ? 'high' : 'low';
}

/** Холодный старт / временная недоступность Cloud Run -> стоит ретраить. */
function isRetriableError(err) {
  if (err.code === 'ECONNABORTED') return true;          // таймаут axios
  if (err.code === 'ECONNRESET') return true;
  const status = err.response && err.response.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function cleanError(err) {
  const status = err.response && err.response.status;
  const detail = err.response && err.response.data && err.response.data.detail;
  const msg = detail || err.message || 'unknown error';
  const e = new Error(`Parser service error${status ? ` [${status}]` : ''}: ${msg}`);
  e.cause = err;
  return e;
}

// --- ЛЮБОЙ формат -> Cloud Run (Docling) ----------------------------------
// Единый умный парсер: PDF/DOCX/TXT/... — Docling сам определяет формат по имени.
async function parseViaCloudRun(filePath, originalName, attempt = 1) {
  const base = process.env.PARSER_SERVICE_URL;
  if (!base) throw new Error('PARSER_SERVICE_URL не задан');
  const audience = base.replace(/\/+$/, '');   // базовый URL без хвостовых слешей и /parse
  const endpoint = `${audience}/parse`;

  // Диагностика: видно, нет ли лишних слешей / неверного URL.
  console.log('[Parser] PARSER_SERVICE_URL=', JSON.stringify(base),
    '| audience=', audience, '| endpoint=', endpoint, '| attempt=', attempt);

  const ext = path.extname(originalName || filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';

  // Свежий стрим и форма на КАЖДУЮ попытку (стрим одноразовый!).
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: originalName,
    contentType,
  });
  const authHeaders = await buildAuthHeaders(audience);

  try {
    const res = await axios.post(endpoint, form, {
      headers: { ...form.getHeaders(), ...authHeaders },
      timeout: DEFAULT_TIMEOUT_MS,
      maxBodyLength: Infinity,    // не упираемся в лимит тела (большой файл)
      maxContentLength: Infinity,
    });
    const markdown = (res.data && res.data.markdown) || '';
    return {
      markdown,
      source: 'docling',
      pages: res.data.pages || null,
      structure_confidence: detectStructureConfidence(markdown),
    };
  } catch (err) {
    // Полные детали ошибки авторизации/запроса (403 обычно несёт тело от IAM Cloud Run).
    const status = err.response && err.response.status;
    const data = err.response && err.response.data;
    console.error('[Parser] Cloud Run FAILED:', status || err.code || '(no status)',
      '| data:', data ? JSON.stringify(data).slice(0, 600) : (err.message || ''));

    if (attempt === 1 && isRetriableError(err)) {
      // Один «прогревочный» ретрай: первый запрос мог разбудить холодный Cloud Run.
      return parseViaCloudRun(filePath, originalName, attempt + 1);
    }
    throw cleanError(err);
  }
}

// --- Умный роутинг парсинга (Docling vs локально) -------------------------
const SMALL_PAGE_LIMIT   = 3;                  // ≤3 страниц = «короткий» документ
const SMALL_CHAR_LIMIT   = 9000;               // ~3 страницы юр-текста (для DOCX/TXT)
const SAFE_BUFFER_BYTES  = 4 * 1024 * 1024;    // выше — НЕ буферим в RAM, сразу Docling (стримом)

async function viaDocling(filePath, originalName) {
  const r = await parseViaCloudRun(filePath, originalName);
  return { ...r, needsFragmentation: false };
}

/**
 * Роутер парсинга. Короткие документы (≤3 стр.) НЕ дёргают тяжёлый Docling:
 * текст извлекается локально (pdf-parse/mammoth/fs), а смысловую нарезку делает
 * Gemini (needsFragmentation:true → роут вызовет deps.fragmentDocument).
 * Большие документы и СКАНЫ (PDF без текстового слоя) → Docling/Cloud Run.
 * ZDR: временный файл удаляется здесь же в finally.
 *
 * @returns {Promise<{markdown:string, source:string, structure_confidence:'high'|'low',
 *                    pages:number|null, needsFragmentation:boolean}>}
 */
async function smartParse(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    const stat = await fs.promises.stat(filePath).catch(() => ({ size: Infinity }));

    // ── PDF ──
    if (ext === '.pdf') {
      if (stat.size > SAFE_BUFFER_BYTES) {
        console.log(`[smartParse] PDF ${stat.size}B > буфер-лимита → Docling (не буферим)`);
        return await viaDocling(filePath, originalName);
      }
      const buffer = await fs.promises.readFile(filePath);
      let pdf = null;
      try { pdf = await pdfParse(buffer); } catch (_) { pdf = null; }
      const pages = pdf ? pdf.numpages : null;
      const text = pdf ? String(pdf.text || '').trim() : '';

      if (!text) {                                    // нет текстового слоя → СКАН → OCR в Docling
        console.log(`[smartParse] PDF pages=${pages}, текст пуст (скан?) → Docling (OCR)`);
        return await viaDocling(filePath, originalName);
      }
      if (pages && pages > SMALL_PAGE_LIMIT) {        // многостраничный → Docling
        console.log(`[smartParse] PDF pages=${pages} > ${SMALL_PAGE_LIMIT} → Docling`);
        return await viaDocling(filePath, originalName);
      }
      console.log(`[smartParse] PDF pages=${pages} ≤ ${SMALL_PAGE_LIMIT} → лёгкий путь (Gemini)`);
      return { markdown: text, source: 'pdf-parse', structure_confidence: 'low', pages, needsFragmentation: true };
    }

    // ── DOCX ──
    if (ext === '.docx' || ext === '.doc') {
      if (stat.size > SAFE_BUFFER_BYTES) return await viaDocling(filePath, originalName);
      const buffer = await fs.promises.readFile(filePath);
      let text = '';
      try { const r = await mammoth.extractRawText({ buffer }); text = String(r.value || '').trim(); } catch (_) { text = ''; }
      if (!text) return await viaDocling(filePath, originalName);   // не извлекли локально → Docling
      if (text.length > SMALL_CHAR_LIMIT) {
        console.log(`[smartParse] DOCX chars=${text.length} > ${SMALL_CHAR_LIMIT} → Docling`);
        return await viaDocling(filePath, originalName);
      }
      console.log(`[smartParse] DOCX chars=${text.length} ≤ ${SMALL_CHAR_LIMIT} → лёгкий путь (Gemini)`);
      return { markdown: text, source: 'mammoth', structure_confidence: 'low', pages: Math.ceil(text.length / 3000), needsFragmentation: true };
    }

    // ── TXT/MD (Docling не нужен в принципе) ──
    if (ext === '.txt' || ext === '.md') {
      const text = (await fs.promises.readFile(filePath, 'utf8')).trim();
      const confidence = detectStructureConfidence(text);
      const short = text.length <= SMALL_CHAR_LIMIT;
      return {
        markdown: text, source: 'txt', structure_confidence: confidence,
        pages: Math.ceil(text.length / 3000), needsFragmentation: short,
      };
    }

    // ── прочие форматы → Docling ──
    return await viaDocling(filePath, originalName);
  } finally {
    // ZDR: гарантированно удаляем временный файл сразу после обработки.
    fs.promises.unlink(filePath).catch(() => { /* файл мог не создаться — игнор */ });
  }
}

// --- Публичный API ---------------------------------------------------------
/**
 * LEGACY: извлекает Markdown ЛЮБОГО формата через Docling (без роутинга).
 * Оставлен для обратной совместимости; основной путь теперь smartParse.
 * ZDR: filePath удаляется в finally.
 */
async function extractMarkdown(filePath, originalName) {
  try {
    return await parseViaCloudRun(filePath, originalName);
  } finally {
    fs.promises.unlink(filePath).catch(() => { /* игнор */ });
  }
}

module.exports = {
  smartParse,
  extractMarkdown,
  // экспортируем для unit-тестов / переиспользования
  _internals: { detectStructureConfidence, isRetriableError, parseViaCloudRun, viaDocling,
    SMALL_PAGE_LIMIT, SMALL_CHAR_LIMIT, SAFE_BUFFER_BYTES },
};
