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

// --- Публичный API ---------------------------------------------------------
/**
 * Извлекает Markdown из файла любого поддерживаемого типа.
 * ВАЖНО: filePath (временный файл в /tmp) удаляется здесь же в finally (ZDR).
 *
 * @param {string} filePath     путь к временному файлу
 * @param {string} originalName исходное имя (нужно расширение)
 * @returns {Promise<{markdown:string, source:string, structure_confidence:'high'|'low'}>}
 */
async function extractMarkdown(filePath, originalName) {
  try {
    // Единый путь: ВСЕ форматы (.pdf/.docx/.txt/...) -> Cloud Run/Docling.
    return await parseViaCloudRun(filePath, originalName);
  } finally {
    // ZDR: гарантированно удаляем временный файл сразу после обработки.
    fs.promises.unlink(filePath).catch(() => { /* файл мог не создаться — игнор */ });
  }
}

module.exports = {
  extractMarkdown,
  // экспортируем для unit-тестов / переиспользования
  _internals: { detectStructureConfidence, isRetriableError, parseViaCloudRun },
};
