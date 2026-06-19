import { SuperDocEditor } from '@superdoc-dev/react';
import '@superdoc-dev/react/style.css';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as ReactDOM from 'react-dom/client';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { diff_match_patch } from 'diff-match-patch';
import { LANGS, t as i18nT, getAppLang, setAppLang, subscribeLang } from './translations.js';
import './ide-styles.css';

window.React = React;
window.DOMPurify = DOMPurify;
window.marked = marked;
window.diff_match_patch = diff_match_patch;
let _tid=0;
const IDE_MODE_KEY='miyzamchy_ide_mode';
const IDE_CHATS_KEY='miyzamchy_ide_chats';
const IDE_ACTIVE_KEY='miyzamchy_ide_active_chat_id';

const uid=()=>('c_'+Math.random().toString(36).slice(2,10)+'_'+Date.now().toString(36));

// ── BACKEND URL (авто-определение) ─────────────────────────────────────────
// Продакшн URL нашего прокси на Render.
// Замените на актуальный адрес если деплой переехал.
const RENDER_BACKEND_URL = 'https://miyzamchi-backend.onrender.com';

// Динамический выбор: localhost в dev, продакшн в прод.
// Оверрайд: localStorage.setItem('mz-backend', 'http://localhost:3000')
// SECURITY: если override пустая строка или null — НИКОГДА не падаем
// в localhost-fallback на продакшн домене (палит данные в browser-консоль).
const BACKEND_URL = (() => {
  // 1. Явный оверрайд от разработчика (приоритет, но только непустая строка)
  const override = localStorage.getItem('mz-backend');
  if (override && override.trim()) return override.trim();
  // 2. Авто-определение: dev → localhost, прод → Render
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return RENDER_BACKEND_URL;
})();
// Гарантия: BACKEND_URL никогда не должен быть falsy. Если что-то пошло
// не так — используем продакшн URL вместо опасного localhost-fallback.
const _ensureBackend = () => BACKEND_URL && BACKEND_URL.length ? BACKEND_URL : RENDER_BACKEND_URL;

const safeJson=(v,fallback)=>{try{return JSON.parse(v)}catch(e){return fallback}};

// ═══ i18n: единый язык KY|RU|EN с лендингом (localStorage 'app_language') ═══
// Любой компонент вызывает useI18n() и реактивно перерисовывается при смене
// языка (useSyncExternalStore на pub/sub из translations.js).
const useI18n=()=>{
  const lang=React.useSyncExternalStore(subscribeLang,getAppLang);
  return { lang, tr:(k)=>i18nT(k,lang), setLang:setAppLang };
};

// PRIVACY: автоматическое удаление чатов старше N дней.
// Чаты юриста могут содержать ФИО клиентов и детали дел — не храним вечно.
// Юрист может изменить лимит через DevTools: localStorage.setItem('mz-history-ttl-days', '90')
const HISTORY_TTL_DAYS = (() => {
  const v = parseInt(localStorage.getItem('mz-history-ttl-days')||'',10);
  return Number.isFinite(v) && v>0 && v<=365 ? v : 60; // default = 60 дней
})();
const HISTORY_TTL_MS = HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000;

const loadIdeChats=()=>{
  // При загрузке: (1) гасим зависший thinkRunning у AI-сообщений,
  // (2) фильтруем чаты старше HISTORY_TTL_DAYS — privacy-protection.
  const raw=safeJson(localStorage.getItem(IDE_CHATS_KEY)||'[]',[]);
  if(!Array.isArray(raw)) return [];
  const cutoff = Date.now() - HISTORY_TTL_MS;
  return raw
    .filter(c=>{
      // Берём updatedAt > createdAt > timestamp последнего сообщения > 0
      const t = c?.updatedAt || c?.createdAt
             || (Array.isArray(c?.messages) && c.messages.length ? (c.messages[c.messages.length-1]?.t || 0) : 0)
             || 0;
      return !t || t >= cutoff; // если timestamp отсутствует — оставляем (back-compat)
    })
    .map(c=>{
      if(!c||!Array.isArray(c.messages)) return c;
      return {
        ...c,
        messages: c.messages.map(m=>{
          if(!m||m.role!=='ai'||!m.thinkRunning) return m;
          const steps=(Array.isArray(m.thinkSteps)?m.thinkSteps:[]).map(s=>s&&s.status==='loading'?{...s,status:'success'}:s);
          return {...m,thinkRunning:false,thinkSteps:steps};
        })
      };
    });
};
const saveIdeChats=(arr)=>{try{localStorage.setItem(IDE_CHATS_KEY,JSON.stringify(arr||[]))}catch(e){}};

// Утилита: полная очистка истории IDE (вызвать из консоли / привязать к кнопке)
window.clearAllIdeHistory = () => {
  try{
    localStorage.removeItem(IDE_CHATS_KEY);
    localStorage.removeItem(IDE_ACTIVE_KEY);
    console.log('[Privacy] История IDE очищена. Перезагрузите страницу.');
  }catch(e){console.warn(e);}
};
const loadIdeMode=()=>{const m=localStorage.getItem(IDE_MODE_KEY);return (m==='thinking'||m==='fast')?m:'fast'};
const saveIdeMode=(m)=>{try{localStorage.setItem(IDE_MODE_KEY,m)}catch(e){}};
const loadIdeActive=()=>localStorage.getItem(IDE_ACTIVE_KEY)||'';
const saveIdeActive=(id)=>{try{localStorage.setItem(IDE_ACTIVE_KEY,id)}catch(e){}};

const extractArticleNumbers=(sources=[])=>{
  const nums=[];
  const re=/стат(?:ья|ьи|ье|ью|ьей|ей|ям|ях|ями)?\s*([0-9]{1,4})/ig;
  for(const s of (sources||[])){
    const str=String(s||'');
    let m;
    while((m=re.exec(str))!==null){
      const n=parseInt(m[1],10);
      if(Number.isFinite(n)&&!nums.includes(n)) nums.push(n);
    }
  }
  return nums;
};

async function streamChat({message,history,mode,agentMode=false,userQuery=null,skipRetrieval=false,documentContext=null,onStatus,onText,onSources,onMetadata,onConfidence,onStep,onTelemetry,signal}){
  const url=BACKEND_URL+'/api/chat';
  console.log('[IDE Chat] Sending to:', url, 'mode:', mode, 'agentMode:', agentMode, 'skipRAG:', skipRetrieval, 'docCtx:', documentContext?documentContext.length+'ch':'none');
  let res;
  try{
    res=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message,history,mode,agentMode,userQuery,skipRetrieval,documentContext}),
      signal
    });
  }catch(fetchErr){
    throw new Error(`Fetch failed → ${url}\n${fetchErr.name}: ${fetchErr.message}`);
  }
  if(!res.ok){
    let t=`HTTP ${res.status} ${res.statusText}`;
    try{const body=await res.text();if(body)t+=`\n${body.substring(0,300)}`}catch(e){}
    throw new Error(`Сервер вернул ошибку:\n${t}\nURL: ${url}`);
  }
  const reader=res.body.getReader();
  const dec=new TextDecoder('utf-8');
  let buf='';
  while(true){
    const {value,done}=await reader.read();
    if(done) break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n');
    buf=lines.pop();
    for(const line of lines){
      const tr=line.trim();
      if(!tr||!tr.startsWith('data:')) continue;
      const raw=tr.slice(5).trim();
      if(raw==='[DONE]') return;
      let parsed=null;
      try{parsed=JSON.parse(raw)}catch(e){continue;}
      if(parsed&&parsed.protocolStatus){onStatus&&onStatus(String(parsed.protocolStatus));}
      if(parsed&&parsed.step){onStep&&onStep(parsed.step);}
      if(parsed&&parsed.text){onText&&onText(String(parsed.text));}
      if(parsed&&parsed.sources){onSources&&onSources(parsed.sources);}
      if(parsed&&parsed.metadata){onMetadata&&onMetadata(parsed.metadata);}
      if(parsed&&parsed.confidence){onConfidence&&onConfidence(parsed.confidence);}
      if(parsed&&parsed.telemetry){onTelemetry&&onTelemetry(parsed.telemetry);}
    }
  }
}

/* ═════════════════════════════════════════════════════════════
   streamUploadDocument — клиент к /api/upload-document (PR3 Shadow Pipeline)
   Запускается в фоне СРАЗУ как только attachment готов (текст извлечён).
   Бэкенд за фоновое время делает context+segment+triage и возвращает
   sessionId, который потом /api/analyze-document использует как ⚡-кэш.
   Возвращает: { sessionId, segmentCount, skipCount, auditCount, metaContext, elapsedSec }
   или null при ошибке (тогда analyze просто запустится без sessionId).
   ═════════════════════════════════════════════════════════════ */
async function streamUploadDocument({documentText, onStep, onStatus, signal}){
  const url = BACKEND_URL + '/api/upload-document';
  console.log('[IDE Shadow] Upload start:', url, '| doc:', documentText?.length, 'ch');
  let res;
  try{
    res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({documentText}),
      signal
    });
  }catch(fetchErr){
    console.warn('[IDE Shadow] Fetch failed:', fetchErr.message);
    return null;
  }
  if(!res.ok){
    console.warn('[IDE Shadow] HTTP', res.status, res.statusText);
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let shadowReady = null;
  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += dec.decode(value, {stream:true});
    const lines = buf.split('\n');
    buf = lines.pop();
    for(const line of lines){
      const tr = line.trim();
      if(!tr || !tr.startsWith('data:')) continue;
      const raw = tr.slice(5).trim();
      if(raw === '[DONE]') return shadowReady;
      let parsed = null;
      try{parsed = JSON.parse(raw)}catch(e){continue;}
      if(parsed && parsed.protocolStatus){onStatus && onStatus(String(parsed.protocolStatus));}
      if(parsed && parsed.step){onStep && onStep(parsed.step);}
      if(parsed && parsed.shadow_ready){
        shadowReady = parsed.shadow_ready;
        console.log('[IDE Shadow] Ready:', shadowReady);
      }
    }
  }
  return shadowReady;
}

/* ═════════════════════════════════════════════════════════════
   streamAnalyzeDocument — клиент к /api/analyze-document
   Document-Grounded pipeline: Extractor → Verifiers → Synthesizer
   PR3: принимает опциональный sessionId — если он есть, бэкенд
   пропускает context+segment+triage (фоновый прогрев уже сделал их).
   ═════════════════════════════════════════════════════════════ */
async function streamAnalyzeDocument({documentText, userQuery, sessionId, file, onStatus, onText, onSources, onMetadata, onConfidence, onStep, onTableRow, onPurityIndex, onTelemetry, onAgentSearch, signal}){
  // V2 (Stateful Multi-Agent RAG): /api/v2/analyze-document.
  //   • Есть file (PDF/DOCX из вложения) → шлём ФИЗИЧЕСКИЙ файл multipart/form-data
  //     → бэкенд V2 стримит его в Cloud Run/Docling (умный серверный парсинг).
  //   • Нет file (печатный текст из TipTap-редактора / incognito) → fallback: JSON documentText.
  const url = BACKEND_URL + '/api/v2/analyze-document';
  let fetchOpts;
  if (file) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'document');
    if (userQuery) fd.append('userQuery', userQuery);
    if (sessionId) fd.append('sessionId', sessionId);
    // Content-Type НЕ ставим вручную — браузер сам подставит boundary для multipart.
    fetchOpts = { method:'POST', body: fd, signal };
    console.log('[IDE Analyze] →', url, '| FILE:', file.name, `(${file.size} B)`, '| query:', (userQuery||'').slice(0,40));
  } else {
    fetchOpts = { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({documentText, userQuery, sessionId}), signal };
    console.log('[IDE Analyze] →', url, '| TEXT:', documentText?.length, 'ch | query:', (userQuery||'').slice(0,40));
  }
  let res;
  try{
    res = await fetch(url, fetchOpts);
  }catch(fetchErr){
    throw new Error(`Fetch failed → ${url}\n${fetchErr.name}: ${fetchErr.message}`);
  }
  if(!res.ok){
    let t = `HTTP ${res.status} ${res.statusText}`;
    try{const body=await res.text();if(body)t+=`\n${body.substring(0,300)}`}catch(e){}
    throw new Error(`Сервер вернул ошибку:\n${t}\nURL: ${url}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += dec.decode(value, {stream:true});
    const lines = buf.split('\n');
    buf = lines.pop();
    for(const line of lines){
      const tr = line.trim();
      if(!tr || !tr.startsWith('data:')) continue;
      const raw = tr.slice(5).trim();
      if(raw === '[DONE]') return;
      let parsed = null;
      try{parsed = JSON.parse(raw)}catch(e){continue;}
      if(parsed && parsed.protocolStatus){onStatus && onStatus(String(parsed.protocolStatus));}
      if(parsed && parsed.step){onStep && onStep(parsed.step);}
      if(parsed && parsed.text){onText && onText(String(parsed.text));}
      if(parsed && parsed.sources){onSources && onSources(parsed.sources);}
      if(parsed && parsed.metadata){onMetadata && onMetadata(parsed.metadata);}
      if(parsed && parsed.confidence){onConfidence && onConfidence(parsed.confidence);}
      if(parsed && parsed.tableRow){onTableRow && onTableRow(parsed.tableRow);}
      if(parsed && parsed.purityIndex !== undefined){onPurityIndex && onPurityIndex(parsed.purityIndex);}
      if(parsed && parsed.telemetry){onTelemetry && onTelemetry(parsed.telemetry);}
      // 2026-05-30 Agentic RAG: модель сама вызывает search_legislation_kg.
      // Показываем юристу в UI: "🔎 Агент ищет: <query>".
      if(parsed && parsed.agent_search){onAgentSearch && onAgentSearch(parsed.agent_search);}
      // 2026-06-01: SSE { trace_ready } больше не используется фронтом.
      // Архив отчётов доступен через постоянную кнопку 🗃️ → GET /api/traces.
      // Бэкенд продолжает слать событие для backward-compat (no-op на фронте).
    }
  }
}

/* ═════════════════════════════════════════════════════════════
   streamDeepAnalyze — клиент к /api/deep-analyze-document
   Premium Router-Worker: Аудитор + Стратег + Драфтер + Ментор + Senior Partner
   Payload: { documentText, userQuery, perspective, modules }
   SSE events: { step }, { protocolStatus }, { deepReport }, { text }
   ═════════════════════════════════════════════════════════════ */
async function streamDeepAnalyze({documentText, userQuery, perspective='audit', modules=['audit','strategy'], onStatus, onStep, onDeepReport, onText, onTelemetry, signal}){
  const url = BACKEND_URL + '/api/deep-analyze-document';
  console.log('[IDE DeepAnalyze] →', url, '| doc:', documentText?.length, 'ch | persp:', perspective, '| modules:', modules.join(','));
  let res;
  try{
    res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({documentText, userQuery, perspective, modules}),
      signal
    });
  }catch(fetchErr){
    throw new Error(`Fetch failed → ${url}\n${fetchErr.name}: ${fetchErr.message}`);
  }
  if(!res.ok){
    let t = `HTTP ${res.status} ${res.statusText}`;
    try{const body=await res.text();if(body)t+=`\n${body.substring(0,300)}`}catch(e){}
    throw new Error(`Сервер вернул ошибку:\n${t}\nURL: ${url}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += dec.decode(value, {stream:true});
    const lines = buf.split('\n');
    buf = lines.pop();
    for(const line of lines){
      const tr = line.trim();
      if(!tr || !tr.startsWith('data:')) continue;
      const raw = tr.slice(5).trim();
      if(raw === '[DONE]') return;
      let parsed = null;
      try{parsed = JSON.parse(raw)}catch(e){continue;}
      if(parsed && parsed.protocolStatus){onStatus && onStatus(String(parsed.protocolStatus));}
      if(parsed && parsed.step){onStep && onStep(parsed.step);}
      if(parsed && parsed.deepReport){onDeepReport && onDeepReport(parsed.deepReport);}
      if(parsed && parsed.text){onText && onText(String(parsed.text));}
      if(parsed && parsed.telemetry){onTelemetry && onTelemetry(parsed.telemetry);}
    }
  }
}

/* ═════════════════════════════════════════════════════════════
   streamCompareDocuments — клиент к /api/compare-documents
   Semantic Legal Redlining: Align → Map (Gemini-воркеры) → Reduce (DeepSeek-судья).
   Payload: { oldDocumentText, newDocumentText }
   SSE events: { step }, { protocolStatus }, { compareReport }, { text }, { telemetry }
   ═════════════════════════════════════════════════════════════ */
async function streamCompareDocuments({oldDocumentText, newDocumentText, onStatus, onStep, onReport, onText, onTelemetry, signal}){
  const url = BACKEND_URL + '/api/compare-documents';
  console.log('[IDE Compare] →', url, '| old:', oldDocumentText?.length, 'ch | new:', newDocumentText?.length, 'ch');
  let res;
  try{
    res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({oldDocumentText, newDocumentText}),
      signal
    });
  }catch(fetchErr){
    throw new Error(`Fetch failed → ${url}\n${fetchErr.name}: ${fetchErr.message}`);
  }
  if(!res.ok){
    let t = `HTTP ${res.status} ${res.statusText}`;
    try{const body=await res.text();if(body)t+=`\n${body.substring(0,300)}`}catch(e){}
    throw new Error(`Сервер вернул ошибку:\n${t}\nURL: ${url}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += dec.decode(value, {stream:true});
    const lines = buf.split('\n');
    buf = lines.pop();
    for(const line of lines){
      const tr = line.trim();
      if(!tr || !tr.startsWith('data:')) continue;
      const raw = tr.slice(5).trim();
      if(raw === '[DONE]') return;
      let parsed = null;
      try{parsed = JSON.parse(raw)}catch(e){continue;}
      if(parsed && parsed.protocolStatus){onStatus && onStatus(String(parsed.protocolStatus));}
      if(parsed && parsed.step){onStep && onStep(parsed.step);}
      if(parsed && parsed.compareReport){onReport && onReport(parsed.compareReport);}
      if(parsed && parsed.text){onText && onText(String(parsed.text));}
      if(parsed && parsed.telemetry){onTelemetry && onTelemetry(parsed.telemetry);}
    }
  }
}

/* ═════════════════════════════════════════════════════════════
   executeAIEdit — правка выделенного фрагмента через /api/edit.
   Бэкенд отдаёт { reasoning, commands[] } (тот же контракт, что и агент).
   Применяем команды нативным Document API через applyAgentCommand.
   Старый Split Execution (tool_calls + window.superdoc.dispatchTool)
   удалён: он давал HTTP 500 и зависел от headless SDK.
   ═════════════════════════════════════════════════════════════ */
async function executeAIEdit({ instruction, text, documentContext = '', onToast }) {
  const url = BACKEND_URL + '/api/edit';
  console.log('[IDE Edit] → /api/edit | instr:', (instruction || '').slice(0, 60), '| sel:', (text || '').length, 'ch');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction, text, documentContext })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Бэкенд → { reasoning, commands:[{op,...}] }. Переиспользуем parseAgentCommands
  // для маппинга op → внутренний type (replace_smart/insert_after/comment/format…).
  let analysis = data.reasoning || '';
  let commands = [];
  if (Array.isArray(data.commands) && data.commands.length) {
    const parsed = parseAgentCommands(JSON.stringify({ reasoning: analysis, commands: data.commands }));
    analysis = parsed.analysis || analysis;
    commands = parsed.commands;
  } else if (data.result) {
    const parsed = parseAgentCommands(data.result);
    analysis = parsed.analysis || analysis;
    commands = parsed.commands;
  }

  let applied = 0;
  for (const c of commands) {
    try { if (applyAgentCommand(c, onToast)) applied++; }
    catch (e) { console.error('[IDE Edit] applyAgentCommand failed:', e, c); }
  }
  console.log(`[IDE Edit] commands=${commands.length} applied=${applied}`);
  return { analysis, applied, total: commands.length };
}


/* ═════════════════════════════════════════════════════════════
   AnalyzeDocsMode — единая вкладка "Анализ Документов" (2026-05-30).
   Заменяет старый CompareMode. Drag&Drop два слота:
     • 1 файл  → /api/analyze-document (Triage + Ищейки + DCR Final Judge)
     • 2 файла → /api/compare           (semantic compare двух редакций)
   Без textarea. Lazy-load mammoth (.docx) / pdf.js (.pdf) — как в index.html.
   SSE callbacks переиспользуют streamAnalyzeDocument / streamCompareDocuments.
   ═════════════════════════════════════════════════════════════ */

// ── Helpers для извлечения текста из файлов (mammoth/pdf.js lazy-load) ──
const _loadScriptOnce = (src) => new Promise((res, rej) => {
  const ex = Array.from(document.scripts).find(s => s.src === src);
  if (ex) return res();
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить ' + src));
  document.head.appendChild(s);
});
const _fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1024*1024 ? Math.round(n/1024) + ' КБ' : (n/1024/1024).toFixed(1) + ' МБ';
const _extractTextFromFile = async (file) => {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.rtf') || name.endsWith('.text')) {
    return await file.text();
  }
  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    if (!window.mammoth) await _loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
    const buffer = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return (res.value || '').trim();
  }
  if (name.endsWith('.pdf')) {
    if (!window.pdfjsLib) {
      await _loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const buffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n\n';
      if (i >= 80) { text += `\n…[Документ обрезан после 80 страниц]\n`; break; }
    }
    return text.trim();
  }
  // Last resort — try as text
  try { return await file.text(); } catch { return null; }
};

/* ═══════════ TraceArchiveModal (Debug-архив) — 2026-06-01 ═══════════
   Открывается постоянной кнопкой 🗃️ Debug-архив. При open=true делает
   fetch('/api/traces') и рендерит таблицу всех trace-файлов с бэка:
   Дата | Файл | Размер | 📥 Скачать.

   Зачем постоянная: SSE-кнопка ненадёжна — пропадает при перезагрузке
   IDE, рассинхронизации SSE, новом анализе. Архив — single source of
   truth, читается прямо с диска. */
const TraceArchiveModal = ({open, onClose}) => {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const refreshSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    const seq = ++refreshSeq.current;
    try {
      const url = ((typeof BACKEND_URL !== 'undefined' && BACKEND_URL) || '') + '/api/traces';
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (seq !== refreshSeq.current) return;
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e.message || String(e));
      setItems([]);
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Закрытие по ESC
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const fmtDate = (iso) => {
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
    } catch { return iso; }
  };

  const filtered = filter
    ? items.filter(it => (it.fileName || '').toLowerCase().includes(filter.toLowerCase()))
    : items;

  return (
    <div className="trace-modal-backdrop" onClick={onClose}>
      <div className="trace-modal" onClick={(e) => e.stopPropagation()}>
        <div className="trace-modal-head">
          <div className="trace-modal-title">🗃️ Debug-архив <span className="trace-modal-count">{items.length}</span></div>
          <div className="trace-modal-actions">
            <button className="trace-modal-refresh" onClick={load} disabled={loading} title="Обновить список">
              {loading ? '⏳' : '🔄'} Обновить
            </button>
            <button className="trace-modal-close" onClick={onClose} title="Закрыть (Esc)">✕</button>
          </div>
        </div>

        <div className="trace-modal-toolbar">
          <input
            className="trace-modal-filter"
            type="text"
            placeholder="🔍 фильтр по имени файла..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="trace-modal-hint">TTL: 7 дней · сортировка: новые сверху</span>
        </div>

        <div className="trace-modal-body">
          {error && <div className="trace-modal-error">⚠️ Ошибка загрузки: {error}</div>}
          {!error && loading && items.length === 0 && (
            <div className="trace-modal-empty">Загружаю список...</div>
          )}
          {!error && !loading && items.length === 0 && (
            <div className="trace-modal-empty">
              Архив пуст. Запустите анализ документа — trace-файл появится здесь автоматически.
            </div>
          )}
          {filtered.length > 0 && (
            <table className="trace-modal-table">
              <thead>
                <tr>
                  <th style={{width:'140px'}}>Дата</th>
                  <th>Имя файла</th>
                  <th style={{width:'80px', textAlign:'right'}}>Размер</th>
                  <th style={{width:'120px'}}>Действие</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => {
                  const dlUrl = ((typeof BACKEND_URL !== 'undefined' && BACKEND_URL) || '') + it.url;
                  return (
                    <tr key={it.fileName}>
                      <td className="trace-cell-date">{fmtDate(it.modifiedAtIso)}</td>
                      <td className="trace-cell-name" title={it.fileName}>{it.fileName}</td>
                      <td className="trace-cell-size">{it.sizeKB} KB</td>
                      <td className="trace-cell-dl">
                        <a className="trace-dl-link"
                           href={dlUrl}
                           download={it.fileName}
                           target="_blank" rel="noopener">
                          📥 Скачать
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filter && filtered.length === 0 && items.length > 0 && (
            <div className="trace-modal-empty">Нет файлов, подходящих под фильтр «{filter}»</div>
          )}
        </div>
      </div>
    </div>
  );
};

const AnalyzeDocsMode = () => {
  // slots: [{ file, text, name, size, status, error }]  status: empty | loading | ready | error
  const EMPTY_SLOT = { file:null, text:'', name:'', size:0, status:'empty', error:'' };
  const [slots, setSlots]         = useState([{...EMPTY_SLOT}, {...EMPTY_SLOT}]);
  const [running, setRunning]     = useState(false);
  const [steps, setSteps]         = useState([]);
  const [tableRows, setTableRows] = useState([]);
  const [purityIndex, setPurityIndex] = useState(null);
  const [summary, setSummary]     = useState('');
  const [sources, setSources]     = useState([]);
  const [report, setReport]       = useState(null);          // compare-only
  const [activePair, setActivePair] = useState(null);
  const [error, setError]         = useState('');
  const [dragOverIdx, setDragOverIdx] = useState(-1);
  // 2026-05-30: телеметрия. Каждый SSE-event {telemetry: {...}} аккумулируется.
  // tele.elapsedMs тикает каждые 100ms пока running=true.
  const EMPTY_TELE = { calls:0, input:0, output:0, cost:0, lastModel:null, lastLabel:null, startedAt:null, elapsedMs:0 };
  const [tele, setTele] = useState({...EMPTY_TELE});
  // 2026-06-01: Debug-архив — модалка со списком всех trace-файлов с бэка.
  // Открывается постоянной кнопкой "🗃️ Debug-архив" в toolbar (в любом
  // состоянии: IDLE / running / done).
  const [archiveOpen, setArchiveOpen] = useState(false);
  const abortRef = useRef(null);
  const fileInputRefs = [useRef(null), useRef(null)];

  // ── Live-таймер: тикает каждые 100ms пока running ─────────────
  // 2026-05-30: каждый тик дублирует tele в window-event для LeftPanel.
  useEffect(() => {
    if (!running || !tele.startedAt) return;
    const id = setInterval(() => {
      setTele(t => {
        const next = { ...t, elapsedMs: Date.now() - (t.startedAt || Date.now()) };
        try { window.dispatchEvent(new CustomEvent('miyzamchi:tele-update', { detail: next })); } catch(_) {}
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [running, tele.startedAt]);

  const readyCount = slots.filter(s => s.status === 'ready').length;
  const loadingCount = slots.filter(s => s.status === 'loading').length;
  const mode = readyCount === 2 ? 'compare' : readyCount === 1 ? 'audit' : null;
  const canRun = !running && loadingCount === 0 && readyCount >= 1;

  // ── File handling ─────────────────────────────────────────────
  const updateSlot = (i, patch) => setSlots(prev => {
    const copy = prev.slice();
    copy[i] = { ...copy[i], ...patch };
    return copy;
  });

  const handleFile = async (slotIdx, file) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      updateSlot(slotIdx, { status:'error', name:file.name, size:file.size, error:'Файл > 25 МБ' });
      return;
    }
    updateSlot(slotIdx, { file, name:file.name, size:file.size, status:'loading', error:'', text:'' });
    try {
      const text = await _extractTextFromFile(file);
      if (text == null) {
        updateSlot(slotIdx, { status:'error', error:'Формат не поддерживается (нужны .txt, .docx, .pdf, .md)' });
        return;
      }
      if (!text.trim() || text.trim().length < 50) {
        updateSlot(slotIdx, { status:'error', error:'Текст пустой или < 50 символов' });
        return;
      }
      updateSlot(slotIdx, { text, status:'ready' });
    } catch (e) {
      updateSlot(slotIdx, { status:'error', error:(e.message || 'Ошибка чтения').slice(0, 80) });
    }
  };

  const removeSlot = (i) => updateSlot(i, {...EMPTY_SLOT});

  // ── Drag & drop ───────────────────────────────────────────────
  const onDragOver = (i) => (e) => { e.preventDefault(); setDragOverIdx(i); };
  const onDragLeave = () => setDragOverIdx(-1);
  const onDrop = (i) => (e) => {
    e.preventDefault();
    setDragOverIdx(-1);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(i, f);
  };

  // ── Stream-step upsert ────────────────────────────────────────
  const upsertStep = (s) => setSteps(prev => {
    const i = prev.findIndex(x => x.id === s.id);
    if (i >= 0) { const c = prev.slice(); c[i] = { ...c[i], ...s }; return c; }
    return [...prev, s];
  });

  // ── Telemetry SSE handler — аккумулирует per-call события ────
  // Бэкенд (server.js sendTelemetry) шлёт {telemetry: {label, model,
  // inputTokens, outputTokens, cost, ...}} на КАЖДЫЙ LLM-вызов.
  // 2026-05-30: дублируем через 2 window-event'а:
  //   • miyzamchi:tele-update — НАКОПЛЕННОЕ значение, для LeftPanel блока "АНАЛИЗ"
  //   • miyzamchi:raw-telemetry — СЫРОЙ chunk, для AIChat (правая панель)
  //     handleTelemetry → sessionStats. Так LeftTelemetryDrawer работает и
  //     во время document analysis (не только во время прямого чата).
  const onTelemetryEvent = (t) => {
    if (!t) return;
    // Сырая телеметрия → AIChat (для AntiGravityTracker / LeftTelemetryDrawer).
    try { window.dispatchEvent(new CustomEvent('miyzamchi:raw-telemetry', { detail: t })); } catch(_) {}
    setTele(prev => {
      const next = {
        ...prev,
        calls:     prev.calls  + 1,
        input:     prev.input  + (t.inputTokens  || 0),
        output:    prev.output + (t.outputTokens || 0),
        cost:      prev.cost   + (t.cost         || 0),
        lastModel: t.model || prev.lastModel,
        lastLabel: t.label || prev.lastLabel
      };
      try { window.dispatchEvent(new CustomEvent('miyzamchi:tele-update', { detail: next })); } catch(_) {}
      return next;
    });
  };

  // ── Agentic RAG: модель сама вызывает search_legislation_kg ─
  // SSE-event { agent_search: { segmentRef, query, reason, turn, model } }
  // Прокидываем во фронт через window-event для LeftPanel.
  const onAgentSearch = (ev) => {
    if (!ev || !ev.query) return;
    try {
      window.dispatchEvent(new CustomEvent('miyzamchi:agent-search', { detail: ev }));
    } catch(_) {}
  };

  // ── Run (audit или compare в зависимости от mode) ─────────────
  const onRun = async () => {
    setRunning(true); setError('');
    setSteps([]); setTableRows([]); setPurityIndex(null); setSummary(''); setSources([]); setReport(null); setActivePair(null);
    // Reset телеметрию с новым startedAt
    const freshTele = { ...EMPTY_TELE, startedAt: Date.now() };
    setTele(freshTele);
    try { window.dispatchEvent(new CustomEvent('miyzamchi:tele-start', { detail: freshTele })); } catch(_) {}
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (mode === 'audit') {
        await streamAnalyzeDocument({
          documentText: slots[0].text,
          file: slots[0].file || null,   // V2: физический файл слота → Cloud Run/Docling (fallback на текст)
          userQuery: 'Проведи полный юридический аудит документа',
          sessionId: null,
          signal: ac.signal,
          onStatus:       () => {},
          onStep:         (s) => { if (s && s.id && s.status) upsertStep(s); },
          onConfidence:   () => {},
          onTableRow:     (r) => setTableRows(p => [...p, r]),
          onPurityIndex:  (idx) => setPurityIndex(idx),
          onText:         (chunk) => setSummary(p => p + chunk),
          onSources:      (s) => setSources(Array.isArray(s) ? s : []),
          onMetadata:     () => {},
          onTelemetry:    onTelemetryEvent,
          onAgentSearch:  onAgentSearch
        });
      } else if (mode === 'compare') {
        await streamCompareDocuments({
          oldDocumentText: slots[0].text,
          newDocumentText: slots[1].text,
          signal: ac.signal,
          onStep:       (s) => upsertStep(s),
          onStatus:     () => {},
          onReport:     (r) => setReport(r),
          onText:       (chunk) => setSummary(p => p + chunk),
          onTelemetry:  onTelemetryEvent
        });
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || String(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Финализируем elapsedMs (фиксируем финальную цифру, таймер остановится сам)
      setTele(t => {
        const final = t.startedAt ? { ...t, elapsedMs: Date.now() - t.startedAt } : t;
        try { window.dispatchEvent(new CustomEvent('miyzamchi:tele-done', { detail: final })); } catch(_) {}
        return final;
      });
    }
  };

  const startNew = () => {
    if (abortRef.current) { try { abortRef.current.abort() } catch(e){} abortRef.current = null; }
    setRunning(false);
    setSlots([{...EMPTY_SLOT}, {...EMPTY_SLOT}]);
    setSteps([]); setTableRows([]); setPurityIndex(null); setSummary(''); setSources([]); setReport(null); setActivePair(null); setError('');
    setTele({...EMPTY_TELE});
    try { window.dispatchEvent(new CustomEvent('miyzamchi:tele-reset')); } catch(_) {}
  };

  // ── IDLE: drag&drop слоты ─────────────────────────────────────
  if (!running && tableRows.length === 0 && !report && !summary && !error) {
    return (
      <div className="ad-root">
        <TraceArchiveModal open={archiveOpen} onClose={() => setArchiveOpen(false)} />
        <div className="cmp-intro">
          <h3 className="cmp-title">Анализ документов</h3>
          <p className="cmp-sub">Перетащите файл сюда или выберите вручную. Один документ → глубокий аудит. Два → сравнение редакций.</p>
          <button className="ad-trace-btn ad-trace-btn--idle"
                  onClick={() => setArchiveOpen(true)}
                  title="Постоянный архив debug-отчётов всех прошлых анализов">
            🗃️ Debug-архив
          </button>
        </div>
        <div className="ad-slots">
          {slots.map((slot, i) => {
            const isOver  = dragOverIdx === i;
            const empty   = slot.status === 'empty';
            const loading = slot.status === 'loading';
            const ready   = slot.status === 'ready';
            const errored = slot.status === 'error';
            const label   = i === 0 ? 'Документ для аудита' : 'Вторая редакция (для сравнения)';
            const cls = [
              'ad-slot',
              ready   ? 'ad-slot--ready'   : '',
              loading ? 'ad-slot--loading' : '',
              errored ? 'ad-slot--error'   : '',
              isOver  ? 'ad-slot--drag'    : ''
            ].filter(Boolean).join(' ');
            return (
              <div key={i} className={cls}
                   onDragOver={onDragOver(i)}
                   onDragLeave={onDragLeave}
                   onDrop={onDrop(i)}
                   onClick={() => { if (empty) fileInputRefs[i].current && fileInputRefs[i].current.click(); }}>
                <input ref={fileInputRefs[i]}
                       type="file"
                       accept=".pdf,.docx,.doc,.txt,.md,.rtf"
                       style={{display:'none'}}
                       onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value=''; if (f) handleFile(i, f); }}/>
                {empty && (
                  <div className="ad-slot-empty">
                    <div className="ad-slot-icon"><Ico k="clip" sz={28} col="var(--muted)"/></div>
                    <div className="ad-slot-label">{label}</div>
                    <div className="ad-slot-hint">Перетащите или кликните · .pdf .docx .txt</div>
                  </div>
                )}
                {loading && (
                  <div className="ad-slot-state">
                    <div className="ad-slot-spin"><Ico k="loader" sz={22}/></div>
                    <div className="ad-slot-name">{slot.name}</div>
                    <div className="ad-slot-hint">Извлекаем текст…</div>
                  </div>
                )}
                {ready && (
                  <div className="ad-slot-state ad-slot-state--ready">
                    <div className="ad-slot-icon"><Ico k="file" sz={26} col="var(--accent)"/></div>
                    <div className="ad-slot-name" title={slot.name}>{slot.name}</div>
                    <div className="ad-slot-meta">{_fmtBytes(slot.size)} · {Math.round(slot.text.length/100)/10}k симв.</div>
                    <button type="button" className="ad-slot-remove" onClick={(e) => { e.stopPropagation(); removeSlot(i); }} title="Удалить">×</button>
                  </div>
                )}
                {errored && (
                  <div className="ad-slot-state ad-slot-state--error">
                    <div className="ad-slot-icon"><Ico k="x" sz={22} col="#e5484d"/></div>
                    <div className="ad-slot-name" title={slot.name}>{slot.name || 'Ошибка'}</div>
                    <div className="ad-slot-hint">{slot.error}</div>
                    <button type="button" className="ad-slot-remove" onClick={(e) => { e.stopPropagation(); removeSlot(i); }} title="Удалить">×</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className={'ad-mode-banner ad-mode-banner--' + (mode || 'none')}>
          {mode === 'audit'   && <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Ico k="microscope" sz={14} col="var(--accent)" /> Режим: <b>Одиночный аудит</b> · Triage + Ищейки + DCR Final Judge</span>}
          {mode === 'compare' && <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Ico k="scale" sz={14} col="var(--accent)" /> Режим: <b>Сравнение редакций</b> · semantic diff + Executive Summary</span>}
          {!mode              && <span>Загрузите хотя бы один документ, чтобы начать</span>}
        </div>
        <div className="cmp-actions">
          <button className="cmp-run-btn" disabled={!canRun} onClick={onRun}>
            {mode === 'compare' ? (
              <span style={{display:'inline-flex',alignItems:'center',gap:6,justifyContent:'center'}}><Ico k="scale" sz={14} /> Сравнить редакции</span>
            ) : (
              <span style={{display:'inline-flex',alignItems:'center',gap:6,justifyContent:'center'}}><Ico k="microscope" sz={14} /> Запустить аудит</span>
            )}
          </button>
          {loadingCount > 0 && <span className="cmp-hint">Дождитесь извлечения текста…</span>}
          {readyCount === 0 && loadingCount === 0 && <span className="cmp-hint">Поддержка: PDF, DOCX, TXT, MD. Макс. 25 МБ.</span>}
        </div>
      </div>
    );
  }

  // ── RUNNING / DONE: степпер + Executive Summary + audit table / compare pairs ─
  const pairs = (report && report.pairs) || [];
  const isCompareView = pairs.length > 0 || (mode === 'compare');
  const isAuditView   = !isCompareView && (tableRows.length > 0 || mode === 'audit');

  const pairClass = (p) => {
    if(p.riskDetected) return 'cmp-pair cmp-pair--risk';
    if(p.category === 'существенное изменение') return 'cmp-pair cmp-pair--substantial';
    if(p.category === 'добавление') return 'cmp-pair cmp-pair--added';
    if(p.category === 'удаление')   return 'cmp-pair cmp-pair--removed';
    return 'cmp-pair cmp-pair--stable';
  };
  const rowClass = (r) => {
    const st = (r.status || 'ok').toLowerCase();
    if (st === 'critical' || st === 'error') return 'ad-row ad-row--critical';
    if (st === 'warning') return 'ad-row ad-row--warning';
    return 'ad-row ad-row--ok';
  };

  // ── 2026-05-31 UX-fix: разделяем steps на 2 потока ─────────────────
  // Бэкенд шлёт два класса SSE-событий:
  //   • Head-steps (id ∈ {router, passport, triage, phase3, judge, hybrid,
  //     segment, шаги pipeline) — высокоуровневые, ВСЕГДА видны юристу.
  //   • Seg-steps (id начинается с "seg_") — по одному на каждый сегмент
  //     документа. На длинных документах их 30-40+ штук, и они
  //     выглядят как "вываливающийся список п.1, п.2..." — это и есть
  //     scroll fatigue. Прячем в <details> вместе с таблицей вердиктов.
  const isSegStep = (s) => s && typeof s.id === 'string' && s.id.startsWith('seg_');
  const headSteps = steps.filter(s => !isSegStep(s));
  const segSteps  = steps.filter(isSegStep);

  return (
    <div className="cmp-root">
      <TraceArchiveModal open={archiveOpen} onClose={() => setArchiveOpen(false)} />
      <div className="cmp-toolbar">
        <button className="cmp-new-btn" onClick={startNew}>← Новый анализ</button>
        {running && abortRef.current && (
          <button className="cmp-stop-btn" onClick={() => abortRef.current.abort()}>Остановить</button>
        )}
        {purityIndex !== null && (
          <div className="ad-purity-badge" title="Индекс правовой чистоты документа">
            🛡️ Чистота: <b>{purityIndex}%</b>
          </div>
        )}
        {/* 2026-06-01: Постоянная кнопка "Debug-архив". Открывает модалку
            с полным списком всех trace-файлов (новые сверху). Эфемерная
            кнопка-после-SSE убрана — она зависела от { trace_ready } и
            пропадала при перезагрузке/рассинхроне. */}
        <button className="ad-trace-btn" onClick={() => setArchiveOpen(true)}
                title="Постоянный архив всех debug-отчётов (.md). Все prompts, tool calls, RAG-выдачи, ответ Финального Судьи.">
          🗃️ Debug-архив
        </button>
        {report && (
          <div className="cmp-stats">
            <span>Пар: <b>{report.total}</b></span>
            <span>· ⚠️ Рисков: <b>{report.risksCount}</b></span>
            <span>· 📌 Сущ.: <b>{report.substantialCount}</b></span>
            <span>· + {report.added}</span>
            <span>· − {report.removed}</span>
          </div>
        )}
        {/* 2026-05-30: телеметрия (⏱ время / 🪙 токены / 💵 стоимость) переехала
            в LeftPanel — блок "АНАЛИЗ". Здесь убран ad-tele-row, чтобы не
            дублировать счётчики. Sync через window-events miyzamchi:tele-*. */}
      </div>

      {/* 2026-05-31: показываем ТОЛЬКО head-steps в верхней панели.
          Seg-steps (по одному на каждый чанк) переехали внутрь <details>. */}
      {headSteps.length > 0 && (
        <div className="cmp-steps">
          {headSteps.map(s => (
            <div key={s.id} className={`cmp-step cmp-step--${s.status}`}>
              <span className="cmp-step-dot"/>
              <span className="cmp-step-text">{s.text}{s.reason ? <span className="ad-step-reason"> · {s.reason}</span> : null}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="cmp-error">⚠️ {error}</div>}

      {/* 2026-05-31 UX-rework: иерархия выдачи —
          1) Executive Summary КРУПНО и сразу — самое важное.
          2) Детальный разбор по пунктам — СВЁРНУТ в <details>.
          3) Использованные нормы — отдельным мелким блоком.
          Это убирает scroll fatigue: юрист видит вывод Финального Судьи
          без скролла, при желании раскрывает детали. */}

      {(summary || running) && (
        <div className="cmp-summary ad-summary-prominent">
          <div className="cmp-summary-head">📋 Executive Summary</div>
          <div className="cmp-summary-body ai-md"
               dangerouslySetInnerHTML={{__html: renderMarkdown(summary || (running ? (isCompareView ? '_Старший партнёр анализирует изменения..._' : '_Финальный судья формирует заключение..._') : ''))}}/>
        </div>
      )}

      {/* AUDIT VIEW: детальный разбор — ВСЁ внутри <details>, СВЁРНУТ.
          Что внутри:
            • seg-чипы (live-прогресс по сегментам пока идёт стрим)
            • таблица вердиктов
          Снаружи остаётся только Executive Summary — самое важное. */}
      {isAuditView && (tableRows.length > 0 || segSteps.length > 0) && (
        <details className="ad-details">
          <summary className="ad-details-summary">
            <span className="ad-details-icon">📋</span>
            <span className="ad-details-title">Детальный разбор по пунктам</span>
            <span className="ad-details-count">{tableRows.length || segSteps.length}</span>
            {running && (
              <span className="ad-details-live" title="Идёт обработка">
                <span className="ad-details-live-dot"/>
                live
              </span>
            )}
            <span className="ad-details-hint">Нажмите, чтобы развернуть</span>
            <span className="ad-details-chevron">▾</span>
          </summary>
          <div className="ad-details-body">
            {segSteps.length > 0 && (
              <div className="cmp-steps ad-seg-steps">
                {segSteps.map(s => (
                  <div key={s.id} className={`cmp-step cmp-step--${s.status}`}>
                    <span className="cmp-step-dot"/>
                    <span className="cmp-step-text">{s.text}{s.reason ? <span className="ad-step-reason"> · {s.reason}</span> : null}</span>
                  </div>
                ))}
              </div>
            )}
            {tableRows.length > 0 && (
              <div className="ad-table-wrap">
                <table className="ad-table ad-table--compact">
                  <thead>
                    <tr>
                      <th style={{width:'18%'}}>Пункт</th>
                      <th>Вердикт и обоснование</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r, i) => (
                      <tr key={i} className={rowClass(r)}>
                        <td className="ad-cell-num">{r.item_number || `п.${i+1}`}</td>
                        <td className="ad-cell-content">
                          <div className="ad-verdict">{r.short_verdict || '—'}</div>
                          {r.legal_rationale && r.legal_rationale !== r.short_verdict && (
                            <div className="ad-rationale">{r.legal_rationale}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </details>
      )}

      {/* AUDIT VIEW: использованные источники НПА */}
      {isAuditView && sources.length > 0 && (
        <details className="ad-details ad-details--minor">
          <summary className="ad-details-summary">
            <span className="ad-details-icon">🔗</span>
            <span className="ad-details-title">Использованные нормы КР</span>
            <span className="ad-details-count">{sources.length}</span>
            <span className="ad-details-chevron">▾</span>
          </summary>
          <ul className="ad-sources-list">
            {sources.slice(0, 10).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </details>
      )}

      {/* COMPARE VIEW: side-by-side pairs */}
      {isCompareView && pairs.length > 0 && (
        <div className="cmp-grid">
          <div className="cmp-grid-head cmp-grid-head--old">Старая редакция</div>
          <div className="cmp-grid-head cmp-grid-head--new">Новая редакция</div>
          {pairs.map((p, i) => (
            <React.Fragment key={i}>
              <div
                className={pairClass(p) + ' cmp-side cmp-side--old' + (activePair === i ? ' cmp-pair--active' : '')}
                onClick={() => setActivePair(activePair === i ? null : i)}
              >
                {p.oldText ? (
                  <React.Fragment>
                    <div className="cmp-pair-num">п. {p.oldNumber || '?'} · {p.oldHeading || ''}</div>
                    <div className="cmp-pair-text">{p.oldText}</div>
                  </React.Fragment>
                ) : <div className="cmp-pair-empty">— (пункт отсутствует в старой редакции)</div>}
              </div>
              <div
                className={pairClass(p) + ' cmp-side cmp-side--new' + (activePair === i ? ' cmp-pair--active' : '')}
                onClick={() => setActivePair(activePair === i ? null : i)}
              >
                {(p.newText || p.redlineHtml) ? (
                  <React.Fragment>
                    <div className="cmp-pair-num">п. {p.newNumber || p.oldNumber || '?'} · {p.newHeading || p.oldHeading || ''}</div>
                    {p.redlineHtml
                      ? <div className="cmp-pair-text cmp-redline" dangerouslySetInnerHTML={{__html: p.redlineHtml}}/>
                      : <div className="cmp-pair-text">{p.newText}</div>}
                  </React.Fragment>
                ) : <div className="cmp-pair-empty">— (пункт удалён в новой редакции)</div>}
                {activePair === i && p.riskDescription && (
                  <div className="cmp-risk-card">
                    <div className="cmp-risk-head">⚠️ Юридический риск</div>
                    <div className="cmp-risk-body">{p.riskDescription}</div>
                  </div>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {!running && !pairs.length && !tableRows.length && !error && (
        <div className="cmp-empty">Ожидаю результат...</div>
      )}
    </div>
  );
};

/* ═══════════ LEGAL DOCUMENT RENDERER (Super Doc, Фаза 1) ═══════════
   Превращает структурированный JSON-документ (DocBlock[]) в готовый
   юридически оформленный документ в SuperDoc: шапка справа, заголовок по
   центру, тело по ширине, жирность/курсив (цитаты НПА)/подчёркивание,
   шрифт Times New Roman. Генерация НАЧИСТО (без Track Changes) в НОВОМ табе.

   Контракт блока:
     { kind, align?, runs: [{ t, bold?, italic?, underline?, cite? }] }
   kind → дефолтное выравнивание (если align не задан явно). */
const LEGAL_KIND_ALIGN = {
  court: 'left', party_header: 'right', spacer: 'left',
  title: 'center', subtitle: 'center', paragraph: 'justify',
  demand_heading: 'left', demand_item: 'left',
  attachment_heading: 'left', attachment_item: 'left', signature: 'right',
  // Договор (двусторонний): разделы, пункты, реквизиты сторон.
  section_heading: 'left', clause: 'justify', requisites: 'left',
};
const LEGAL_FONT = 'Times New Roman, serif';

// Атрибут выравнивания абзаца в схеме SuperDoc — textAlign (подтверждено в
// ядре: attrs.textAlign → OOXML w:jc). Значения: left|center|right|justify.

// Ждём, пока после newDoc смонтируется СВЕЖИЙ редактор (window.docEngine
// переустанавливается в onEditorCreate при remount'е по новому activeTab).
const _waitFreshEditor = (prev, timeoutMs = 8000) => new Promise((resolve) => {
  const start = Date.now();
  const tick = () => {
    const e = window.docEngine;
    const ready = e && e.view && e.view.state;
    if (ready && (e !== prev || prev == null)) return resolve(e);
    if (Date.now() - start > timeoutMs) return resolve(ready ? e : null);
    setTimeout(tick, 120);
  };
  tick();
});

// HTML-экранирование + сборка run → HTML. НЕ режем пробелы (иначе соседние
// runs слипаются: «Согласно » + «статье» → «Согласностатье»). Только
// схлопываем переносы строк в пробел (PM-абзац = один блок).
const _escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _runToHtml = (run) => {
  const t = String((run && run.t) || '').replace(/\s*\n\s*/g, ' ');
  if (!t.trim() && t === '') return '';
  let html = _escHtml(t);
  if (run.bold) html = `<strong>${html}</strong>`;
  if (run.italic) html = `<em>${html}</em>`;       // курсив — цитаты НПА
  if (run.underline) html = `<u>${html}</u>`;       // подчёрк — особые моменты
  return html;
};
// Ячейка реквизитов: строки → абзацы (первая строка — жирная: название стороны).
const _linesToCellHtml = (s) => String(s == null ? '' : s).split('\n').map((ln, i) => {
  const t = _escHtml(ln.trim());
  return `<p style="font-family:'Times New Roman', serif;${i === 0 ? 'font-weight:bold;' : ''}">${t || '&nbsp;'}</p>`;
}).join('');
const _blockToHtml = (block) => {
  // Двухколоночные реквизиты договора (Сторона 1 | Сторона 2) — через таблицу.
  if (block.kind === 'requisites_table' && (block.left || block.right)) {
    return `<table style="width:100%;border-collapse:collapse;border:none;"><tbody><tr>`
      + `<td style="width:50%;vertical-align:top;padding-right:12px;border:none;">${_linesToCellHtml(block.left)}</td>`
      + `<td style="width:50%;vertical-align:top;padding-left:12px;border:none;">${_linesToCellHtml(block.right)}</td>`
      + `</tr></tbody></table>`;
  }
  const align = block.align || LEGAL_KIND_ALIGN[block.kind] || 'left';
  const inner = (block.runs || []).map(_runToHtml).join('');
  // text-align читается HTML-импортёром SuperDoc (style.textAlign → OOXML w:jc).
  const style = `text-align:${align};font-family:'Times New Roman', serif;`;
  return `<p style="${style}">${inner || '&nbsp;'}</p>`;
};

// Убираем ПУСТЫЕ абзацы по краям (стартовый <p><br></p> нового дока и хвост),
// НЕ трогая намеренные spacer-абзацы в середине.
const _trimEmptyEdges = (editor) => {
  const view = editor && editor.view; if (!view) return;
  // лидирующий пустой абзац
  let st = view.state;
  if (st.doc.childCount > 1) {
    const f = st.doc.firstChild;
    if (f && f.isTextblock && f.content.size === 0) view.dispatch(st.tr.delete(0, f.nodeSize));
  }
  // хвостовой пустой абзац
  st = view.state;
  if (st.doc.childCount > 1) {
    const l = st.doc.lastChild;
    if (l && l.isTextblock && l.content.size === 0) {
      const start = st.doc.content.size - l.nodeSize;
      view.dispatch(st.tr.delete(start, st.doc.content.size));
    }
  }
};

async function renderLegalDocument(blocks, opts = {}) {
  const toast = opts.onToast;
  if (!Array.isArray(blocks) || !blocks.length) { toast && toast('warning', 'Пустой документ'); return false; }

  // 1. Новый чистый таб (генерация начисто, без Track Changes).
  const prev = window.docEngine || null;
  try { if (window.__ideHandleAction) window.__ideHandleAction('newDoc', opts.name || 'Документ.docx'); }
  catch (e) { console.warn('[renderLegalDocument] newDoc dispatch failed', e); }

  // 2. Ждём готовности нового редактора (Document API).
  const editor = await _waitFreshEditor(prev, 8000);
  if (!editor || !editor.doc || typeof editor.doc.insert !== 'function') { toast && toast('warning', 'Редактор не готов'); return false; }

  try {
    // 3. Собираем HTML и вставляем через Document API. HTML-импортёр SuperDoc
    //    сам разбирает style="text-align" → выравнивание и <strong>/<em>/<u>
    //    → марки. Это надёжнее, чем гадать имя PM-атрибута выравнивания.
    const html = blocks.map(_blockToHtml).join('');
    const r = editor.doc.insert({ value: html, type: 'html' });
    if (r && typeof r.then === 'function') { try { await r; } catch (_) {} }
    // 4. Чистим пустой стартовый абзац нового документа.
    setTimeout(() => { try { _trimEmptyEdges(editor); } catch (_) {} }, 60);
    try { editor.commands && editor.commands.focus && editor.commands.focus('start'); } catch (_) {}
    console.log('[renderLegalDocument] rendered via HTML', { blocks: blocks.length, htmlLen: html.length });
    toast && toast('check', 'Документ сгенерирован');
    return true;
  } catch (e) {
    console.error('[renderLegalDocument] failed:', e);
    toast && toast('warning', 'Ошибка генерации: ' + ((e && e.message) || e));
    return false;
  }
}

/* ═══ Прогрессивная вставка: документ появляется по блокам во время генерации ═══ */
// Открываем чистый таб ОДИН раз и возвращаем свежий редактор. Дальше блоки
// дописываются по одному (_appendLegalBlock) — как печатает ИИ.
const _openLegalDoc = async (opts = {}) => {
  const prev = window.docEngine || null;
  try { if (window.__ideHandleAction) window.__ideHandleAction('newDoc', opts.name || 'Документ.docx'); }
  catch (e) { console.warn('[openLegalDoc] newDoc dispatch failed', e); }
  const editor = await _waitFreshEditor(prev, 8000);
  return (editor && editor.doc && typeof editor.doc.insert === 'function') ? editor : null;
};
// Дописываем один блок в конец. Курсор держим в конце (focus('end')) — тогда
// последовательные insert'ы идут друг за другом, а не в начало.
const _appendLegalBlock = async (editor, block) => {
  try { editor.commands && editor.commands.focus && editor.commands.focus('end'); } catch (_) {}
  const html = _blockToHtml(block);
  const r = editor.doc.insert({ value: html, type: 'html' });
  if (r && typeof r.then === 'function') { try { await r; } catch (_) {} }
};
// Финал: убрать пустые края, курсор в начало.
const _finalizeLegalDoc = (editor) => {
  setTimeout(() => { try { _trimEmptyEdges(editor); } catch (_) {} }, 60);
  try { editor.commands && editor.commands.focus && editor.commands.focus('start'); } catch (_) {}
};

/* ═══════════ ТЕСТОВЫЙ JSON ИСКА (Фаза 1 — проверка движка) ═══════════ */
const ISK_TEST_BLOCKS = [
  { kind: 'court', align: 'right', runs: [{ t: 'Свердловский районный суд г. Бишкек' }] },
  { kind: 'spacer', runs: [] },
  { kind: 'party_header', runs: [{ t: 'Истец: ОсОО «Бишкектеплосервис»' }] },
  { kind: 'party_header', runs: [{ t: 'г. Бишкек, ул. Рыскулова, 34' }] },
  { kind: 'party_header', runs: [{ t: 'ИНН: 00710201910236' }] },
  { kind: 'party_header', runs: [{ t: 'Ответчик: гр. Иванов Иван Иванович' }] },
  { kind: 'party_header', runs: [{ t: 'г. Бишкек, ул. Ленина, 1, кв. 8' }] },
  { kind: 'spacer', runs: [] },
  { kind: 'title', runs: [{ t: 'ИСКОВОЕ ЗАЯВЛЕНИЕ', bold: true }] },
  { kind: 'subtitle', runs: [{ t: 'о взыскании задолженности за потреблённую тепловую энергию в сумме 13 564,86 сом' }] },
  { kind: 'spacer', runs: [] },
  { kind: 'paragraph', runs: [{ t: 'На основании договора доверительного управления имуществом от 13 октября 2023 года ОсОО «Бишкектеплосервис» приняло оборудование газовой котельной и обеспечивает бесперебойную поставку тепловой энергии потребителям.' }] },
  { kind: 'paragraph', runs: [
      { t: 'Согласно ' },
      { t: 'статье 487 Гражданского кодекса Кыргызской Республики', italic: true, cite: 'ГК КР ст.487' },
      { t: ', по договору энергоснабжения энергоснабжающая организация обязуется подавать абоненту энергию, а абонент обязуется оплачивать принятую энергию.' },
  ] },
  { kind: 'paragraph', runs: [
      { t: 'В соответствии с ' },
      { t: 'частью 5 статьи 222 Гражданского кодекса Кыргызской Республики', italic: true, cite: 'ГК КР ст.222 ч.5' },
      { t: ', собственник несёт бремя содержания принадлежащего ему имущества, включая оплату тепловой энергии.' },
  ] },
  { kind: 'paragraph', runs: [
      { t: 'Сумма задолженности ответчика по состоянию на дату подачи иска составляет ' },
      { t: '13 564,86 сом', bold: true, underline: true },
      { t: ' и до настоящего времени не погашена.' },
  ] },
  { kind: 'spacer', runs: [] },
  { kind: 'demand_heading', runs: [{ t: 'Прошу:', bold: true, underline: true }] },
  { kind: 'demand_item', runs: [{ t: '1. Взыскать с ответчика в пользу ОсОО «Бишкектеплосервис» задолженность за тепловую энергию в сумме 13 564,86 сом;' }] },
  { kind: 'demand_item', runs: [{ t: '2. Взыскать с ответчика государственную пошлину в сумме 100 сом.' }] },
  { kind: 'paragraph', runs: [{ t: 'Всего взыскать: 13 564,86 сом.', bold: true }] },
  { kind: 'spacer', runs: [] },
  { kind: 'attachment_heading', runs: [{ t: 'Приложение:', bold: true }] },
  { kind: 'attachment_item', runs: [{ t: '1. Договор доверительного управления имуществом;' }] },
  { kind: 'attachment_item', runs: [{ t: '2. Расчёт суммы задолженности;' }] },
  { kind: 'attachment_item', runs: [{ t: '3. Копия претензии;' }] },
  { kind: 'attachment_item', runs: [{ t: '4. Квитанция об оплате государственной пошлины.' }] },
  { kind: 'spacer', runs: [] },
  { kind: 'signature', runs: [{ t: 'Представитель по доверенности _____________ / И.О. Фамилия' }] },
];

/* ═══════════ CREATE DOC MODE — мультиагентная генерация по досье ═══════════ */
// Типы документов для шага выбора. Все ведут единый пайплайн (draft-intake →
// draft-document); поведение ветвится по метаданным шаблона в lib/docTemplates.js.
// «custom» (Прочее) — свободное описание: интервьюер сам выясняет, что нужно.
const DOC_TYPES = [
  { k: 'isk',         label: 'Исковое заявление',    blurb: 'Обращение в суд',              active: true },
  { k: 'pretenziya',  label: 'Претензия',            blurb: 'Досудебное требование',        active: true },
  { k: 'zayavlenie',  label: 'Заявление',            blurb: 'Обращение в орган/организацию', active: true },
  { k: 'zhaloba',     label: 'Жалоба',               blurb: 'Обжалование действий в орган',  active: true },
  { k: 'vozrazhenie', label: 'Возражение на иск',    blurb: 'Отзыв ответчика на иск',        active: true },
  { k: 'hodataistvo', label: 'Ходатайство',          blurb: 'Процессуальное обращение в суд', active: true },
  { k: 'apellyaciya', label: 'Апелляционная жалоба', blurb: 'Обжалование решения суда',      active: true },
  { k: 'raspiska',    label: 'Расписка',             blurb: 'Получение денег/имущества',     active: true },
  { k: 'doverennost', label: 'Доверенность',         blurb: 'Полномочия представителю',      active: true },
  { k: 'pismo',       label: 'Официальное письмо',   blurb: 'Деловое письмо в орган',        active: true },
  { k: 'dogovor',     label: 'Договор',              blurb: 'Двусторонний, любой вид',       active: true },
  { k: 'custom',      label: 'Прочее',               blurb: 'Опишите, какой документ нужен', active: true, custom: true },
];
const INTAKE_GREETING = {
  isk: 'Опишите ситуацию своими словами: в какой суд подаём иск, кто истец и кто ответчик, что произошло и чего вы требуете. Если чего-то не хватит — я уточню.',
  pretenziya: 'Опишите ситуацию: кому адресована претензия и от кого, какой договор/обязательство нарушены, что именно вы требуете и в какой срок. Если чего-то не хватит — я уточню.',
  zayavlenie: 'Опишите ситуацию: в какой орган или организацию подаётся заявление, от кого, и о чём вы просите. Если чего-то не хватит — я уточню.',
  zhaloba: 'Опишите ситуацию: куда подаётся жалоба и от кого, чьи действия обжалуете, что произошло и чего хотите добиться. Если чего-то не хватит — я уточню.',
  vozrazhenie: 'Опишите: в каком суде дело, кто истец и ответчик, на что подан иск и почему вы с ним не согласны. Если чего-то не хватит — я уточню.',
  hodataistvo: 'Опишите: в каком суде дело и о чём вы хотите ходатайствовать (истребовать доказательство, вызвать свидетеля, назначить экспертизу и т.п.). Если чего-то не хватит — я уточню.',
  apellyaciya: 'Опишите: какое решение какого суда и по какому делу обжалуете, и почему оно, по-вашему, незаконно. Если чего-то не хватит — я уточню.',
  raspiska: 'Опишите: кто и от кого получил деньги или имущество, какая сумма, на каком основании (заём/задаток) и к какому сроку вернуть. Если чего-то не хватит — я уточню.',
  doverennost: 'Опишите: кто доверитель и кому (поверенному) доверяет, какие именно полномочия и на какой срок. Если чего-то не хватит — я уточню.',
  pismo: 'Опишите: кому адресовано письмо и от кого, и что вы хотите сообщить или попросить. Если чего-то не хватит — я уточню.',
  dogovor: 'Опишите: какой нужен договор (услуги, аренда, купля-продажа, подряд, заём и т.п.), кто стороны (наименования/ФИО, реквизиты), что является предметом и ключевые условия (цена, сроки, обязанности). Если чего-то не хватит — я уточню.',
  custom: 'Опишите своими словами, какой документ вам нужен и для какой ситуации: кто участвует, что нужно зафиксировать или потребовать. Я уточню недостающее и составлю документ.',
};
// Готовые примеры для старта диалога (заполняют поле ввода по клику).
const DOC_EXAMPLES = {
  isk: 'Иск в Первомайский районный суд г. Бишкек. Истец Иванов И.И., ответчик ОсОО «Ромашка». Не вернули предоплату 50 000 сом по договору поставки от 10.01.2025.',
  pretenziya: 'Претензия к ОсОО «Маркет»: купил телефон 01.03.2025, через неделю сломался, требую вернуть 20 000 сом в течение 10 дней.',
  zayavlenie: 'Заявление в мэрию г. Бишкек о предоставлении информации о статусе земельного участка по ул. Чуй, 100.',
  zhaloba: 'Жалоба в Нацбанк на ОАО «Банк»: списали комиссию 5 000 сом без согласия, требую вернуть и проверить.',
  vozrazhenie: 'Возражение на иск ОсОО «Тепло» о взыскании 30 000 сом: услуги не оказаны, расчёт завышен, истёк срок давности.',
  hodataistvo: 'Ходатайство в суд об истребовании банковской выписки по счёту ответчика для подтверждения оплаты.',
  apellyaciya: 'Апелляционная жалоба на решение Свердловского райсуда от 01.04.2025: суд не учёл квитанцию об оплате.',
  raspiska: 'Расписка: Петров П.П. получил от Иванова И.И. 100 000 сом в долг, обязуется вернуть до 31.12.2025 под 2% в месяц.',
  doverennost: 'Доверенность от Иванова И.И. на Петрова П.П. представлять интересы в суде и госорганах сроком на 1 год.',
  pismo: 'Письмо в антимонопольную службу с разъяснениями по обращению гражданина о тарифах на теплоснабжение.',
  dogovor: 'Договор оказания услуг между ОсОО «Заказчик» и ИП Петров: разработка сайта за 80 000 сом, срок 30 дней.',
  custom: 'Соглашение о намерениях между двумя компаниями о будущем сотрудничестве по поставке оборудования.',
};

const CreateDocMode = ({ onToast }) => {
  const [step, setStep]       = useState('pick');   // pick | chat
  const [docType, setDocType] = useState(null);
  const [messages, setMessages] = useState([]);     // {role:'assistant'|'user', text}
  const [input, setInput]     = useState('');
  const [busy, setBusy]       = useState(false);     // интервьюер думает
  const [ready, setReady]     = useState(false);     // досье собрано
  const [genBusy, setGenBusy] = useState(false);
  const [genStatus, setGenStatus] = useState('');  // прогресс генерации (SSE-stage)
  const [genDone, setGenDone]     = useState(false); // документ сгенерирован (показать «Скачать»)
  const [genReview, setGenReview] = useState(null);  // результат самопроверки {ok, issues[]}
  const [genBlocks, setGenBlocks] = useState([]);   // блоки последнего документа (для точечного патча)
  const [patchBusy, setPatchBusy] = useState(false); // идёт точечное исправление замечаний
  const [deepReview, setDeepReview] = useState(null); // результат глубокой проверки {findings[], score, summary}
  const [deepBusy, setDeepBusy]   = useState(false);  // идёт глубокая проверка
  const listRef = useRef(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, busy]);

  const pickType = (t) => {
    setDocType(t); setStep('chat'); setReady(false); setGenDone(false); setGenReview(null);
    setMessages([{ role: 'assistant', text: INTAKE_GREETING[t] || 'Опишите суть документа.' }]);
  };
  const restart = () => { setStep('pick'); setDocType(null); setMessages([]); setInput(''); setReady(false); setGenDone(false); setGenReview(null); };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user', text }];
    setMessages(next); setInput(''); setBusy(true);
    try {
      // В модель шлём всю историю (память диалога), КРОМЕ служебных ошибок —
      // чтобы они не засоряли контекст интервьюера.
      const payloadMsgs = next.filter(m => !(m.role === 'assistant' && /не до конца понял|не смог разобрать|Не удалось связаться/i.test(m.text)));
      const res = await fetch(`${_ensureBackend()}/api/v2/draft-intake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType, messages: payloadMsgs }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.ready) {
        setReady(true);
        const sum = data.summary ? `Досье собрано:\n\n${data.summary}\n\n` : 'Досье собрано.\n\n';
        setMessages(m => [...m, { role: 'assistant', text: sum + '✅ Можно переходить к генерации документа.' }]);
      } else {
        const qs = (data.questions && data.questions.length) ? data.questions : ['Уточните, пожалуйста, детали.'];
        setMessages(m => [...m, { role: 'assistant', text: qs.map((q, i) => qs.length > 1 ? `${i + 1}. ${q}` : q).join('\n') }]);
      }
    } catch (e) {
      console.error('[draft-intake]', e);
      setMessages(m => [...m, { role: 'assistant', text: '⚠️ Не удалось связаться с интервьюером. Попробуйте ещё раз.' }]);
      onToast && onToast('warning', 'Ошибка интервьюера');
    } finally { setBusy(false); }
  };

  const downloadDoc = () => { try { window.__ideHandleAction && window.__ideHandleAction('exportWord'); } catch (_) {} };
  const downloadPdf = () => { try { window.__ideHandleAction && window.__ideHandleAction('exportPdf'); } catch (_) {} };

  const generate = async () => {
    if (genBusy) return; setGenBusy(true); setGenStatus('Запускаю агентов…'); setGenDone(false); setGenReview(null); setDeepReview(null);
    try {
      // Фаза 2B: мультиагентная research-коллегия (SSE):
      // планировщик → RAG по 4 группам норм → отборщик → драфтер v4-pro.
      const payloadMsgs = messages.filter(m => !(m.role === 'assistant' && /не до конца понял|не смог разобрать|Не удалось связаться/i.test(m.text)));
      const res = await fetch(`${_ensureBackend()}/api/v2/draft-document`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType, messages: payloadMsgs }),
      });
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try { const e = await res.json(); if (e && e.error) msg = e.error; } catch (_) {}
        throw new Error(msg);
      }
      const tplLabel = (DOC_TYPES.find(d => d.k === docType) || {}).label || 'Документ';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let result = null, errMsg = null;
      // Прогрессивная отрисовка: открываем редактор на первом блоке и дописываем
      // блоки по мере прихода. failed → переходим на полный рендер в конце.
      const streamed = [];
      let editor = null, opened = false, failed = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt; try { evt = JSON.parse(payload); } catch (_) { continue; }
          if (evt.block) {
            streamed.push(evt.block);
            setGenStatus(`✍️ Пишу документ… (блоков: ${streamed.length})`);
            if (!failed) {
              if (!opened) { opened = true; editor = await _openLegalDoc({ name: `${tplLabel}.docx` }); if (!editor) failed = true; }
              if (editor) { try { await _appendLegalBlock(editor, evt.block); } catch (_) { failed = true; } }
            }
          }
          else if (evt.stage) setGenStatus(evt.stage);
          else if (evt.error) errMsg = evt.error;
          else if (evt.done) result = evt;
          // evt.heartbeat игнорируем (только держит соединение живым).
        }
      }
      if (errMsg) throw new Error(errMsg);
      const finalBlocks = (result && Array.isArray(result.blocks) && result.blocks.length) ? result.blocks : streamed;
      if (!finalBlocks.length) throw new Error('Пустой документ от генератора');

      if (!failed && opened && editor && streamed.length) {
        // Прогрессивная вставка прошла — просто финализируем.
        setGenStatus('Готово ✓');
        _finalizeLegalDoc(editor);
        onToast && onToast('check', 'Документ сгенерирован');
      } else {
        // Фолбэк: рисуем целиком (стрим не сработал / формат-обёртка / нет блоков).
        setGenStatus('Отрисовываю документ…');
        await renderLegalDocument(finalBlocks, { onToast, name: `${tplLabel}.docx` });
      }
      const n = (result && result.articlesUsed || []).length;
      if (n) onToast && onToast('law', `Задействовано норм: ${n}`);
      setGenReview(result && result.review || null);
      setGenBlocks(finalBlocks);
      setGenDone(true);
    } catch (e) {
      console.error('[draft-document]', e);
      onToast && onToast('warning', 'Ошибка генерации: ' + ((e && e.message) || e));
    } finally { setGenBusy(false); setGenStatus(''); }
  };

  // ── Точечное исправление замечаний самопроверки ──
  const fixIssues = async () => {
    if (patchBusy || genBusy || !genBlocks.length || !(genReview && genReview.issues && genReview.issues.length)) return;
    // Захватываем issues ДО обнуления состояния
    const issuesToFix = genReview.issues.filter(i => i.severity !== 'low');
    const blocksSnapshot = genBlocks.slice();
    setPatchBusy(true); setGenBusy(true); setGenStatus('🔎 Анализирую замечания…'); setGenReview(null);
    try {
      const res = await fetch(`${_ensureBackend()}/api/v2/patch-document`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType, messages, blocks: blocksSnapshot, issues: issuesToFix }),
      });
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try { const e = await res.json(); if (e && e.error) msg = e.error; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let result = null, errMsg = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt; try { evt = JSON.parse(payload); } catch (_) { continue; }
          if (evt.stage) setGenStatus(evt.stage);
          else if (evt.error) errMsg = evt.error;
          else if (evt.done) result = evt;
        }
      }
      if (errMsg) throw new Error(errMsg);
      if (!result || !Array.isArray(result.blocks) || !result.blocks.length) throw new Error('Нет исправленных блоков');
      const tplLabel = (DOC_TYPES.find(d => d.k === docType) || {}).label || 'Документ';
      setGenStatus('Обновляю документ…');
      await renderLegalDocument(result.blocks, { onToast, name: `${tplLabel}.docx` });
      setGenBlocks(result.blocks);
      setGenReview(result.review || null);
      onToast && onToast('check', result.patched ? 'Замечания исправлены точечно' : 'Документ обновлён');
    } catch (e) {
      console.error('[patch-document]', e);
      onToast && onToast('warning', 'Ошибка исправления: ' + ((e && e.message) || e));
    } finally { setPatchBusy(false); setGenBusy(false); setGenStatus(''); }
  };

  // ── Глубокая проверка документа (по кнопке) ──
  const runDeepCheck = async () => {
    if (deepBusy || genBusy || !genBlocks.length) return;
    setDeepBusy(true); setDeepReview(null);
    try {
      const res = await fetch(`${_ensureBackend()}/api/v2/deep-check-document`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType, messages, blocks: genBlocks }),
      });
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try { const e = await res.json(); if (e && e.error) msg = e.error; } catch (_) {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let result = null, errMsg = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt; try { evt = JSON.parse(payload); } catch (_) { continue; }
          if (evt.error) errMsg = evt.error;
          else if (evt.done) result = evt;
        }
      }
      if (errMsg) throw new Error(errMsg);
      if (result) setDeepReview(result);
    } catch (e) {
      console.error('[deep-check]', e);
      onToast && onToast('warning', 'Ошибка глубокой проверки: ' + ((e && e.message) || e));
    } finally { setDeepBusy(false); }
  };

  // ── ШАГ 1: выбор типа ──
  if (step === 'pick') {
    return (
      <div style={{ padding: 'var(--s-4)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--text-main)', margin: 0 }}>Создание документа</h3>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 'var(--s-1)' }}>Выберите тип — затем опишите ситуацию, ИИ задаст уточняющие вопросы и соберёт досье.</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          {DOC_TYPES.map(d => (
            <button key={d.k} type="button" disabled={!d.active} className={`myz-doc-type-btn${d.active?'':' myz-doc-type-btn--dim'}`}
              onClick={() => d.active && pickType(d.k)}
              style={{ textAlign: 'left', padding: 'var(--s-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: d.active ? 'var(--bg-app)' : 'var(--hover)', cursor: d.active ? 'pointer' : 'default', opacity: d.active ? 1 : 0.55, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-2)', fontFamily: 'var(--font-sans)' }}>
              <span>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--text-base)', color: 'var(--text-main)' }}>{d.label}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{d.blurb}</span>
              </span>
              {!d.active && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-pill)', padding: '2px 8px' }}>скоро</span>}
              {d.active && <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 16 }}>→</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── ШАГ 2: диалог-досье ──
  const tplLabel = (DOC_TYPES.find(d => d.k === docType) || {}).label || 'Документ';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 var(--s-2) 0', borderBottom: '1px solid var(--border-color)' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-main)' }}>{tplLabel}</span>
        <button type="button" onClick={restart} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', cursor: 'pointer' }}>Сменить тип</button>
      </div>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 'var(--s-2h) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {messages.map((m, i) => (
          <div key={i} className={`myz-create-bubble${m.role==='user'?' myz-create-bubble--user':' myz-create-bubble--ai'}`} style={{ alignSelf: m.role==='user'?'flex-end':'flex-start', maxWidth:'88%', whiteSpace:'pre-wrap', fontSize:'var(--text-sm)', lineHeight:1.6, padding:'var(--s-1h) var(--s-2h)', borderRadius: m.role==='user'?'12px 12px 4px 12px':'12px 12px 12px 4px' }}>{m.text}</div>
        ))}
        {busy && (
          <div className="myz-create-bubble myz-create-bubble--ai" style={{ alignSelf:'flex-start', maxWidth:'60%', padding:'var(--s-1h) var(--s-2h)', borderRadius:'12px 12px 12px 4px', display:'flex', alignItems:'center', gap:'var(--s-1h)' }}>
            <span className="gen-dots"><span/><span/><span/></span>
            <span style={{ fontSize:'var(--text-xs)', color:'var(--muted)' }}>Интервьюер думает…</span>
          </div>
        )}
      </div>
      {ready && (
        <div style={{ margin: 'var(--s-2) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-1h)' }}>
          {/* Прогресс генерации / патча */}
          {genBusy && genStatus && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', padding: '0 var(--s-1)', display: 'flex', alignItems: 'center' }}>
              <span className="gen-dots"><span/><span/><span/></span>
              <span>{genStatus}</span>
            </div>
          )}

          {/* Кнопка первичной генерации — только до первого успешного результата */}
          {!genDone && (
            <button type="button" onClick={generate} disabled={genBusy}
              style={{ width: '100%', padding: 'var(--s-2h)', borderRadius: 'var(--radius-sm)', border: 'none', background: genBusy ? 'var(--hover)' : 'linear-gradient(135deg,var(--accent),var(--accent2))', color: genBusy ? 'var(--muted)' : '#fff', fontWeight: 600, fontSize: 'var(--text-sm)', cursor: genBusy ? 'default' : 'pointer', fontFamily: 'var(--font-sans)' }}>
              {genBusy ? 'Агенты работают…' : '⚖️ Сгенерировать документ'}
            </button>
          )}

          {/* После генерации: скачать → замечания → Доработать */}
          {genDone && !genBusy && (
            <>
              <div style={{ display: 'flex', gap: 'var(--s-1h)' }}>
                <button type="button" onClick={downloadDoc}
                  style={{ flex: 1, padding: 'var(--s-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-app)', color: 'var(--text-main)', fontWeight: 600, fontSize: 'var(--text-sm)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                  ⬇ .docx
                </button>
                <button type="button" onClick={downloadPdf}
                  style={{ flex: 1, padding: 'var(--s-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-app)', color: 'var(--text-main)', fontWeight: 600, fontSize: 'var(--text-sm)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                  ⬇ PDF
                </button>
              </div>

              {/* Карточка самопроверки */}
              {genReview && (
                <div style={{ padding: 'var(--s-2h)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-app)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: genReview.ok ? 'var(--green, #10a37f)' : 'var(--orange, #d97706)', marginBottom: (genReview.issues && genReview.issues.length) ? 'var(--s-1h)' : 0 }}>
                    {genReview.ok ? '✓ Самопроверка: замечаний нет' : `⚠ Самопроверка: замечаний — ${genReview.issues.length}`}
                  </div>
                  {(genReview.issues || []).map((it, i) => (
                    <div key={i} style={{ display: 'flex', gap: 'var(--s-1)', fontSize: 'var(--text-xs)', lineHeight: 1.45, padding: '3px 0' }}>
                      <span style={{ flexShrink: 0 }}>{it.severity === 'high' ? '🔴' : it.severity === 'medium' ? '🟡' : '🔵'}</span>
                      <span style={{ color: it.severity === 'low' ? 'var(--accent, #2563eb)' : 'var(--text-muted)' }}>
                        {it.text}
                        {it.severity === 'low' && <span style={{ marginLeft: 4, opacity: 0.7, fontStyle: 'italic' }}> — заполните вручную</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Кнопка «Глубокий анализ» ── */}
              <button type="button" onClick={runDeepCheck} disabled={deepBusy || genBusy}
                style={{ width: '100%', padding: 'var(--s-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: deepBusy ? 'var(--hover)' : 'var(--bg-app)', color: deepBusy ? 'var(--muted)' : 'var(--text-main)', fontWeight: 600, fontSize: 'var(--text-sm)', cursor: (deepBusy || genBusy) ? 'default' : 'pointer', fontFamily: 'var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--s-1h)' }}>
                {deepBusy
                  ? <><span className="gen-dots"><span/><span/><span/></span><span>Анализирую…</span></>
                  : '🔬 Глубокий анализ документа'}
              </button>

              {/* ── Карточка результатов глубокой проверки ── */}
              {deepReview && (
                <div style={{ padding: 'var(--s-2h)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-app)' }}>
                  {/* Заголовок с оценкой */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s-1h)' }}>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-main)' }}>🔬 Глубокий анализ</span>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-pill)',
                      background: deepReview.score >= 85 ? 'rgba(16,163,127,.15)' : deepReview.score >= 60 ? 'rgba(217,119,6,.15)' : 'rgba(239,68,68,.15)',
                      color: deepReview.score >= 85 ? 'var(--green,#10a37f)' : deepReview.score >= 60 ? 'var(--orange,#d97706)' : '#ef4444' }}>
                      {deepReview.score}/100
                    </span>
                  </div>
                  {/* Итог */}
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: deepReview.findings && deepReview.findings.length ? 'var(--s-1h)' : 0, lineHeight: 1.45 }}>
                    {deepReview.summary}
                  </div>
                  {/* Список замечаний */}
                  {(deepReview.findings || []).map((f, i) => (
                    <div key={i} style={{ borderTop: '1px solid var(--border-color)', paddingTop: 'var(--s-1)', marginTop: 'var(--s-1)', display: 'flex', gap: 'var(--s-1)', fontSize: 'var(--text-xs)', lineHeight: 1.45 }}>
                      <span style={{ flexShrink: 0 }}>{f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🔵'}</span>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{f.claim}</div>
                        {f.location && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>📍 {f.location}</div>}
                        {f.article_hint && <div style={{ color: 'var(--accent,#2563eb)', marginTop: 2 }}>⚖️ {f.article_hint}</div>}
                        {f.reason && <div style={{ color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>{f.reason}</div>}
                        {f.category && <span style={{ display: 'inline-block', marginTop: 3, fontSize: 10, padding: '1px 6px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--border-color)', color: 'var(--muted)' }}>{f.category}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Кнопка «Доработать документ» / «Исправить замечания» — всегда снизу */}
              {(() => {
                const fixable = genReview && genReview.issues && genReview.issues.filter(i => i.severity !== 'low').length > 0;
                return (
                  <button type="button"
                    onClick={fixable ? fixIssues : generate}
                    style={{ width: '100%', padding: 'var(--s-2h)', borderRadius: 'var(--radius-sm)', border: 'none', background: 'linear-gradient(135deg,var(--accent),var(--accent2))', color: '#fff', fontWeight: 600, fontSize: 'var(--text-sm)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
                    {fixable
                      ? `✏️ Исправить замечания (${genReview.issues.filter(i => i.severity !== 'low').length})`
                      : '↺ Доработать документ'}
                  </button>
                );
              })()}
            </>
          )}
        </div>
      )}
      {/* Пример для старта — заполняет поле ввода (только в начале диалога). */}
      {messages.length <= 1 && !input.trim() && !ready && DOC_EXAMPLES[docType] && (
        <button type="button" onClick={() => setInput(DOC_EXAMPLES[docType])}
          style={{ alignSelf: 'flex-start', marginBottom: 'var(--s-1h)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-app)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-pill)', padding: 'var(--s-1) var(--s-2)', cursor: 'pointer', fontFamily: 'var(--font-sans)', textAlign: 'left', maxWidth: '100%' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}>
          💡 Пример: {DOC_EXAMPLES[docType].length > 64 ? DOC_EXAMPLES[docType].slice(0, 64) + '…' : DOC_EXAMPLES[docType]}
        </button>
      )}
      <div style={{ display: 'flex', gap: 'var(--s-1h)', alignItems: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: 'var(--s-2)' }}>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={Math.min(5, Math.max(1, input.split('\n').length))}
          placeholder="Опишите ситуацию или ответьте на вопрос…"
          style={{ flex: 1, resize: 'none', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', color: 'var(--text-main)', fontSize: 'var(--text-sm)', lineHeight: 1.5, padding: 'var(--s-1h) var(--s-2)', fontFamily: 'var(--font-sans)', outline: 'none' }}/>
        <button type="button" onClick={send} disabled={busy || !input.trim()}
          style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 'var(--radius-sm)', border: 'none', background: (busy || !input.trim()) ? 'var(--hover)' : 'var(--primary)', color: (busy || !input.trim()) ? 'var(--muted)' : '#fff', cursor: (busy || !input.trim()) ? 'default' : 'pointer', fontSize: 15 }}>➤</button>
      </div>
    </div>
  );
};

/* ═══════════ LEGAL TOOLS — калькулятор сроков (чистый клиент, без бэкенда) ═══════════ */
// Прибавляет период к дате. Без хардкода правовых ставок — период задаёт юрист,
// пресеты лишь ориентир (исчисление сроков уточняется по НПА КР).
const _addPeriod = (dateStr, amount, unit) => {
  const d = new Date(dateStr); if (isNaN(d.getTime())) return null;
  const a = Number(amount) || 0;
  if (unit === 'years') d.setFullYear(d.getFullYear() + a);
  else if (unit === 'months') d.setMonth(d.getMonth() + a);
  else d.setDate(d.getDate() + a);
  return d;
};
const _fmtDate = (d) => d ? `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}` : '—';
const SROK_PRESETS = [
  ['Исковая давность (3 года)', 3, 'years'],
  ['Спец. давность (1 год)', 1, 'years'],
  ['Апелляция (30 дней)', 30, 'days'],
  ['Ответ на претензию (10 дней)', 10, 'days'],
  ['Ответ на претензию (30 дней)', 30, 'days'],
];
const DeadlineCalculator = () => {
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(3);
  const [unit, setUnit] = useState('years');
  const end = useMemo(() => _addPeriod(start, amount, unit), [start, amount, unit]);
  const daysLeft = useMemo(() => {
    if (!end) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((end.getTime() - today.getTime()) / 86400000);
  }, [end]);
  const tone = daysLeft == null ? 'var(--text-muted)' : daysLeft < 0 ? 'var(--red, #dc2626)' : daysLeft <= 30 ? 'var(--orange, #d97706)' : 'var(--green, #10a37f)';
  const inputStyle = { border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', color: 'var(--text-main)', fontSize: 'var(--text-sm)', padding: 'var(--s-1h) var(--s-2)', fontFamily: 'var(--font-sans)', outline: 'none' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2h)' }}>
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--text-main)', margin: 0 }}>Калькулятор сроков</h3>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--s-1)' }}>Дата события + период → крайний срок и сколько дней осталось.</p>
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-1h)', flexWrap: 'wrap' }}>
        {SROK_PRESETS.map(([label, a, u]) => (
          <button key={label} type="button" onClick={() => { setAmount(a); setUnit(u); }}
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-pill)', padding: 'var(--s-1) var(--s-2)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
            {label}
          </button>
        ))}
      </div>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Дата события
        <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
      </label>
      <div style={{ display: 'flex', gap: 'var(--s-1h)', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          Период
          <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} style={inputStyle} />
        </label>
        <select value={unit} onChange={e => setUnit(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
          <option value="days">дней</option>
          <option value="months">месяцев</option>
          <option value="years">лет</option>
        </select>
      </div>
      <div style={{ padding: 'var(--s-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-app)' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Крайний срок</div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-main)', fontFamily: 'var(--font-display)' }}>{_fmtDate(end)}</div>
        {daysLeft != null && (
          <div style={{ fontSize: 'var(--text-sm)', color: tone, marginTop: 4, fontWeight: 600 }}>
            {daysLeft < 0 ? `Срок истёк ${Math.abs(daysLeft)} дн. назад` : daysLeft === 0 ? 'Срок истекает сегодня' : `Осталось ${daysLeft} дн.`}
          </div>
        )}
      </div>
      <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted)', lineHeight: 1.4 }}>
        ⚠️ Ориентировочный расчёт. Порядок исчисления сроков (нерабочие дни, момент начала течения) уточняйте по НПА КР для конкретного случая.
      </p>
    </div>
  );
};
// Калькулятор госпошлины — цена иска × ставка. Ставка РЕДАКТИРУЕМАЯ (пресеты —
// ориентир по ПП КР №159), без хардкода спорных значений; ссылка на офиц. калькулятор.
const _fmtSom = (n) => { try { return new Intl.NumberFormat('ru-RU').format(Math.round(n)); } catch (_) { return String(Math.round(n)); } };
const GOSP_PRESETS = [['Имущественный иск (3%)', 3], ['Раздел имущества (1%)', 1], ['Свой %', null]];
const GosposhlinaCalculator = () => {
  const [claim, setClaim] = useState('');
  const [rate, setRate] = useState(3);
  const fee = useMemo(() => {
    const c = parseFloat(String(claim).replace(/\s/g, '').replace(',', '.')) || 0;
    const r = parseFloat(String(rate).replace(',', '.')) || 0;
    return c > 0 ? c * r / 100 : 0;
  }, [claim, rate]);
  const inputStyle = { border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', color: 'var(--text-main)', fontSize: 'var(--text-sm)', padding: 'var(--s-1h) var(--s-2)', fontFamily: 'var(--font-sans)', outline: 'none', width: '100%', boxSizing: 'border-box' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2h)' }}>
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--text-main)', margin: 0 }}>Калькулятор госпошлины</h3>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--s-1)' }}>Цена иска × ставка. Ставку можно изменить под конкретное требование.</p>
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-1h)', flexWrap: 'wrap' }}>
        {GOSP_PRESETS.filter(p => p[1] != null).map(([label, r]) => (
          <button key={label} type="button" onClick={() => setRate(r)}
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-pill)', padding: 'var(--s-1) var(--s-2)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
            {label}
          </button>
        ))}
      </div>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Цена иска, сом
        <input type="text" inputMode="decimal" value={claim} onChange={e => setClaim(e.target.value)} placeholder="например, 150000" style={inputStyle} />
      </label>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Ставка, %
        <input type="number" min="0" step="0.1" value={rate} onChange={e => setRate(e.target.value)} style={inputStyle} />
      </label>
      <div style={{ padding: 'var(--s-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-app)' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Госпошлина</div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-main)', fontFamily: 'var(--font-display)' }}>{_fmtSom(fee)} сом</div>
      </div>
      <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted)', lineHeight: 1.4 }}>
        ⚠️ Ориентировочно. Ставки утверждены ПП КР №159 (15.04.2019) и зависят от характера требования и расчётного показателя (возможна прогрессивная шкала и льготы). Точный расчёт — на официальном калькуляторе sot.kg.
      </p>
    </div>
  );
};

// Библиотека типовых клауз — вставка готовых формулировок в открытый документ.
// Это шаблоны с прочерками; вставляются как обычный текст (не Track Changes).
const CLAUSES = [
  ['Разрешение споров',
    'Все споры и разногласия, возникающие из настоящего договора или в связи с ним, Стороны разрешают путём переговоров с обязательным направлением письменной претензии. Срок ответа на претензию — 10 (десять) календарных дней. При недостижении согласия спор подлежит рассмотрению в суде по месту нахождения ответчика в соответствии с законодательством Кыргызской Республики.'],
  ['Форс-мажор',
    'Стороны освобождаются от ответственности за полное или частичное неисполнение обязательств по настоящему договору, если оно явилось следствием обстоятельств непреодолимой силы (форс-мажор), возникших после заключения договора и которые Стороны не могли предвидеть или предотвратить. Сторона, для которой создалась невозможность исполнения, обязана письменно уведомить другую Сторону в течение ____ дней с момента наступления таких обстоятельств.'],
  ['Конфиденциальность',
    'Стороны обязуются сохранять конфиденциальность сведений, полученных в ходе исполнения настоящего договора, и не разглашать их третьим лицам без письменного согласия другой Стороны, за исключением случаев, предусмотренных законодательством Кыргызской Республики. Обязательство о конфиденциальности действует в течение срока действия договора и ____ лет после его прекращения.'],
  ['Согласие на обработку персональных данных',
    'Подписывая настоящий договор, Стороны дают друг другу согласие на обработку персональных данных (сбор, хранение, использование, передачу) в целях исполнения договора в соответствии с законодательством Кыргызской Республики о персональных данных. Согласие действует до истечения установленных законом сроков хранения.'],
  ['Срок действия и расторжение',
    'Настоящий договор вступает в силу с момента подписания Сторонами и действует до «___» __________ 20__ года / до полного исполнения Сторонами своих обязательств. Договор может быть расторгнут по соглашению Сторон, а также в одностороннем порядке в случаях, предусмотренных законодательством Кыргызской Республики, с письменным уведомлением за ____ дней.'],
  ['Электронный документооборот',
    'Стороны признают юридическую силу документов и сообщений, направленных по адресам электронной почты и номерам телефонов в мессенджерах, указанным в реквизитах Сторон. Стороны вправе использовать факсимильное воспроизведение подписи, что не противоречит требованиям статьи 176 Гражданского кодекса Кыргызской Республики.'],
];
const ClauseLibrary = ({ onToast }) => {
  const insertClause = (title, body) => {
    const ed = window.docEngine;
    if (!ed || !ed.doc || typeof ed.doc.insert !== 'function') { onToast && onToast('warning', 'Откройте документ в редакторе'); return; }
    const html = `<p style="text-align:left;font-family:'Times New Roman', serif;"><strong>${_escHtml(title)}</strong></p>`
      + `<p style="text-align:justify;font-family:'Times New Roman', serif;">${_escHtml(body)}</p>`;
    try { ed.commands && ed.commands.focus && ed.commands.focus('end'); } catch (_) {}
    try {
      const r = ed.doc.insert({ value: html, type: 'html' });
      if (r && typeof r.then === 'function') r.catch(() => {});
      onToast && onToast('check', `Вставлено: ${title}`);
    } catch (e) { onToast && onToast('warning', 'Не удалось вставить'); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--text-main)', margin: 0 }}>Библиотека клауз</h3>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--s-1)' }}>Готовые формулировки — вставляются в открытый документ (прочерки заполните).</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1h)' }}>
        {CLAUSES.map(([title, body]) => (
          <button key={title} type="button" onClick={() => insertClause(title, body)}
            style={{ textAlign: 'left', padding: 'var(--s-2h)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-app)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}>
            <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-main)' }}>{title}</span>
            <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{body.slice(0, 70)}…</span>
          </button>
        ))}
      </div>
    </div>
  );
};
const LegalToolsMode = ({ onToast }) => (
  <div style={{ padding: 'var(--s-1)', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
    <DeadlineCalculator />
    <div style={{ height: 1, background: 'var(--border-color)' }} />
    <GosposhlinaCalculator />
    <div style={{ height: 1, background: 'var(--border-color)' }} />
    <ClauseLibrary onToast={onToast} />
  </div>
);

/* ═══════════ DOCUMENTS MODE — оболочка с вкладками «Анализ | Создать | Инструменты» ═══════════ */
const DocumentsMode = ({ onToast }) => {
  const { tr } = useI18n();
  const [tab, setTab] = useState('analyze');
  const tabBtn = (k, label) => (
    <button key={k} type="button" onClick={() => setTab(k)}
      style={{ flex: 1, padding: 'var(--s-1h) var(--s-2)', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, fontFamily: 'var(--font-sans)', background: tab === k ? 'var(--primary)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-muted)', transition: 'background .15s, color .15s' }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: 'var(--s-1)', padding: 'var(--s-1h)', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-pill)', margin: '0 0 var(--s-2h) 0' }}>
        {tabBtn('analyze', tr('docs_tab_analyze'))}
        {tabBtn('create', tr('docs_tab_create'))}
        {tabBtn('tools', 'Инструменты')}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tab === 'analyze' ? <AnalyzeDocsMode /> : tab === 'create' ? <CreateDocMode onToast={onToast} /> : <LegalToolsMode onToast={onToast} />}
      </div>
    </div>
  );
};

/* ═══════════ MARKDOWN HELPER (с XSS-санитизацией через DOMPurify) ═══════════ */
// Sanitize HTML после marked.parse() — основная защита от XSS.
// Если DOMPurify не загрузился (CDN-сбой) — fallback на escape всего HTML.
const sanitizeHtml = (rawHtml) => {
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(rawHtml, {
      // Разрешаем стандартные markdown-теги + наш кастомный <sup class="cite-chip">.
      ALLOWED_TAGS: ['a','b','blockquote','br','code','div','em','h1','h2','h3','h4','h5','h6',
                     'hr','i','li','ol','p','pre','span','strong','sub','sup','table','tbody',
                     'td','th','thead','tr','u','ul'],
      ALLOWED_ATTR: ['href','title','class','data-cite','role','tabindex','target','rel'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      // forbid <script>, <iframe>, on* event-handlers (DOMPurify дефолт)
      FORBID_TAGS: ['style','script','iframe','object','embed','form','input'],
      FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover','onfocus','onblur']
    });
  }
  // Fallback: эскейпим всё → безопасный plain-text вывод
  return String(rawHtml).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
};

// Статус-маркеры пунктов заключения: цветной кружок-эмодзи → инлайновая SVG-иконка.
// Юр-агент-Судья ставит 🔴/🟡/🔵 в начало заголовка проблемного пункта вместо
// уродливых тегов [risk]/[violation]. Иконки — наша доверенная статика,
// вставляются ПОСЛЕ sanitizeHtml (как cite-chip), поэтому DOMPurify их не режет.
const STATUS_ICONS={
  [String.fromCodePoint(0x1F534)]: '<svg class="ag-stat-ico ag-stat-ico--red" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#e5484d"/><rect x="7.1" y="3.6" width="1.8" height="5.4" rx=".9" fill="#fff"/><circle cx="8" cy="11.7" r="1.1" fill="#fff"/></svg>',
  [String.fromCodePoint(0x1F7E1)]: '<svg class="ag-stat-ico ag-stat-ico--amber" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15.2 14.2H.8L8 1.5Z" fill="#f5a623"/><rect x="7.1" y="5.7" width="1.8" height="4.6" rx=".9" fill="#fff"/><circle cx="8" cy="12.2" r="1.05" fill="#fff"/></svg>',
  [String.fromCodePoint(0x1F535)]: '<svg class="ag-stat-ico ag-stat-ico--blue" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#3b82f6"/><circle cx="8" cy="4.7" r="1.15" fill="#fff"/><rect x="7.1" y="6.7" width="1.8" height="5.7" rx=".9" fill="#fff"/></svg>',
  [String.fromCodePoint(0x1F7E2)]: '<svg class="ag-stat-ico ag-stat-ico--green" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#30a46c"/><path d="M4.6 8.3 7 10.6 11.5 5.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const renderMarkdown=(text)=>{
  if(!text) return '';
  try{
    if(window.marked){
      const raw=window.marked.parse(String(text));
      let safe = sanitizeHtml(raw);
      // Inline-цитаты [1] / [2] → кликабельные chip. На уже sanitized HTML.
      // Не трогаем содержимое <code>/<pre> и атрибуты href.
      safe = safe.replace(/(<(?:code|pre)[^>]*>[\s\S]*?<\/(?:code|pre)>)|\[(\d{1,3})\]/g,
        (full, codeBlock, num) => codeBlock || `<sup class="cite-chip" data-cite="${num}" role="button" tabindex="0">[${num}]</sup>`);
      // Статус-маркеры 🔴🟡🔵🟢 → цветные SVG-иконки. Код-блоки не трогаем.
      safe = safe.replace(/(<(?:code|pre)[^>]*>[\s\S]*?<\/(?:code|pre)>)|([\u{1F534}\u{1F7E1}\u{1F535}\u{1F7E2}])/gu,
        (full, codeBlock, emoji) => codeBlock || (STATUS_ICONS[emoji] || emoji));
      return safe;
    }
  }catch(e){}
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>');
};

/* ═══════════ ARTICLE MODAL ═══════════ */
const ArticleModal=({article,onClose,onInsert})=>{
  const modalRef=useRef(null);
  useFocusTrap(!!article,modalRef);
  if(!article) return null;
  return(
    <div className="art-modal-overlay" onClick={onClose} role="presentation">
      <div className="art-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label={'Статья: '+(article.article_title||'')} onClick={e=>e.stopPropagation()}>
        <div className="art-modal-head">
          <div style={{display:'flex',alignItems:'center',gap:'var(--s-3)',minWidth:0,flex:1}}>
            <Ico k="book" sz={20} col="var(--accent)" grad glow/>
            <div style={{minWidth:0,flex:1}}>
              <div style={{fontFamily:'var(--font-display)',fontStyle:'italic',fontSize:'var(--text-xl)',color:'var(--text)',letterSpacing:'-.018em',lineHeight:'var(--lh-tight)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{article.article_title||'Статья'}</div>
              <div style={{fontSize:'var(--text-xs)',color:'var(--muted)',marginTop:'var(--s-half)',fontFamily:'var(--font-mono)',letterSpacing:'.04em',textTransform:'uppercase',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{article.npa_title||''}</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:'var(--s-2)',flexShrink:0}}>
            <span style={{fontSize:'var(--text-2xs)',fontFamily:'var(--font-mono)',color:'var(--muted)',padding:'var(--s-half) var(--s-1h)',border:'1px solid var(--border)',borderRadius:'var(--radius-xs)',letterSpacing:'.04em'}}>ESC</span>
            <button onClick={onClose} className="btn" title="Закрыть" style={{background:'var(--hover)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',width:32,height:32,padding:0,cursor:'pointer',color:'var(--text)',display:'flex',alignItems:'center',justifyContent:'center'}} onMouseEnter={e=>{e.currentTarget.style.background='var(--accent-dim)';e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.color='var(--accent-strong)'}} onMouseLeave={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text)'}}>
              <Ico k="x" sz={16}/>
            </button>
          </div>
        </div>
        <div className="art-modal-body">{article.full_text||'Текст статьи не найден.'}</div>
        <div className="art-modal-foot">
          <button onClick={()=>{navigator.clipboard&&navigator.clipboard.writeText(article.full_text||'');}} className="ai-act-btn">
            <Ico k="copy" sz={14}/><span>Копировать</span>
          </button>
          <button onClick={()=>onInsert&&onInsert(article.full_text||'')} className="btn" style={{display:'flex',alignItems:'center',gap:'var(--s-1h)',padding:'var(--s-1h) var(--s-3h)',border:'none',borderRadius:'var(--radius-sm)',background:'linear-gradient(135deg,var(--accent),var(--accent2))',color:'#fff',fontSize:'var(--text-sm)',fontWeight:600,cursor:'pointer',fontFamily:'var(--font-sans)'}}>
            <Ico k="file" sz={14} col="#fff"/><span>Вставить в редактор</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/* ═══════════ EDITOR ADAPTER (works with Quill OR TipTap based on true) ═══════════ */

/* ═══════════ INSERT INTO QUILL/TIPTAP ═══════════ */

/* ═══════════ AGENT MODE HELPERS ═══════════ */
const getDocSnapshot=()=>{
  if (!window.docEngine) return {text:"",selection:"",hasSelection:false};
  try {
    // ⚠️ SuperDoc Document API (без deprecated editor.view):
    //   • текст     → docEngine.doc.getText({})
    //   • выделение → docEngine.doc.selection.current() (empty/target)
    // editor.view (deprecated) дёргаем ТОЛЬКО когда выделение реально есть —
    // чтобы извлечь его текст. Эта функция вызывается на каждый рендер,
    // поэтому в обычном случае (без выделения) к view НЕ обращаемся → нет спама
    // «editor.view is deprecated».
    const doc = window.docEngine.doc;
    const text = (doc && typeof doc.getText === 'function')
      ? String(doc.getText({}) || '')
      : '';

    let selection = '';
    let hasSelection = false;
    try {
      const sel = (doc && doc.selection && typeof doc.selection.current === 'function')
        ? doc.selection.current()
        : null;
      if (sel && !sel.empty && sel.target) {
        // есть непустое текстовое выделение → достаём его текст из view
        const view = window.docEngine.view;
        if (view && view.state) {
          const { from, to } = view.state.selection;
          if (from < to) {
            selection = view.state.doc.textBetween(from, to, '\n');
            hasSelection = selection.trim().length > 0;
          }
        }
      }
    } catch (selErr) { /* нет выделения / API недоступен — не критично */ }
    return { text, selection, hasSelection };
  } catch (err) {
    console.warn('[getDocSnapshot] failed:', err);
    return {text:"",selection:"",hasSelection:false};
  }
};
const buildAgentPrompt=(userMsg,doc)=>{
  const MAX_DOC=15000;
  const rawText=String(doc.text||'').trim();
  const isEmpty=rawText.length===0;
  // Текст документа больше НЕ вшивается в prompt — он уходит отдельным полем
  // documentContext (бэкенд подмешивает его сам). Здесь только инструкция.
  let docCtx=isEmpty?'':rawText;
  if(docCtx.length>MAX_DOC) docCtx=docCtx.slice(0,MAX_DOC)+'\n…[документ обрезан]';
  const selBlock=doc.hasSelection?`\nВЫДЕЛЕННЫЙ ФРАГМЕНТ:\n"""\n${doc.selection}\n"""\n`:'';
  const emptyHint=isEmpty?'\n⚠️ Документ ПУСТ — обязательно верни "anchor_text": "EMPTY".':'';
  const prompt=`Ты — профессиональный юрист-драфтер Кыргызской Республики.

# КРИТИЧЕСКОЕ ПРАВИЛО — БЕЗ ГАЛЛЮЦИНАЦИЙ
Тебе ЗАПРЕЩЕНО:
1. Выдумывать номера статей, законов, кодексов, договоров, дат принятия НПА.
2. Утверждать о смене редакций кодекса/закона ("в редакции 1997 года это была ст. X, а в 2021 году стала ст. Y") если ты НЕ УВЕРЕН на 100%. Реформа УК КР 2021 г. перенумеровала многие статьи, но ты НЕ ЗНАЕШЬ точных соответствий без сверки с базой.
3. Ссылаться на номер статьи если не помнишь её точно. Лучше написать "согласно соответствующей статье УК КР о пытках" чем дать неверный номер.

Если пользователь УЖЕ упомянул номера статей в документе — НЕ оспаривай их без явных оснований. Просто работай с тем что есть.

Если сомневаешься в номере — добавь в reasoning явный disclaimer:
"⚠️ Номера статей следует сверить с актуальной редакцией на cbd.minjust.gov.kg — действует УК КР 2021 г., нумерация может отличаться от моей памяти."

# НАМЕРЕНИЕ ПОЛЬЗОВАТЕЛЯ
Сначала определи:
• ПРАВКА документа — фразы «добавь», «впиши», «вставь», «замени», «исправь», «дополни», «составь пункт», «перепиши».
• АНАЛИЗ без правки — «проанализируй», «разбери», «что думаешь», «оцени», «проверь риски», «найди ошибки», «объясни», «суммируй».

ТЕКУЩИЙ ТЕКСТ ДОКУМЕНТА передан отдельным блоком (см. ниже, под этим запросом).
${selBlock}
ЗАПРОС ПОЛЬЗОВАТЕЛЯ: ${userMsg}${emptyHint}

# ФОРМАТ ОТВЕТА — ТОЛЬКО JSON в \`\`\`json блоке. Никакого текста до или после блока:

\`\`\`json
{
  "reasoning": "Если ПРАВКА — кратко (1-2 предложения) что и почему меняешь. Если АНАЛИЗ — полный ответ пользователю: разбор + выводы + disclaimer о сверке номеров статей. Это поле увидит пользователь.",
  "commands": [
    {"op": "replace", "old_text": "ТОЧНАЯ существующая фраза из документа (посимвольно, как есть)", "new_text": "новый текст"},
    {"op": "insert_after", "anchor": "ТОЧНАЯ фраза-якорь из документа", "text": "новый абзац"},
    {"op": "insert_end", "text": "текст для добавления в конец документа"},
    {"op": "comment", "anchor": "ТОЧНАЯ фраза из документа", "text": "Риск: противоречит ст. X ГК КР — ..."},
    {"op": "format", "anchor": "ТОЧНАЯ фраза из документа", "marks": {"bold": true}}
  ]
}
\`\`\`

# КОГДА ЧТО ИСПОЛЬЗОВАТЬ (главное правило)
- Пользователь просит ИЗМЕНИТЬ/ИСПРАВИТЬ/ЗАМЕНИТЬ (сумму, дату, формулировку) → "op":"replace". Меняем текст.
- Пользователь просит ПРОАНАЛИЗИРОВАТЬ / НАЙТИ РИСКИ / ПРОВЕРИТЬ НА СООТВЕТСТВИЕ → НЕ переписывай документ! Вешай "op":"comment" на рискованные фрагменты: text = «Риск: противоречит ст. X ГК КР — пояснение». Текст документа остаётся нетронутым.
- Нужно ВЫДЕЛИТЬ фрагмент (новую сумму жирным, рискованный пункт) → "op":"format", marks: {"bold":true} | {"italic":true} | {"underline":true} | {"highlight":"yellow"} | {"color":"#c00"}.

# ПРАВИЛА КОМАНД (commands)
1. replace: old_text = ТОЧНАЯ существующая фраза из документа (буквально, посимвольно, со знаками), new_text = на что заменить. НЕ дублируй — именно замена.
2. insert_after (anchor) / insert_end — добавить новый пункт/абзац.
3. comment: anchor = ТОЧНАЯ фраза из документа, на которую вешается замечание; text = само замечание. Используй для режима поиска рисков.
4. format: anchor = ТОЧНАЯ фраза, marks = объект стиля.
5. anchor и old_text копируй ДОСЛОВНО из ТЕКУЩЕГО документа — иначе фрагмент не найдётся поиском.
6. Можно вернуть НЕСКОЛЬКО команд (например, comment на 3 рискованных пункта сразу).
7. Чистый АНАЛИЗ без привязки к фрагментам → "commands": [], весь ответ в reasoning.
8. Документ пуст → только "insert_end". Не обрывай JSON. Disclaimer о сверке статей с cbd.minjust.gov.kg.`;
  return { prompt, documentContext: docCtx };
};

const parseAgentCommands=(text)=>{
  if(!text) return {analysis:'',commands:[]};
  const result={analysis:'',commands:[]};

  try {
    let jsonStr = text;
    const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (match && match[1]) {
      jsonStr = match[1];
    } else {
      const match2 = text.match(/\{[\s\S]*\}/);
      if (match2) jsonStr = match2[0];
    }
    const parsed = JSON.parse(jsonStr);
    if (parsed.reasoning) {
      result.analysis = parsed.reasoning;
    }

    // ─── НОВЫЙ контракт: массив commands с операциями SuperDoc ───
    // [{op:'replace', old_text, new_text}, {op:'insert_after', anchor, text},
    //  {op:'insert_end', text}]. Маппим op → внутренний type для applyAgentCommand.
    if (Array.isArray(parsed.commands)) {
      for (const c of parsed.commands) {
        if (!c || !c.op) continue;
        const op = String(c.op).toLowerCase();
        if (op === 'replace') {
          const oldText = (c.old_text || c.oldText || '').toString().trim();
          const newText = (c.new_text || c.newText || c.text || '').toString();
          if (oldText && newText) result.commands.push({ type:'replace_smart', oldText, text:newText });
        } else if (op === 'insert_after') {
          const t = (c.text || c.new_text || '').toString().trim();
          const anchor = (c.anchor || c.anchor_text || '').toString().trim();
          if (t) result.commands.push({ type:'insert_after', anchor: anchor==='EMPTY'?'':anchor, text:t });
        } else if (op === 'insert_end' || op === 'insert') {
          const t = (c.text || '').toString().trim();
          if (t) result.commands.push({ type:'insert_end', text:t });
        } else if (op === 'replace_selection') {
          const t = (c.text || c.new_text || '').toString().trim();
          if (t) result.commands.push({ type:'replace_selection', text:t });
        } else if (op === 'comment') {
          const anchor = (c.anchor || c.anchor_text || c.target || '').toString().trim();
          const body = (c.text || c.comment || c.note || '').toString().trim();
          if (anchor && body) result.commands.push({ type:'comment', anchor, text:body });
        } else if (op === 'format') {
          const anchor = (c.anchor || c.anchor_text || c.target || '').toString().trim();
          const marks = (c.marks && typeof c.marks === 'object') ? c.marks : {};
          if (anchor && Object.keys(marks).length) result.commands.push({ type:'format', anchor, marks });
        }
      }
    }

    // ─── ОБРАТНАЯ СОВМЕСТИМОСТЬ: старый формат insertion_text/anchor_text ───
    if (result.commands.length === 0) {
      const insertion = (parsed.insertion_text || parsed.exact_insertion || '').toString().trim();
      if (insertion) {
        const rawAnchor = (parsed.anchor_text || '').trim();
        const isEmptyMarker = rawAnchor === 'EMPTY' || rawAnchor === '';
        result.commands.push({
          type: 'insert_smart',
          text: insertion,
          anchor: isEmptyMarker ? '' : rawAnchor
        });
      }
    }
  } catch (e) {
    // JSON сломан (обрезанный stream / лишний текст). Пытаемся вытащить хоть reasoning
    // и НЕ показывать сырой JSON-обрывок — это пугающий UX.
    const rawText = text.trim();
    let extractedReasoning = '';
    // Регулярка: вытащить значение "reasoning": "..." даже если JSON оборвался
    const reMatch = rawText.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/);
    if (reMatch && reMatch[1]) {
      extractedReasoning = reMatch[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\');
    }
    if (extractedReasoning) {
      result.analysis = extractedReasoning +
        '\n\n*(Ответ ИИ был обрезан или повреждён. Попробуйте повторить запрос, либо переключитесь в режим **Чат** для анализа без правок.)*';
    } else {
      result.analysis = 'Не удалось получить ответ. Возможно ответ был обрезан. Попробуйте ещё раз или переключитесь в режим **Чат** для анализа документа без правок.';
    }
  }
  return result;
};

// Track Changes: включаем режим рецензирования один раз за сессию (идемпотентно).
// Каждая ИИ-правка тогда становится tracked change — юрист принимает/отклоняет
// её в SuperDoc или Word. Best-effort: если API нет — правка применится напрямую.
const ensureTrackChanges=(editor)=>{
  try{
    // автор правок — чтобы в рецензировании было видно «Мыйзамчи AI»
    try{
      const sd=window.superdoc;
      if(sd && !sd.user) sd.user={name:'Мыйзамчи AI', email:'ai@miyzamchi'};
    }catch(_){ }
    if(window.__miyzTrackOn) return true;
    const c=editor && editor.commands;
    if(c && typeof c.enableTrackChanges==='function'){ c.enableTrackChanges(); window.__miyzTrackOn=true; return true; }
    if(c && typeof c.toggleTrackChanges==='function'){ c.toggleTrackChanges(); window.__miyzTrackOn=true; console.log('[trackChanges] enabled via toggle'); return true; }
  }catch(e){ console.warn('[trackChanges] enable failed (правки пойдут напрямую):', e); }
  return false;
};

// Снимок id всех текущих tracked changes (editor.doc.trackChanges.list()).
// Diff до/после применения команды → id'шники именно этой правки.
const tcListIds=()=>{
  try{
    const tc=window.docEngine && window.docEngine.doc && window.docEngine.doc.trackChanges;
    if(tc && typeof tc.list==='function'){
      const r=tc.list();
      const arr=(r && (r.items||r.changes||r.results)) || (Array.isArray(r)?r:[]);
      return Array.isArray(arr) ? arr.map(c=> c && (c.id || (c.address && c.address.entityId))).filter(Boolean) : [];
    }
  }catch(e){ console.warn('[trackChanges.list] failed:', e); }
  return [];
};

// Программное принятие/отклонение конкретного tracked change по id.
// Эталон — editor.doc.trackChanges.decide({decision, target:{id}}).
const decideTrackedChange=(id,decision)=>{
  try{
    const tc=window.docEngine && window.docEngine.doc && window.docEngine.doc.trackChanges;
    if(tc && typeof tc.decide==='function'){ tc.decide({ decision, target:{ id } }); return true; }
    if(tc && typeof tc[decision]==='function'){ tc[decision]({ id }); return true; } // fallback accept()/reject()
  }catch(e){ console.error('[trackChanges.decide] failed:', e, {id,decision}); }
  return false;
};

// Применить команду и вернуть id'шники созданных tracked changes (diff list).
const applyCommandCaptureIds=(cmd,toastFn)=>{
  const before=new Set(tcListIds());
  const ok=applyAgentCommand(cmd,toastFn);
  if(!ok) return { ok:false, ids:[] };
  const after=tcListIds();
  const ids=after.filter(id=>!before.has(id));
  return { ok:true, ids };
};

const applyAgentCommand=(cmd,toastFn)=>{
  // ⚠️ Чистый SuperDoc Document API (editor.doc) — НЕ deprecated:
  //   replace→doc.find→doc.replace · comment→doc.comments.create ·
  //   format→doc.format.apply · insert→doc.insert. editor.commands и editor.view
  //   ОБА deprecated (само чтение печатает warning) → берём ЛЕНИВО (getCmds/
  //   ensurePM) и ТОЛЬКО как fallback. Мутации — в режиме Track Changes.
  if(!window.docEngine){toastFn&&toastFn('warning','Редактор не найден');return false;}
  const docApi = window.docEngine.doc || null;
  const getCmds=()=>{ try{ return window.docEngine.commands||null; }catch(_){ return null; } };
  const text=String(cmd.text||'').trim();
  if(!text && cmd.type!=='replace_all' && cmd.type!=='format'){toastFn&&toastFn('warning','Пустой текст команды');return false;}

  // Ленивый доступ к ProseMirror view/state — ТОЛЬКО для PM-fallback и
  // insert/replace_selection/replace_all. Нативные команды (replace/comment/
  // format/insert_end) к editor.view НЕ обращаются → нет deprecation warning.
  let view=null, state=null, schema=null, paraType=null;
  const ensurePM=()=>{
    if(state) return true;
    try{ view=window.docEngine.view||null; }catch(_){ view=null; }
    if(!view || !view.state) return false;
    state=view.state; schema=state.schema; paraType=schema.nodes.paragraph;
    return true;
  };

  // Поиск ГОТОВОГО SelectionTarget по тексту через Document API.
  // ⚠️ doc.find → SDFindResult.items[].address = NodeAddress (БЛОК), это НЕ
  // SelectionTarget → doc.replace кидает "target must be a SelectionTarget".
  // Правильно: doc.match → QueryMatchOutput.context[i].target = SelectionTarget
  // (kind:'selection'), готовый для doc.replace/comments/format.
  // TextSelector = { type:'text', pattern }.
  const findTarget=(needle)=>{
    if(!needle || !docApi || typeof docApi.match!=='function') return null;
    const tries=[
      ()=> docApi.match({ select:{ type:'text', pattern: needle } }),
      ()=> docApi.match({ type:'text', pattern: needle }),
      ()=> docApi.match({ select:{ type:'text', text: needle } }),
    ];
    for(const fn of tries){
      try{
        const out=fn(); if(!out) continue;
        const ctx=out.context;
        if(Array.isArray(ctx) && ctx.length){
          const t=ctx.map(c=>c && c.target).find(Boolean);
          if(t) return t;   // SelectionTarget {kind:'selection', start, end}
        }
      }catch(_){ /* пробуем следующую форму */ }
    }
    return null;
  };
  // doc.* мутации принимают либо {target: SelectionTarget}, либо {ref: string}.
  const asTargetArg=(t)=> (t && t.ref) ? { ref:t.ref } : { target:t };

  try{

    // ═══ REPLACE_SMART — точечная inline-замена old_text → new_text ═══
    // Эталон: чистый Document API doc.find → doc.replace; PM/search — фолбэк.
    if(cmd.type==='replace_smart'){
      const oldText=String(cmd.oldText||'').trim();
      const newText=String(cmd.text||'');
      if(!oldText){toastFn&&toastFn('warning','Не указан текст для замены (old_text)');return false;}
      ensureTrackChanges(window.docEngine);

      // 1) ЧИСТЫЙ Document API: doc.find → doc.replace (без deprecated commands/view)
      try{
        const target=findTarget(oldText);
        if(target && docApi && typeof docApi.replace==='function'){
          const r=docApi.replace({ ...asTargetArg(target), text:newText });
          if(r && typeof r.then==='function') r.catch(e=>console.error('[applyAgentCommand] replace async fail:', e));
          console.log('[applyAgentCommand] replace via doc.replace (Document API)', {old:oldText.slice(0,40),newLen:newText.length});
          toastFn&&toastFn('check','Заменено');
          return true;
        }
      }catch(e){ console.warn('[applyAgentCommand] doc.replace упал, фолбэк:', e); }

      // 2) ФОЛБЭК: window.superdoc.search → commands.insertContentAt
      let matches=null;
      try{ if(window.superdoc && typeof window.superdoc.search==='function') matches=window.superdoc.search(oldText); }catch(e){ console.warn('[applyAgentCommand] search упал:', e); }
      if(matches && matches.length){
        const m=matches[0]; const c=getCmds();
        console.log('[applyAgentCommand] replace via search+insertContentAt (fallback)', {from:m.from,to:m.to,matches:matches.length});
        if(c && typeof c.insertContentAt==='function') c.insertContentAt({from:m.from,to:m.to}, newText);
        else if(ensurePM()) view.dispatch(state.tr.insertText(newText, m.from, m.to));
        toastFn&&toastFn('check', matches.length>1?`Заменено (1 из ${matches.length})`:'Заменено');
        return true;
      }

      // 3) ФОЛБЭК: ручной поиск по text-нодам ProseMirror
      let done=false;
      if(ensurePM()) state.doc.descendants((node,pos)=>{
        if(done) return false;
        if(node.isText && node.text){
          const idx=node.text.indexOf(oldText);
          if(idx!==-1){
            const from=pos+idx, to=from+oldText.length;
            console.log('[applyAgentCommand] replace via PM fallback', {from,to,old:oldText.slice(0,40)});
            view.dispatch(state.tr.insertText(newText, from, to));
            done=true; return false;
          }
        }
        return true;
      });
      if(done){ toastFn&&toastFn('check','Заменено'); return true; }

      console.warn('[applyAgentCommand] replace: фрагмент не найден:', oldText.slice(0,80));
      toastFn&&toastFn('warning','Фрагмент не найден: «'+oldText.slice(0,40)+'»');
      return false;
    }

    // resolveTarget: target по тексту. PRIMARY — чистый doc.find (без commands/
    // view, не дёргает deprecated API и не кидает TextSelection-ошибку).
    // FALLBACK — search + setTextSelection + selection.current (deprecated путь).
    const resolveTarget=(anchor)=>{
      const t=findTarget(anchor);
      if(t) return { target:t, via:'find' };
      let matches=null;
      try{ if(window.superdoc && typeof window.superdoc.search==='function') matches=window.superdoc.search(anchor); }catch(_){ }
      if(!matches || !matches.length) return null;
      const m=matches[0]; const c=getCmds();
      try{
        if(c && typeof c.setTextSelection==='function') c.setTextSelection({from:m.from,to:m.to});
        else if(ensurePM()) view.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, m.from, m.to)));
      }catch(e){ console.warn('[applyAgentCommand] setTextSelection упал:', e); }
      let target=null;
      try{ const sel=docApi && docApi.selection; if(sel && typeof sel.current==='function') target=sel.current().target; }catch(e){ console.warn('[applyAgentCommand] selection.current упал:', e); }
      return target ? { target, via:'selection', from:m.from, to:m.to } : null;
    };

    // ═══ COMMENT — повесить замечание на фрагмент (режим поиска рисков) ═══
    // Агент НЕ переписывает пункт, а аннотирует его: «Риск: противоречит ст. X».
    if(cmd.type==='comment'){
      const anchor=String(cmd.anchor||'').trim();
      const body=text;
      if(!anchor){toastFn&&toastFn('warning','Не указан фрагмент для комментария (anchor)');return false;}
      const sel=resolveTarget(anchor);
      if(!sel || !sel.target){ console.warn('[applyAgentCommand] comment: фрагмент не найден:', anchor.slice(0,60)); toastFn&&toastFn('warning','Фрагмент не найден: «'+anchor.slice(0,40)+'»'); return false; }
      const commentsApi=docApi && docApi.comments;
      console.log('[applyAgentCommand] comment', {anchor:anchor.slice(0,40),via:sel.via,bodyLen:body.length});
      if(commentsApi && typeof commentsApi.create==='function'){
        const r=commentsApi.create({...asTargetArg(sel.target), text:body});
        if(r && typeof r.then==='function') r.then(()=>{}).catch(e=>console.error('[applyAgentCommand] comment async fail:', e));
        toastFn&&toastFn('check','Комментарий добавлен');
        return true;
      }
      console.error('[applyAgentCommand] doc.comments.create недоступен');
      toastFn&&toastFn('warning','Комментарии не поддерживаются редактором');
      return false;
    }

    // ═══ FORMAT — стиль фрагмента (жирный/курсив/подчёрк/цвет) ═══
    if(cmd.type==='format'){
      ensureTrackChanges(window.docEngine);
      const anchor=String(cmd.anchor||'').trim();
      const marks=(cmd.marks && typeof cmd.marks==='object')?cmd.marks:{};
      if(!anchor){toastFn&&toastFn('warning','Не указан фрагмент для форматирования (anchor)');return false;}
      if(!Object.keys(marks).length){toastFn&&toastFn('warning','Не указан стиль (marks)');return false;}
      const sel=resolveTarget(anchor);
      if(!sel || !sel.target){ console.warn('[applyAgentCommand] format: фрагмент не найден:', anchor.slice(0,60)); toastFn&&toastFn('warning','Фрагмент не найден: «'+anchor.slice(0,40)+'»'); return false; }
      console.log('[applyAgentCommand] format', {anchor:anchor.slice(0,40),via:sel.via,marks});
      const fmtApi=docApi && docApi.format;
      // 1) Чистый Document API: format.apply({target, inline})
      if(fmtApi && typeof fmtApi.apply==='function'){
        try{
          const r=fmtApi.apply({...asTargetArg(sel.target), inline:marks});
          if(r && typeof r.then==='function') r.then(()=>{}).catch(e=>console.error('[applyAgentCommand] format async fail:', e));
          toastFn&&toastFn('check','Форматирование применено');
          return true;
        }catch(e){ console.warn('[applyAgentCommand] format.apply упал, PM-фолбэк:', e); }
      }
      // 2) ФОЛБЭК: ProseMirror addMark по {from,to} (только если есть координаты)
      if(sel.from!=null && sel.to!=null && ensurePM()) try{
        const tr=state.tr; let applied=false;
        const markMap={bold:'bold',italic:'italic',underline:'underline',strike:'strike',highlight:'highlight',color:'textStyle'};
        for(const k of Object.keys(marks)){
          const markName=markMap[k]||k;
          const mt=schema.marks[markName];
          if(mt){ const attrs=(k==='color')?{color:marks[k]}:(typeof marks[k]==='object'?marks[k]:undefined); tr.addMark(sel.from, sel.to, mt.create(attrs)); applied=true; }
        }
        if(applied){ view.dispatch(tr); toastFn&&toastFn('check','Форматирование применено'); return true; }
      }catch(e){ console.error('[applyAgentCommand] format PM fallback fail:', e); }
      toastFn&&toastFn('warning','Не удалось применить формат');
      return false;
    }

    // Текст → массив абзацев (ProseMirror-узлы text не могут содержать \n,
    // поэтому многострочную вставку режем на параграфы).
    const makeParas=(t)=>{
      if(!paraType) return null;
      const lines=String(t).split(/\n+/).map(s=>s.trim()).filter(Boolean);
      const nodes=(lines.length?lines:['']).map(line=>
        line ? paraType.createAndFill(null, schema.text(line)) : paraType.createAndFill(null)
      ).filter(Boolean);
      return nodes.length?nodes:null;
    };

    // Позиция сразу ПОСЛЕ блока, содержащего anchor (или null если не найден).
    const findBlockAfterAnchor=(anchor)=>{
      if(!anchor) return null;
      let result=null;
      state.doc.descendants((node,pos)=>{
        if(result!==null) return false;
        if(node.isText && node.text && node.text.includes(anchor)){
          const $=state.doc.resolve(pos);
          result=$.after($.depth);   // конец абзаца с якорем
          return false;
        }
        return true;
      });
      return result;
    };

    if(cmd.type==='insert_smart' || cmd.type==='insert_after' || cmd.type==='insert_end' || cmd.type==='insert_cursor'){
      ensureTrackChanges(window.docEngine);
      const anchor=String(cmd.anchor||'').trim();
      const isAnchored=(cmd.type==='insert_smart'||cmd.type==='insert_after');

      // Нативный путь для вставки В КОНЕЦ (без якоря): editor.doc.insert с markdown —
      // переносы строк станут реальными абзацами (см. superdoc_docs.md).
      if(cmd.type==='insert_end' || (isAnchored && !anchor)){
        try{
          if(docApi && typeof docApi.insert==='function'){
            docApi.insert({ value:text, type:'markdown' });
            console.log('[applyAgentCommand] insert_end via doc.insert(markdown)', {textLen:text.length});
            toastFn&&toastFn('check','Вставлено в конец');
            return true;
          }
        }catch(e){ console.warn('[applyAgentCommand] doc.insert упал, PM-фолбэк:', e); }
      }

      if(!ensurePM()){ toastFn&&toastFn('warning','Редактор не готов'); return false; }
      let pos=null, matched=false;
      if(isAnchored){
        pos=findBlockAfterAnchor(anchor);
        matched=pos!==null;
      } else if(cmd.type==='insert_cursor'){
        pos=state.selection.to;
        matched=true;
      }
      if(pos===null) pos=state.doc.content.size;   // конец документа

      const paras=makeParas(text);
      console.log('[applyAgentCommand] insert', {type:cmd.type, anchor:anchor.slice(0,40), anchorMatched:matched, pos, docSize:state.doc.content.size, paras:paras&&paras.length, textLen:text.length});

      const tr = paras ? state.tr.insert(pos, paras) : state.tr.insertText('\n'+text, pos);
      view.dispatch(tr);

      if(isAnchored) toastFn&&toastFn('check', matched?'Вставка применена':'Якорь не найден — добавлено в конец');
      else if(cmd.type==='insert_cursor') toastFn&&toastFn('check','Вставлено в позицию курсора');
      else toastFn&&toastFn('check','Вставлено в конец');
      return true;
    }

    if(cmd.type==='replace_selection'){
      ensureTrackChanges(window.docEngine);
      if(!ensurePM()){ toastFn&&toastFn('warning','Редактор не готов'); return false; }
      const {from,to}=state.selection;
      if(from>=to){toastFn&&toastFn('warning','Нет выделения для замены');return false;}
      console.log('[applyAgentCommand] replace_selection', {from,to,textLen:text.length});
      view.dispatch(state.tr.insertText(text, from, to));
      toastFn&&toastFn('check','Выделение заменено');
      return true;
    }

    if(cmd.type==='replace_all'){
      ensureTrackChanges(window.docEngine);
      if(!ensurePM()){ toastFn&&toastFn('warning','Редактор не готов'); return false; }
      const end=state.doc.content.size;
      const paras=makeParas(text);
      console.log('[applyAgentCommand] replace_all', {docSize:end,paras:paras&&paras.length,textLen:text.length});
      const tr = paras ? state.tr.replaceWith(0, end, paras) : state.tr.insertText(text, 0, end);
      view.dispatch(tr);
      toastFn&&toastFn('check','Документ заменён');
      return true;
    }

    toastFn&&toastFn('warning','Неизвестная команда: '+cmd.type);
    return false;
  }catch(e){
    console.error('[applyAgentCommand] mutation failed:', e, {cmdType:cmd.type, anchor:cmd.anchor});
    toastFn&&toastFn('warning','Ошибка применения: '+(e&&e.message||e));
    return false;
  }
};

const COMMAND_META={
  replace_smart:{label:'Заменить фрагмент',icon:'sparkles',color:'var(--orange)'},
  comment:{label:'Комментарий-замечание',icon:'book',color:'var(--accent)'},
  format:{label:'Форматирование',icon:'sparkles',color:'var(--accent)'},
  insert_smart:{label:'Умная вставка',icon:'sparkles',color:'var(--accent)'},
  insert_after:{label:'Вставить после фрагмента',icon:'plus',color:'var(--accent)'},
  insert_end:{label:'Вставить в конец',icon:'plus',color:'var(--green)'},
  insert_cursor:{label:'Вставить в курсор',icon:'plus',color:'var(--accent)'},
  replace_selection:{label:'Заменить выделение',icon:'sparkles',color:'var(--orange)'},
  replace_all:{label:'Заменить весь документ',icon:'warning',color:'var(--red)'}
};

/* ═══════════ A11Y: FOCUS-TRAP HOOK ═══════════
   Когда модалка открыта, Tab не должен «утечь» наружу.
   1) При открытии — фокус на первый focusable внутри
   2) Tab и Shift+Tab закольцованы
   3) При закрытии — возврат фокуса на trigger
   ═══════════════════════════════════════════════ */
const useFocusTrap=(active,containerRef)=>{
  useEffect(()=>{
    if(!active||!containerRef.current)return;
    const prevFocus=document.activeElement;
    const node=containerRef.current;
    const getFocusable=()=>Array.from(node.querySelectorAll(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(el=>!el.hasAttribute('aria-hidden'));
    const focusables=getFocusable();
    if(focusables[0])focusables[0].focus();
    const onKey=e=>{
      if(e.key!=='Tab')return;
      const els=getFocusable();
      if(!els.length)return;
      const first=els[0],last=els[els.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
    };
    node.addEventListener('keydown',onKey);
    return()=>{
      node.removeEventListener('keydown',onKey);
      if(prevFocus&&prevFocus.focus)prevFocus.focus();
    };
  },[active]);
};

/* ═══════════════════════════════════════════════════════════════
   GLYPH — типографические SVG-иконки взамен emoji (✅⚠️❌ℹ️…)
   На Windows OS-emoji плоско-двуцветные, на Mac цветные 3D, на Linux
   разные. Для согласованного UI лучше SVG.
   ═══════════════════════════════════════════════════════════════ */
const GLYPHS = {
  check:   {col:'var(--green)',  path:'M5 12.5l4 4 10-10'},
  warn:    {col:'var(--orange)', path:'M12 4v9.5M12 17v.6'},
  error:   {col:'var(--red)',    path:'M6 6l12 12M18 6L6 18'},
  info:    {col:'var(--info)',   path:'M12 8v4M12 16v.6'},
  scale:   {col:'var(--accent)', path:'M12 4v16M4 9h16M6 9l-2 5h4zM18 9l-2 5h4z'},
  search:  {col:'var(--accent)', path:'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.5-4.5'},
  list:    {col:'var(--accent)', path:'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'},
  file:    {col:'var(--accent)', path:'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6'},
  chart:   {col:'var(--accent)', path:'M4 20V8M10 20V4M16 20v-9M20 20v-14'},
  refresh: {col:'var(--accent)', path:'M21 8a8 8 0 10-2.5 6M21 4v4h-4'},
  edit:    {col:'var(--accent)', path:'M12 20h8M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4z'},
  dna:     {col:'var(--accent)', path:'M5 4c0 6 14 8 14 14M5 20c0-6 14-8 14-14M8 5l2 2M14 5l-2 2M8 19l2-2M14 19l-2-2'},
};
const Glyph=({type, sz=14, style={}})=>{
  const g = GLYPHS[type];
  if(!g) return null;
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" style={{display:'inline-block',verticalAlign:'-2px',flexShrink:0,color:g.col,...style}} aria-hidden="true">
      <path d={g.path} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};
/* splitGlyph(text) → { glyph, body }  парсит leading emoji в SSE-сообщениях
   от сервера ("✅ Ст. 6 ГК КР: подтверждена") и возвращает имя глифа +
   текст без эмодзи. Если эмодзи не распознан — { glyph:null, body:text }. */
const splitGlyph=(s)=>{
  if(!s) return {glyph:null, body:''};
  const t = String(s);
  const tests = [
    [/^✅\s*/,'check'], [/^⚠️\s*/,'warn'], [/^⚠\s*/,'warn'],
    [/^❌\s*/,'error'], [/^ℹ️\s*/,'info'], [/^ℹ\s*/,'info'],
    [/^⚖️\s*/,'scale'], [/^⚖\s*/,'scale'],
    [/^🔍\s*/,'search'], [/^📋\s*/,'list'], [/^📄\s*/,'file'],
    [/^📊\s*/,'chart'], [/^🔄\s*/,'refresh'], [/^✍️\s*/,'edit'],
    [/^✍\s*/,'edit'], [/^🧬\s*/,'dna'],
  ];
  for(const [re, name] of tests){
    if(re.test(t)) return {glyph:name, body:t.replace(re,'')};
  }
  return {glyph:null, body:t};
};

/* ═══════════ ICON COMPONENT ═══════════ */
const Ico=({k,sz=16,col,fill,grad,glow,duo,style={}})=>{
  const cls=['ico'];
  if(grad)cls.push('ico-grad');
  if(glow)cls.push('ico-glow');
  if(fill)cls.push('ico-fill');
  if(duo)cls.push('ico-duo');
  const svgStyle={width:sz,height:sz};
  if(duo)svgStyle.fill=fill||'var(--accent-dim)';
  const renderer = ICONS[k];
  if (typeof renderer !== 'function') {
    if (typeof console !== 'undefined') console.warn('[Ico] Unknown icon key:', k);
    return <span className={cls.join(' ')} style={{width:sz,height:sz,fontSize:Math.round(sz*.9),lineHeight:1,color:col||'inherit',display:'inline-flex',alignItems:'center',justifyContent:'center',...style}}>{typeof k === 'string' && k.length <= 2 ? k : '·'}</span>;
  }
  return(
    <span className={cls.join(' ')} style={{width:sz,height:sz,color:col||'inherit','--ico-color':col,'--ico-fill':fill||'var(--accent-dim)',...style}}>
      {renderer(sz)}
    </span>
  );
};

const ICONS={
  'strike':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/></svg>),
  'align-left':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/></svg>),
  'align-center':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="12" x2="7" y2="12"/><line x1="19" y1="18" x2="5" y2="18"/></svg>),
  'align-right':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="9" y2="12"/><line x1="21" y1="18" x2="7" y2="18"/></svg>),
  'align-justify':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/></svg>),
  'list-ordered':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>),
  'indent':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polygon points="3 8 7 12 3 16"/></svg>),
  'outdent':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/><polygon points="7 8 3 12 7 16"/></svg>),
  explorer:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 002-2V8l-6-6H6a2 2 0 00-2 2v14a2 2 0 002 2z"/><path d="M14 2v6h6"/><path d="M2 14h20"/><path d="M12 14v6"/>
    </svg>
  ),
  law:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l-7 4v6c0 5.5 3.8 10.7 7 12 3.2-1.3 7-6.5 7-12V6l-7-4z"/>
      <path d="M12 8v4"/><path d="M9 11l3 3 3-3"/><path d="M12 14v2"/>
    </svg>
  ),
  search:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="7.5"/><path d="M21 21l-5.2-5.2"/>
    </svg>
  ),
  book:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
      <path d="M8 7h8M8 11h6"/>
    </svg>
  ),
  settings:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  sun:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
    </svg>
  ),
  moon:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
    </svg>
  ),
  x:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>
  ),
  check:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  starO:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  starFilled:(s)=>(
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  chevD:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6"/>
    </svg>
  ),
  chevR:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  ),
  file:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  ),
  folderClosed:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h3.6a2 2 0 011.4.58L11.2 6.6a2 2 0 001.4.58H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" fill="currentColor" fillOpacity="0.18"/>
    </svg>
  ),
  folderOpen:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h3.6a2 2 0 011.4.58L11.2 6.6a2 2 0 001.4.58H19a2 2 0 012 2v1H3V7z" fill="currentColor" fillOpacity="0.18"/>
      <path d="M3 10h18.2l-1.8 7.4A2 2 0 0117.5 19H5.4A2 2 0 013.5 17.5L3 10z" fill="currentColor" fillOpacity="0.28"/>
    </svg>
  ),
  fileDoc:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="currentColor" fillOpacity="0.08"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
      <line x1="8" y1="17" x2="13" y2="17"/>
    </svg>
  ),
  bold:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8a4 4 0 010 8H6z"/><path d="M6 12h9a4 4 0 010 8H6z"/>
    </svg>
  ),
  italic:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>
    </svg>
  ),
  underl:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v7a6 6 0 0012 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>
    </svg>
  ),
  copy:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
    </svg>
  ),
  save:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
    </svg>
  ),
  pdf:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <text x="8" y="18" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="inherit">PDF</text>
    </svg>
  ),
  send:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  ),
  mic:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  ),
  cmd:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z"/>
    </svg>
  ),
  more:(s)=>(
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
    </svg>
  ),
  user:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  zap:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  bell:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
    </svg>
  ),
  outline:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>
    </svg>
  ),
  split:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
    </svg>
  ),
  undo:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
    </svg>
  ),
  redo:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
    </svg>
  ),
  plus:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  trash:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
    </svg>
  ),
  list:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>
    </svg>
  ),
  clip:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
    </svg>
  ),
  check:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  ),
  warning:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  star:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  rocket:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/>
      <path d="M12 15l-3-3a22 22 0 01-3-3.83A12.83 12.83 0 013 6c0-2.66 4-5 4-5s4 2.34 4 5a12.83 12.83 0 01-3 3.83L12 15z"/>
      <path d="M8 21.5c-1.19.58-2.5 1-2.5 1s1.45-.47 2.5-1c.95-.95 1.5-2.5 1.5-2.5s-1.55.55-2.5 1.5z"/>
      <path d="M14 12l-2.5-2.5"/>
      <path d="M16.5 9.5l-2.5-2.5"/>
      <path d="M19 6.5l-2.5-2.5"/>
    </svg>
  ),
  robot:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="5" r="2"/>
      <path d="M12 7v4"/>
      <line x1="8" y1="16" x2="8" y2="16"/>
      <line x1="16" y1="16" x2="16" y2="16"/>
      <path d="M9 11l.01 0"/>
      <path d="M15 11l.01 0"/>
    </svg>
  ),
  sparkles:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 008.5 14.063l-6.135-1.582a.5.5 0 010-.962L8.5 9.936A2 2 0 009.937 8.5l1.582-6.135a.5.5 0 01.963 0L14.063 8.5A2 2 0 0015.5 9.937l6.135 1.581a.5.5 0 010 .964L15.5 14.063a2 2 0 00-1.437 1.437l-1.582 6.135a.5.5 0 01-.963 0z"/>
    </svg>
  ),
  loader:(s)=>(
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
  ),
  'folder':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>),
  'chevron-right':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>),
  'chevron-down':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>),
  'clock':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>),
  'shield':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>),
  'users':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>),
  'home':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>),
  'activity':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>),
  'edit':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>),
  'maximize':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>),
  'coin':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><circle cx="18" cy="18" r="4"/><path d="M12 18a6 6 0 0 0-6-6"/></svg>),
  'dollar':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>),
  'scale':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v17M4 8h16M6 8l-2 5h4zm12 0l-2 5h4z"/></svg>),
  'microscope':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18h8M3 22h18M14 22a7 7 0 1 0-14 0M14 14a4.5 4.5 0 0 0-8 0M12 2h4M14 2v6M8 8h8"/></svg>),
  'brain':(s)=>(<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3.001 3.001 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3.001 3.001 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2z"/></svg>)
};

/* ═══ Brand Logo — Kyrgyz tunduk + М (Мыйзамчы) ═══ */
const LogoIcon=({sz=44,glow})=>(
  <span className="ico myz-brand-logo" style={{width:sz,height:sz,...(glow?{filter:'drop-shadow(0 0 10px var(--accent-glow)) drop-shadow(0 0 20px var(--accent-glow))'}:{})}}>
    <img src="../logo/Logo.png" alt="Мыйзамчы" draggable="false"/>
  </span>
);

/* ═══ Emoji Components ═══ */
const EmojiBubble=({emoji,size=20,bg,glow})=>(
  <span className="emoji" style={{fontSize:size,...(glow?{filter:'drop-shadow(0 0 12px var(--accent-glow))'}:{})}}>
    <span className="emoji-bubble" style={{...(bg?{background:bg}:{})}}>{emoji}</span>
  </span>
);

const StatusDot=({color='green'})=>(
  <span className={'status-dot status-'+color}/>
);

const GradBadge=({children,shimmer})=>(
  <span className={'grad-badge'+(shimmer?' grad-badge-shimmer':'')}>{children}</span>
);

const AvatarRing=({children,size=32})=>(
  <div className="avatar-ring" style={{width:size+4,height:size+4}}>
    <div style={{width:size,height:size,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:size*.42,fontWeight:700,color:'#fff',background:'linear-gradient(135deg,var(--accent),var(--accent2))'}}>
      {children}
    </div>
  </div>
);

/* ═══ Empty State Illustration ═══ */
const EmptyIllust=()=>(
  <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:16}}>
    <div className="emoji emoji-float" style={{fontSize:56}}>
      <span className="welcome-screen-logo-container" style={{display:'inline-flex',width:128,height:128,alignItems:'center',justifyContent:'center',borderRadius:28,background:'linear-gradient(135deg,var(--accent-dim),var(--accent-soft))',border:'1px solid var(--accent-edge)'}}>
        <LogoIcon sz={100} glow/>
      </span>
    </div>
    <div style={{fontSize:20,fontWeight:600,color:'var(--text)',letterSpacing:'-.02em'}}>Мыйзамчы Legal IDE</div>
    <div style={{fontSize:13.5,color:'var(--muted)',textAlign:'center',maxWidth:300,lineHeight:1.7}}>
      Создавайте документы, проверяйте на ошибки, находите ссылки на НПА — всё в одном месте
    </div>
    <div style={{width:280,height:100,border:'2px dashed var(--border)',borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center',gap:12,transition:'all .2s',cursor:'pointer'}}
      onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.background='var(--accent-dim)';e.currentTarget.style.borderStyle='solid'}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.background='transparent';e.currentTarget.style.borderStyle='dashed'}}>
      <Ico k="explorer" sz={28} col="var(--accent)" />
      <div>
        <div style={{fontSize:13,fontWeight:500,color:'var(--text)'}}>Перетащите файл сюда</div>
        <div style={{fontSize:11.5,color:'var(--muted)'}}>или используйте Ctrl+N</div>
      </div>
    </div>
  </div>
);

/* ═══ Toast ═══ */
const ToastContainer=({toasts,onRemove})=>(
  <div role="status" aria-live="polite" aria-atomic="false" style={{position:'fixed',top:50,right:16,zIndex:2000,display:'flex',flexDirection:'column',gap:8,pointerEvents:'none'}}>
    {toasts.map(t=>(
      <div key={t.id} onClick={()=>onRemove(t.id)} style={{pointerEvents:'auto',display:'flex',alignItems:'center',gap:10,padding:'10px 16px',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:10,boxShadow:'var(--shadow-lg)',animation:t.leaving?'toastOut .25s ease forwards':'toastIn .3s ease',cursor:'pointer',maxWidth:340,fontSize:13,color:'var(--text)'}}>
        {t.icon && (typeof ICONS[t.icon]==='function'
          ? <Ico k={t.icon} sz={18} col="var(--accent)" />
          : <span style={{fontSize:16,lineHeight:1}}>{t.icon}</span>)}
        <span style={{flex:1,lineHeight:1.4}}>{t.text}</span>
      </div>
    ))}
  </div>
);

/* ═══ Ctx Menu ═══ */
const CtxMenu=({x,y,items,onClose})=>{
  const ref=useRef(null);
  useEffect(()=>{const h=e=>{if(!ref.current||!ref.current.contains(e.target))onClose()};document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h)},[onClose]);
  return(
    <div ref={ref} role="menu" aria-label="Контекстное меню" style={{position:'fixed',left:Math.min(x,window.innerWidth-220),top:Math.min(y,window.innerHeight-items.length*34-16),zIndex:'var(--z-modal)',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius)',boxShadow:'var(--shadow-lg)',padding:'4px',minWidth:210,animation:'fadeInScale .12s ease'}}>
      {items.map((it,i)=>{
        if(it.sep) return <div key={i} role="separator" style={{height:1,background:'var(--border)',margin:'4px 8px'}}/>;
        return(
          <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={()=>{it.action&&it.action();onClose()}} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,padding:'7px 10px',borderRadius:'var(--radius-sm)',border:'none',background:'transparent',width:'100%',textAlign:'left',cursor:it.disabled?'not-allowed':'pointer',fontSize:12.5,fontFamily:'inherit',color:it.disabled?'var(--muted)':'var(--text)',opacity:it.disabled?.4:1}} onMouseEnter={e=>{if(!it.disabled)e.currentTarget.style.background='var(--hover)'}} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{display:'flex',alignItems:'center',gap:8}}>{it.icon&&<Ico k={it.icon} sz={14} col="var(--muted)"/>}{it.label}</span>
            {it.shortcut && <kbd style={{fontSize:10.5,color:'var(--muted)',fontFamily:'var(--font-mono)'}}>{it.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
};

/* ═══ Docx Original Preview ═══ */
const DocxPreview=({buffer,name,onClose})=>{
  const containerRef=useRef(null);
  const dialogRef=useRef(null);
  useFocusTrap(true,dialogRef);
  const[err,setErr]=useState(null);
  const[loading,setLoading]=useState(true);
  useEffect(()=>{
    if(!buffer||!containerRef.current||!window.docx)return;
    setLoading(true);setErr(null);
    containerRef.current.innerHTML='';
    try{
      window.docx.renderAsync(buffer,containerRef.current,null,{
        className:'docx-original',
        inWrapper:true,
        ignoreWidth:false,
        ignoreHeight:false,
        ignoreFonts:false,
        breakPages:true,
        ignoreLastRenderedPageBreak:true,
        experimental:false,
        useBase64URL:true
      }).then(()=>setLoading(false)).catch(e=>{setErr(e.message||String(e));setLoading(false)});
    }catch(e){setErr(e.message||String(e));setLoading(false)}
  },[buffer]);
  return(
    <div onClick={onClose} role="presentation" style={{position:'fixed',inset:0,zIndex:'var(--z-modal-overlay)',background:'rgba(0,0,0,.55)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',animation:'fadeIn .15s ease'}}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={'Оригинал DOCX: '+(name||'')} onClick={e=>e.stopPropagation()} style={{width:'min(900px, 92vw)',height:'90vh',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',boxShadow:'var(--shadow-lg)',overflow:'hidden',display:'flex',flexDirection:'column',animation:'fadeInScale .18s ease'}}>
        <div style={{padding:'12px 18px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <Ico k="file" sz={18} col="var(--accent)" grad/>
            <span style={{fontSize:14,fontWeight:600,color:'var(--text)'}}>Оригинал документа</span>
            <span style={{fontSize:12,color:'var(--muted)'}}>{name}</span>
          </div>
          <button onClick={onClose} style={{background:'var(--hover)',border:'1px solid var(--border)',borderRadius:6,padding:'4px 10px',cursor:'pointer',color:'var(--muted)',fontSize:12}}>ESC</button>
        </div>
        <div style={{flex:1,overflowY:'auto',background:'#e8e8e8',padding:'20px'}}>
          {loading && <div style={{textAlign:'center',color:'var(--muted)',padding:40,fontSize:13}}>Рендер оригинала…</div>}
          {err && <div style={{padding:16,background:'var(--red)',color:'#fff',borderRadius:8,fontSize:12}}>Ошибка превью: {err}</div>}
          <div ref={containerRef} style={{background:'var(--bg-panel)',color:'var(--text-main)'}}/>
        </div>
      </div>
    </div>
  );
};

/* ═══ Shortcut Overlay ═══ */
const ShortcutOverlay=({onClose})=>(
  <div onClick={onClose} style={{position:'fixed',inset:0,zIndex:1800,background:'rgba(17,24,39,.45)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',animation:'fadeIn .15s ease'}}>
    <div onClick={e=>e.stopPropagation()} style={{width:520,maxHeight:'70vh',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',boxShadow:'var(--shadow-lg)',overflow:'hidden',animation:'fadeInScale .18s ease',fontFamily:'var(--font-sans)'}}>
      <div style={{padding:'var(--s-4) var(--s-5)',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-2h)'}}>
          <Ico k="cmd" sz={20} col="var(--accent)" /><span style={{fontSize:'var(--text-md)',fontWeight:600,color:'var(--text)'}}>Горячие клавиши</span>
        </div>
        <button onClick={onClose} style={{background:'var(--hover)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'var(--s-1) var(--s-2h)',cursor:'pointer',color:'var(--muted)',fontSize:'var(--text-sm)',fontFamily:'var(--font-sans)'}}>ESC</button>
      </div>
      <div style={{overflowY:'auto',padding:'var(--s-2) 0',maxHeight:'calc(70vh - 56px)'}}>
        {[{s:'Общие',i:[['Ctrl+P','Палитра команд'],['Ctrl+/','Горячие клавиши'],['Ctrl+\\','Split editor']]},{s:'Панели',i:[['Ctrl+B','Левая панель'],['Ctrl+J','AI панель']]},{s:'Файлы',i:[['Ctrl+N','Новый документ'],['Ctrl+S','Сохранить'],['Ctrl+W','Закрыть вкладку']]},{s:'Редактор',i:[['Ctrl+F','Найти'],['Ctrl+H','Заменить']]}].map((sec,si)=>(
          <div key={si}>
            <div style={{padding:'var(--s-2) var(--s-5) var(--s-1)',fontSize:'var(--text-2xs)',fontWeight:600,color:'var(--muted)',letterSpacing:'.07em',textTransform:'uppercase'}}>{sec.s}</div>
            {sec.i.map(([k,d])=>(
              <div key={k} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'var(--s-1h) var(--s-5)',fontSize:'var(--text-sm)',color:'var(--text)'}}>
                <span>{d}</span>
                <span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',minWidth:28,height:24,padding:'0 var(--s-2)',background:'var(--hover)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',fontFamily:'var(--font-mono)',fontSize:'var(--text-xs)',color:'var(--text)',fontWeight:500}}>{k}</span>
              </div>
            ))}
            {si<3 && <div style={{height:1,background:'var(--border)',margin:'var(--s-1h) var(--s-4)'}}/>}
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ═══ Find Bar ═══ */
const FindBar=({onClose,onToast})=>{
  const[q,setQ]=useState('');const ref=useRef(null);
  useEffect(()=>{ref.current&&ref.current.focus()},[]);
  return(
    <div style={{position:'absolute',top:0,right:56,left:0,zIndex:50,background:'var(--bg-panel)',borderBottom:'1px solid var(--border)',boxShadow:'var(--shadow)',padding:'var(--s-2) var(--s-3)',animation:'fadeIn .15s ease',fontFamily:'var(--font-sans)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-2)'}}>
        <div style={{flex:1,display:'flex',alignItems:'center',gap:'var(--s-1h)',background:'var(--bg-editor)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'0 var(--s-2)'}}>
          <Ico k="search" sz={14} col="var(--muted)"/>
          <input ref={ref} value={q} onChange={e=>setQ(e.target.value)} placeholder="Найти…" aria-label="Поиск в документе" style={{flex:1,background:'transparent',border:'none',outline:'none',fontSize:'var(--text-sm)',color:'var(--text)',fontFamily:'var(--font-sans)',padding:'var(--s-1h) 0'}}/>
          {q && <span style={{fontSize:'var(--text-sm)',color:'var(--accent)',fontFamily:'var(--font-mono)',fontWeight:500}}>3</span>}
        </div>
        <button onClick={onClose} style={{background:'transparent',border:'none',cursor:'pointer',color:'var(--muted)',display:'flex',padding:'var(--s-half)'}}><Ico k="x" sz={14}/></button>
      </div>
    </div>
  );
};

/* ═══ Notifications ═══ */
const Notifications=({onClose})=>{
  const items=[
    {icon:'law',title:'AI проверка завершена',text:'Найдено 2 замечания',time:'2 мин',unread:true,bg:'var(--accent-dim)'},
    {icon:'save',title:'Автосохранение',text:'Template сохранён',time:'5 мин',unread:true,bg:'rgba(31,158,90,.12)'},
    {icon:'book',title:'Обновление НПА',text:'Ст. 288 — новая редакция',time:'1 ч',unread:false,bg:'var(--hover)'},
  ];
  return(
    <div style={{position:'absolute',top:'100%',right:0,width:360,background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',boxShadow:'var(--shadow-lg)',zIndex:100,overflow:'hidden',animation:'fadeInScale .15s ease',marginTop:'var(--s-1h)',fontFamily:'var(--font-sans)'}}>
      <div style={{padding:'var(--s-3) var(--s-3h)',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-2)'}}><Ico k="bell" sz={18} col="var(--accent)" /><span style={{fontSize:'var(--text-sm)',fontWeight:600,color:'var(--text)'}}>Уведомления</span></div>
        <span style={{fontSize:'var(--text-xs)',color:'var(--accent)',cursor:'pointer',fontWeight:500}}>Прочитать все</span>
      </div>
      <div style={{maxHeight:260,overflowY:'auto'}}>
        {items.map((n,i)=>(
          <div key={i} style={{padding:'var(--s-2h) var(--s-3h)',borderBottom:i<items.length-1?'1px solid var(--border)':'none',display:'flex',gap:'var(--s-2h)',cursor:'pointer',background:n.unread?'var(--accent-dim)':'transparent',transition:'background .1s'}} onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'} onMouseLeave={e=>e.currentTarget.style.background=n.unread?'var(--accent-dim)':'transparent'}>
            <Ico k={n.icon} sz={20} col="var(--accent)" />
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:'var(--text-sm)',fontWeight:n.unread?600:400,color:'var(--text)',marginBottom:'var(--s-half)'}}>{n.title}</div>
              <div style={{fontSize:'var(--text-xs)',color:'var(--muted)',lineHeight:'var(--lh-snug)'}}>{n.text}</div>
            </div>
            <span style={{fontSize:'var(--text-2xs)',color:'var(--muted)',flexShrink:0,marginTop:'var(--s-half)'}}>{n.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ═══ Outline ═══ */
const DocOutline=({onClose})=>{
  const items=[{l:1,t:'Исковое заявление',n:1},{l:2,t:'о прекращении права собственности',n:2},{l:0,t:'Истец: Иванов А.А.',n:5},{l:0,t:'Ответчик: ОсОО «Мээрим»',n:6},{l:1,t:'Прошу суд:',n:9},{l:0,t:'1. Признать незаконными',n:10},{l:0,t:'2. Взыскать неустойку',n:11},{l:0,t:'3. Применить ст. 289',n:12},{l:0,t:'4. Обязать устранить',n:13},{l:0,t:'5. Взыскать расходы',n:14}];
  return(
    <div style={{height:'100%',background:'var(--bg-panel)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
      <div style={{padding:'9px 12px 8px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}><Ico k="outline" sz={13} col="var(--accent)" grad/><span style={{fontSize:10.5,fontWeight:600,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase'}}>Структура</span></div>
        <button onClick={onClose} style={{background:'transparent',border:'none',cursor:'pointer',color:'var(--muted)',display:'flex'}}><Ico k="x" sz={13}/></button>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'6px 0'}}>
        {items.map((it,i)=>(
          <div key={i} style={{padding:(it.l===0?'4px':'6px')+' 12px '+(it.l===0?'4px':'6px')+' '+(12+it.l*14)+'px',cursor:'pointer',fontSize:it.l===1?12.5:12,color:it.l===1?'var(--text)':'var(--muted)',fontWeight:it.l===1?600:400,borderLeft:it.l===1?'2px solid var(--accent)':'2px solid transparent',transition:'background .1s'}} onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
            <span style={{fontFamily:'var(--font-mono)',fontSize:10,opacity:.35,marginRight:8}}>{it.n}</span>{it.t}
          </div>
        ))}
      </div>
    </div>
  );
};

/* ═══ Tour ═══ */
const TOUR_STEPS=[
  {idx:0,title:'Добро пожаловать!',text:'Юридическая IDE нового поколения.',pos:{top:80,left:'50%',transform:'translateX(-50%)'}},
  {idx:1,title:'Навигатор',text:'Кодексы, законы, практика. Двойной клик — открыть.',pos:{top:120,left:100}},
  {idx:2,title:'Редактор',text:'Выделите текст — плавающая панель с AI-действиями.',pos:{top:'45%',left:'50%',transform:'translateX(-50%)'}},
  {idx:3,title:'AI-ассистент',text:'Проверка, расчёт неустойки, поиск практики.',pos:{top:'40%',right:40}},
  {idx:4,title:'Готово!',text:'Ctrl+P — быстрый доступ. Удачи!',pos:{bottom:60,left:'50%',transform:'translateX(-50%)'}},
];
const TourStep=({step,total,onNext,onClose})=>{
  if(!step) return null;
  return(
    <div style={{position:'fixed',zIndex:3000,animation:'fadeInScale .3s ease',...step.pos}}>
      <div style={{background:'var(--bg-panel)',border:'1px solid var(--accent)',borderRadius:12,boxShadow:'0 0 0 4px var(--accent-dim),var(--shadow-lg)',padding:'16px 20px',maxWidth:320}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
          <Ico k="law" sz={24} col="var(--accent)" />
          <div style={{fontSize:14,fontWeight:600,color:'var(--text)'}}>{step.title}</div>
        </div>
        <div style={{fontSize:13,color:'var(--muted)',lineHeight:1.6,marginBottom:14,marginLeft:34}}>{step.text}</div>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{display:'flex',gap:4}}>{Array.from({length:total},(_,i)=><div key={i} style={{width:6,height:6,borderRadius:'50%',background:i<=step.idx?'var(--accent)':'var(--border)',transition:'background .3s'}}/>)}</div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={onClose} style={{fontSize:12,color:'var(--muted)',background:'transparent',border:'none',cursor:'pointer'}}>Пропустить</button>
            <button onClick={onNext} className="btn" style={{fontSize:12,color:'#fff',background:'var(--accent)',border:'none',borderRadius:6,padding:'5px 14px',cursor:'pointer',fontWeight:500}}>{step.idx<total-1?'Далее':'Начать'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══ DATA ═══ */
const NPA={288:{title:'Статья 288 ГК КР',full:'Статья 288. Основания прекращения права собственности',text:'Право собственности прекращается при отчуждении собственником своего имущества другим лицам, отказе собственника от права собственности, гибели или уничтожении имущества.\n\nПринудительное изъятие не допускается, кроме:\n\n1) обращение взыскания (ст. 289);\n2) отчуждение имущества (ст. 246);\n3) изъятие участка (ст. 290);\n4) выкуп культурных ценностей (ст. 291, 292);\n5) реквизиция (ст. 293);\n6) конфискация (ст. 294).',prev:287,next:289},289:{title:'Статья 289 ГК КР',full:'Статья 289. Обращение взыскания',text:'Изъятие имущества путём обращения взыскания производится на основании решения суда, если иной порядок не предусмотрен законом или договором.\n\nПраво собственности прекращается с момента возникновения права у лица, к которому переходит имущество.',prev:288,next:290},360:{title:'Статья 360 ГК КР',full:'Статья 360. Неустойка',text:'Неустойкой признаётся денежная сумма, которую должник обязан уплатить кредитору при неисполнении обязательства.\n\nКредитор не обязан доказывать причинение убытков.\n\nНеустойка не взыскивается, если должник не несёт ответственности.',prev:359,next:361}};
const INIT_CHAT=[{role:'user',text:'Проверь этот иск на ошибки'},{role:'ai',lines:[{t:'Анализирую документ...'},{t:'Структура верна.',c:'green'},{t:'В п.3 не указан срок исковой давности.',c:'orange'},{t:'Ссылка на ст. 299 устарела — актуальная ст. 288.',c:'orange'}]},{role:'user',text:'Да'},{role:'ai',lines:[{t:'Исправлено. ✓'},{t:'Рекомендую добавить расчёт неустойки по ст. 360.'}]}];
const TREE=[{id:'codes',icon:'book',label:'КОДЕКСЫ КР',sub:'ГК, УК, ТК, СК, НК',children:['Гражданский кодекс КР','Уголовный кодекс КР','Трудовой кодекс КР','Семейный кодекс КР','Налоговый кодекс КР']},{id:'laws',icon:'book',label:'ЗАКОНЫ КР',sub:'О защите прав потребителей',children:['О защите прав потребителей','О нотариате','Об адвокатской деятельности']},{id:'practice',icon:'law',label:'СУДЕБНАЯ ПРАКТИКА',sub:'Постановления Пленума ВС',children:['Постановления Пленума ВС КР №12','Постановления Пленума ВС КР №7','Обзоры практики 2024']},{id:'cases',icon:'explorer',label:'МОИ ДЕЛА',sub:'Иванов А.А., ОсОО «Мээрим»',children:['Иванов А.А. — исковое заявление','ОсОО «Мээрим» — договор аренды','Петрова Н.И. — апелляция']},{id:'tpl',icon:'file',label:'ШАБЛОНЫ',sub:'Иски, Претензии, Договоры',children:['Исковое заявление (типовое)','Претензия (досудебная)','Договор купли-продажи']}];

/* ═══ Handle ═══ */
const Handle=({onMD,vert})=>{
  const[hov,setHov]=useState(false);const[act,setAct]=useState(false);
  return(<div onMouseDown={onMD} onMouseUp={()=>setAct(false)} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>{setHov(false);setAct(false)}} style={{[vert?'width':'height']:'100%',[vert?'height':'width']:4,flexShrink:0,cursor:vert?'row-resize':'col-resize',zIndex:10,display:'flex',alignItems:'center',justifyContent:'center',background:act?'var(--accent)':hov?'var(--accent)':'var(--border)',transition:'background .15s',boxShadow:act?'0 0 10px var(--accent-glow)':'none'}}>
    <div style={{[vert?'width':'height']:20,[vert?'height':'width']:2,background:(hov||act)?'rgba(255,255,255,.4)':'transparent',borderRadius:1}}/>
  </div>);
};

/* ═══ Palette ═══ */
const Palette=({onClose,dark,onAction})=>{
  const[q,setQ]=useState('');const[sel,setSel]=useState(0);const ref=useRef(null);const dialogRef=useRef(null);
  useFocusTrap(true,dialogRef);
  useEffect(()=>{ref.current&&ref.current.focus()},[]);
  const all=[
    {label:'Иванов А.А. — исковое',icon:'file',sub:'МОИ ДЕЛА',action:()=>onAction('openFile','Claim_Ivanov.docx')},
    {label:'Статья 288 ГК КР',icon:'book',sub:'НПА',action:()=>onAction('openNPA',288)},
    {label:'Статья 360 ГК КР',icon:'book',sub:'НПА',action:()=>onAction('openNPA',360)},
    {label:'Новый документ',icon:'plus',hint:'Ctrl+N',sub:'Файл',action:()=>onAction('newDoc')},
    {label:'Сохранить',icon:'save',hint:'Ctrl+S',sub:'Файл',action:()=>onAction('save')},
    {label:'Найти',icon:'search',hint:'Ctrl+F',sub:'Редактор',action:()=>onAction('find')},
    {label:'Outline',icon:'outline',sub:'Вид',action:()=>onAction('outline')},
    {label:'Split editor',icon:'split',hint:'Ctrl+\\',sub:'Вид',action:()=>onAction('splitEditor')},
    {label:'Переключить тему',icon:dark?'sun':'moon',sub:'Вид',action:()=>onAction('toggleTheme')},
    {label:'Проверить документ',icon:'law',sub:'AI',action:()=>onAction('aiCheck')},
  ];
  const items=q?all.filter(i=>i.label.toLowerCase().includes(q.toLowerCase())||i.sub.toLowerCase().includes(q.toLowerCase())):all;
  useEffect(()=>setSel(0),[q]);
  useEffect(()=>{const h=e=>{if(e.key==='ArrowDown'){e.preventDefault();setSel(s=>Math.min(s+1,items.length-1))}if(e.key==='ArrowUp'){e.preventDefault();setSel(s=>Math.max(s-1,0))}if(e.key==='Enter'&&items[sel]){items[sel].action&&items[sel].action();onClose()}};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)},[items,sel,onClose]);
  return(
    <div onClick={onClose} role="presentation" style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(17,24,39,.45)',backdropFilter:'blur(4px)',display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:'var(--s-16)'}}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Командная палитра" onClick={e=>e.stopPropagation()} style={{width:560,background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',boxShadow:'var(--shadow-lg)',animation:'fadeInScale .14s ease',maxHeight:'72vh',display:'flex',flexDirection:'column',overflow:'hidden',fontFamily:'var(--font-sans)'}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-2h)',padding:'var(--s-3) var(--s-3h)',borderBottom:'1px solid var(--border)',flexShrink:0}}>
          <Ico k="search" sz={16} col="var(--muted)"/>
          <input ref={ref} value={q} onChange={e=>setQ(e.target.value)} placeholder="Поиск команд, файлов, статей…" aria-label="Командная палитра" style={{flex:1,background:'transparent',border:'none',outline:'none',color:'var(--text)',fontSize:'var(--text-md)',fontFamily:'var(--font-sans)'}}/>
          <kbd style={{color:'var(--muted)',fontSize:'var(--text-xs)',background:'var(--hover)',padding:'var(--s-half) var(--s-1h)',borderRadius:'var(--radius-xs)',border:'1px solid var(--border)',fontFamily:'var(--font-mono)'}}>ESC</kbd>
        </div>
        <div style={{overflowY:'auto'}}>
          {items.map((it,i)=>{
            const isS=i===Math.min(sel,items.length-1);
            return(
              <div key={i} onClick={()=>{it.action&&it.action();onClose()}} onMouseEnter={()=>setSel(i)} style={{display:'flex',alignItems:'center',gap:'var(--s-2h)',padding:'var(--s-2) var(--s-3h)',cursor:'pointer',background:isS?'var(--hover)':'transparent'}}>
                <div style={{width:28,height:28,borderRadius:'var(--radius-sm)',flexShrink:0,background:isS?'var(--accent-dim)':'var(--bg-bar)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <Ico k={it.icon} sz={14} col={isS?'var(--accent)':'var(--muted)'} {...(isS&&it.icon==='law'?{grad:true,glow:true}:{})}/>
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:'var(--text-sm)',color:'var(--text)',fontWeight:isS?500:400,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{it.label}</div>
                  <div style={{fontSize:'var(--text-xs)',color:'var(--muted)',marginTop:1}}>{it.sub}</div>
                </div>
                {it.hint && <kbd style={{fontSize:'var(--text-2xs)',color:'var(--muted)',background:'var(--bg-bar)',border:'1px solid var(--border)',padding:'var(--s-half) var(--s-1h)',borderRadius:'var(--radius-xs)',fontFamily:'var(--font-mono)',flexShrink:0}}>{it.hint}</kbd>}
              </div>
            );
          })}
          {q&&items.length===0 && <div style={{padding:'var(--s-6)',textAlign:'center',color:'var(--muted)',fontSize:'var(--text-sm)'}}><Ico k="search" sz={20} col="var(--muted)" /><div style={{marginTop:'var(--s-2)'}}>Ничего не найдено</div></div>}
        </div>
      </div>
    </div>
  );
};

/* ═══ Menu Bar ═══ */
const MenuBar=({dark,onToggle,onPalette,showNotif,onToggleNotif,onAction,rightOpen,onToggleRight,isMobile,unsavedCount=0,hasActiveDoc=false,analysing=false})=>{
  const{lang,tr,setLang}=useI18n();
  const[hov,setHov]=useState(null);
  const[open,setOpen]=useState(null);
  
  useEffect(()=>{
    const h=()=>setOpen(null);
    window.addEventListener('click',h);
    return()=>window.removeEventListener('click',h);
  },[]);

  const menus={
    'Файл':[
      {l:tr('mi_new_doc'),h:'Ctrl+N',a:()=>onAction('newDoc')},
      {l:tr('mi_open_file'),h:'Ctrl+O',a:()=>onAction('openFromDisk')},
      {l:tr('mi_open_folder'),a:()=>onAction('openFolder')},
      {s:true},
      {l:tr('mi_save'),h:'Ctrl+S',a:()=>onAction('save')},
      {l:tr('mi_export_pdf'),a:()=>onAction('exportPdf')},
      {l:tr('mi_export_word'),a:()=>onAction('exportWord')},
      {s:true},
      {l:tr('mi_close_editor'),h:'Ctrl+W',a:()=>onAction('closeTab')},
      {l:tr('mi_close_all'),a:()=>onAction('closeAllTabs')}
    ],
    'Правка':[
      {l:tr('mi_undo'),h:'Ctrl+Z',a:()=>{try{window.docEngine&&window.docEngine.commands&&window.docEngine.commands.undo&&window.docEngine.commands.undo()}catch(_){}}},
      {l:tr('mi_redo'),h:'Ctrl+Y',a:()=>{try{window.docEngine&&window.docEngine.commands&&window.docEngine.commands.redo&&window.docEngine.commands.redo()}catch(_){}}},
      {s:true},
      {l:tr('mi_find'),h:'Ctrl+F',a:()=>onAction('find')}
    ],
    'Вид':[
      {l:tr('mi_left_panel'),h:'Ctrl+B',a:()=>onAction('toggleLeft')},
      {l:tr('mi_ai_panel'),h:'Ctrl+J',a:()=>onAction('toggleRight')},
      {s:true},
      {l:tr('mi_split_editor'),h:'Ctrl+\\',a:()=>onAction('splitEditor')},
      {s:true},
      {l:tr('mi_theme'),a:()=>onAction('toggleTheme')}
    ],
    'Перейти':[
      {l:tr('mi_palette'),h:'Ctrl+P',a:onPalette},
      {l:tr('mi_outline'),a:()=>onAction('outline')}
    ]
  };
  // Внутренние ключи menus остаются русскими (стабильные id), наружу — перевод
  const MENU_LABELS={'Файл':tr('menu_file'),'Правка':tr('menu_edit'),'Вид':tr('menu_view'),'Перейти':tr('menu_go'),'Черновик':tr('menu_draft'),'Право':tr('menu_law'),'Справка':tr('menu_help')};

  return(
    <div className="myz-menubar" style={{height:48,flexShrink:0,borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',paddingLeft:'var(--s-1h)',paddingRight:'var(--s-2h)',userSelect:'none'}}>
      <div style={{display:'flex',alignItems:'center'}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-2h)',padding:'0 var(--s-3h) 0 var(--s-1h)',marginRight:'var(--s-1)'}}>
          <LogoIcon sz={42} glow/>
          <span style={{fontWeight:600,fontSize:'var(--text-base)',letterSpacing:'-.02em',color:'var(--text)',fontFamily:'var(--font-sans)'}}>Мыйзамчы</span>
        </div>
        {!isMobile && ['Файл','Правка','Вид','Перейти','Черновик','Право','Справка'].map(m=>(
          <div key={m} style={{position:'relative'}}>
            <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open===m?'true':'false'} onClick={(e)=>{e.stopPropagation();setOpen(open===m?null:m)}} style={{padding:'var(--s-1) var(--s-2h)',borderRadius:'var(--radius-sm)',border:'none',cursor:'pointer',fontSize:'var(--text-sm)',color:'var(--text)',background:hov===m||open===m?'var(--hover)':'transparent',fontFamily:'var(--font-sans)',letterSpacing:'-.005em'}} onMouseEnter={()=>setHov(m)} onMouseLeave={()=>setHov(null)}>{MENU_LABELS[m]||m}</button>
            {open===m && menus[m] && (
              <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'100%',left:0,marginTop:'var(--s-half)',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',boxShadow:'var(--shadow-lg)',zIndex:2000,minWidth:190,padding:'var(--s-1h) 0',animation:'fadeInScale .1s ease',fontFamily:'var(--font-sans)'}}>
                {menus[m].map((it,i)=>it.s?<div key={'s'+i} style={{height:1,background:'var(--border)',margin:'var(--s-1) 0'}}/> : (
                  <div key={i} onClick={()=>{setOpen(null);it.a&&it.a()}} style={{padding:'var(--s-1h) var(--s-3h)',fontSize:'var(--text-sm)',color:'var(--text)',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center',transition:'background .1s'}} onMouseEnter={e=>e.currentTarget.style.background='var(--hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <span>{it.l}</span>
                    {it.h && <span style={{fontSize:'var(--text-2xs)',color:'var(--muted)',fontFamily:'var(--font-mono)'}}>{it.h}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-1h)'}}>
        {/* Статус-pills — короткие визуальные сигналы для юриста перед отправкой документа */}
        {!isMobile && hasActiveDoc && (
          <div style={{display:'flex',alignItems:'center',gap:'var(--s-1h)',marginRight:'var(--s-1h)',fontFamily:'var(--font-sans)'}}>
            {unsavedCount === 0 ? (
              <span title="Все вкладки сохранены" style={{display:'inline-flex',alignItems:'center',gap:'var(--s-1)',padding:'var(--s-half) var(--s-2)',borderRadius:'var(--radius-pill)',background:'var(--green-soft)',color:'var(--green-ink, var(--green))',fontSize:'var(--text-xs)',fontWeight:600,letterSpacing:'-.005em'}}>
                <Glyph type="check" sz={11}/>{tr('pill_saved')}
              </span>
            ) : (
              <span title={`Несохранённых вкладок: ${unsavedCount}`} style={{display:'inline-flex',alignItems:'center',gap:'var(--s-1)',padding:'var(--s-half) var(--s-2)',borderRadius:'var(--radius-pill)',background:'var(--orange-soft)',color:'var(--orange-ink, var(--orange))',fontSize:'var(--text-xs)',fontWeight:600,letterSpacing:'-.005em'}}>
                <Glyph type="warn" sz={11}/>{tr('pill_unsaved')}{unsavedCount > 1 ? ` · ${unsavedCount}` : ''}
              </span>
            )}
            {analysing ? (
              <span style={{display:'inline-flex',alignItems:'center',gap:'var(--s-1)',padding:'var(--s-half) var(--s-2)',borderRadius:'var(--radius-pill)',background:'var(--accent-soft)',color:'var(--accent-strong)',fontSize:'var(--text-xs)',fontWeight:600,letterSpacing:'-.005em'}}>
                <svg width="11" height="11" viewBox="0 0 24 24" style={{animation:'spin 0.9s linear infinite'}}><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeOpacity=".22"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>
                {tr('pill_analyzing')}
              </span>
            ) : (
              <span title="Можно запустить AI-проверку" style={{display:'inline-flex',alignItems:'center',gap:'var(--s-1)',padding:'var(--s-half) var(--s-2)',borderRadius:'var(--radius-pill)',background:'var(--info-soft)',color:'var(--info-ink, var(--info))',fontSize:'var(--text-xs)',fontWeight:600,letterSpacing:'-.005em'}}>
                <Glyph type="scale" sz={11}/>{tr('pill_ready')}
              </span>
            )}
          </div>
        )}
        <div role="group" aria-label="Тил / Язык / Language" style={{display:'flex',alignItems:'center',gap:2,padding:2,border:'1px solid var(--border)',borderRadius:8,marginRight:'var(--s-1)'}}>
          {LANGS.map(l=>(
            <button key={l} type="button" onClick={()=>setLang(l)} className="btn"
              style={{padding:'3px 7px',border:'none',borderRadius:6,cursor:'pointer',fontSize:10.5,fontWeight:700,letterSpacing:'.04em',fontFamily:'inherit',background:lang===l?'var(--accent-dim)':'transparent',color:lang===l?'var(--accent)':'var(--muted)',transition:'all .15s'}}
              onMouseEnter={e=>{if(lang!==l)e.currentTarget.style.color='var(--text)'}}
              onMouseLeave={e=>{if(lang!==l)e.currentTarget.style.color='var(--muted)'}}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        {!isMobile && <a href="/chat.html" className="btn" style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',background:'transparent',border:'1px solid var(--border)',borderRadius:'8px',cursor:'pointer',color:'var(--muted)',fontSize:11.5,fontFamily:'inherit',textDecoration:'none'}}
          onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}}
          onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
          <span style={{fontSize:13}}>💬</span><span>{tr('to_chat')}</span>
        </a>}
        {!isMobile && <button onClick={onPalette} className="btn" style={{display:'flex',alignItems:'center',gap:5,padding:'4px 9px',background:'var(--hover)',border:'1px solid var(--border)',borderRadius:'6px',cursor:'pointer',color:'var(--muted)',fontSize:11.5,fontFamily:'inherit'}} onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.color='var(--text)'}} onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--muted)'}}>
          <Ico k="cmd" sz={12}/><span>Ctrl+P</span>
        </button>}
        <div style={{position:'relative'}}>
          <button onClick={onToggleNotif} className="btn" title="Уведомления" style={{width:30,height:30,borderRadius:'7px',border:'1px solid var(--border)',background:'transparent',cursor:'pointer',color:'var(--muted)',display:'flex',alignItems:'center',justifyContent:'center'}} onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
            <Ico k="bell" sz={14}/>
          </button>
          <div className="nbadge" style={{position:'absolute',top:-3,right:-3,minWidth:16,height:16,borderRadius:'8px',background:'var(--red)',color:'#fff',fontSize:9,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',border:'2px solid var(--bg-bar)',padding:'0 3px',boxShadow:'0 0 8px var(--red-soft)'}}>2</div>
          {showNotif && <Notifications onClose={onToggleNotif}/>}
        </div>
        <button onClick={onToggleRight} className="btn" title="Панель НПА и AI (Ctrl+J)" style={{width:30,height:30,borderRadius:'7px',border:'1px solid var(--border)',background:rightOpen?'var(--accent-dim)':'transparent',cursor:'pointer',color:rightOpen?'var(--accent)':'var(--muted)',display:'flex',alignItems:'center',justifyContent:'center',transition:'all .15s'}} onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}} onMouseLeave={e=>{e.currentTarget.style.background=rightOpen?'var(--accent-dim)':'transparent';e.currentTarget.style.color=rightOpen?'var(--accent)':'var(--muted)'}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="15" y1="3" x2="15" y2="21"/>{rightOpen && <line x1="18" y1="9" x2="18" y2="9.01"/>}</svg>
        </button>
        <button onClick={onToggle} className="btn" style={{width:30,height:30,borderRadius:'7px',border:'1px solid var(--border)',background:'transparent',cursor:'pointer',color:'var(--muted)',display:'flex',alignItems:'center',justifyContent:'center'}} onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
          <Ico k={dark?'sun':'moon'} sz={14}/>
        </button>
        {!isMobile && <div style={{width:1,height:16,background:'var(--border)',margin:'0 2px'}}/>}
        {!isMobile && <Ico k="user" sz={14} col="var(--muted)"/>}
        {!isMobile && <span style={{fontWeight:500,fontSize:13,color:'var(--text)'}}>Zhanybek Asirov</span>}
        {!isMobile && <GradBadge shimmer>PRO</GradBadge>}
        <AvatarRing size={isMobile?26:30}>ZA</AvatarRing>
      </div>
    </div>
  );
};

/* ═══ Activity Bar ═══ */
const ActBar=({active,onSet})=>{
  const items=[
    {id:'explorer',k:'home',label:'Мои файлы'},
    {id:'law',k:'book',label:'Навигатор'},
    {id:'search',k:'search',label:'Поиск'},
    {id:'outline',k:'list',label:'Оглавление'},
    {id:'analytics',k:'activity',label:'Аналитика'},
  ];
  return(
    <nav className="global-nav" aria-label="Навигация рабочих областей" style={{width:44,flexShrink:0,background:'var(--bg-panel)',borderRight:'1px solid var(--border)',display:'flex',flexDirection:'column',alignItems:'center',paddingTop:12,paddingBottom:12,gap:10}}>
      <div style={{marginBottom: 10, color: 'var(--primary)'}}><Ico k="shield" sz={20}/></div>
      {items.map(it=>{
        const on=active===it.id;
        return(
          <button key={it.id} type="button" title={it.label} aria-label={it.label} aria-pressed={on?'true':'false'} onClick={()=>onSet(on?null:it.id)} className="btn" style={{width:34,height:34,borderRadius:7,border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',position:'relative',background:on?'var(--accent-soft)':'transparent',color:on?'var(--primary)':'var(--muted)',transition:'all .2s',padding:0}} onMouseEnter={e=>{if(!on){e.currentTarget.style.background='var(--hover)'; e.currentTarget.style.color='var(--primary-hover)'}}} onMouseLeave={e=>{if(!on){e.currentTarget.style.background='transparent'; e.currentTarget.style.color='var(--muted)'}}}>
            {on && <span style={{position:'absolute',left:0,top:'50%',transform:'translateY(-50%)',width:3,height:20,background:'var(--primary)',borderRadius:'0 3px 3px 0'}}/>}
            <Ico k={it.k} sz={17} />
          </button>
        );
      })}
      <div style={{flex:1}}/>
      <button type="button" title="Пользователи" aria-label="Пользователи" className="btn" style={{width:34,height:34,borderRadius:7,border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--muted)',background:'transparent',transition:'all .15s',padding:0}} onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--primary)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
        <Ico k="users" sz={17}/>
      </button>
      <button type="button" title="Настройки" aria-label="Настройки" className="btn" style={{width:34,height:34,borderRadius:7,border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--muted)',background:'transparent',transition:'all .15s',padding:0}} onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--primary)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
        <Ico k="settings" sz={17}/>
      </button>
    </nav>
  );
};

/* ═══ NPALibraryTree ═══ */
// IDs выгружены с https://cbd.minjust.gov.kg/api/v1/References?id=5 (виды) и ?id=22 (статусы)
// Эндпоинт /GetDocuments (тот же, что использует /list-docs/ru) — поля refTypeId + authoritiesId.
// /Registries возвращает только узкий «Государственный реестр НПА» (напр. 3 кодекса вместо 20).
const NPA_DICTIONARY = {
  types: {
    'Конституция':                                                                 { refTypeId: '0010', authoritiesId: '' },
    'Конституционный закон':                                                       { refTypeId: '1020', authoritiesId: '' },
    'Кодекс':                                                                       { refTypeId: '0030', authoritiesId: '' },
    'Закон':                                                                        { refTypeId: '0020', authoritiesId: '' },
    'Указ Президента КР':                                                           { refTypeId: '0040', authoritiesId: '' },
    'Постановления ЖК КР':                                                          { refTypeId: '0050', authoritiesId: '0010.0010' },
    'Постановления Кабинета Министров Кыргызской Республики':                       { refTypeId: '0050', authoritiesId: '0040.0010' },
    'Постановления Национального банка КР':                                         { refTypeId: '0050', authoritiesId: '0100.0010' },
    'Постановления Центральной комиссии по выборам и проведению референдумов КР':   { refTypeId: '0050', authoritiesId: '0100.0050' },
    'Постановления ОМСУ':                                                           { refTypeId: '0050', authoritiesId: '0090' },
    'Приказ':                                                                       { refTypeId: '0200', authoritiesId: '' },
  },
  statuses: {
    'Действует':               '10',
    'Утратил силу':            '20',
    'Не вступил в силу':       '30',
    'Отменено':                '40',
    'Прекратило действие':     '200000',
    'Действие приостановлено': '952d75356608404e886b907b296f57b9',
    'Не действует':            '25a976c3-122a-4269-b8d7-5e77c113f9f8',
  },
};
const NPA_CATEGORIES = Object.keys(NPA_DICTIONARY.types);
const NPA_STATUSES   = Object.keys(NPA_DICTIONARY.statuses);
const NPA_DEFAULT_STATUS = 'Действует';

const NPA_PAGE_SIZE = 10;   // документов на UI-страницу

const NPALibraryTree = ({ onClose, onSelectArticle }) => {
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [expandedStatus, setExpandedStatus] = useState(null);    // развёрнут только один статус внутри одной категории
  const [selectedDocKey, setSelectedDocKey] = useState(null);
  const [npaList, setNpaList] = useState([]);
  const [totalResults, setTotalResults] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  // Ленивый кэш «category|status» → { docs, total } (живёт на время сессии панели)
  const cacheRef = useRef(new Map());
  const cacheKey = (cat, st) => `${cat}|${st}`;

  // ── Избранное (звёздочки) ──────────────────────────────────────────
  // Храним полные мини-объекты, чтобы секция «Избранное» работала без повторного запроса в API.
  const FAV_STORAGE_KEY = 'miyzamchi_npa_favorites';
  const favKeyOf = (item) =>
    item.documentCode || String(item.lastEdition || item.editionId || item.id || '');
  const [favorites, setFavorites] = useState(() => {
    try {
      const raw = localStorage.getItem(FAV_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return new Map();
      // Поддержка старого формата (массив ключей-строк): подтянутся как заглушки
      if (parsed.length && typeof parsed[0] === 'string') {
        return new Map(parsed.map(k => [k, { key: k, nameRu: 'Без названия', status: '', documentCode: '', lastEdition: null }]));
      }
      return new Map(parsed.filter(o => o && o.key).map(o => [o.key, o]));
    } catch { return new Map(); }
  });
  const persistFavorites = (m) => {
    try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...m.values()])); } catch {}
  };
  const toggleFavorite = (item, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const key = item && (item.key || favKeyOf(item));
    if (!key) return;
    setFavorites(prev => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, {
          key,
          nameRu:       item.nameRu || item.documentTitle || '',
          status:       item.status || '',
          documentCode: item.documentCode || '',
          lastEdition:  item.lastEdition || item.editionId || item.Id || null,
          addedAt:      Date.now(),
        });
      }
      persistFavorites(next);
      return next;
    });
  };
  const [showFavs, setShowFavs] = useState(true);
  const [favPage, setFavPage] = useState(1);

  // Сортировка избранного: 'newest' | 'oldest' | 'name'
  const FAV_SORT_KEY = 'miyzamchi_npa_fav_sort';
  const [favSort, setFavSort] = useState(() => {
    try { return localStorage.getItem(FAV_SORT_KEY) || 'newest'; }
    catch { return 'newest'; }
  });
  const changeFavSort = (val) => {
    setFavSort(val);
    setFavPage(1);
    try { localStorage.setItem(FAV_SORT_KEY, val); } catch {}
  };

  const favoritesList = (() => {
    const arr = [...favorites.values()];
    if (favSort === 'newest') {
      arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (favSort === 'oldest') {
      arr.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    } else if (favSort === 'name') {
      arr.sort((a, b) =>
        String(a.nameRu || '').localeCompare(String(b.nameRu || ''), 'ru', { sensitivity: 'base' })
      );
    }
    return arr;
  })();

  const favTotalPages = Math.max(1, Math.ceil(favoritesList.length / NPA_PAGE_SIZE));
  // Если на странице больше нет элементов (удалили все) — откатываем к существующей
  const favSafePage = Math.min(favPage, favTotalPages);
  const favPageDocs = favoritesList.slice((favSafePage - 1) * NPA_PAGE_SIZE, favSafePage * NPA_PAGE_SIZE);

  const fetchCategoryData = async (typeKey, statusKey) => {
    const type = NPA_DICTIONARY.types[typeKey];
    const statusId = NPA_DICTIONARY.statuses[statusKey];
    if (!type) { console.warn('[NPA] Unknown category:', typeKey); return; }

    setApiError(null);
    setCurrentPage(1);

    const key = cacheKey(typeKey, statusKey);
    if (cacheRef.current.has(key)) {
      const { docs, total } = cacheRef.current.get(key);
      setNpaList(docs);
      setTotalResults(total);
      return;
    }

    // /GetDocuments — полный реестр Минюста (тот же эндпоинт, что использует /list-docs/ru).
    // authoritiesId пустую строку слать НЕЛЬЗЯ — сервер тогда не сужает выборку до конкретного органа.
    const payload = { refTypeId: type.refTypeId, refStatusId: statusId };
    if (type.authoritiesId) payload.authoritiesId = type.authoritiesId;

    setIsLoading(true);
    setNpaList([]);
    setTotalResults(0);

    try {
      const res = await fetch(
        `${_ensureBackend()}/api/minjust/GetDocuments?pageNumber=1&pageSize=500`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error('Пустой ответ от сервера Минюста');
      const json = JSON.parse(text);
      // Часть записей (особенно ОМСУ) без названия — официальный фронт их тоже фильтрует
      const docs = (Array.isArray(json.data) ? json.data : []).filter(d => d.nameRu || d.nameKg || d.documentTitle);
      const total = Number(json.totalResultsCount ?? json.filteredResultsCount ?? docs.length);
      cacheRef.current.set(key, { docs, total });
      setNpaList(docs);
      setTotalResults(total);
    } catch (err) {
      console.error('[Minjust API]', err);
      setApiError(
        err.message === 'RATE_LIMIT'
          ? 'Сервер Минюста временно перегружен. Подождите пару минут.'
          : 'Ошибка загрузки: ' + err.message
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCategoryClick = (cat) => {
    const wasExpanded = expandedCategory === cat;
    setExpandedCategory(wasExpanded ? null : cat);
    setExpandedStatus(null);    // при смене категории — сворачиваем активный статус
  };

  const handleStatusClick = (cat, status, e) => {
    e.stopPropagation();
    const wasExpanded = expandedStatus === status && expandedCategory === cat;
    if (wasExpanded) {
      setExpandedStatus(null);
    } else {
      setExpandedStatus(status);
      fetchCategoryData(cat, status);
    }
  };

  const handleRetry = (cat, status) => {
    cacheRef.current.delete(cacheKey(cat, status));
    fetchCategoryData(cat, status);
  };

  // ── Поиск по названию ────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState('');     // '' = любой статус
  const [searchResults, setSearchResults] = useState(null); // null = поиск не выполнялся; [] = выполнен, ничего
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchPage, setSearchPage] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const runSearch = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setIsSearching(true);
    setSearchError(null);
    setSearchPage(1);
    setSearchResults([]);
    setSearchTotal(0);
    try {
      const payload = { nameRus: q };
      const statusId = NPA_DICTIONARY.statuses[searchStatus];
      if (statusId) payload.refStatusId = statusId;
      const res = await fetch(
        `${_ensureBackend()}/api/minjust/GetDocuments?pageNumber=1&pageSize=500`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(await res.text());
      const docs = (Array.isArray(json.data) ? json.data : []).filter(d => d.nameRu || d.nameKg || d.documentTitle);
      setSearchResults(docs);
      setSearchTotal(Number(json.totalResultsCount ?? json.filteredResultsCount ?? docs.length));
    } catch (err) {
      console.error('[NPA Search]', err);
      setSearchError(
        err.message === 'RATE_LIMIT'
          ? 'Сервер Минюста временно перегружен. Подождите пару минут.'
          : 'Ошибка поиска: ' + err.message
      );
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchResults(null);
    setSearchError(null);
    setSearchPage(1);
  };

  // ── Пагинация (общий helper) ─────────────────────────────────────────
  const buildPageNumbers = (total, current) => {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const set = new Set([1, total, current, current - 1, current + 1]);
    const arr = [...set].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    arr.forEach((n, i) => {
      if (i > 0 && n - arr[i - 1] > 1) out.push('…');
      out.push(n);
    });
    return out;
  };

  // дерево
  const totalPages = Math.max(1, Math.ceil(npaList.length / NPA_PAGE_SIZE));
  const pageDocs = npaList.slice((currentPage - 1) * NPA_PAGE_SIZE, currentPage * NPA_PAGE_SIZE);
  const pageNumbers = buildPageNumbers(totalPages, currentPage);

  // поиск
  const searchTotalPages = Math.max(1, Math.ceil((searchResults?.length || 0) / NPA_PAGE_SIZE));
  const searchPageDocs = (searchResults || []).slice((searchPage - 1) * NPA_PAGE_SIZE, searchPage * NPA_PAGE_SIZE);
  const searchPageNumbers = buildPageNumbers(searchTotalPages, searchPage);

  // избранное
  const favPageNumbers = buildPageNumbers(favTotalPages, favSafePage);

  return (
    <>
      <style>{`
        .npa-tree {
          display: flex;
          flex-direction: column;
          gap: 1px;
          font-family: var(--font-body);
          font-size: 13px;
          color: var(--text);
          --npa-folder-color: #5DADE2;
          --npa-folder-color-open: #F5A623;
          --npa-doc-color: var(--muted);
          --npa-row-indent-1: 2px;
          --npa-row-indent-2: 12px;
          --npa-row-indent-3: 22px;
        }
        .npa-row {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 4px;
          border-radius: 5px;
          cursor: pointer;
          color: var(--text);
          user-select: none;
          transition: background 0.12s ease, color 0.12s ease;
          line-height: 1.35;
          white-space: nowrap;
        }
        .npa-row:hover {
          background: var(--hover);
        }
        .npa-row .npa-chev-wrap {
          flex: 0 0 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          opacity: 0.55;
          transition: transform 0.18s var(--ease-out);
        }
        .npa-row.is-open > .npa-chev-wrap {
          transform: rotate(90deg);
          opacity: 0.85;
        }
        .npa-row .npa-icon-wrap {
          flex: 0 0 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .npa-row .npa-label {
          flex: 1 1 auto;
          overflow: hidden;
          text-overflow: ellipsis;
          font-weight: 500;
        }
        .npa-row .npa-badge {
          flex: 0 0 auto;
          font-size: 10px;
          color: var(--muted);
          background: var(--hover);
          border-radius: 999px;
          padding: 1px 7px;
          letter-spacing: 0;
          font-variant-numeric: tabular-nums;
        }
        .npa-row.is-leaf .npa-chev-wrap { visibility: hidden; }
        .npa-row.is-folder-1 { padding-left: var(--npa-row-indent-1); font-weight: 600; font-size: 13px; }
        .npa-row.is-folder-2 { padding-left: var(--npa-row-indent-2); font-size: 12.5px; }
        .npa-row.is-leaf      { padding-left: var(--npa-row-indent-3); font-size: 12px; color: var(--text); }
        .npa-row.is-leaf:hover .npa-label { color: var(--accent); }
        .npa-row.is-folder-1 .npa-icon-wrap { color: var(--npa-folder-color); }
        .npa-row.is-folder-2 .npa-icon-wrap { color: var(--npa-folder-color); opacity: 0.85; }
        .npa-row.is-open.is-folder-1 .npa-icon-wrap,
        .npa-row.is-open.is-folder-2 .npa-icon-wrap { color: var(--npa-folder-color-open); }
        .npa-row.is-leaf .npa-icon-wrap { color: var(--npa-doc-color); }
        .npa-row.is-active {
          background: rgba(93, 173, 226, 0.14);
          color: var(--accent);
        }
        .npa-row.is-active .npa-label { color: var(--accent); font-weight: 600; }
        .npa-row.is-active .npa-icon-wrap { color: var(--accent); }
        .npa-row.is-active .npa-badge { background: rgba(93, 173, 226, 0.22); color: var(--accent); }
        .npa-expand-region {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.22s var(--ease-out);
        }
        .npa-expand-region.is-open { grid-template-rows: 1fr; }
        .npa-expand-inner { overflow: hidden; }

        .npa-state-line {
          padding: 12px 8px;
          padding-left: var(--npa-row-indent-3);
          color: var(--muted);
          font-size: 11.5px;
          line-height: 1.5;
        }
        .npa-state-error { color: var(--red, #e74c3c); }
        .npa-retry-btn {
          display: inline-block;
          margin-top: 8px;
          padding: 4px 10px;
          background: var(--accent);
          color: #fff;
          border: none;
          border-radius: 5px;
          font-size: 11px;
          cursor: pointer;
          font-family: inherit;
        }
        .npa-retry-btn:hover { filter: brightness(1.1); }

        .npa-total-note {
          padding: 6px 8px 2px;
          padding-left: var(--npa-row-indent-3);
          font-size: 10.5px;
          color: var(--muted);
          letter-spacing: 0.02em;
        }
        .npa-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 3px;
          padding: 8px 0 10px;
          padding-left: var(--npa-row-indent-2);
          padding-right: 8px;
          flex-wrap: wrap;
        }
        .npa-pg-btn {
          min-width: 22px;
          height: 22px;
          padding: 0 6px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          font-size: 11px;
          font-family: inherit;
          font-variant-numeric: tabular-nums;
          border-radius: 4px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: all 0.12s ease;
        }
        .npa-pg-btn:hover:not(:disabled):not(.is-active) {
          background: var(--hover);
          color: var(--text);
        }
        .npa-pg-btn.is-active {
          background: var(--accent);
          color: #fff;
          font-weight: 600;
        }
        .npa-pg-btn:disabled {
          opacity: 0.35;
          cursor: default;
        }
        .npa-pg-ellipsis {
          color: var(--muted);
          font-size: 11px;
          padding: 0 2px;
          user-select: none;
        }

        /* ── Search bar ── */
        .npa-search-bar {
          padding: 6px 4px 4px;
          border-bottom: 1px solid var(--border);
          display: flex; flex-direction: column; gap: 4px;
          background: var(--bg-panel);
          flex-shrink: 0;
        }
        .npa-search-input-wrap {
          display: flex; align-items: center;
          background: var(--bg-input, var(--hover));
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 0 8px;
          height: 30px;
          gap: 6px;
          transition: border-color 0.15s, box-shadow 0.15s;
          color: var(--muted);
        }
        .npa-search-input-wrap:focus-within {
          border-color: var(--accent-edge, var(--accent));
          box-shadow: 0 0 0 2px var(--accent-glow, rgba(245,166,35,0.15));
          color: var(--text);
        }
        .npa-search-input-wrap input {
          flex: 1; min-width: 0;
          border: none; outline: none; background: transparent;
          color: var(--text); font-family: inherit; font-size: 12.5px;
        }
        .npa-search-input-wrap input::placeholder { color: var(--muted); }
        .npa-search-clear-btn {
          background: transparent; border: none; cursor: pointer;
          color: var(--muted); display: flex; align-items: center;
          padding: 2px; border-radius: 3px;
        }
        .npa-search-clear-btn:hover { background: var(--hover); color: var(--text); }

        .npa-search-row { display: flex; gap: 6px; align-items: center; }
        .npa-search-status {
          flex: 1; min-width: 0;
          height: 28px;
          background: var(--bg-input, var(--hover));
          border: 1px solid var(--border);
          border-radius: 5px;
          color: var(--text);
          font-family: inherit; font-size: 11.5px;
          padding: 0 6px;
          cursor: pointer;
          outline: none;
        }
        .npa-search-status:focus { border-color: var(--accent-edge, var(--accent)); }
        .npa-search-go {
          height: 28px; padding: 0 12px;
          border: none; border-radius: 5px;
          background: var(--accent); color: #fff;
          font-family: inherit; font-size: 11.5px; font-weight: 600;
          cursor: pointer; transition: filter 0.15s, opacity 0.15s;
          display: inline-flex; align-items: center; gap: 5px;
          white-space: nowrap;
        }
        .npa-search-go:hover:not(:disabled) { filter: brightness(1.1); }
        .npa-search-go:disabled { opacity: 0.45; cursor: not-allowed; }

        /* ── Results view ── */
        .npa-results-header {
          padding: 4px 8px 8px;
          display: flex; justify-content: space-between; align-items: center;
          gap: 8px;
        }
        .npa-results-info {
          font-size: 10.5px;
          color: var(--muted);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .npa-results-back {
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 3px 8px;
          color: var(--muted);
          cursor: pointer;
          font-size: 10.5px;
          font-family: inherit;
          display: inline-flex; align-items: center; gap: 4px;
        }
        .npa-results-back:hover {
          background: var(--hover);
          color: var(--text);
          border-color: var(--accent-edge);
        }

        /* Результат поиска — компактный ряд: статус-галочка + название */
        .npa-search-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 4px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12.5px;
          line-height: 1.4;
          color: var(--text);
          transition: background 0.12s ease;
          user-select: none;
        }
        .npa-search-item + .npa-search-item {
          border-top: 1px solid var(--border);
        }
        .npa-search-item:hover { background: var(--hover); }
        .npa-search-item.is-active {
          background: rgba(93,173,226,0.14);
        }
        .npa-search-item.is-active .npa-search-label {
          color: var(--accent);
          font-weight: 600;
        }
        .npa-search-status-ico {
          flex: 0 0 16px;
          width: 16px; height: 16px;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .npa-search-status-ico.ok    { color: var(--green, #22c55e); }
        .npa-search-status-ico.notok { color: var(--red, #ef4444); }
        .npa-search-label {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Звёздочка избранного */
        .npa-fav-btn {
          flex: 0 0 18px;
          width: 18px; height: 18px;
          display: inline-flex; align-items: center; justify-content: center;
          background: transparent; border: none; cursor: pointer; padding: 0;
          color: var(--muted);
          opacity: 0.35;
          transition: opacity 0.15s ease, color 0.15s ease, transform 0.15s ease;
          border-radius: 3px;
        }
        .npa-search-item:hover .npa-fav-btn,
        .npa-row:hover .npa-fav-btn { opacity: 0.7; }
        .npa-fav-btn:hover {
          opacity: 1 !important;
          color: #F5A623;
          transform: scale(1.18);
        }
        .npa-fav-btn.is-fav {
          opacity: 1;
          color: #F5A623;
        }

        /* Секция «Избранное» снизу */
        .npa-favorites-section {
          margin-top: 18px;
          border-top: 1px solid var(--border);
          padding-top: 10px;
        }
        .npa-favorites-header {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px 6px;
          color: var(--muted);
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          cursor: pointer;
          user-select: none;
          transition: color 0.12s ease;
        }
        .npa-favorites-header:hover { color: var(--text); }
        .npa-favorites-header .npa-fav-chev {
          opacity: 0.6;
          transition: transform 0.18s var(--ease-out);
        }
        .npa-favorites-header.is-open .npa-fav-chev {
          transform: rotate(90deg);
        }
        .npa-favorites-header .npa-fav-star { color: #F5A623; }
        .npa-favorites-count {
          font-size: 10px;
          color: var(--muted);
          background: var(--hover);
          border-radius: 999px;
          padding: 1px 7px;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0;
          text-transform: none;
          font-weight: 600;
        }
        .npa-favorites-empty {
          padding: 10px 8px 6px;
          font-size: 11px;
          color: var(--muted);
          text-align: center;
          font-style: italic;
          line-height: 1.5;
        }
        .npa-fav-sort {
          height: 20px;
          font-size: 10px;
          background: var(--bg-input, var(--hover));
          border: 1px solid var(--border);
          border-radius: 4px;
          color: var(--muted);
          cursor: pointer;
          padding: 0 4px;
          font-family: inherit;
          outline: none;
          text-transform: none;
          letter-spacing: 0;
          font-weight: 500;
        }
        .npa-fav-sort:hover { color: var(--text); border-color: var(--accent-edge); }
        .npa-fav-sort:focus { border-color: var(--accent-edge, var(--accent)); }
      `}</style>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)' }}>
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Реестр НПА
          </span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <Ico k="x" sz={14} />
          </button>
        </div>

        <form className="npa-search-bar" onSubmit={runSearch}>
          <div className="npa-search-input-wrap">
            <Ico k="search" sz={13} />
            <input
              type="text"
              placeholder="Поиск по названию документа…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="npa-search-clear-btn"
                onClick={() => { setSearchQuery(''); clearSearch(); }}
                title="Очистить"
              ><Ico k="x" sz={11} /></button>
            )}
          </div>
          <div className="npa-search-row">
            <select
              className="npa-search-status"
              value={searchStatus}
              onChange={(e) => setSearchStatus(e.target.value)}
            >
              <option value="">Любой статус</option>
              {NPA_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button
              className="npa-search-go"
              type="submit"
              disabled={!searchQuery.trim() || isSearching}
            >
              <Ico k="search" sz={11} />
              {isSearching ? 'Поиск…' : 'Найти'}
            </button>
          </div>
        </form>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 2px' }}>
          {searchResults !== null ? (
            <div>
              <div className="npa-results-header">
                <span className="npa-results-info">
                  {isSearching ? 'Поиск…' : `Найдено: ${searchTotal}`}
                </span>
                <button className="npa-results-back" onClick={clearSearch}>
                  <Ico k="chevR" sz={10} style={{ transform: 'rotate(180deg)' }} />
                  К дереву
                </button>
              </div>
              {isSearching ? (
                <div className="npa-state-line">Поиск документов…</div>
              ) : searchError ? (
                <div className="npa-state-line npa-state-error">
                  {searchError}
                  <div>
                    <button className="npa-retry-btn" onClick={runSearch}>Повторить</button>
                  </div>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="npa-state-line">Ничего не найдено.</div>
              ) : (
                <>
                  {searchTotal > searchResults.length && (
                    <div className="npa-total-note" style={{ paddingLeft: 12 }}>
                      Показаны первые {searchResults.length} из {searchTotal}
                    </div>
                  )}
                  {searchPageDocs.map((item) => {
                    const docKey = item.documentCode || item.id || item.lastEdition || (item.nameRu || '').slice(0, 40);
                    const isActive = selectedDocKey === docKey;
                    const isInForce = String(item.status || '').trim().toLowerCase() === 'действует';
                    const fkey = favKeyOf(item);
                    const isFav = favorites.has(fkey);
                    return (
                      <div
                        key={docKey}
                        className={`npa-search-item ${isActive ? 'is-active' : ''}`}
                        onClick={() => {
                          setSelectedDocKey(docKey);
                          onSelectArticle({
                            editionId:    item.lastEdition || item.editionId || item.Id,
                            documentCode: item.documentCode || '',
                            status:       item.status || '',
                            title:        item.nameRu || item.documentTitle || '',
                          });
                        }}
                        title={item.nameRu || item.documentTitle || ''}
                      >
                        <button
                          type="button"
                          className={`npa-fav-btn ${isFav ? 'is-fav' : ''}`}
                          onClick={(e) => toggleFavorite(item, e)}
                          title={isFav ? 'Убрать из избранного' : 'В избранное'}
                          aria-label={isFav ? 'Убрать из избранного' : 'В избранное'}
                        ><Ico k={isFav ? 'starFilled' : 'starO'} sz={13}/></button>
                        <span className={`npa-search-status-ico ${isInForce ? 'ok' : 'notok'}`}>
                          <Ico k={isInForce ? 'check' : 'x'} sz={14} />
                        </span>
                        <span className="npa-search-label">{item.nameRu || item.documentTitle || 'Без названия'}</span>
                      </div>
                    );
                  })}
                  {searchTotalPages > 1 && (
                    <div className="npa-pagination" style={{ paddingLeft: 8 }}>
                      <button
                        className="npa-pg-btn"
                        disabled={searchPage === 1}
                        onClick={() => setSearchPage(p => Math.max(1, p - 1))}
                        aria-label="Назад"
                      ><Ico k="chevR" sz={11} style={{ transform: 'rotate(180deg)' }} /></button>
                      {searchPageNumbers.map((n, i) =>
                        n === '…'
                          ? <span key={`e${i}`} className="npa-pg-ellipsis">…</span>
                          : <button
                              key={n}
                              className={`npa-pg-btn ${n === searchPage ? 'is-active' : ''}`}
                              onClick={() => setSearchPage(n)}
                            >{n}</button>
                      )}
                      <button
                        className="npa-pg-btn"
                        disabled={searchPage === searchTotalPages}
                        onClick={() => setSearchPage(p => Math.min(searchTotalPages, p + 1))}
                        aria-label="Вперёд"
                      ><Ico k="chevR" sz={11} /></button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
          <div className="npa-tree">
            {NPA_CATEGORIES.map((cat) => {
              const isCatOpen = expandedCategory === cat;
              return (
                <div key={cat}>
                  <div
                    className={`npa-row is-folder-1 ${isCatOpen ? 'is-open' : ''}`}
                    onClick={() => handleCategoryClick(cat)}
                  >
                    <span className="npa-chev-wrap"><Ico k="chevR" sz={11} /></span>
                    <span className="npa-icon-wrap"><Ico k={isCatOpen ? 'folderOpen' : 'folderClosed'} sz={16} /></span>
                    <span className="npa-label">{cat}</span>
                  </div>
                  <div className={`npa-expand-region ${isCatOpen ? 'is-open' : ''}`}>
                    <div className="npa-expand-inner">
                      {NPA_STATUSES.map(status => {
                        const isStOpen = isCatOpen && expandedStatus === status;
                        const cacheEntry = cacheRef.current.get(cacheKey(cat, status));
                        const cachedTotal = cacheEntry?.total;
                        return (
                          <div key={status}>
                            <div
                              className={`npa-row is-folder-2 ${isStOpen ? 'is-open' : ''}`}
                              onClick={(e) => handleStatusClick(cat, status, e)}
                            >
                              <span className="npa-chev-wrap"><Ico k="chevR" sz={11} /></span>
                              <span className="npa-icon-wrap"><Ico k={isStOpen ? 'folderOpen' : 'folderClosed'} sz={15} /></span>
                              <span className="npa-label">{status}</span>
                              {cachedTotal != null && <span className="npa-badge">{cachedTotal}</span>}
                            </div>
                            <div className={`npa-expand-region ${isStOpen ? 'is-open' : ''}`}>
                              <div className="npa-expand-inner">
                                {isStOpen && (
                                  isLoading ? (
                                    <div className="npa-state-line">Загрузка документов…</div>
                                  ) : apiError ? (
                                    <div className="npa-state-line npa-state-error">
                                      {apiError}
                                      <div>
                                        <button
                                          className="npa-retry-btn"
                                          onClick={(e) => { e.stopPropagation(); handleRetry(cat, status); }}
                                        >Повторить</button>
                                      </div>
                                    </div>
                                  ) : npaList.length === 0 ? (
                                    <div className="npa-state-line">В этой категории документов нет.</div>
                                  ) : (
                                    <>
                                      {totalResults > npaList.length && (
                                        <div className="npa-total-note">
                                          Показаны первые {npaList.length} из {totalResults}
                                        </div>
                                      )}
                                      {pageDocs.map((item) => {
                                        const docKey = item.documentCode || item.id || item.lastEdition || (item.nameRu || '').slice(0,40);
                                        const isActive = selectedDocKey === docKey;
                                        const fkey = favKeyOf(item);
                                        const isFav = favorites.has(fkey);
                                        return (
                                          <div
                                            key={docKey}
                                            className={`npa-row is-leaf ${isActive ? 'is-active' : ''}`}
                                            onClick={() => {
                                              setSelectedDocKey(docKey);
                                              onSelectArticle({
                                                editionId:    item.lastEdition || item.editionId || item.Id,
                                                documentCode: item.documentCode || '',
                                                status:       item.status || '',
                                                title:        item.nameRu || item.documentTitle || '',
                                              });
                                            }}
                                            title={item.nameRu || item.documentTitle || ''}
                                          >
                                            <span className="npa-chev-wrap"/>
                                            <button
                                              type="button"
                                              className={`npa-fav-btn ${isFav ? 'is-fav' : ''}`}
                                              onClick={(e) => toggleFavorite(item, e)}
                                              title={isFav ? 'Убрать из избранного' : 'В избранное'}
                                              aria-label={isFav ? 'Убрать из избранного' : 'В избранное'}
                                            ><Ico k={isFav ? 'starFilled' : 'starO'} sz={12}/></button>
                                            <span className="npa-icon-wrap"><Ico k="fileDoc" sz={14} /></span>
                                            <span className="npa-label">{item.nameRu || item.documentTitle || 'Без названия'}</span>
                                          </div>
                                        );
                                      })}
                                      {totalPages > 1 && (
                                        <div className="npa-pagination">
                                          <button
                                            className="npa-pg-btn"
                                            disabled={currentPage === 1}
                                            onClick={(e) => { e.stopPropagation(); setCurrentPage(p => Math.max(1, p - 1)); }}
                                            aria-label="Назад"
                                          ><Ico k="chevR" sz={11} style={{transform:'rotate(180deg)'}}/></button>
                                          {pageNumbers.map((n, i) =>
                                            n === '…'
                                              ? <span key={`e${i}`} className="npa-pg-ellipsis">…</span>
                                              : <button
                                                  key={n}
                                                  className={`npa-pg-btn ${n === currentPage ? 'is-active' : ''}`}
                                                  onClick={(e) => { e.stopPropagation(); setCurrentPage(n); }}
                                                >{n}</button>
                                          )}
                                          <button
                                            className="npa-pg-btn"
                                            disabled={currentPage === totalPages}
                                            onClick={(e) => { e.stopPropagation(); setCurrentPage(p => Math.min(totalPages, p + 1)); }}
                                            aria-label="Вперёд"
                                          ><Ico k="chevR" sz={11}/></button>
                                        </div>
                                      )}
                                    </>
                                  )
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          )}

          {/* ── Секция «Избранное» ── */}
          <div className="npa-favorites-section">
            <div
              className={`npa-favorites-header ${showFavs ? 'is-open' : ''}`}
              onClick={() => setShowFavs(s => !s)}
            >
              <span className="npa-fav-chev"><Ico k="chevR" sz={10}/></span>
              <span className="npa-fav-star"><Ico k="starFilled" sz={12}/></span>
              <span style={{ flex: 1 }}>Избранное</span>
              {favoritesList.length > 1 && (
                <select
                  className="npa-fav-sort"
                  value={favSort}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { e.stopPropagation(); changeFavSort(e.target.value); }}
                  title="Сортировка"
                >
                  <option value="newest">Новые ↓</option>
                  <option value="oldest">Старые ↑</option>
                  <option value="name">А–Я</option>
                </select>
              )}
              <span className="npa-favorites-count">{favoritesList.length}</span>
            </div>
            {showFavs && (
              favoritesList.length === 0 ? (
                <div className="npa-favorites-empty">
                  Нажмите ☆ на любом документе,<br/>чтобы добавить сюда
                </div>
              ) : (
                <>
                  {favPageDocs.map((item) => {
                    const isActive = selectedDocKey === item.key;
                    const isInForce = String(item.status || '').trim().toLowerCase() === 'действует';
                    return (
                      <div
                        key={item.key}
                        className={`npa-search-item ${isActive ? 'is-active' : ''}`}
                        onClick={() => {
                          setSelectedDocKey(item.key);
                          onSelectArticle({
                            editionId:    item.lastEdition || null,
                            documentCode: item.documentCode || '',
                            status:       item.status || '',
                            title:        item.nameRu || '',
                          });
                        }}
                        title={item.nameRu || ''}
                      >
                        <button
                          type="button"
                          className="npa-fav-btn is-fav"
                          onClick={(e) => toggleFavorite(item, e)}
                          title="Убрать из избранного"
                          aria-label="Убрать из избранного"
                        ><Ico k="starFilled" sz={13}/></button>
                        <span className={`npa-search-status-ico ${isInForce ? 'ok' : 'notok'}`}>
                          <Ico k={isInForce ? 'check' : 'x'} sz={14} />
                        </span>
                        <span className="npa-search-label">{item.nameRu || 'Без названия'}</span>
                      </div>
                    );
                  })}
                  {favTotalPages > 1 && (
                    <div className="npa-pagination" style={{ paddingLeft: 0 }}>
                      <button
                        className="npa-pg-btn"
                        disabled={favSafePage === 1}
                        onClick={() => setFavPage(p => Math.max(1, p - 1))}
                        aria-label="Назад"
                      ><Ico k="chevR" sz={11} style={{ transform: 'rotate(180deg)' }} /></button>
                      {favPageNumbers.map((n, i) =>
                        n === '…'
                          ? <span key={`fe${i}`} className="npa-pg-ellipsis">…</span>
                          : <button
                              key={n}
                              className={`npa-pg-btn ${n === favSafePage ? 'is-active' : ''}`}
                              onClick={() => setFavPage(n)}
                            >{n}</button>
                      )}
                      <button
                        className="npa-pg-btn"
                        disabled={favSafePage === favTotalPages}
                        onClick={() => setFavPage(p => Math.min(favTotalPages, p + 1))}
                        aria-label="Вперёд"
                      ><Ico k="chevR" sz={11} /></button>
                    </div>
                  )}
                </>
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
};

const FileTreeNode = ({ node, depth = 0, onOpenFile }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [children, setChildren] = useState(node.children || []);
  const [isScanned, setIsScanned] = useState(node.isScanned || false);

  const toggleOpen = async (e) => {
    e.stopPropagation();
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    if (!isScanned && node.handle) {
      setIsLoading(true);
      try {
        const list = [];
        for await (const entry of node.handle.values()) {
          if (entry.kind === 'file') {
            list.push({ kind: 'file', name: entry.name, handle: entry });
          } else if (entry.kind === 'directory') {
            list.push({ kind: 'directory', name: entry.name, handle: entry, isScanned: false, children: [] });
          }
        }
        list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'directory' ? -1 : 1)));
        setChildren(list);
        setIsScanned(true);
      } catch (err) {
        console.error('Failed to scan directory', err);
      }
      setIsLoading(false);
    }
    setIsOpen(true);
  };

  const isDir = node.kind === 'directory';

  return (
    <div>
      <div 
        onClick={(e) => {
           if (isDir) toggleOpen(e);
           else onOpenFile(node);
        }}
        style={{
          padding: `6px 10px 6px ${16 + depth * 14}px`,
          cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 8,
          transition: 'background .1s'
        }}
        onMouseEnter={e => {e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text)'}}
        onMouseLeave={e => {e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'}}
      >
        {isDir ? (
           <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: isLoading ? 0.5 : 1, width: '100%' }}>
             <Ico k={isOpen ? 'chevron-down' : 'chevron-right'} sz={14} col="currentColor" />
             <Ico k="folder" sz={14} col="currentColor" />
             <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
           </div>
        ) : (
           <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
             <Ico k="file" sz={14} col="currentColor" />
             <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>{node.name}</span>
           </div>
        )}
      </div>
      {isOpen && children.map(child => (
         <FileTreeNode key={child.path || child.name} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
};

/* ═══ Left Panel ═══ */
const LeftPanel=({mode,actPanel,onClose,onCtx,onToast,onOpenFile,fsHandle,fsFiles,onOpenFolder,onPickFile,onAction,tabs=[],activeTab=null,onSwitchTab,onCloseTab,recentFiles=[]})=>{
  const [localTree, setLocalTree] = useState([]);
  const [expandedNav, setExpandedNav] = useState(null);  // null | 'recent' | 'starred' | ...

  // ── 2026-05-30: Live-телеметрия пайплайна анализа ─────────────────────
  // Принимаем из AnalyzeDocsMode через window-events:
  //   miyzamchi:tele-start  — старт нового запроса
  //   miyzamchi:tele-update — каждый telemetry chunk + каждый таймер-тик
  //   miyzamchi:tele-done   — пайплайн завершён
  //   miyzamchi:tele-reset  — startNew (юрист нажал "Новый документ")
  //   miyzamchi:agent-search — модель вызвала search_legislation_kg
  const EMPTY_TELE_LP = { calls:0, input:0, output:0, cost:0, lastModel:null, lastLabel:null, startedAt:null, elapsedMs:0 };
  const [pipelineTele, setPipelineTele] = React.useState({ ...EMPTY_TELE_LP });
  const [pipelineRunning, setPipelineRunning] = React.useState(false);
  const [lastAgentSearch, setLastAgentSearch] = React.useState(null);

  React.useEffect(() => {
    const onStart  = (e) => { setPipelineRunning(true);  setPipelineTele(e.detail || { ...EMPTY_TELE_LP, startedAt: Date.now() }); setLastAgentSearch(null); };
    const onUpdate = (e) => { if (e.detail) setPipelineTele(e.detail); };
    const onDone   = (e) => { setPipelineRunning(false); if (e.detail) setPipelineTele(e.detail); };
    const onReset  = ()  => { setPipelineRunning(false); setPipelineTele({ ...EMPTY_TELE_LP }); setLastAgentSearch(null); };
    const onSearch = (e) => { if (e.detail && e.detail.query) setLastAgentSearch({ ...e.detail, at: Date.now() }); };
    window.addEventListener('miyzamchi:tele-start',  onStart);
    window.addEventListener('miyzamchi:tele-update', onUpdate);
    window.addEventListener('miyzamchi:tele-done',   onDone);
    window.addEventListener('miyzamchi:tele-reset',  onReset);
    window.addEventListener('miyzamchi:agent-search', onSearch);
    return () => {
      window.removeEventListener('miyzamchi:tele-start',  onStart);
      window.removeEventListener('miyzamchi:tele-update', onUpdate);
      window.removeEventListener('miyzamchi:tele-done',   onDone);
      window.removeEventListener('miyzamchi:tele-reset',  onReset);
      window.removeEventListener('miyzamchi:agent-search', onSearch);
    };
  }, []);

  // Свежий поисковый запрос держим в UI 6 секунд — потом скрываем.
  const [searchVisible, setSearchVisible] = React.useState(false);
  React.useEffect(() => {
    if (!lastAgentSearch) { setSearchVisible(false); return; }
    setSearchVisible(true);
    const id = setTimeout(() => setSearchVisible(false), 6000);
    return () => clearTimeout(id);
  }, [lastAgentSearch]);

  const showAnalysisBlock = pipelineRunning || pipelineTele.calls > 0;

  const navItems = [
    { id: 'recent',  label: 'Недавние',           icon: 'clock' },
    { id: 'starred', label: 'Избранное',          icon: 'star' },
    { id: 'shared',  label: 'Поделились со мной', icon: 'users' },
    { id: 'trash',   label: 'Корзина',            icon: 'trash' },
  ];

  const fmtRecentDate = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return 'только что';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' мин';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' ч';
    return new Date(ts).toLocaleDateString('ru-RU');
  };

  const handleRecentClick = (name) => {
    const open = tabs.find(t => t.name === name);
    if (open) { onSwitchTab && onSwitchTab(open.id); }
    else { onToast && onToast('warning', 'Файл закрыт. Откройте заново через ➕'); }
  };

  if(actPanel==='outline' || mode==='outline') return <DocOutline onClose={onClose}/>;
  if(actPanel==='law' || mode==='law') return <NPALibraryTree onClose={onClose} onSelectArticle={(art)=>onAction('openNPA', art)} />;

  return(
    <div className="file-explorer" style={{height:'100%',background:'var(--bg-panel)',display:'flex',flexDirection:'column',overflowY:'auto',position:'relative',fontFamily:'var(--font-sans)'}}>
      <style>{`.btn-new-document { background-color: var(--primary); color: #ffffff; border: none; border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-4); width: calc(100% - var(--s-8)); margin: var(--s-2) var(--s-4) var(--s-6) var(--s-4); font-weight: 600; display: flex; align-items: center; justify-content: center; gap: var(--s-2); cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans); transition: background-color 0.2s ease; } .btn-new-document:hover { background-color: var(--primary-hover); } .btn-open-document { background-color: transparent; color: var(--text); border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-4); width: calc(100% - var(--s-8)); margin: 0 var(--s-4) 0 var(--s-4); font-weight: 500; display: flex; align-items: center; justify-content: center; gap: var(--s-2); cursor: pointer; font-size: var(--text-sm); font-family: var(--font-sans); transition: all 0.2s ease; } .btn-open-document:hover { background-color: var(--hover); border-color: var(--text-muted); }`}</style>

      <div style={{padding: 'var(--s-6) var(--s-4) var(--s-3) var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>МОИ ФАЙЛЫ</div>
        <button onClick={onClose} style={{background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex'}}><Ico k="x" sz={14}/></button>
      </div>

      <button className="btn-open-document" onClick={()=>onAction('openFromDisk')}>
        <span style={{fontSize: 14}}>📁</span>
        <span>Открыть документ</span>
      </button>

      <button className="btn-new-document" onClick={()=>onAction('newDoc')}>
        <Ico k="plus" sz={14} col="#fff"/>
        <span>Новый документ</span>
      </button>

      <style>{`
        .myz-nav-row { display:flex; align-items:center; gap:var(--s-3); padding:var(--s-2) var(--s-3); cursor:pointer; border-radius:var(--radius-sm); color:var(--muted); transition: background .15s, color .15s; }
        .myz-nav-row:hover { background: var(--hover); color: var(--text); }
        .myz-nav-row.is-open { color: var(--text); background: var(--hover); }
        .myz-nav-row .myz-nav-badge { margin-left:auto; font-size:var(--text-2xs); color:var(--muted); background:var(--hover); padding:var(--s-half) var(--s-1h); border-radius:var(--radius-pill); font-weight:600; }
        .myz-nav-row.is-open .myz-nav-badge { background: var(--bg-panel); }
        .myz-recent-list { padding: var(--s-1) var(--s-2) var(--s-2) var(--s-8); display:flex; flex-direction:column; gap:var(--s-half); }
        .myz-recent-item { display:flex; align-items:center; gap:var(--s-2); padding:var(--s-1h) var(--s-2); border-radius:var(--radius-xs); cursor:pointer; font-size:var(--text-sm); color:var(--text); transition: background .12s; }
        .myz-recent-item:hover { background: var(--hover); }
        .myz-recent-item.is-closed { color: var(--muted); }
        .myz-recent-item .myz-recent-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .myz-recent-item .myz-recent-date { flex-shrink:0; font-size:var(--text-2xs); color:var(--muted); }
        .myz-recent-empty { padding: var(--s-2) var(--s-2) var(--s-2) var(--s-8); font-size:var(--text-xs); color:var(--muted); font-style:italic; }
        .myz-file-row { display:flex; align-items:center; gap:var(--s-2); padding:var(--s-1h) var(--s-3); cursor:pointer; border-radius:var(--radius-xs); transition: background .12s; color:var(--text); }
        .myz-file-row:hover { background: var(--hover); }
        .myz-file-row.is-active { background: var(--accent-soft); color: var(--primary); font-weight: 600; }
        .myz-file-row .myz-file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-sm); }
        .myz-file-row .myz-file-dot { width:6px; height:6px; border-radius:50%; background:var(--accent); opacity:0; flex-shrink:0; }
        .myz-file-row.is-mod .myz-file-dot { opacity:1; }
        .myz-file-row .myz-file-close { opacity:0; background:transparent; border:none; cursor:pointer; color:var(--muted); padding:var(--s-half); border-radius:var(--radius-xs); display:flex; }
        .myz-file-row:hover .myz-file-close { opacity:1; }
        .myz-file-row .myz-file-close:hover { background:var(--border); color:var(--text); }
      `}</style>

      <div style={{display: 'flex', flexDirection: 'column', gap: 'var(--s-half)', padding: '0 var(--s-2)', marginBottom: 'var(--s-4)'}}>
        {navItems.map(it => {
          const isOpen = expandedNav === it.id;
          const badge = it.id === 'recent' ? recentFiles.length : null;
          return (
            <React.Fragment key={it.id}>
              <div
                className={`myz-nav-row ${isOpen ? 'is-open' : ''}`}
                onClick={() => setExpandedNav(isOpen ? null : it.id)}
              >
                <Ico k={it.icon} sz={16} col="currentColor" />
                <span style={{fontSize: 'var(--text-sm)', fontWeight: 500}}>{it.label}</span>
                {badge != null && badge > 0 && <span className="myz-nav-badge">{badge}</span>}
              </div>
              {isOpen && it.id === 'recent' && (
                recentFiles.length === 0 ? (
                  <div className="myz-recent-empty">Список пуст. Откройте файл — он появится здесь.</div>
                ) : (
                  <div className="myz-recent-list">
                    {recentFiles.map(r => {
                      const isOpenNow = tabs.some(t => t.name === r.name);
                      return (
                        <div
                          key={r.name}
                          className={`myz-recent-item ${isOpenNow ? '' : 'is-closed'}`}
                          onClick={() => handleRecentClick(r.name)}
                          title={isOpenNow ? r.name : r.name + ' (закрыт)'}
                        >
                          <Ico k="file" sz={11} col="currentColor"/>
                          <span className="myz-recent-name">{r.name}</span>
                          <span className="myz-recent-date">{fmtRecentDate(r.addedAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── 2026-05-30: блок "АНАЛИЗ" — live-телеметрия пайплайна ── */}
      {showAnalysisBlock && (
        <div style={{padding: '0 var(--s-4)', marginBottom: 'var(--s-4)'}}>
          <style>{`
            .myz-tele-block { background: var(--hover); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--s-2h) var(--s-3); display: flex; flex-direction: column; gap: var(--s-1h); }
            .myz-tele-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s-1); }
            .myz-tele-title { font-size: var(--text-xs); font-weight: 700; color: var(--muted); letterSpacing: 0.06em; }
            .myz-tele-pulse { width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: myzPulse 1.2s infinite ease-in-out; }
            .myz-tele-pulse--idle { background: #9ca3af; animation: none; }
            @keyframes myzPulse { 0%,100% { opacity: 0.4; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } }
            .myz-tele-row { display: flex; align-items: center; gap: var(--s-2); font-size: var(--text-sm); color: var(--text); }
            .myz-tele-ico { font-size: 13px; opacity: 0.75; }
            .myz-tele-val { font-variant-numeric: tabular-nums; font-weight: 600; }
            .myz-tele-unit { font-size: var(--text-2xs); color: var(--muted); }
            .myz-tele-sep { color: var(--muted); margin: 0 2px; }
            .myz-tele-last { font-size: var(--text-2xs); color: var(--muted); border-top: 1px solid var(--border); padding-top: var(--s-1h); margin-top: var(--s-1); display: flex; flex-direction: column; gap: 2px; }
            .myz-tele-last b { color: var(--text); font-weight: 600; }
            .myz-tele-search { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-xs); padding: var(--s-1h) var(--s-2); margin-top: var(--s-1h); font-size: var(--text-2xs); color: var(--text); animation: fadeInScale .15s ease; line-height: 1.4; }
            .myz-tele-search-label { color: #10b981; font-weight: 700; margin-right: 4px; }
          `}</style>
          <div className="myz-tele-block">
            <div className="myz-tele-head">
              <span className="myz-tele-title">АНАЛИЗ</span>
              <span className={'myz-tele-pulse' + (pipelineRunning ? '' : ' myz-tele-pulse--idle')} title={pipelineRunning ? 'Запрос обрабатывается' : 'Готово'}/>
            </div>
            <div className="myz-tele-row" title="Длительность обработки">
              <span className="myz-tele-ico"><Ico k="clock" sz={13} col="inherit" /></span>
              <span className="myz-tele-val">{(pipelineTele.elapsedMs / 1000).toFixed(1)}</span>
              <span className="myz-tele-unit">сек</span>
            </div>
            <div className="myz-tele-row" title="Токены: input / output">
              <span className="myz-tele-ico"><Ico k="coin" sz={13} col="inherit" /></span>
              <span className="myz-tele-val">{(pipelineTele.input || 0).toLocaleString('ru-RU')}</span>
              <span className="myz-tele-sep">/</span>
              <span className="myz-tele-val">{(pipelineTele.output || 0).toLocaleString('ru-RU')}</span>
              <span className="myz-tele-unit">tok</span>
            </div>
            <div className="myz-tele-row" title="Накопленная стоимость пайплайна">
              <span className="myz-tele-ico"><Ico k="dollar" sz={13} col="inherit" /></span>
              <span className="myz-tele-val">${(pipelineTele.cost || 0).toFixed(5)}</span>
            </div>
            <div className="myz-tele-row" title="Количество LLM-вызовов">
              <span className="myz-tele-ico"><Ico k="robot" sz={13} col="inherit" /></span>
              <span className="myz-tele-val">{pipelineTele.calls || 0}</span>
              <span className="myz-tele-unit">вызовов</span>
            </div>
            {(pipelineTele.lastModel || pipelineTele.lastLabel) && (
              <div className="myz-tele-last">
                <span>Последний:</span>
                {pipelineTele.lastModel && <span><b>{pipelineTele.lastModel}</b></span>}
                {pipelineTele.lastLabel && <span style={{opacity:0.75}}>{pipelineTele.lastLabel}</span>}
              </div>
            )}
            {searchVisible && lastAgentSearch && (
              <div className="myz-tele-search" title={lastAgentSearch.reason || ''}>
                <span className="myz-tele-search-label">🔎 Агент ищет:</span>
                «{lastAgentSearch.query}»
                {lastAgentSearch.segmentRef && <div style={{opacity:0.7, marginTop:2}}>· {lastAgentSearch.segmentRef}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{padding: '0 var(--s-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s-2)'}}>
        <div style={{fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.06em'}}>ФАЙЛЫ</div>
      </div>

      <div style={{flex: 1, paddingBottom: 'var(--s-4)', padding: '0 var(--s-2)'}}>
        {tabs.length === 0 ? (
          <div style={{padding: '0 var(--s-2)', fontSize: 'var(--text-sm)', color: 'var(--muted)', fontStyle: 'italic'}}>Нет открытых файлов.</div>
        ) : (
          tabs.map(tab => (
            <div
              key={tab.id}
              className={`myz-file-row ${tab.id === activeTab ? 'is-active' : ''} ${tab.mod ? 'is-mod' : ''}`}
              onClick={() => onSwitchTab && onSwitchTab(tab.id)}
              title={tab.name}
            >
              <Ico k="file" sz={14} col="currentColor"/>
              <span className="myz-file-name">{tab.name}</span>
              <span className="myz-file-dot" title="Несохранённые изменения"/>
              <button
                type="button"
                className="myz-file-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(tab.id); }}
                title="Закрыть"
              ><Ico k="x" sz={12}/></button>
            </div>
          ))
        )}
      </div>

    </div>
  );
};


/* ═══ Error Boundary ═══ */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return <div style={{padding:8,background:'var(--red)',color:'#fff',fontSize:12}}>Ruler Error: {this.state.error?.message}</div>;
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════════
   DocEngine constants + helpers (ported from docengine.html)
   ═══════════════════════════════════════════════ */
const A4_HEIGHT_MM = 297;
const A4_WIDTH_MM = 210;
const PAD_TOP_MM = 20;
const PAD_BOTTOM_MM = 20;
const PAD_LEFT_MM_DOC = 30;
const PAD_RIGHT_MM_DOC = 15;
const MM_PER_PX = 0.2645833333;
const PX_PER_MM = 1 / MM_PER_PX;
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOM_KEY = 'docengine-zoom';

/* ═══ DOCX IMPORT (docx-preview → cleaned HTML) ═══ */
const ALLOWED_INLINE_STYLES = new Set([
  'text-align', 'text-indent', 'line-height',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'color', 'background-color',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding-left', 'padding-right',
  'text-decoration', 'vertical-align',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'width',
]);
const cleanInlineStyle = (styleStr) => {
  if (!styleStr) return '';
  const decls = styleStr.split(';').map(d => d.trim()).filter(Boolean);
  const kept = [];
  for (const d of decls) {
    const colonIdx = d.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = d.slice(0, colonIdx).trim().toLowerCase();
    const val = d.slice(colonIdx + 1).trim();
    if (!ALLOWED_INLINE_STYLES.has(prop)) continue;
    if (prop === 'text-align' && (val === 'both' || val === 'distribute')) {
      kept.push('text-align: justify');
    } else {
      kept.push(prop + ': ' + val);
    }
  }
  return kept.join('; ');
};
const PUSH_DOWN_PROPS = ['font-family', 'font-size', 'color'];
const parseStyleStr = (str) => {
  const out = [];
  if (!str) return out;
  str.split(';').forEach(decl => {
    const idx = decl.indexOf(':');
    if (idx === -1) return;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).trim();
    if (k && v) out.push([k, v]);
  });
  return out;
};
const stringifyStyle = (decls) => decls.map(([k, v]) => `${k}: ${v}`).join('; ');
const pushDownInlineStyles = (root) => {
  const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th');
  blocks.forEach(block => {
    const decls = parseStyleStr(block.getAttribute('style'));
    if (decls.length === 0) return;
    const toPush = [];
    const toKeep = [];
    decls.forEach(([k, v]) => {
      if (PUSH_DOWN_PROPS.includes(k)) toPush.push([k, v]);
      else toKeep.push([k, v]);
    });
    if (toPush.length === 0) return;
    const span = document.createElement('span');
    span.setAttribute('style', stringifyStyle(toPush));
    while (block.firstChild) span.appendChild(block.firstChild);
    block.appendChild(span);
    if (toKeep.length) block.setAttribute('style', stringifyStyle(toKeep));
    else block.removeAttribute('style');
  });
};
const cleanDocxPreviewDom = (root) => {
  const sections = Array.from(root.querySelectorAll('section.docx'));
  let extracted;
  if (sections.length > 0) {
    extracted = document.createElement('div');
    sections.forEach(sec => {
      Array.from(sec.children).forEach(ch => {
        if (ch.matches?.('.docx-header, .docx-footer, header, footer')) return;
        extracted.appendChild(ch.cloneNode(true));
      });
    });
  } else {
    extracted = root.cloneNode(true);
  }
  const walker = document.createTreeWalker(extracted, NodeFilter.SHOW_ELEMENT, null);
  const toRemove = [];
  let node = walker.currentNode;
  while ((node = walker.nextNode())) {
    const tag = node.tagName.toLowerCase();
    if (['header', 'footer', 'aside', 'nav', 'script', 'style', 'meta', 'link'].includes(tag)) {
      toRemove.push(node); continue;
    }
    node.removeAttribute('class');
    node.removeAttribute('id');
    Array.from(node.attributes).forEach(attr => {
      if (attr.name.startsWith('data-') || attr.name === 'contenteditable') node.removeAttribute(attr.name);
    });
    if (node.hasAttribute('style')) {
      const cleaned = cleanInlineStyle(node.getAttribute('style'));
      if (cleaned) node.setAttribute('style', cleaned);
      else node.removeAttribute('style');
    }
  }
  toRemove.forEach(n => n.remove());
  pushDownInlineStyles(extracted);
  let changed = true; let iter = 0;
  while (changed && iter < 5) {
    changed = false; iter++;
    extracted.querySelectorAll('article, section').forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el); changed = true;
    });
  }
  Array.from(extracted.childNodes).forEach(child => {
    if (child.nodeType === 3 && child.textContent.trim()) {
      const p = document.createElement('p');
      p.textContent = child.textContent;
      extracted.replaceChild(p, child);
    }
  });
  return extracted.innerHTML;
};

/* ═══ HTML → DOCX EXPORT (uses window.docxLib from esm.sh) ═══ */
const ALIGN_TO_DOCX = { left: 'left', center: 'center', right: 'right', justify: 'both' };
const cssColorToHex = (c) => {
  if (!c) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    const r = c[1], g = c[2], b = c[3];
    return (r + r + g + g + b + b).toUpperCase();
  }
  const probe = document.createElement('div');
  probe.style.color = c; document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color; document.body.removeChild(probe);
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return undefined;
  return [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0').toUpperCase()).join('');
};
const cssLenToPt = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(-?[\d.]+)(pt|px|mm|cm|in|em|rem)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'px').toLowerCase();
  if (unit === 'pt') return n;
  if (unit === 'px') return n * 0.75;
  if (unit === 'mm') return n * 2.83465;
  if (unit === 'cm') return n * 28.3465;
  if (unit === 'in') return n * 72;
  if (unit === 'em' || unit === 'rem') return n * 12;
  return null;
};
const cssLenToHalfPt = (s) => { const pt = cssLenToPt(s); return pt == null ? null : Math.round(pt * 2); };
const cssLenToDxa = (s) => { const pt = cssLenToPt(s); return pt == null ? null : Math.round(pt * 20); };
const inlineToRuns = (node, inheritedMarks, D) => {
  const runs = [];
  if (node.nodeType === 3) {
    const t = node.textContent;
    if (t) runs.push(new D.TextRun({ text: t, ...inheritedMarks }));
    return runs;
  }
  if (node.nodeType !== 1) return runs;
  const tag = node.tagName.toUpperCase();
  if (tag === 'BR') { runs.push(new D.TextRun({ text: '', break: 1 })); return runs; }
  if (tag === 'IMG') return runs;
  const m = { ...inheritedMarks };
  if (tag === 'STRONG' || tag === 'B') m.bold = true;
  if (tag === 'EM' || tag === 'I') m.italics = true;
  if (tag === 'U') m.underline = { type: 'single' };
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.strike = true;
  if (tag === 'SUB') m.subScript = true;
  if (tag === 'SUP') m.superScript = true;
  if (tag === 'CODE') m.font = 'Courier New';
  if (tag === 'A' && node.getAttribute('href')) m.style = 'Hyperlink';
  if (node.style) {
    if (node.style.color) { const c = cssColorToHex(node.style.color); if (c) m.color = c; }
    if (node.style.backgroundColor) {
      const c = cssColorToHex(node.style.backgroundColor);
      if (c) { m.highlight = 'yellow'; m.shading = { type: 'clear', color: 'auto', fill: c }; }
    }
    if (node.style.fontFamily) m.font = node.style.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
    if (node.style.fontSize) { const hp = cssLenToHalfPt(node.style.fontSize); if (hp) m.size = hp; }
  }
  for (const child of node.childNodes) runs.push(...inlineToRuns(child, m, D));
  return runs;
};
const blockProps = (node) => {
  const props = {};
  if (node.style) {
    if (node.style.textAlign && ALIGN_TO_DOCX[node.style.textAlign]) {
      props.alignment = ALIGN_TO_DOCX[node.style.textAlign];
    }
    if (node.style.lineHeight) {
      const lh = parseFloat(node.style.lineHeight);
      if (Number.isFinite(lh)) props.spacing = { line: Math.round(lh * 240), lineRule: 'auto' };
    }
    const indent = {};
    if (node.style.textIndent) {
      const dxa = cssLenToDxa(node.style.textIndent);
      if (dxa != null) indent.firstLine = Math.max(0, dxa);
    }
    if (node.style.marginLeft) {
      const dxa = cssLenToDxa(node.style.marginLeft);
      if (dxa != null) indent.left = Math.max(0, dxa);
    }
    if (node.style.marginRight) {
      const dxa = cssLenToDxa(node.style.marginRight);
      if (dxa != null) indent.right = Math.max(0, dxa);
    }
    if (Object.keys(indent).length) props.indent = indent;
  }
  return props;
};
const HEADING_NAMES = { H1: 'Heading1', H2: 'Heading2', H3: 'Heading3', H4: 'Heading4', H5: 'Heading5', H6: 'Heading6' };
const blockToBlocks = (node, D, ctx) => {
  if (node.nodeType !== 1) {
    if (node.nodeType === 3 && node.textContent.trim()) {
      return [new D.Paragraph({ children: [new D.TextRun(node.textContent)] })];
    }
    return [];
  }
  const tag = node.tagName.toUpperCase();
  const props = blockProps(node);
  if (tag === 'P' || tag === 'DIV') {
    const runs = [];
    for (const c of node.childNodes) runs.push(...inlineToRuns(c, {}, D));
    if (runs.length === 0) runs.push(new D.TextRun(''));
    return [new D.Paragraph({ ...props, children: runs })];
  }
  if (HEADING_NAMES[tag]) {
    const runs = [];
    for (const c of node.childNodes) runs.push(...inlineToRuns(c, {}, D));
    return [new D.Paragraph({ ...props, heading: HEADING_NAMES[tag], children: runs })];
  }
  if (tag === 'BLOCKQUOTE') {
    const runs = [];
    for (const c of node.childNodes) runs.push(...inlineToRuns(c, { italics: true }, D));
    return [new D.Paragraph({ ...props, indent: { left: 720 }, children: runs })];
  }
  if (tag === 'PRE') {
    const text = node.textContent || '';
    return text.split('\n').map(line =>
      new D.Paragraph({ children: [new D.TextRun({ text: line, font: 'Courier New' })] })
    );
  }
  if (tag === 'HR') {
    return [new D.Paragraph({
      border: { bottom: { color: '999999', size: 6, space: 1, style: 'single' } },
      children: [new D.TextRun('')],
    })];
  }
  if (tag === 'UL' || tag === 'OL') {
    const blocks = []; const isOL = tag === 'OL';
    for (const li of node.children) {
      if (li.tagName !== 'LI') continue;
      const runs = []; const subBlocks = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
          subBlocks.push(...blockToBlocks(c, D, ctx));
        } else {
          runs.push(...inlineToRuns(c, {}, D));
        }
      }
      blocks.push(new D.Paragraph({
        children: runs.length ? runs : [new D.TextRun('')],
        ...(isOL ? { numbering: { reference: 'numbered', level: 0 } } : { bullet: { level: 0 } }),
      }));
      blocks.push(...subBlocks);
    }
    return blocks;
  }
  if (tag === 'TABLE') {
    const rows = [];
    const tbody = node.querySelector('tbody') || node;
    const trs = Array.from(tbody.children).filter(c => c.tagName === 'TR');
    const thead = node.querySelector('thead');
    const headTrs = thead ? Array.from(thead.children).filter(c => c.tagName === 'TR') : [];
    for (const tr of [...headTrs, ...trs]) {
      const cells = [];
      for (const td of tr.children) {
        if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
        const cellBlocks = []; let hasBlock = false;
        for (const c of td.childNodes) {
          if (c.nodeType === 1 && (c.tagName === 'P' || HEADING_NAMES[c.tagName] || ['UL','OL','BLOCKQUOTE','PRE','HR','TABLE'].includes(c.tagName))) {
            cellBlocks.push(...blockToBlocks(c, D, ctx)); hasBlock = true;
          }
        }
        if (!hasBlock) {
          const runs = [];
          for (const c of td.childNodes) runs.push(...inlineToRuns(c, {}, D));
          cellBlocks.push(new D.Paragraph({ children: runs.length ? runs : [new D.TextRun('')] }));
        }
        cells.push(new D.TableCell({ children: cellBlocks }));
      }
      rows.push(new D.TableRow({ children: cells }));
    }
    if (rows.length === 0) return [];
    return [new D.Table({ rows, width: { size: 100, type: 'pct' } })];
  }
  const out = [];
  for (const c of node.childNodes) out.push(...blockToBlocks(c, D, ctx));
  return out;
};
const buildDocxBlob = (html) => {
  const D = window.docxLib;
  if (!D) throw new Error('docxLib не загружена');
  const parser = new DOMParser();
  const doc = parser.parseFromString('<!DOCTYPE html><html><body>' + html + '</body></html>', 'text/html');
  const root = doc.body;
  const elements = [];
  for (const child of root.childNodes) elements.push(...blockToBlocks(child, D, {}));
  if (elements.length === 0) elements.push(new D.Paragraph({ children: [new D.TextRun('')] }));
  const dxaMM = (mm) => Math.round(mm * 56.6929);
  const document = new D.Document({
    creator: 'Myyzamchi DocEngine',
    title: 'Документ',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { after: 120, line: 312, lineRule: 'auto' } },
        },
        heading1: { run: { font: 'Times New Roman', size: 32, bold: true }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading2: { run: { font: 'Times New Roman', size: 28, bold: true }, paragraph: { spacing: { before: 200, after: 100 } } },
        heading3: { run: { font: 'Times New Roman', size: 26, bold: true }, paragraph: { spacing: { before: 160, after: 80 } } },
        heading4: { run: { font: 'Times New Roman', size: 24, bold: true }, paragraph: { spacing: { before: 140, after: 70 } } },
      },
    },
    numbering: {
      config: [{
        reference: 'numbered',
        levels: [{
          level: 0, format: 'decimal', text: '%1.', alignment: 'start',
          style: { paragraph: { indent: { left: 720, hanging: 260 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: { margin: { top: dxaMM(20), right: dxaMM(15), bottom: dxaMM(20), left: dxaMM(30) } },
      },
      children: elements,
    }],
  });
  return D.Packer.toBlob(document);
};
const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/* ═══ TIPTAP TOOLBAR ═══ */
const TT_FONTS = [
  { v: 'Times New Roman, serif', l: 'Times New Roman' },
  { v: 'Arial, sans-serif', l: 'Arial' },
  { v: 'Georgia, serif', l: 'Georgia' },
  { v: 'Verdana, sans-serif', l: 'Verdana' },
  { v: 'Courier New, monospace', l: 'Courier New' },
  { v: 'Calibri, sans-serif', l: 'Calibri' },
];
const TT_SIZES = ['8pt','9pt','10pt','11pt','12pt','13pt','14pt','16pt','18pt','20pt','22pt','24pt','28pt','32pt','36pt','48pt','72pt'];
const TT_LINE_HEIGHTS = ['1.0','1.15','1.5','2.0','2.5','3.0'];

const TbBtn = ({ active, disabled, onMouseDown, title, children, accent }) => (
  <button
    type="button"
    className={'tb-btn' + (active ? ' active' : '') + (accent ? ' accent' : '')}
    disabled={disabled}
    onMouseDown={(e) => { e.preventDefault(); !disabled && onMouseDown && onMouseDown(e); }}
    title={title}
  >{children}</button>
);
const TbSep = () => <span className="tb-sep" />;

const TipTapToolbar = ({ editor }) => {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => forceTick(t => t + 1);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);
  if (!editor) return <div className="docengine-toolbar disabled" />;
  const headingValue = editor.isActive('heading', { level: 1 }) ? 'h1' :
    editor.isActive('heading', { level: 2 }) ? 'h2' :
    editor.isActive('heading', { level: 3 }) ? 'h3' :
    editor.isActive('heading', { level: 4 }) ? 'h4' : 'p';
  const setHeading = (v) => {
    if (v === 'p') editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setHeading({ level: parseInt(v.slice(1)) }).run();
  };
  const tsAttrs = editor.getAttributes('textStyle');
  const currentFont = (tsAttrs.fontFamily || '').replace(/['"]/g, '');
  const currentSize = tsAttrs.fontSize || '';
  const currentColor = tsAttrs.color || '#000000';
  const currentHi = editor.getAttributes('highlight').color || '#ffeb3b';
  const currentLineHeight = editor.getAttributes('paragraph').lineHeight || editor.getAttributes('heading').lineHeight || '';
  const setFont = (v) => v ? editor.chain().focus().setFontFamily(v).run() : editor.chain().focus().unsetFontFamily().run();
  const setSize = (v) => v ? editor.chain().focus().setFontSize(v).run() : editor.chain().focus().unsetFontSize().run();
  const setLH = (v) => v ? editor.chain().focus().setLineHeight(v).run() : editor.chain().focus().unsetLineHeight().run();
  const insertTable = () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  const insertImage = () => { const url = prompt('URL картинки (https://...):'); if (url) editor.chain().focus().setImage({ src: url }).run(); };
  const insertLink = () => {
    const cur = editor.getAttributes('link').href || 'https://';
    const url = prompt('URL ссылки:', cur);
    if (url === null) return;
    if (!url) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };
  const clearFmt = () => editor.chain().focus().clearNodes().unsetAllMarks().run();
  return (
    <div className="docengine-toolbar">
      <TbBtn title="Отменить (Ctrl+Z)" disabled={!editor.can().undo()} onMouseDown={() => editor.chain().focus().undo().run()}>↶</TbBtn>
      <TbBtn title="Повторить (Ctrl+Y)" disabled={!editor.can().redo()} onMouseDown={() => editor.chain().focus().redo().run()}>↷</TbBtn>
      <TbSep />
      <select className="tb-sel" value={headingValue} onChange={e => setHeading(e.target.value)} title="Стиль абзаца">
        <option value="p">Обычный</option><option value="h1">Заголовок 1</option><option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option><option value="h4">Заголовок 4</option>
      </select>
      <TbSep />
      <select className="tb-sel tb-sel-font" value={currentFont} onChange={e => setFont(e.target.value)} title="Шрифт" style={{fontFamily: currentFont || 'inherit'}}>
        <option value="">— шрифт —</option>
        {TT_FONTS.map(f => <option key={f.v} value={f.v} style={{fontFamily: f.v}}>{f.l}</option>)}
      </select>
      <select className="tb-sel tb-sel-size" value={currentSize} onChange={e => setSize(e.target.value)} title="Размер">
        <option value="">—</option>
        {TT_SIZES.map(s => <option key={s} value={s}>{parseInt(s)}</option>)}
      </select>
      <TbSep />
      <TbBtn title="Жирный (Ctrl+B)" active={editor.isActive('bold')} onMouseDown={() => editor.chain().focus().toggleBold().run()}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg></TbBtn>
      <TbBtn title="Курсив (Ctrl+I)" active={editor.isActive('italic')} onMouseDown={() => editor.chain().focus().toggleItalic().run()}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg></TbBtn>
      <TbBtn title="Подчёркнутый (Ctrl+U)" active={editor.isActive('underline')} onMouseDown={() => editor.chain().focus().toggleUnderline().run()}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg></TbBtn>
      <TbBtn title="Зачёркнутый" active={editor.isActive('strike')} onMouseDown={() => editor.chain().focus().toggleStrike().run()}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/></svg></TbBtn>
      <TbSep />
      <label className="tb-color" title="Цвет текста" style={{color: currentColor}}>
        <span className="tb-color-letter">A</span>
        <input type="color" value={currentColor} onChange={e => editor.chain().focus().setColor(e.target.value).run()} />
        <span className="tb-color-bar" style={{background: currentColor}} />
      </label>
      <label className="tb-color" title="Заливка текста" style={{color: currentHi}}>
        <span className="tb-color-letter">H</span>
        <input type="color" value={currentHi} onChange={e => editor.chain().focus().toggleHighlight({color: e.target.value}).run()} />
        <span className="tb-color-bar" style={{background: currentHi}} />
      </label>
      <TbBtn title="Снять заливку" onMouseDown={() => editor.chain().focus().unsetHighlight().run()}>⌫</TbBtn>
      <TbSep />
      <TbBtn title="По левому краю" active={editor.isActive({textAlign: 'left'}) || (!editor.isActive({textAlign: 'center'}) && !editor.isActive({textAlign: 'right'}) && !editor.isActive({textAlign: 'justify'}))} onMouseDown={() => editor.chain().focus().setTextAlign('left').run()}>⬱</TbBtn>
      <TbBtn title="По центру" active={editor.isActive({textAlign: 'center'})} onMouseDown={() => editor.chain().focus().setTextAlign('center').run()}>⬲</TbBtn>
      <TbBtn title="По правому краю" active={editor.isActive({textAlign: 'right'})} onMouseDown={() => editor.chain().focus().setTextAlign('right').run()}>⬳</TbBtn>
      <TbBtn title="По ширине" active={editor.isActive({textAlign: 'justify'})} onMouseDown={() => editor.chain().focus().setTextAlign('justify').run()}>≡</TbBtn>
      <TbSep />
      <select className="tb-sel tb-sel-lh" value={currentLineHeight} onChange={e => setLH(e.target.value)} title="Межстрочный интервал">
        <option value="">↕</option>
        {TT_LINE_HEIGHTS.map(lh => <option key={lh} value={lh}>{lh}</option>)}
      </select>
      <TbSep />
      <TbBtn title="Маркированный список" active={editor.isActive('bulletList')} onMouseDown={() => editor.chain().focus().toggleBulletList().run()}>•</TbBtn>
      <TbBtn title="Нумерованный список" active={editor.isActive('orderedList')} onMouseDown={() => editor.chain().focus().toggleOrderedList().run()}>1.</TbBtn>
      <TbBtn title="Блок цитаты" active={editor.isActive('blockquote')} onMouseDown={() => editor.chain().focus().toggleBlockquote().run()}>❝</TbBtn>
      <TbSep />
      <TbBtn title="Вставить таблицу 3×3" onMouseDown={insertTable}>⊞</TbBtn>
      <TbBtn title="Вставить картинку" onMouseDown={insertImage}>🖼</TbBtn>
      <TbBtn title={editor.isActive('link') ? 'Изменить/удалить ссылку' : 'Вставить ссылку'} active={editor.isActive('link')} onMouseDown={insertLink}>🔗</TbBtn>
      <TbBtn title="Горизонтальная линия" onMouseDown={() => editor.chain().focus().setHorizontalRule().run()}>―</TbBtn>
      <TbSep />
      <TbBtn title="Очистить форматирование" onMouseDown={clearFmt}>✕</TbBtn>
    </div>
  );
};

/* ═══ TIPTAP RULER ═══ */
const TipTapRuler = ({ editor, zoom, marginLeft, marginRight, setMarginLeft, setMarginRight }) => {
  const trackRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [textIndent, setTextIndent] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const ti = editor.getAttributes('paragraph').textIndent || editor.getAttributes('heading').textIndent || '';
      const num = parseFloat(ti);
      setTextIndent(Number.isFinite(num) ? num : 0);
    };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);
  const startDrag = (kind) => (e) => { e.preventDefault(); setDrag(kind); };
  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const track = trackRef.current; if (!track) return;
      const rect = track.getBoundingClientRect();
      const xPx = e.clientX - rect.left;
      const trackWidthMm = A4_WIDTH_MM;
      const mm = Math.max(0, Math.min(trackWidthMm, (xPx / rect.width) * trackWidthMm));
      const snapped = Math.round(mm * 4) / 4;
      if (drag === 'left') {
        const max = A4_WIDTH_MM - marginRight - 20;
        setMarginLeft(Math.max(5, Math.min(max, snapped)));
      } else if (drag === 'right') {
        const fromRightMm = trackWidthMm - snapped;
        const max = A4_WIDTH_MM - marginLeft - 20;
        setMarginRight(Math.max(5, Math.min(max, Math.round(fromRightMm * 4) / 4)));
      } else if (drag === 'indent') {
        const indentFromLeft = snapped - marginLeft;
        const clamped = Math.max(-marginLeft + 5, Math.min(A4_WIDTH_MM - marginLeft - marginRight - 5, indentFromLeft));
        const value = Math.round(clamped * 4) / 4;
        setTextIndent(value);
        if (editor) editor.chain().focus().setTextIndent(value + 'mm').run();
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [drag, marginLeft, marginRight, editor, setMarginLeft, setMarginRight]);
  const trackWidthCss = `calc(${A4_WIDTH_MM}mm * ${zoom})`;
  const pctLeft = (marginLeft / A4_WIDTH_MM) * 100;
  const pctRight = (marginRight / A4_WIDTH_MM) * 100;
  const pctIndent = ((marginLeft + textIndent) / A4_WIDTH_MM) * 100;
  return (
    <div className="docengine-ruler">
      <div className="ruler-track" ref={trackRef} style={{ width: trackWidthCss }}>
        <div className="ruler-margin-zone" style={{ left: 0, width: pctLeft + '%' }} />
        <div className="ruler-margin-zone" style={{ right: 0, width: pctRight + '%' }} />
        {Array.from({ length: 22 }, (_, i) => (
          <div key={i} className="ruler-tick major" style={{ left: `calc(${(i / 21) * 100}% - 0.5px)` }}>
            <span className="ruler-tick-num">{i}</span>
          </div>
        ))}
        {Array.from({ length: 21 }, (_, i) => (
          <div key={'h-' + i} className="ruler-tick half" style={{ left: `calc(${((i + 0.5) / 21) * 100}% - 0.5px)` }} />
        ))}
        <div className={'ruler-marker ruler-margin-left' + (drag === 'left' ? ' dragging' : '')} style={{ left: pctLeft + '%' }} onMouseDown={startDrag('left')} title={`Левое поле: ${marginLeft}mm`}>
          <span className="m-arrow up">▲</span><span className="m-arrow down">▼</span>
        </div>
        <div className={'ruler-marker ruler-margin-right' + (drag === 'right' ? ' dragging' : '')} style={{ left: (100 - pctRight) + '%' }} onMouseDown={startDrag('right')} title={`Правое поле: ${marginRight}mm`}>
          <span className="m-arrow up">▲</span><span className="m-arrow down">▼</span>
        </div>
        <div className={'ruler-marker ruler-text-indent' + (drag === 'indent' ? ' dragging' : '')} style={{ left: pctIndent + '%' }} onMouseDown={startDrag('indent')} title={`Красная строка: ${textIndent}mm от левого поля`}>
          <span className="ti-tri">▽</span>
        </div>
      </div>
    </div>
  );
};

/* ═══ TIPTAP PAGE OVERLAY ═══ */
const TipTapPageBreakOverlay = ({ pages }) => {
  if (pages <= 0) return null;
  return (
    <div className="docengine-page-overlay">
      {Array.from({ length: pages }, (_, i) => (
        <div key={'pn-' + i} className="page-num" style={{ top: `calc(${i} * ${A4_HEIGHT_MM}mm + ${PAD_TOP_MM}mm)` }}>
          стр. <strong>{i + 1}</strong> / {pages}
        </div>
      ))}
      {Array.from({ length: pages - 1 }, (_, i) => (
        <React.Fragment key={'br-' + i}>
          <div className="page-edge" style={{ top: `calc(${(i + 1) * A4_HEIGHT_MM}mm - 8px)` }} />
          <div className="page-break" style={{ top: `calc(${(i + 1) * A4_HEIGHT_MM}mm)` }}>
            <span className="page-break-label">конец страницы {i + 1}</span>
          </div>
          <div className="page-edge" style={{ top: `calc(${(i + 1) * A4_HEIGHT_MM}mm + 1px)`, transform: 'scaleY(-1)' }} />
        </React.Fragment>
      ))}
    </div>
  );
};

/* ═══ AI Editor (TipTap, A3 — full layout: toolbar + ruler + A4 + page breaks + zoom) ═══ */

/* ═══ AI Editor ═══ */

/* ═══ Editor ═══ */

/* ═══ NPA Viewer ═══ */
// Header-actions компонент (используется во всех 3-х ветках NPAView render).
// Кнопки: [—] свернуть только NPA  •  [✕] закрыть всю правую панель
const NpaHeaderActions=({onCollapse,onClose})=>(
  <div style={{display:'flex',alignItems:'center',gap:1}}>
    {onCollapse && (
      <button type="button" onClick={onCollapse} title="Свернуть НПА" aria-label="Свернуть НПА"
        style={{background:'transparent',border:'none',cursor:'pointer',color:'var(--muted)',display:'flex',alignItems:'center',justifyContent:'center',width:18,height:18,borderRadius:4,padding:0}}
        onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}}
        onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
        <span style={{display:'block',width:8,height:1.3,background:'currentColor',borderRadius:1}}/>
      </button>
    )}
    <button type="button" onClick={onClose} title="Закрыть панель" aria-label="Закрыть панель"
      style={{background:'transparent',border:'none',cursor:'pointer',color:'var(--muted)',display:'flex',alignItems:'center',justifyContent:'center',width:18,height:18,borderRadius:4,padding:0}}
      onMouseEnter={e=>{e.currentTarget.style.background='var(--hover)';e.currentTarget.style.color='var(--text)'}}
      onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>
      <Ico k="x" sz={11}/>
    </button>
  </div>
);

const NPAView=({art,onClose,onNav,onCollapse,npaTabs=[],activeNpaTabId=null,onSwitchNpaTab,onCloseNpaTab})=>{
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef  = useRef(null); // прокрутка тела документа
  const contentRef = useRef(null); // див с HTML-контентом (для перехвата кликов по ссылкам)

  // ── Метаданные документа (титул, статус, код) ─────────────────────────
  // art может быть: number | string | { editionId, documentCode, status, title }
  const artIsObj = art && typeof art === 'object' && !Array.isArray(art);
  // status из API связанных документов приходит как объект {code, nameRus} — нормализуем в строку
  const rawStatus = artIsObj ? art.status : '';
  const normStatus = typeof rawStatus === 'string'
    ? rawStatus
    : (rawStatus && typeof rawStatus === 'object' ? (rawStatus.nameRus || rawStatus.name || '') : '');
  const docMeta = {
    editionId:    artIsObj ? (art.editionId ?? art) : art,
    documentCode: artIsObj ? (art.documentCode || '') : '',
    status:       normStatus,
    title:        artIsObj ? (art.title || '')        : '',
  };

  // Локальный (in-memory) NPA — только если ID реально есть в словаре NPA{}.
  // Иначе number, пришедший от ссылок Минюста, отправляем в Minjust-ветку.
  const hasLocalEntry = typeof art === 'number'
    && typeof NPA !== 'undefined' && NPA && Object.prototype.hasOwnProperty.call(NPA, art);
  const isOldNpa     = !!hasLocalEntry;
  const isMinjustDoc = !isOldNpa && (
    typeof art === 'string'
    || typeof art === 'number'
    || (artIsObj && docMeta.editionId)
  );

  // ── Редакции (дропдаун Time Travel) ──────────────────────────────
  const [editions, setEditions]               = useState([]);
  const [isLoadingEditions, setIsLoadingEditions] = useState(false);
  // null = показываем editionId из art; цифра = явно выбранная редакция
  const [activeEditionId, setActiveEditionId] = useState(null);

  // ── Связанные документы (Legal Graph) ────────────────────────────
  // Структура: [{ documentCode, nameRu, status:{code,nameRus}, lastEdition }]
  const [relatedDocs, setRelatedDocs]               = useState([]);
  const [isLoadingRelations, setIsLoadingRelations] = useState(false);

  // AbortController — отменяем in-flight fetch'и при смене art/вкладки,
  // чтобы устаревший ответ не затирал актуальный.
  const fetchCtrlRef = useRef(null);

  // Загружает HTML по произвольному editionId (для Time-Travel селекта)
  const fetchEditionById = useCallback(async (editionId, signal) => {
    setIsLoading(true);
    setError(null);
    const parseAndAnchor = (html) => {
      if (typeof html !== 'string' || !html) return '';
      return html.replace(/(\u0421\u0442\u0430\u0442\u044c\u044f\s+(\d+)\.?)/gi,
        (m, p1, p2) => `<span id="article-${p2}" class="article-anchor"></span>${p1}`);
    };
    try {
      const res = await fetch(
        `${_ensureBackend()}/api/minjust/GetEdition?editionId=${editionId}&lang=ru`,
        { signal }
      );
      if (signal && signal.aborted) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (signal && signal.aborted) return;
      if (!text) throw new Error('Пустой ответ');
      const data = JSON.parse(text);
      let html = data.contentRu || data.contentKg
              || data.Content  || data.content || data.html || data.text || '';
      if (typeof html !== 'string') html = String(html ?? '');
      html = html.replace(/<meta[^>]*charset=["']?windows-1251["']?[^>]*>/gi, '');
      if (signal && signal.aborted) return;
      setContent(parseAndAnchor(html));
      setActiveEditionId(editionId);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[NPAView] fetchEditionById:', err);
      setError(err.message);
    } finally {
      if (!signal || !signal.aborted) setIsLoading(false);
    }
  }, []);

  // Загружает список редакций через GetDocument (editions[] внутри ответа)
  // Структура: { id, editionCode, nameRus, nameKyr, textRusType }
  // nameRus = дата редакции, editionCode = хронологический номер
  const fetchEditionsList = useCallback(async (documentCode, signal) => {
    if (!documentCode) return;
    setIsLoadingEditions(true);
    try {
      const res = await fetch(
        `${_ensureBackend()}/api/minjust/GetDocument?DocumentCode=${encodeURIComponent(documentCode)}`,
        { signal }
      );
      if (signal && signal.aborted) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(await res.text());
      if (signal && signal.aborted) return;
      const list = Array.isArray(data.editions) ? data.editions : [];
      // От новых к старым: чем выше editionCode, тем новее редакция
      list.sort((a, b) => (b.editionCode || 0) - (a.editionCode || 0));
      setEditions(list);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[NPAView] fetchEditionsList:', err);
    } finally {
      if (!signal || !signal.aborted) setIsLoadingEditions(false);
    }
  }, []);

  // Загружает связанные документы через documentReferences[] внутри GetDocument.
  // GetReferenceDocuments (API v1) не существует (404), поэтому
  // используем уже выполненный GET /GetDocument и кэшированный ответ.
  const fetchRelatedDocuments = useCallback(async (documentCode, signal) => {
    if (!documentCode) return;
    setIsLoadingRelations(true);
    try {
      const res = await fetch(
        `${_ensureBackend()}/api/minjust/GetDocument?DocumentCode=${encodeURIComponent(documentCode)}`,
        { signal }
      );
      if (signal && signal.aborted) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(await res.text());
      if (signal && signal.aborted) return;
      const refs = Array.isArray(data.documentReferences) ? data.documentReferences : [];
      setRelatedDocs(refs.filter(r => r.lastEdition));
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[NPAView] fetchRelatedDocuments:', err);
    } finally {
      if (!signal || !signal.aborted) setIsLoadingRelations(false);
    }
  }, []);


  useEffect(() => {
    window.scrollToArticle = (num) => {
      const el = document.getElementById(`article-${num}`);
      if (el && scrollRef.current) {
        const top = el.offsetTop;
        scrollRef.current.scrollTo({ top: top - 20, behavior: 'smooth' });
      }
    };
    return () => { delete window.scrollToArticle; };
  }, []);

  // Перехват кликов по ссылкам Минюста — открываем документ внутри IDE
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    // Гибкий парсер URL Минюста.
    // Поддерживаемые форматы:
    //   http://cbd.minjust.gov.kg/act/view/ru-ru/34746
    //   http://cbd.minjust.gov.kg/act/view/ru-ru/34746/5
    //   ?editionId=34746
    //   ?id=34746
    const extractEditionId = (href) => {
      if (!href) return null;
      try {
        const url = new URL(href, 'https://cbd.minjust.gov.kg');
        // 1. Параметры editionId / id
        const qId = url.searchParams.get('editionId') || url.searchParams.get('id');
        if (qId && /^\d+$/.test(qId)) return Number(qId);
        // 2. Путь /act/view/ru-ru/34746 — последний сегмент из пути
        const segments = url.pathname.split('/').filter(Boolean);
        // Берём последний числовой сегмент
        for (let i = segments.length - 1; i >= 0; i--) {
          if (/^\d{4,}$/.test(segments[i])) return Number(segments[i]);
        }
      } catch (_) {
        // если URL относительный — ищем цифру прямо в href
        const m = href.match(/(\d{4,})/);
        if (m) return Number(m[1]);
      }
      return null;
    };

    const handleClick = (e) => {
      // Event delegation: ищем ближайший <a> от места клика вверх по DOM
      const anchor = e.target.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;

      // Внешние не-Минюст ссылки (часть сайтов) и якорь-ссылки — пропускаем
      if (href.startsWith('#')) return;
      const isMinjust = href.includes('minjust.gov.kg') || href.includes('cbd.minjust');
      const isRelative = !href.startsWith('http');
      if (!isMinjust && !isRelative) return; // внешние не-Минюст — оставляем браузеру

      // Перехватываем
      e.preventDefault();
      e.stopPropagation();

      const editionId = extractEditionId(href);
      if (!editionId) {
        console.warn('[NPAView] Не удалось извлечь editionId из:', href);
        return;
      }

      // Переключаем вид через глобальный диспатчер IDE
      if (typeof window.__ideHandleAction === 'function') {
        window.__ideHandleAction('openNPA', editionId);
      } else {
        // Фоллбэк: загрузить новую редакцию прямо в текущем вьюере
        fetchEditionById(editionId);
      }
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [content, fetchEditionById]); // перевешиваем при каждой смене текста

  // При смене art: загружаем текст + сбрасываем редакции + запрашиваем их список + связи.
  // Используем общий AbortController: при следующей смене art все 3 запроса отменяются.
  useEffect(() => {
    if (!isMinjustDoc) return;
    // Отменяем предыдущие in-flight запросы
    if (fetchCtrlRef.current) fetchCtrlRef.current.abort();
    const ctrl = new AbortController();
    fetchCtrlRef.current = ctrl;

    setEditions([]);
    setActiveEditionId(null);
    setRelatedDocs([]);
    fetchEditionById(docMeta.editionId, ctrl.signal);
    if (docMeta.documentCode) {
      fetchEditionsList(docMeta.documentCode, ctrl.signal);
      fetchRelatedDocuments(docMeta.documentCode, ctrl.signal);
    }
    return () => { ctrl.abort(); };
  }, [art, isMinjustDoc]);

  if(!art) return (
    <div style={{height:'100%',display:'flex',flexDirection:'column',background:'var(--bg-panel)'}}>
      <div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <Ico k="book" sz={16} col="var(--accent)" />
          <span style={{fontSize:11,fontWeight:600,color:'var(--muted)',letterSpacing:'.06em',textTransform:'uppercase'}}>Просмотр НПА</span>
        </div>
        <NpaHeaderActions onCollapse={onCollapse} onClose={onClose}/>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,padding:24,textAlign:'center'}}>
        <Ico k="book" sz={36} col="var(--accent-edge)"/>
        <span style={{fontSize:15,color:'var(--muted)',lineHeight:1.55,maxWidth:240,fontFamily:"'Instrument Serif', Georgia, serif",fontStyle:'italic'}}>{'\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u041d\u041f\u0410 \u0438\u043b\u0438 \u0441\u0442\u0430\u0442\u044c\u044e \u0432 \u043c\u0435\u043d\u044e \u0441\u043b\u0435\u0432\u0430 \u0434\u043b\u044f \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0430'}</span>
      </div>
    </div>
  );

  if(isOldNpa){
    const d=NPA[art];if(!d)return null;
    return(<div style={{height:'100%',display:'flex',flexDirection:'column',background:'var(--bg-panel)'}}><div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}><div style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}><Ico k="book" sz={16} col="var(--accent)" /><span style={{fontSize:11,fontWeight:600,color:'var(--muted)',letterSpacing:'.06em',textTransform:'uppercase'}}>Просмотр НПА</span></div><div style={{display:'flex',alignItems:'center',gap:6,minWidth:0}}><Ico k="book" sz={13} col="var(--accent)" grad glow/><span style={{fontSize:12,fontWeight:600,color:'var(--accent)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:140}}>{d.title}</span><NpaHeaderActions onCollapse={onCollapse} onClose={onClose}/></div></div><div style={{flex:1,overflowY:'auto',padding:'14px 16px'}}><div style={{fontSize:12.5,fontWeight:700,color:'var(--text)',marginBottom:12,lineHeight:1.4}}>{d.full}</div><div style={{fontSize:12,color:'var(--text)',lineHeight:1.75,fontFamily:"'JetBrains Mono',monospace",whiteSpace:'pre-wrap',opacity:.9}}>{d.text}</div></div><div style={{padding:'8px 12px',borderTop:'1px solid var(--border)',display:'flex',gap:6,flexShrink:0}}>{[['← Пред.',d.prev],['След. →',d.next]].map(([l,t])=><button key={l} onClick={()=>t&&onNav(t)} disabled={!t} style={{flex:1,padding:'5px 8px',border:'1px solid var(--border)',borderRadius:5,background:'transparent',cursor:t?'pointer':'not-allowed',color:t?'var(--text)':'var(--muted)',fontSize:11.5,fontFamily:'inherit'}} onMouseEnter={e=>{if(t)e.currentTarget.style.background='var(--hover)'}} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>{l}</button>)}</div></div>);
  }
  
  if (isMinjustDoc) {
    // Цвет плашки статуса
    const statusNorm = (docMeta.status || '').trim().toLowerCase();
    const statusStyle = statusNorm.includes('действ') ?
      { bg: 'var(--green-dim)', color: 'var(--green)', label: docMeta.status || 'Действует' } :
      statusNorm.includes('утрат') || statusNorm.includes('сила') ?
      { bg: 'var(--red-dim)', color: 'var(--red)', label: docMeta.status || 'Утратил силу' } :
      { bg: 'var(--hover)', color: 'var(--muted)', label: docMeta.status || 'Неизвестно' };

    return (
      <div style={{height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRadius: 6, border: '1px solid var(--border-color)', overflow: 'hidden', transition:'background-color 0.3s ease, border-color 0.3s ease'}}>
          {/* Хедер: полоса вкладок открытых НПА + кнопки [—]/[✕] */}
          <div className="npa-tabstrip">
            <div className="npa-tabstrip-tabs">
              {npaTabs.map(t => {
                const isActive = t.id === activeNpaTabId;
                return (
                  <div
                    key={t.id}
                    className={`npa-tab ${isActive ? 'is-active' : ''}`}
                    onClick={() => onSwitchNpaTab && onSwitchNpaTab(t.id)}
                    title={t.title}
                  >
                    <Ico k="book" sz={10} col={isActive ? 'var(--primary)' : 'currentColor'}/>
                    <span className="npa-tab-name">{t.title}</span>
                    <button
                      type="button"
                      className="npa-tab-close"
                      onClick={(e) => { e.stopPropagation(); onCloseNpaTab && onCloseNpaTab(t.id); }}
                      title="Закрыть вкладку"
                      aria-label="Закрыть"
                    ><Ico k="x" sz={9}/></button>
                  </div>
                );
              })}
            </div>
            <div className="npa-tabstrip-actions">
              <NpaHeaderActions onCollapse={onCollapse} onClose={onClose}/>
            </div>
          </div>

        {/* ── Тело документа (реквизиты теперь ВНУТРИ — уходят вверх при скролле) ── */}
        <div ref={scrollRef} style={{flex: 1, overflowY: 'auto', padding: '8px 14px', background: 'var(--bg-panel)', scrollBehavior: 'smooth', transition:'background-color 0.3s ease'}}>
          {/* ── Реквизиты документа: статус, код, редакция, название ── */}
          {(docMeta.title || docMeta.status || docMeta.documentCode) && (
            <div style={{
              padding: '4px 0 8px',
              marginBottom: '6px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: '4px',
              maxWidth: '850px', margin: '0 auto 8px'
            }}>
              <div style={{display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap'}}>
                {docMeta.status && (
                  <span style={{
                    padding: '1px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 700,
                    background: statusStyle.bg, color: statusStyle.color, letterSpacing: '0.02em'
                  }}>
                    {statusStyle.label}
                  </span>
                )}
                {docMeta.documentCode && (
                  <span style={{
                    padding: '1px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 500,
                    background: 'var(--hover)', color: 'var(--muted)', fontFamily: 'var(--font-mono)'
                  }}>
                    {docMeta.documentCode}
                  </span>
                )}
                {editions.length > 0 && (
                  <select
                    value={activeEditionId ?? docMeta.editionId}
                    onChange={e => {
                      if (fetchCtrlRef.current) fetchCtrlRef.current.abort();
                      const ctrl = new AbortController();
                      fetchCtrlRef.current = ctrl;
                      fetchEditionById(Number(e.target.value), ctrl.signal);
                    }}
                    disabled={isLoading || isLoadingEditions}
                    title="Выбрать редакцию"
                    style={{
                      marginLeft: 'auto', fontSize: '10px', fontFamily: 'var(--font-body)',
                      background: 'var(--bg-editor)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderRadius: '4px',
                      padding: '1px 4px', cursor: 'pointer', outline: 'none',
                      maxWidth: '120px', minWidth: '78px', height: '20px'
                    }}
                  >
                    {editions.map(ed => (
                      <option key={ed.id} value={ed.id}>
                        {ed.nameRus || ed.nameKyr || String(ed.id)}
                      </option>
                    ))}
                  </select>
                )}
                {isLoadingEditions && !editions.length && (
                  <span style={{fontSize:'9.5px', color:'var(--muted)', marginLeft:'auto'}}>⏳ редакции...</span>
                )}
              </div>
              {docMeta.title && (
                <div style={{
                  fontSize: '11px', color: 'var(--text)', lineHeight: '1.35',
                  fontWeight: 500, letterSpacing: '-0.01em'
                }}>
                  {docMeta.title}
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <div style={{textAlign: 'center', padding: '40px', color: 'var(--muted)', fontFamily: 'sans-serif', fontSize: '14px'}}>
              <div style={{ marginBottom: '12px', fontSize: '20px' }}>⏳</div>
              Загрузка документа...
            </div>
          ) : error ? (
            <div style={{textAlign: 'center', padding: '40px', color: 'var(--red)', fontFamily: 'sans-serif', fontSize: '14px'}}>
              Ошибка загрузки: {error}
            </div>
          ) : content ? (
            <div
              ref={contentRef}
              className="npa-content-academic"
              dangerouslySetInnerHTML={{ __html: content }}
            />
          ) : (
            <div style={{textAlign: 'center', padding: '40px', color: 'var(--muted)', fontFamily: 'sans-serif', fontSize: '14px'}}>
              Документ не найден или текст отсутствует
            </div>
          )}

          {/* ── Связанные акты ── */}
          {isLoadingRelations && (
            <div style={{
              marginTop: '40px', borderTop: '1px solid var(--border)', paddingTop: '24px',
              maxWidth: '850px', margin: '40px auto 0'
            }}>
              <p style={{fontSize:'13px',color:'var(--muted)',fontFamily:'sans-serif'}}>⏳ Загрузка связанных документов...</p>
            </div>
          )}
          {!isLoadingRelations && relatedDocs.length > 0 && (
            <div className="npa-related-docs">
              <h3 className="npa-related-title">
                Связанные документы
                <span className="npa-related-count">{relatedDocs.length}</span>
              </h3>
              <ul className="npa-related-list">
                {relatedDocs.map(doc => {
                  const sCode = doc.status?.code;
                  const sLabel = doc.status?.nameRus || '';
                  const sColor = sCode === '10' ? 'var(--green)' : 'var(--red)';
                  const sBg    = sCode === '10' ? 'var(--green-dim)' : 'var(--red-dim)';
                  return (
                    <li key={doc.documentCode || doc.lastEdition} className="npa-related-item">
                      <button
                        className="npa-related-link"
                        onClick={() => {
                          const id = doc.lastEdition;
                          if (typeof window.__ideHandleAction === 'function') {
                            window.__ideHandleAction('openNPA', id);
                          } else {
                            fetchEditionById(id);
                          }
                        }}
                      >
                        <span className="npa-related-name">
                          {String(doc.nameRu ?? '').replace(/\r?\n/g, ' ').trim() || 'Без названия'}
                        </span>
                        {sLabel && (
                          <span style={{
                            fontSize:'10px', fontWeight:700, padding:'1px 6px',
                            borderRadius:'3px', background:sBg, color:sColor,
                            flexShrink:0, alignSelf:'flex-start', marginTop:'2px'
                          }}>{sLabel}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        <style>{`
          /* ── Полоса вкладок открытых НПА ── */
          .npa-tabstrip {
            display: flex;
            flex-shrink: 0;
            background: var(--bg-app);
            border-bottom: 1px solid var(--border);
            height: 24px;
            align-items: stretch;
          }
          .npa-tabstrip-tabs {
            flex: 1 1 auto;
            display: flex;
            overflow-x: auto;
            overflow-y: hidden;
            min-width: 0;
            scrollbar-width: thin;
          }
          .npa-tabstrip-tabs::-webkit-scrollbar { height: 3px; }
          .npa-tabstrip-tabs::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
          .npa-tab {
            display: flex; align-items: center; gap: 5px;
            padding: 0 4px 0 8px;
            border-right: 1px solid var(--border);
            background: transparent;
            cursor: pointer;
            font-size: 10px;
            color: var(--muted);
            max-width: 160px;
            min-width: 90px;
            white-space: nowrap;
            transition: background 0.12s, color 0.12s;
            user-select: none;
          }
          .npa-tab:hover { background: var(--hover); color: var(--text); }
          .npa-tab.is-active {
            background: var(--bg-panel);
            color: var(--text);
            font-weight: 600;
            position: relative;
          }
          .npa-tab.is-active::after {
            content: '';
            position: absolute;
            left: 0; right: 0; bottom: -1px;
            height: 2px;
            background: var(--primary);
          }
          .npa-tab-name {
            flex: 1; overflow: hidden; text-overflow: ellipsis;
            font-family: var(--font-body);
            letter-spacing: -0.01em;
          }
          .npa-tab-close {
            background: transparent; border: none; cursor: pointer;
            color: var(--muted); padding: 1px;
            border-radius: 3px;
            display: flex; align-items: center; justify-content: center;
            opacity: 0.4;
            width: 14px; height: 14px;
            flex-shrink: 0;
          }
          .npa-tab:hover .npa-tab-close,
          .npa-tab.is-active .npa-tab-close { opacity: 1; }
          .npa-tab-close:hover { background: var(--border); color: var(--text); }
          .npa-tabstrip-actions {
            display: flex;
            align-items: center;
            padding: 0 3px;
            border-left: 1px solid var(--border);
            background: var(--bg-app);
            flex-shrink: 0;
          }

          .npa-content-academic {
            font-family: "Times New Roman", Times, serif;
            font-size: 14px;
            line-height: 1.5;
            text-align: justify;
            color: var(--text-main);
            max-width: 850px;
            margin: 0 auto;
          }
          .npa-content-academic p { text-indent: 1.5em; margin-bottom: 0.5em; margin-top: 0; }
          .npa-content-academic h1, .npa-content-academic h2,
          .npa-content-academic h3, .npa-content-academic h4 {
            text-align: center; text-indent: 0; font-weight: bold;
            margin-top: 1em; margin-bottom: 0.5em;
            line-height: 1.35;
          }
          .npa-content-academic h1 { font-size: 17px; }
          .npa-content-academic h2 { font-size: 15.5px; }
          .npa-content-academic h3 { font-size: 14px; }
          .npa-content-academic h4 { font-size: 13px; }
          .article-anchor { scroll-margin-top: 24px; }

          /* ── Интерактивные ссылки Минюста ── */
          .npa-content-academic a {
            color: var(--link);
            text-decoration: underline;
            text-decoration-color: var(--link-dim);
            text-underline-offset: 2px;
            cursor: pointer;
            transition: background 0.18s, text-decoration-color 0.18s;
            border-radius: 2px;
            padding: 0 1px;
          }
          .npa-content-academic a:hover {
            background-color: var(--link-dim-hover);
            text-decoration-color: var(--link);
          }
          .npa-content-academic a:active {
            background-color: var(--link-dim-active);
          }

          /* ── Блок «Связанные акты» ── */
          .npa-related-docs {
            max-width: 850px;
            margin: 40px auto 0;
            padding-top: 24px;
            border-top: 1.5px solid var(--border);
            padding-bottom: 32px;
            font-family: "Times New Roman", Times, serif;
          }
          .npa-related-title {
            font-size: 12px;
            font-weight: 700;
            color: var(--text-main);
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin: 0 0 14px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-family: ui-sans-serif, system-ui, sans-serif;
          }
          .npa-related-count {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 20px;
            height: 18px;
            padding: 0 5px;
            border-radius: 9px;
            background: var(--link-dim);
            color: var(--link);
            font-size: 10.5px;
            font-weight: 700;
          }
          .npa-related-list {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .npa-related-item {
            display: flex;
          }
          .npa-related-link {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            width: 100%;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 6px;
            padding: 8px 10px;
            cursor: pointer;
            text-align: left;
            font-family: inherit;
            font-size: 13px;
            color: var(--link);
            line-height: 1.45;
            transition: background 0.15s, border-color 0.15s;
          }
          .npa-related-link:hover {
            background: var(--link-dim-hover);
            border-color: var(--link-dim);
          }
          .npa-related-link:active {
            background: var(--link-dim-active);
          }
          .npa-related-name {
            flex: 1;
            text-decoration: underline;
            text-decoration-color: var(--link-dim);
            text-underline-offset: 2px;
          }
          .npa-related-link:hover .npa-related-name {
            text-decoration-color: var(--link);
          }
        `}</style>
      </div>
    );
  }

  const items = Array.isArray(art) ? art : [art];
  if(items.length === 0) return null;

  const npaTitle = items[0].metadata?.npa_title || 'Документ';

  return (
    <div style={{height:'100%',display:'flex',flexDirection:'column',background:'var(--bg-panel)'}}>
      <div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <Ico k="book" sz={16} col="var(--accent)" />
          <span style={{fontSize:11,fontWeight:600,color:'var(--muted)',letterSpacing:'.06em',textTransform:'uppercase'}}>Просмотр НПА</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6, minWidth:0}}>
          <Ico k="book" sz={13} col="var(--accent)" grad glow/>
          <span style={{fontSize:12,fontWeight:600,color:'var(--accent)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:160}} title={npaTitle}>
            {npaTitle}
          </span>
          <NpaHeaderActions onCollapse={onCollapse} onClose={onClose}/>
        </div>
      </div>
      <div ref={scrollRef} style={{flex:1,overflowY:'auto',background:'var(--bg-panel)',padding:'12px 14px',transition:'background-color 0.3s ease'}} className="npa-viewer-content npa-content-academic">
        {items.map((item, idx) => {
          const rawText = item.content?.full_text || '';
          const lines = rawText.split('\n').filter(l => l.trim());
          const titleLine = lines[0] || ('Статья ' + item.metadata?.article_display);
          const paragraphs = lines.slice(1);
          return (
            <div key={idx} style={{marginBottom: items.length > 1 ? 40 : 0}} id={`article-${item.metadata?.article_display || idx}`}>
              {titleLine && <h3 style={{textAlign:'center',fontFamily:'"Times New Roman", Times, serif',fontWeight:'bold',marginBottom:'1em'}}>{titleLine}</h3>}
              {paragraphs.map((p, i) => <p key={i} style={{textIndent:'1.5em',fontFamily:'"Times New Roman", Times, serif',fontSize:'16px',textAlign:'justify',color:'var(--text-main)',lineHeight:'1.5',marginBottom:'0.5em',marginTop:0}}>{p}</p>)}
              {idx < items.length - 1 && <hr style={{border: 'none', borderTop: '1px dashed var(--border)', margin: '40px 0 0'}} />}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ═══ SourceList — расширенный inline-список источников НПА ═══
   Заменяет chip-бейджи: каждый источник — карточка с превью текста
   и возможностью раскрыть полный текст или открыть в модалке.
═════════════════════════════════════════════════════════════════ */
const SourceList = ({sources, metadata, onSourceClick}) => {
  const [openSet, setOpenSet] = useState(() => new Set());
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const md = Array.isArray(metadata) ? metadata : [];

  const toggle = (i) => {
    setOpenSet(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  return (
    <div className="msg-sources">
      <div className="msg-sources-title">
        <Ico k="book" sz={11} col="var(--link)"/>
        <span>Источники</span>
        <span className="msg-sources-count">{sources.length}</span>
      </div>
      <div className="msg-sources-list">
        {sources.map((src, i) => {
          const m = md[i] || {};
          const isOpen = openSet.has(i);
          const rawStr = String(src || '').trim();
          const npaTitle = (m.npa_title || '').trim() || rawStr;
          const articleTitle = (m.article_title || '').trim();
          const fullText = (m.full_text || '').trim();
          const preview = fullText
            ? (fullText.length > 240 ? fullText.slice(0, 240).trim() + '…' : fullText)
            : '';

          return (
            <div key={i} className={`src-item ${isOpen ? 'is-open' : ''}`}>
              <div className="src-item-header" onClick={() => fullText ? toggle(i) : (onSourceClick && onSourceClick(rawStr, i, null))}>
                <span className="src-item-icon"><Ico k="book" sz={10} col="var(--link)"/></span>
                <div className="src-item-title">
                  <span className="src-item-npa">{npaTitle}</span>
                  {articleTitle && <span className="src-item-art"> · {articleTitle}</span>}
                </div>
                {fullText && (
                  <span className="src-item-chev" title={isOpen ? 'Свернуть' : 'Развернуть текст'}>
                    <Ico k={isOpen ? 'chevD' : 'chevR'} sz={10}/>
                  </span>
                )}
              </div>
              {!isOpen && preview && (
                <div className="src-item-preview">{preview}</div>
              )}
              {isOpen && fullText && (
                <div className="src-item-body">
                  <div className="src-item-text">{fullText}</div>
                  {onSourceClick && (
                    <button
                      type="button"
                      className="src-item-action"
                      onClick={(e) => { e.stopPropagation(); onSourceClick(rawStr, i, null); }}
                      title="Открыть статью в режиме чтения"
                    >
                      <Ico k="book" sz={10}/> Открыть полностью
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ═══ ConfidenceBadge — показывает уверенность RAG-проверки и детали по статьям ═══ */
const ConfidenceBadge = ({conf}) => {
  const [open, setOpen] = useState(false);
  if (!conf || !conf.level) return null;
  const articles = Array.isArray(conf.articles) ? conf.articles : [];

  // Поддержка нового (per-article) и старого (group) формата payload.
  // Новый: { total, verified, notFound, mismatched, avgScore }
  // Старый: { totalArticles, foundArticles, notFoundArticles, mismatchArticles, lowConfArticles }
  const totalN    = conf.total          ?? conf.totalArticles    ?? articles.length;
  const verifiedN = conf.verified       ?? conf.foundArticles    ?? 0;
  const notFoundN = conf.notFound       ?? conf.notFoundArticles ?? 0;
  const mismatchN = conf.mismatched     ?? conf.mismatchArticles ?? 0;
  const avgScore  = conf.avgScore       ?? 0;

  const ok = articles.filter(a => a.status === 'ok');
  const mismatch = articles.filter(a => a.status === 'mismatch');
  const low = articles.filter(a => a.status === 'low');
  const notFound = articles.filter(a => a.status === 'not_found');

  const renderRow = (a, glyphType) => (
    <div key={a.ref} className="confidence-article-row" title={a.reason}>
      <span className="confidence-article-icon"><Glyph type={glyphType} sz={12}/></span>
      <span className="confidence-article-ref">{a.ref}</span>
      <span className="confidence-article-reason">{a.reason}</span>
      {a.score > 0 && <span className="confidence-article-score">{a.score.toFixed(2)}</span>}
    </div>
  );

  return (
    <div className={`confidence-wrap confidence-${conf.level}`}>
      <div
        className={`confidence-badge confidence-${conf.level}`}
        onClick={() => setOpen(o => !o)}
        role="button"
        tabIndex={0}
        title={`Avg score: ${avgScore} · клик для деталей`}
      >
        {conf.level === 'high' && <><Ico k="check" sz={11}/> Анализ подтверждён базой НПА</>}
        {conf.level === 'medium' && <><Ico k="settings" sz={11}/> Частично подтверждено — проверьте ⚠️ статьи</>}
        {conf.level === 'low' && <><Ico k="x" sz={11}/> Слабое совпадение — перепроверьте источники</>}
        <span className="confidence-stats">
          {verifiedN}/{totalN}
          {mismatchN > 0 && ` · ⚠️ ${mismatchN}`}
          {notFoundN > 0 && ` · ❌ ${notFoundN}`}
        </span>
        {articles.length > 0 && (
          <span className="confidence-toggle">
            <Ico k={open ? 'chevD' : 'chevR'} sz={10}/> {open ? 'скрыть' : 'детали'}
          </span>
        )}
      </div>

      {open && articles.length > 0 && (
        <div className="confidence-details">
          {ok.length > 0 && (
            <div className="confidence-details-group">
              <div className="confidence-details-group-title">
                <Glyph type="check" sz={12}/> Подтверждено в базе ({ok.length})
              </div>
              {ok.map(a => renderRow(a, 'check'))}
            </div>
          )}
          {mismatch.length > 0 && (
            <div className="confidence-details-group">
              <div className="confidence-details-group-title">
                <Glyph type="warn" sz={12}/> Номер не совпал ({mismatch.length}) — возможно устаревшая редакция
              </div>
              {mismatch.map(a => renderRow(a, 'warn'))}
            </div>
          )}
          {low.length > 0 && (
            <div className="confidence-details-group">
              <div className="confidence-details-group-title">
                <Glyph type="warn" sz={12}/> Низкая уверенность ({low.length}) — требует ручной проверки
              </div>
              {low.map(a => renderRow(a, 'warn'))}
            </div>
          )}
          {notFound.length > 0 && (
            <div className="confidence-details-group">
              <div className="confidence-details-group-title">
                <Glyph type="error" sz={12}/> Не найдено в базе ({notFound.length})
              </div>
              {notFound.map(a => renderRow(a, 'error'))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SegmentReport — таблица результатов проверки документа по пунктам.
   Гибридный pipeline отдаёт два отчёта: ConfidenceBadge (по статьям)
   и этот — по пунктам/разделам, даже если в документе не было статей.
   ═══════════════════════════════════════════════════════════════ */
const ProtocolReport = ({ tableRows, purityIndex }) => {
  const [expandedIds, setExpandedIds] = useState({});
  if (!tableRows || tableRows.length === 0) return null;

  const toggleRow = (id) => setExpandedIds(p => ({...p, [id]: !p[id]}));

  return (
    <div style={{ marginTop: 16 }}>
      {purityIndex !== undefined && (
        <div className={`purity-index-badge ${purityIndex >= 90 ? 'green' : purityIndex >= 70 ? 'orange' : 'red'}`}>
          <Glyph type={purityIndex >= 90 ? 'check' : purityIndex >= 70 ? 'warn' : 'error'} sz={16}/>
          Индекс правовой чистоты документа: {purityIndex}%
        </div>
      )}
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-main)', marginBottom: 8 }}>
        Протокол соответствия НПА
      </div>
      <table className="analyze-table">
        <tbody>
          {tableRows.map((row, i) => {
            const expanded = !!expandedIds[i];
            const hasDetails = !!row.legal_rationale;
            const icon = row.status === 'ok' ? '✅' : row.status === 'warning' ? '⚠️' : '❌';
            return (
              <React.Fragment key={i}>
                <tr className={`analyze-row ${expanded ? 'expanded' : ''}`} onClick={() => hasDetails && toggleRow(i)}>
                  <td className="analyze-cell analyze-cell-icon">{icon}</td>
                  <td className="analyze-cell analyze-cell-num">{row.item_number}</td>
                  <td className="analyze-cell analyze-cell-verdict">{row.short_verdict}</td>
                </tr>
                {hasDetails && (
                  <tr style={{ display: expanded ? 'table-row' : 'none' }}>
                    <td colSpan="3" style={{ padding: 0 }}>
                      <div className="analyze-accordion-content" style={{ display: 'block' }}>
                        <div className="analyze-accordion-title">Юридическое обоснование (Ищейки + Юрист)</div>
                        <div>{row.legal_rationale}</div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   AntiGravityTracker — панель токен-телеметрии (рендерится в drawer-е слева).
   Принимает sessionStats (агрегированные данные сессии) + таймеры запросов.
   ═══════════════════════════════════════════════════════════════ */
const AntiGravityTracker = ({sessionStats, timing, onClose, onReset}) => {
  const [showBreakdown, setShowBreakdown] = useState(true);
  const hasStats = sessionStats && sessionStats.totalCalls > 0;
  const hasTiming = timing && (timing.running || timing.lastWallSec > 0);
  if (!hasStats && !hasTiming) {
    // Пустое состояние — показываем подсказку вместо пустого виджета.
    return (
      <div className="ag-empty">
        <div className="ag-empty-ico">📊</div>
        <div className="ag-empty-title">Телеметрия пуста</div>
        <div className="ag-empty-hint">Задайте вопрос или запустите анализ — здесь появится статистика по моделям, токенам и времени ответа.</div>
      </div>
    );
  }
  const fmtTok = (n) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);
  const fmtSec = (n) => {
    if (!n || n < 0) return '0.0';
    return n < 10 ? n.toFixed(1) : n.toFixed(0);
  };

  // Короткое имя модели для отображения (gemini-3-flash-preview → 3-flash)
  const shortName = (m) => {
    if (!m) return '—';
    return String(m)
      .replace(/^models\//, '')
      .replace(/^gemini-/, '')
      .replace(/-preview$/, '')
      .replace(/^deepseek-/, 'ds-');
  };
  // Бейдж тира по имени модели — визуальная подсказка кто есть кто
  const tierBadge = (m) => {
    if (!m) return null;
    const s = String(m);
    if (s.includes('deepseek-v4-pro'))   return {label:'JUDGE',    color:'#a855f7'};
    if (s.includes('deepseek'))          return {label:'WORKER',   color:'#0ea5e9'};
    if (s.includes('flash-lite'))        return {label:'WORKER',   color:'#0ea5e9'};
    if (s.includes('2.5-flash') || s.includes('flash-latest')) return {label:'FALLBACK', color:'#64748b'};
    if (s.includes('flash'))             return {label:'SENIOR',   color:'#10b981'};
    if (s.includes('embedding'))         return {label:'EMBED',    color:'#94a3b8'};
    return null;
  };

  // Сортируем модели по убыванию стоимости — самые дорогие первыми
  const modelEntries = Object.entries(sessionStats.perModel || {})
    .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));

  return (
    <div className="ag-panel" role="status" aria-label="Token Telemetry">
      <div className="ag-head">
        <span className="ag-head-title" style={{display:'inline-flex',alignItems:'center',gap:6}}><Ico k="rocket" sz={14} col="var(--accent)" /> Телеметрия моделей</span>
        <div style={{display:'flex', gap:6}}>
          {onReset && <button type="button" className="ag-btn" onClick={onReset} title="Сбросить счётчик">↻</button>}
          {onClose && <button type="button" className="ag-btn" onClick={onClose} title="Закрыть панель">×</button>}
        </div>
      </div>

      {/* ── Таймеры последнего/текущего запроса ───────────────────── */}
      {hasTiming && (
        <div className="ag-timer-block">
          <div className="ag-timer-row">
            <span className="ag-timer-label">
              <span className="ag-timer-ico"><Ico k="clock" sz={13} col="inherit" /></span> Полное ожидание
              {timing.running && <span className="ag-live-dot" aria-label="идёт запрос" />}
            </span>
            <span className={`ag-timer-val ${timing.running ? 'live' : ''}`}>
              {fmtSec(timing.running ? timing.liveSec : timing.lastWallSec)}<small>с</small>
            </span>
          </div>
          <div className="ag-timer-row">
            <span className="ag-timer-label">
              <span className="ag-timer-ico"><Ico k="brain" sz={13} col="inherit" /></span> Время моделей
            </span>
            <span className="ag-timer-val secondary">
              {fmtSec(timing.lastModelSec)}<small>с</small>
            </span>
          </div>
          {!timing.running && timing.lastWallSec > 0 && timing.lastModelSec > 0 && (
            <div className="ag-timer-meta">
              Сетевые/RTT расходы: {fmtSec(Math.max(0, timing.lastWallSec - timing.lastModelSec))}с
            </div>
          )}
        </div>
      )}

      {hasStats && (
        <>
          {sessionStats.lastModel && (
            <>
              <div className="ag-row"><span>Последний запрос:</span><span style={{fontFamily:'var(--font-mono)'}}>{sessionStats.lastLabel || '—'}</span></div>
              <div className="ag-row">
                <span>Модель:</span>
                <span style={{display:'flex',alignItems:'center',gap:6,fontFamily:'var(--font-mono)',fontSize:'11px'}}>
                  {tierBadge(sessionStats.lastModel) && (
                    <span style={{background:tierBadge(sessionStats.lastModel).color,color:'#fff',padding:'1px 6px',borderRadius:4,fontSize:'9px',fontWeight:600}}>
                      {tierBadge(sessionStats.lastModel).label}
                    </span>
                  )}
                  {shortName(sessionStats.lastModel)}
                </span>
              </div>
              <div className="ag-row"><span>Вход (prompt):</span><span>{fmtTok(sessionStats.lastInput)} tok</span></div>
              <div className="ag-row"><span>Выход (gen):</span><span>{fmtTok(sessionStats.lastOutput)} tok</span></div>
              <div className="ag-row"><span>Цена запроса:</span><span>${(sessionStats.lastCost || 0).toFixed(5)}</span></div>
            </>
          )}

          {modelEntries.length > 1 && (
            <>
              <div className="ag-breakdown-toggle" onClick={()=>setShowBreakdown(v=>!v)} role="button" tabIndex={0}>
                <span style={{display:'inline-flex',alignItems:'center',gap:6}}><Ico k="activity" sz={13} /> По моделям ({modelEntries.length})</span>
                <span>{showBreakdown ? '▼' : '▶'}</span>
              </div>
              {showBreakdown && (
                <div className="ag-breakdown">
                  {modelEntries.map(([model, stats]) => {
                    const badge = tierBadge(model);
                    return (
                      <div key={model} className="ag-model-row">
                        <div className="ag-model-name">
                          {badge && (
                            <span className="ag-tier-badge" style={{background:badge.color}}>{badge.label}</span>
                          )}
                          <span>{shortName(model)}</span>
                        </div>
                        <div className="ag-model-stats">
                          <span>{stats.calls}× · {fmtTok(stats.input + stats.output)}t</span>
                          <span className="ag-model-cost">${(stats.cost || 0).toFixed(4)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <div className="ag-row"><span>Всего вызовов:</span><span>{sessionStats.totalCalls}</span></div>
          <div className="ag-row"><span>Всего токенов:</span><span>{fmtTok(sessionStats.totalInput + sessionStats.totalOutput)}</span></div>
          <div className="ag-row ag-total">
            <span>СЖЕЧЕНО ЗА СЕССИЮ:</span>
            <span>${(sessionStats.totalCost || 0).toFixed(4)}</span>
          </div>
        </>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   LeftTelemetryDrawer — выдвижная панель слева + таб-кнопка на краю.
   Закрыт по умолчанию: торчит только узкий таб с пиктограммой.
   Клик по табу → панель выезжает; клик по × или Esc → прячется.
   Показывает компактный live-индикатор времени даже когда закрыт.
   ═══════════════════════════════════════════════════════════════ */
const LeftTelemetryDrawer = ({open, onToggle, sessionStats, timing, onReset, onHide}) => {
  // Esc закрывает drawer когда он открыт
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onToggle(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onToggle]);

  const liveSec = timing && timing.running ? timing.liveSec : 0;
  const lastSec = timing && !timing.running ? timing.lastWallSec : 0;
  const tabBadge = liveSec > 0 ? liveSec.toFixed(1) : (lastSec > 0 ? lastSec.toFixed(1) : null);
  const calls = sessionStats?.totalCalls || 0;

  return (
    <>
      {/* Таб-кнопка — всегда видна на левом краю */}
      <button
        type="button"
        className={`ag-left-tab ${open ? 'open' : ''} ${timing?.running ? 'pulsing' : ''}`}
        onClick={() => onToggle(!open)}
        title={open ? 'Свернуть телеметрию (Esc)' : 'Открыть телеметрию'}
        aria-expanded={open}
        aria-label="Телеметрия моделей"
      >
        <span className="ag-tab-ico">📊</span>
        <span className="ag-tab-text">Телеметрия</span>
        {tabBadge && (
          <span className={`ag-tab-badge ${timing?.running ? 'live' : ''}`}>
            {tabBadge}<small>с</small>
          </span>
        )}
        {calls > 0 && !tabBadge && (
          <span className="ag-tab-badge">{calls}×</span>
        )}
      </button>

      {/* Выдвижная панель */}
      <aside className={`ag-left-drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <AntiGravityTracker
          sessionStats={sessionStats}
          timing={timing}
          onReset={onReset}
          onClose={onHide}
        />
      </aside>

      {/* Полупрозрачный backdrop для клика-вне (только когда открыто) */}
      {open && <div className="ag-drawer-backdrop" onClick={() => onToggle(false)} aria-hidden="true" />}
    </>
  );
};

/* ═══════════════════════════════════════════════════════════════
   DeepAnalyzeModal — конфигурация запуска premium-анализа.
   Юрист выбирает:
   • Перспективу (наш / против нас / нейтральный аудит)
   • Какие модули запустить (Аудитор, Стратег, Драфтер, Ментор)
   ═══════════════════════════════════════════════════════════════ */
const DeepAnalyzeModal = ({open, hasDocument, defaultPerspective='audit', onClose, onRun}) => {
  const dialogRef = useRef(null);
  const [persp, setPersp] = useState(defaultPerspective);
  const [mods, setMods] = useState({audit:true, strategy:true, drafter:false, mentor:false});
  useFocusTrap(open, dialogRef);

  useEffect(() => { if (open) setPersp(defaultPerspective || 'audit'); }, [open, defaultPerspective]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const perspectives = [
    {id:'ours',     label:'Наш документ',     hint:'Защищаем нашего клиента'},
    {id:'opponent', label:'Против нас',       hint:'Документ оппонента, ищем атаку'},
    {id:'audit',    label:'Аудит',            hint:'Нейтральная экспертиза'}
  ];

  const moduleList = [
    {id:'audit',    label:'Аудитор',  desc:'Red flags, коллизии, проц.дефекты, фактчек',  icon:'law'},
    {id:'strategy', label:'Стратег',  desc:'Тепловая карта + контраргументы со статьями', icon:'split'},
    {id:'drafter',  label:'Драфтер',  desc:'Готовит отзыв / возражение / меморандум',     icon:'file'},
    {id:'mentor',   label:'Ментор',   desc:'Атаки оппонента + вопросы суда (спарринг)',   icon:'book'}
  ];

  const selectedMods = Object.entries(mods).filter(([_,v])=>v).map(([k])=>k);
  const canRun = hasDocument && selectedMods.length > 0;

  const handleRun = () => {
    if (!canRun) return;
    onRun && onRun({perspective: persp, modules: selectedMods});
  };

  return (
    <div className="art-modal-overlay" onClick={onClose} role="presentation">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Глубокий анализ (PRO)" onClick={e=>e.stopPropagation()}
           style={{width:'min(560px, 92vw)', background:'var(--bg-panel)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', boxShadow:'var(--shadow-lg)', display:'flex', flexDirection:'column', maxHeight:'88vh', overflow:'hidden', fontFamily:'var(--font-sans)', animation:'fadeInScale .14s ease'}}>
        <div style={{display:'flex', alignItems:'center', gap:'var(--s-3)', padding:'var(--s-4) var(--s-4)', borderBottom:'1px solid var(--border)'}}>
          <div style={{width:40, height:40, borderRadius:'var(--radius)', background:'linear-gradient(135deg, var(--accent-dim), var(--accent-soft, var(--hover)))', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
            <Ico k="law" sz={20} col="var(--accent)" grad glow/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:'var(--text-md)', fontWeight:600, color:'var(--text)', letterSpacing:'-.01em'}}>Глубокий анализ <span style={{color:'var(--accent)', fontFamily:'var(--font-mono)', fontSize:'var(--text-xs)', marginLeft:'var(--s-1h)', letterSpacing:'.05em'}}>PRO</span></div>
            <div style={{fontSize:'var(--text-xs)', color:'var(--muted)', marginTop:2}}>Мульти-агентный разбор: Аудитор + Стратег + Драфтер + Ментор</div>
          </div>
          <button onClick={onClose} title="Закрыть" style={{width:30, height:30, border:'1px solid var(--border)', background:'var(--hover)', borderRadius:'var(--radius-sm)', cursor:'pointer', color:'var(--text)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
            <Ico k="x" sz={14}/>
          </button>
        </div>

        <div style={{overflowY:'auto', padding:'var(--s-4)', display:'flex', flexDirection:'column', gap:'var(--s-4)'}}>
          {!hasDocument && (
            <div style={{padding:'var(--s-3)', border:'1px solid var(--yellow, #f59e0b)', background:'var(--yellow-soft, rgba(245,158,11,.08))', borderRadius:'var(--radius)', fontSize:'var(--text-sm)', color:'var(--text)', display:'flex', alignItems:'flex-start', gap:'var(--s-2)'}}>
              <Ico k="warning" sz={16} col="var(--yellow, #f59e0b)"/>
              <span>Откройте документ в редакторе или прикрепите файл — без документа глубокий анализ не запускается.</span>
            </div>
          )}

          <div>
            <div style={{fontSize:'var(--text-xs)', fontFamily:'var(--font-mono)', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'var(--s-2)'}}>Перспектива анализа</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'var(--s-2)'}}>
              {perspectives.map(p => {
                const active = persp === p.id;
                return (
                  <button key={p.id} type="button" onClick={()=>setPersp(p.id)}
                          style={{textAlign:'left', padding:'var(--s-2h)', border:'1px solid '+(active?'var(--accent)':'var(--border)'), background:active?'var(--accent-dim)':'var(--bg-bar)', borderRadius:'var(--radius)', cursor:'pointer', transition:'all .15s', display:'flex', flexDirection:'column', gap:2}}>
                    <span style={{fontSize:'var(--text-sm)', fontWeight:600, color:active?'var(--accent-strong, var(--accent))':'var(--text)'}}>{p.label}</span>
                    <span style={{fontSize:'var(--text-xs)', color:'var(--muted)'}}>{p.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{fontSize:'var(--text-xs)', fontFamily:'var(--font-mono)', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'var(--s-2)'}}>Модули</div>
            <div style={{display:'flex', flexDirection:'column', gap:'var(--s-1h)'}}>
              {moduleList.map(mod => {
                const active = !!mods[mod.id];
                return (
                  <label key={mod.id}
                         style={{display:'flex', alignItems:'flex-start', gap:'var(--s-2h)', padding:'var(--s-2h)', border:'1px solid '+(active?'var(--accent)':'var(--border)'), background:active?'var(--accent-dim)':'var(--bg-bar)', borderRadius:'var(--radius)', cursor:'pointer', transition:'all .15s'}}>
                    <input type="checkbox" checked={active} onChange={e=>setMods(m=>({...m, [mod.id]:e.target.checked}))}
                           style={{accentColor:'var(--accent)', cursor:'pointer', marginTop:2, width:14, height:14, flexShrink:0}}/>
                    <div style={{width:24, height:24, borderRadius:'var(--radius-sm)', background:active?'var(--accent-soft, var(--hover))':'var(--hover)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0}}>
                      <Ico k={mod.icon} sz={12} col={active?'var(--accent)':'var(--muted)'}/>
                    </div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:'var(--text-sm)', fontWeight:600, color:'var(--text)'}}>{mod.label}</div>
                      <div style={{fontSize:'var(--text-xs)', color:'var(--muted)', marginTop:1, lineHeight:'var(--lh-snug)'}}>{mod.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div style={{fontSize:'var(--text-xs)', color:'var(--muted)', marginTop:'var(--s-2)', lineHeight:'var(--lh-snug)'}}>
              Совет: Аудитор + Стратег обязательны для базы. Драфтер и Ментор увеличивают время и стоимость анализа.
            </div>
          </div>
        </div>

        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'var(--s-2)', padding:'var(--s-3) var(--s-4)', borderTop:'1px solid var(--border)', background:'var(--bg-bar)'}}>
          <span style={{fontSize:'var(--text-xs)', color:'var(--muted)', fontFamily:'var(--font-mono)'}}>
            {selectedMods.length === 0 ? 'Выберите модули' : `Выбрано: ${selectedMods.length} из 4`}
          </span>
          <div style={{display:'flex', gap:'var(--s-2)'}}>
            <button onClick={onClose} className="btn" style={{padding:'var(--s-1h) var(--s-3)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', background:'var(--hover)', color:'var(--text)', cursor:'pointer', fontSize:'var(--text-sm)', fontFamily:'var(--font-sans)'}}>Отмена</button>
            <button onClick={handleRun} disabled={!canRun}
                    style={{padding:'var(--s-1h) var(--s-3h)', border:'none', borderRadius:'var(--radius-sm)', background: canRun ? 'linear-gradient(135deg, var(--accent), var(--accent2))' : 'var(--border)', color: canRun ? '#fff' : 'var(--muted)', cursor: canRun ? 'pointer' : 'not-allowed', fontSize:'var(--text-sm)', fontWeight:600, fontFamily:'var(--font-sans)', display:'flex', alignItems:'center', gap:'var(--s-1h)', boxShadow: canRun ? '0 1px 3px var(--accent-glow)' : 'none'}}>
              <Ico k="law" sz={14} col={canRun?'#fff':'var(--muted)'}/>
              Запустить анализ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   DeepAnalysisReport — финальный отчёт мульти-агентного анализа.
   Раскладывает payload Senior Partner на 4 интерактивные вкладки:
   🔴 Аудит и Риски   — red flags, коллизии, процессуальные ошибки
   ♟️ Стратегия       — тепловая карта пунктов, контраргументы, вердикт
   📝 Проекты         — готовые драфты (отзыв/возражение/претензия)
   🥷 Симулятор       — каверзные вопросы оппонента и судьи

   Ожидаемая форма payload (от Senior Partner):
   {
     perspective: 'ours' | 'opponent' | 'audit',
     audit:    { redFlags:[...], collisions:[...], procIssues:[...], factSummary?: string },
     strategy: { heatmap:[...], counterArgs:[...], verdict?: string },
     drafter:  { type, content } | null,
     mentor:   { opponent:[...], judge:[...] } | null
   }
   ═══════════════════════════════════════════════════════════════ */
const DeepAnalysisReport = ({report, onInsertDraft}) => {
  const [activeTab, setActiveTab] = useState('audit');
  if (!report) return null;

  const audit    = report.audit    || {};
  const strategy = report.strategy || {};
  const drafter  = report.drafter  || null;
  const mentor   = report.mentor   || null;

  const counts = {
    audit:    (audit.redFlags?.length||0) + (audit.collisions?.length||0) + (audit.procIssues?.length||0),
    strategy: (strategy.heatmap?.length||0),
    drafts:   drafter && drafter.body ? 1 : 0,
    mentor:   (mentor?.attacks?.length||0) + (mentor?.judgeQuestions?.length||0)
  };

  const PERSP_LABEL = {
    ours:     {text: 'Защищаем нашу позицию', glyph: 'check',   tone: 'good'},
    opponent: {text: 'Документ против нас',   glyph: 'warn',    tone: 'warn'},
    audit:    {text: 'Нейтральный аудит',      glyph: 'search',  tone: 'info'}
  };
  const persp = PERSP_LABEL[report.perspective] || null;

  const tabs = [
    {id:'audit',    label:'Аудит и Риски', glyph:'warn',     count: counts.audit},
    {id:'strategy', label:'Стратегия',     glyph:'scale',    count: counts.strategy},
    {id:'drafts',   label:'Проекты',       glyph:'edit',     count: counts.drafts},
    {id:'mentor',   label:'Симулятор',     glyph:'sparkles', count: counts.mentor}
  ].filter(t => t.count > 0 || t.id === 'audit'); // пустые вкладки скрываем, audit всегда первый

  return (
    <div className="deep-report">
      <div className="deep-report-head">
        <div className="deep-report-title">
          <Glyph type="scale" sz={14}/>
          <span>Глубокий анализ</span>
          {report.docType && <span className="deep-report-doctype">· {report.docType}</span>}
        </div>
        {persp && (
          <span className={`deep-report-persp deep-report-persp-${persp.tone}`}>
            <Glyph type={persp.glyph} sz={11}/>{persp.text}
          </span>
        )}
      </div>

      <div className="deep-tabs" role="tablist" aria-label="Разделы отчёта">
        {tabs.map(t => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(t.id)}
              className={`deep-tab ${active?'is-active':''}`}
            >
              <Glyph type={t.glyph} sz={12}/>
              <span>{t.label}</span>
              {t.count > 0 && <span className="deep-tab-count">{t.count}</span>}
            </button>
          );
        })}
      </div>

      <div className="deep-tab-body">
        {activeTab === 'audit'    && <DeepAuditPanel data={audit}/>}
        {activeTab === 'strategy' && <DeepStrategyPanel data={strategy}/>}
        {activeTab === 'drafts'   && <DeepDraftsPanel data={drafter} onInsert={onInsertDraft}/>}
        {activeTab === 'mentor'   && <DeepMentorPanel data={mentor}/>}
      </div>
    </div>
  );
};

/* ─── AUDIT PANEL ──────────────────────────────────────────────── */
const DeepAuditPanel = ({data}) => {
  const {factSummary, redFlags=[], collisions=[], procIssues=[]} = data || {};
  if (!factSummary && redFlags.length===0 && collisions.length===0 && procIssues.length===0) {
    return <div className="deep-empty">Аудит ещё не сформирован.</div>;
  }
  const SEV = {
    high:   {label:'высокий',  bg:'var(--red-soft)',    ink:'var(--red-ink, var(--red))',       glyph:'error'},
    medium: {label:'средний',  bg:'var(--orange-soft)', ink:'var(--orange-ink, var(--orange))', glyph:'warn'},
    low:    {label:'низкий',   bg:'var(--info-soft)',   ink:'var(--info-ink, var(--info))',     glyph:'info'}
  };
  return (
    <div className="deep-sect-list">
      {factSummary && (
        <div className="deep-card deep-card-summary">
          <div className="deep-card-head"><Glyph type="check" sz={12}/><span>Фактчек статей</span></div>
          <div className="deep-card-body" dangerouslySetInnerHTML={{__html: renderMarkdown(factSummary)}}/>
        </div>
      )}

      {redFlags.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="error" sz={12}/>
            <span>Red Flags</span>
            <span className="deep-sect-count">{redFlags.length}</span>
          </div>
          <div className="deep-rows">
            {redFlags.map((rf, i) => {
              const sev = SEV[rf.severity] || SEV.medium;
              return (
                <div key={i} className="deep-row">
                  <span className="deep-row-badge" style={{background:sev.bg, color:sev.ink}}>
                    <Glyph type={sev.glyph} sz={10}/>{sev.label}
                  </span>
                  <div className="deep-row-body">
                    <div className="deep-row-title">{rf.title}</div>
                    {rf.quote && <div className="deep-row-quote">«{rf.quote}»</div>}
                    {rf.suggestion && <div className="deep-row-sugg"><Glyph type="edit" sz={11}/>{rf.suggestion}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {collisions.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="warn" sz={12}/>
            <span>Внутренние коллизии</span>
            <span className="deep-sect-count">{collisions.length}</span>
          </div>
          <div className="deep-rows">
            {collisions.map((c, i) => (
              <div key={i} className="deep-row">
                <span className="deep-row-badge" style={{background:'var(--orange-soft)', color:'var(--orange-ink, var(--orange))'}}>
                  <Glyph type="warn" sz={10}/>{c.severity || 'противоречие'}
                </span>
                <div className="deep-row-body">
                  <div className="deep-row-title">
                    {c.refA && c.refB
                      ? <>{c.refA} ↔ {c.refB}</>
                      : 'Противоречие в документе'}
                  </div>
                  {c.description && <div className="deep-row-text">{c.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {procIssues.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="list" sz={12}/>
            <span>Процессуальные дефекты</span>
            <span className="deep-sect-count">{procIssues.length}</span>
          </div>
          <div className="deep-rows">
            {procIssues.map((p, i) => (
              <div key={i} className="deep-row">
                <span className="deep-row-badge" style={{background:'var(--info-soft)', color:'var(--info-ink, var(--info))'}}>
                  <Glyph type="info" sz={10}/>{p.type || 'дефект'}
                </span>
                <div className="deep-row-body">
                  <div className="deep-row-title">{p.title || p.description}</div>
                  {p.title && p.description && <div className="deep-row-text">{p.description}</div>}
                  {p.deadline && <div className="deep-row-meta"><Ico k="clock" sz={11} style={{verticalAlign:'-1.5px',marginRight:4}} />{p.deadline}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ─── STRATEGY PANEL ──────────────────────────────────────────── */
const DeepStrategyPanel = ({data}) => {
  const {verdict, heatmap=[], counterArgs=[]} = data || {};
  if (!verdict && heatmap.length===0 && counterArgs.length===0) {
    return <div className="deep-empty">Стратегия ещё не сформирована.</div>;
  }
  const HEAT = {
    strong: {bg:'var(--green-soft)',  ink:'var(--green-ink, var(--green))',     dot:'var(--green)',  label:'сильная позиция'},
    neutral:{bg:'var(--accent-soft)', ink:'var(--accent-strong)',                dot:'var(--accent)', label:'нейтрально'},
    risk:   {bg:'var(--orange-soft)', ink:'var(--orange-ink, var(--orange))',   dot:'var(--orange)', label:'риск'},
    threat: {bg:'var(--red-soft)',    ink:'var(--red-ink, var(--red))',         dot:'var(--red)',    label:'угроза'},
    bluff:  {bg:'var(--info-soft)',   ink:'var(--info-ink, var(--info))',       dot:'var(--info)',   label:'блеф'}
  };
  const [hoverIdx, setHoverIdx] = useState(null);
  return (
    <div className="deep-sect-list">
      {verdict && (
        <div className="deep-card deep-card-verdict">
          <div className="deep-card-head"><Glyph type="scale" sz={12}/><span>Оценка позиции</span></div>
          <div className="deep-card-body" dangerouslySetInnerHTML={{__html: renderMarkdown(verdict)}}/>
        </div>
      )}

      {heatmap.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="chart" sz={12}/>
            <span>Тепловая карта пунктов</span>
            <span className="deep-sect-count">{heatmap.length}</span>
          </div>
          <div className="deep-heatmap" role="list">
            {heatmap.map((h, i) => {
              const tone = HEAT[h.tone] || HEAT.neutral;
              return (
                <div
                  key={i}
                  role="listitem"
                  className="deep-heat-cell"
                  style={{background:tone.bg, color:tone.ink}}
                  onMouseEnter={() => setHoverIdx(i)}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <span className="deep-heat-dot" style={{background:tone.dot}}/>
                  <span className="deep-heat-num">п.{h.number || (i+1)}</span>
                  <span className="deep-heat-heading">{h.heading || h.label || tone.label}</span>
                </div>
              );
            })}
          </div>
          {hoverIdx != null && heatmap[hoverIdx]?.comment && (
            <div className="deep-heat-detail">
              <Glyph type={HEAT[heatmap[hoverIdx].tone]?.glyph || 'info'} sz={11}/>
              <span>{heatmap[hoverIdx].comment}</span>
            </div>
          )}
          <div className="deep-heat-legend">
            {Object.entries(HEAT).map(([k, v]) => (
              <span key={k} className="deep-heat-legend-item">
                <span className="deep-heat-dot" style={{background:v.dot}}/>{v.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {counterArgs.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="scale" sz={12}/>
            <span>Контраргументы</span>
            <span className="deep-sect-count">{counterArgs.length}</span>
          </div>
          <div className="deep-rows">
            {counterArgs.map((c, i) => (
              <div key={i} className="deep-row deep-row-counter">
                <div className="deep-counter-threat">
                  <span className="deep-counter-label">Угроза:</span>
                  <span>{c.threat}</span>
                </div>
                <div className="deep-counter-norm">
                  <span className="deep-counter-label">Перекрывает:</span>
                  <span>{c.citation || c.norm}</span>
                </div>
                {c.argument && <div className="deep-row-text">{c.argument}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ─── DRAFTS PANEL ────────────────────────────────────────────── */
const DeepDraftsPanel = ({data, onInsert}) => {
  const [copied, setCopied] = useState(false);
  if (!data || !data.body) {
    return <div className="deep-empty">Драфт пока не сгенерирован. Запустите блок «Драфтер» в настройках анализа.</div>;
  }
  const copy = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(data.body); } catch {}
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="deep-sect-list">
      <div className="deep-card deep-card-draft">
        <div className="deep-card-head">
          <Glyph type="edit" sz={12}/>
          <span>{data.title || 'Проект документа'}</span>
          <div className="deep-card-actions">
            <button type="button" className="deep-btn-mini" onClick={copy} title="Скопировать">
              <Glyph type={copied?'check':'file'} sz={11}/>{copied?'Скопировано':'Копировать'}
            </button>
            {onInsert && (
              <button type="button" className="deep-btn-mini deep-btn-primary" onClick={()=>onInsert(data.body)} title="Вставить в редактор">
                <Glyph type="edit" sz={11}/>Вставить
              </button>
            )}
          </div>
        </div>
        <div className="deep-card-body deep-draft-body" dangerouslySetInnerHTML={{__html: renderMarkdown(data.body)}}/>
        {Array.isArray(data.notes) && data.notes.length > 0 && (
          <div className="deep-card-notes" style={{padding:'var(--s-2h) var(--s-3)', borderTop:'1px solid var(--border)', background:'var(--bg-bar)'}}>
            <div style={{fontSize:'var(--text-xs)', fontFamily:'var(--font-mono)', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'var(--s-1h)'}}>Заметки для юриста</div>
            <ul style={{margin:0, paddingLeft:'var(--s-4)', display:'flex', flexDirection:'column', gap:'var(--s-1)'}}>
              {data.notes.map((n, i) => (
                <li key={i} style={{fontSize:'var(--text-sm)', color:'var(--text)', lineHeight:'var(--lh-snug)'}}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── MENTOR PANEL ────────────────────────────────────────────── */
const DeepMentorPanel = ({data}) => {
  const attacks = data?.attacks || [];
  const judgeQs = data?.judgeQuestions || [];
  if (attacks.length === 0 && judgeQs.length === 0) {
    return <div className="deep-empty">Симулятор оппонента ещё не запущен.</div>;
  }
  return (
    <div className="deep-sect-list">
      {attacks.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="warn" sz={12}/>
            <span>Атаки оппонента</span>
            <span className="deep-sect-count">{attacks.length}</span>
          </div>
          <div className="deep-rows">
            {attacks.map((a, i) => (
              <div key={i} className="deep-row deep-row-mentor">
                <span className="deep-row-badge" style={{background:'var(--red-soft)', color:'var(--red-ink, var(--red))'}}>оппонент</span>
                <div className="deep-row-body">
                  <div className="deep-row-title">{a.attack}</div>
                  {a.weakSpot    && <div className="deep-row-text">⚡ Уязвимость: {a.weakSpot}</div>}
                  {a.ourResponse && <div className="deep-row-sugg"><Glyph type="check" sz={11}/>Ответ: {a.ourResponse}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {judgeQs.length > 0 && (
        <div className="deep-sect">
          <div className="deep-sect-title">
            <Glyph type="scale" sz={12}/>
            <span>Вопросы судьи</span>
            <span className="deep-sect-count">{judgeQs.length}</span>
          </div>
          <div className="deep-rows">
            {judgeQs.map((q, i) => (
              <div key={i} className="deep-row deep-row-mentor">
                <span className="deep-row-badge" style={{background:'var(--info-soft)', color:'var(--info-ink, var(--info))'}}>судья</span>
                <div className="deep-row-body">
                  <div className="deep-row-title">{q.question}</div>
                  {q.whyAsked        && <div className="deep-row-meta">Почему спросит: {q.whyAsked}</div>}
                  {q.suggestedAnswer && <div className="deep-row-sugg"><Glyph type="check" sz={11}/>Рекомендуемый ответ: {q.suggestedAnswer}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   ThinkingBox — коллапсируемый stepper "мыслей" агента над финальным
   markdown-ответом. Шаги {id, status, text, reason?, score?} приходят
   из SSE: появление = loading со spinner; обновление того же id =
   success/warning/error. Автосворот при первом content-чанке.
   ═══════════════════════════════════════════════════════════════ */
const ThinkingBox = ({steps, collapsed, onToggle, running, doneLabel, onStop}) => {
  const bodyRef = useRef(null);
  const [maxH, setMaxH] = useState(0);

  useEffect(() => {
    if (!bodyRef.current) return;
    if (collapsed) { setMaxH(0); return; }
    setMaxH(bodyRef.current.scrollHeight);
  }, [collapsed, steps.length]);

  if (!steps || steps.length === 0) return null;

  const total = steps.length;
  const completed = steps.filter(s => s.status !== 'loading').length;
  const ok = steps.filter(s => s.status === 'success').length;
  const showProgress = running && total > 0;

  const renderIcon = (status) => {
    const box = {width:14,height:14,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0};
    if (status === 'loading') return (
      <span style={{...box}}>
        <svg width="11" height="11" viewBox="0 0 24 24" style={{animation:'spin 0.9s linear infinite'}} aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeOpacity=".22"/>
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/>
        </svg>
      </span>
    );
    if (status === 'success') return <span style={{...box, color:'var(--green, #10a37f)'}}><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
    if (status === 'warning') return <span style={{...box, color:'var(--orange, #d97706)'}}><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v9M12 17.5v.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/></svg></span>;
    return <span style={{...box, color:'var(--red, #dc2626)'}}><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/></svg></span>;
  };

  return (
    <div className="think-box">
      <button
        type="button"
        className="think-header"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span className="think-header-icon">
          {running
            ? <svg width="12" height="12" viewBox="0 0 24 24" style={{animation:'spin 0.9s linear infinite'}} aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeOpacity=".22"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>
            : <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
        </span>
        <span className="think-header-text">
          {running
            ? `Проверка статей в базе${showProgress ? ` (${completed}/${total})` : '...'}`
            : (doneLabel || `Проверка завершена (${ok}/${total})`)}
        </span>
        <span className="think-header-chev" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" style={{transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition:'transform .2s ease'}}>
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        {running && onStop && (
          <span
            role="button"
            tabIndex={0}
            className="think-header-stop"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onStop(); } }}
          >Стоп</span>
        )}
      </button>

      <div
        className="think-body-wrap"
        style={{maxHeight: collapsed ? 0 : maxH, transition: 'max-height .26s ease'}}
        aria-hidden={collapsed}
      >
        <div ref={bodyRef} className="think-body">
          {steps.map((s) => {
            const isError = s.status === 'error';
            return (
              <div key={s.id} className={`think-step think-step-${s.status}`}>
                <span className="think-step-icon">{renderIcon(s.status)}</span>
                <span className="think-step-content">
                  <span className={`think-step-text${isError ? ' think-step-text-strike' : ''}`}>{s.text}</span>
                  {s.reason && <span className="think-step-reason">{s.reason}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/* ═══ AI Chat ═══ */
const anonymizeText = (t) => {
  if (!t) return '';
  return t
    .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, '[ДАТА СКРЫТА]')
    .replace(/\b[A-ZА-ЯЁ]{2}\d{6,8}\b/g, '[ПАСПОРТ СКРЫТ]')
    .replace(/\b\d{14,20}\b/g, '[СЧЕТ СКРЫТ]')
    .replace(/[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\./g, '[ФИО СКРЫТО]')
    .replace(/[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+/g, '[ФИО СКРЫТО]');
};
const AIChat=({onToast,onOpenArticle,onCollapse})=>{
  const {tr} = useI18n();
  const [incognito, setIncognito] = useState(false);
  const [deepModalOpen, setDeepModalOpen] = useState(false);

  // Anti-Gravity Telemetry — аккумулятор токенов/стоимости за всю сессию IDE.
  // Обновляется из любого SSE-helper'а (streamDeepAnalyze, streamAnalyzeDocument)
  // при получении { telemetry } чанка от бэкенда.
  // perModel — breakdown по моделям, чтобы видеть кто из роя сколько сжёг
  // (judge / senior / worker / fallback).
  const [sessionStats, setSessionStats] = useState({
    totalCalls: 0, totalInput: 0, totalOutput: 0, totalCost: 0,
    lastLabel: null, lastModel: null, lastInput: 0, lastOutput: 0, lastCost: 0,
    perModel: {}  // { 'gemini-3-flash-preview': { calls, input, output, cost }, ... }
  });
  const [telemetryHidden, setTelemetryHidden] = useState(false);
  // По умолчанию drawer закрыт — таб торчит из левого края, пользователь сам открывает
  const [telemetryDrawerOpen, setTelemetryDrawerOpen] = useState(false);

  // ── Таймеры ответа ────────────────────────────────────────────────
  // wallSec  — реальное ожидание пользователя (от старта запроса до [DONE])
  // modelSec — время, в течение которого модели реально работали
  //            (от первой telemetry до последней — отсекает RTT/setup)
  // liveSec  — текущая прошедшая секунда (тикает раз в 100мс пока running)
  // last*    — финальные значения предыдущего запроса (чтоб видеть после завершения)
  const [timing, setTiming] = useState({
    running: false,
    startedAt: null,
    firstTelemetryAt: null,
    lastTelemetryAt: null,
    liveSec: 0,
    lastWallSec: 0,
    lastModelSec: 0
  });
  const startTiming = useCallback(() => {
    setTiming({
      running: true,
      startedAt: Date.now(),
      firstTelemetryAt: null,
      lastTelemetryAt: null,
      liveSec: 0,
      lastWallSec: 0,
      lastModelSec: 0
    });
  }, []);
  const stopTiming = useCallback(() => {
    setTiming(t => {
      if (!t.startedAt) return t;
      const now = Date.now();
      const wallSec  = (now - t.startedAt) / 1000;
      const modelSec = (t.firstTelemetryAt && t.lastTelemetryAt)
        ? (t.lastTelemetryAt - t.firstTelemetryAt) / 1000
        : 0;
      return { ...t, running: false, lastWallSec: wallSec, lastModelSec: modelSec, liveSec: wallSec };
    });
  }, []);
  // Живой счётчик пока запрос идёт — тикает каждые 100мс
  useEffect(() => {
    if (!timing.running || !timing.startedAt) return;
    const id = setInterval(() => {
      setTiming(t => t.running && t.startedAt
        ? { ...t, liveSec: (Date.now() - t.startedAt) / 1000 }
        : t);
    }, 100);
    return () => clearInterval(id);
  }, [timing.running, timing.startedAt]);

  const handleTelemetry = useCallback((t) => {
    if (!t) return;
    const now = Date.now();
    // Отмечаем первую/последнюю телеметрию — нужно для расчёта modelSec
    setTiming(prev => ({
      ...prev,
      firstTelemetryAt: prev.firstTelemetryAt || now,
      lastTelemetryAt: now
    }));
    setSessionStats(s => {
      const m = t.model || 'unknown';
      const prev = s.perModel[m] || { calls: 0, input: 0, output: 0, cost: 0 };
      return {
        totalCalls:  s.totalCalls + 1,
        totalInput:  s.totalInput  + (t.inputTokens  || 0),
        totalOutput: s.totalOutput + (t.outputTokens || 0),
        totalCost:   s.totalCost   + (t.cost         || 0),
        lastLabel:   t.label || null,
        lastModel:   t.model || null,
        lastInput:   t.inputTokens  || 0,
        lastOutput:  t.outputTokens || 0,
        lastCost:    t.cost         || 0,
        perModel: {
          ...s.perModel,
          [m]: {
            calls:  prev.calls  + 1,
            input:  prev.input  + (t.inputTokens  || 0),
            output: prev.output + (t.outputTokens || 0),
            cost:   prev.cost   + (t.cost         || 0)
          }
        }
      };
    });
  }, []);
  // ── 2026-05-30: bridge для document-analysis телеметрии ─────────────
  // AnalyzeDocsMode (центральная панель) шлёт сырые telemetry-чанки через
  // window-event 'miyzamchi:raw-telemetry'. Тут мы их форвардим в
  // handleTelemetry → sessionStats. Так AntiGravityTracker / LeftTelemetryDrawer
  // (живут в правой панели AIChat) показывают live-статистику и во время
  // document analysis, а не только при прямом чате.
  //
  // Старт/стоп таймера завязаны на tele-start/tele-done события, чтобы
  // wallSec корректно считал время document analysis в правой панели.
  useEffect(() => {
    const onRaw = (e) => { if (e?.detail) handleTelemetry(e.detail); };
    const onStart = () => { startTiming(); };
    const onDone = () => { stopTiming(); };
    window.addEventListener('miyzamchi:raw-telemetry', onRaw);
    window.addEventListener('miyzamchi:tele-start', onStart);
    window.addEventListener('miyzamchi:tele-done', onDone);
    return () => {
      window.removeEventListener('miyzamchi:raw-telemetry', onRaw);
      window.removeEventListener('miyzamchi:tele-start', onStart);
      window.removeEventListener('miyzamchi:tele-done', onDone);
    };
  }, [handleTelemetry, startTiming, stopTiming]);

  const resetSessionStats = useCallback(() => {
    setSessionStats({
      totalCalls: 0, totalInput: 0, totalOutput: 0, totalCost: 0,
      lastLabel: null, lastModel: null, lastInput: 0, lastOutput: 0, lastCost: 0,
      perModel: {}
    });
    setTiming({
      running: false, startedAt: null, firstTelemetryAt: null, lastTelemetryAt: null,
      liveSec: 0, lastWallSec: 0, lastModelSec: 0
    });
  }, []);
  // Два режима в IDE-чате:
  //   • 'agent' — видит открытый документ, может его править (JSON-команды)
  //   • 'chat'  — НЕ видит документ, чистая 5-этапная консультация (DeepThinking)
  // Переключается пилюлей в header чата. Сохраняется в localStorage.
  const mode = 'thinking';
  const [chatMode, setChatMode] = useState(() => {
    try { return localStorage.getItem('myz_chat_mode') === 'chat' ? 'chat' : 'agent'; }
    catch { return 'agent'; }
  });
  useEffect(() => { try { localStorage.setItem('myz_chat_mode', chatMode); } catch {} }, [chatMode]);
  const agent = chatMode === 'agent';
  const [chats,setChats]=useState(()=>loadIdeChats());
  const [activeId,setActiveId]=useState(()=>loadIdeActive());
  const [inp,setInp]=useState('');
  const [thinking,setThinking]=useState(false);
  const [articleModal,setArticleModal]=useState(null);
  const [streamStatus,setStreamStatus]=useState('');
  const [stick,setStick]=useState(true);
  const [agentSteps, setAgentSteps] = useState([]);
  // ═══ File attachments (PDF/DOCX/TXT extraction + image previews) ═══
  const [attachments,setAttachments]=useState([]);
  const fileInputRef=useRef(null);
  const attachCounterRef=useRef(0);
  const fmtSizeAtt=useCallback((n)=>n<1024?n+' B':n<1024*1024?Math.round(n/1024)+' КБ':(n/1024/1024).toFixed(1)+' МБ',[]);
  const ensurePdfJs=useCallback(async()=>{
    if(window.pdfjsLib) return;
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    await new Promise((res,rej)=>{s.onload=res;s.onerror=()=>rej(new Error('pdf.js не загружен'));document.head.appendChild(s)});
    if(window.pdfjsLib?.GlobalWorkerOptions){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  },[]);
  const extractAttText=useCallback(async(file)=>{
    const name=(file.name||'').toLowerCase();
    if(name.endsWith('.txt')||name.endsWith('.md')||name.endsWith('.rtf')) return await file.text();
    if(name.endsWith('.docx')||name.endsWith('.doc')){
      if(!window.mammoth) throw new Error('mammoth не загружен');
      const buf=await file.arrayBuffer();
      const r=await window.mammoth.extractRawText({arrayBuffer:buf});
      return (r.value||'').trim();
    }
    if(name.endsWith('.pdf')){
      await ensurePdfJs();
      const buf=await file.arrayBuffer();
      const pdf=await window.pdfjsLib.getDocument({data:buf}).promise;
      let text='';
      for(let i=1;i<=pdf.numPages;i++){
        const p=await pdf.getPage(i);
        const c=await p.getTextContent();
        text+=c.items.map(it=>it.str).join(' ')+'\n\n';
        if(i>=50){text+='\n…[обрезано после 50 страниц]\n';break;}
      }
      return text.trim();
    }
    return null;
  },[ensurePdfJs]);
  // ═════════════════════════════════════════════════════════════════
  // ⚡ PR3 Shadow Pipeline для TipTap-РЕДАКТОРА (а не только attachment)
  // ═════════════════════════════════════════════════════════════════
  // Юрист обычно работает не через "прикрепить файл", а просто
  // вставляет/набирает документ прямо в TipTap. Этот хук слушает
  // изменения редактора и фоном прогревает analyze pipeline:
  //   • Subscribe на docEngine.on('update')
  //   • Debounce 4 секунды (не дёргаем shadow на каждое нажатие клавиши)
  //   • Min text length ≥ 500 chars (не имеет смысла греть короткие)
  //   • Простой текстовый hash → если текст не менялся, не повторяем
  //   • Fire-and-forget → editorShadowRef.current.sessionId сохраняется
  //   • На send-handler берётся этот sessionId, если largeAtt отсутствует
  //
  // Если /upload-document падает — sessionId остаётся null,
  // analyze запустится по обычному пути (full pipeline).
  const editorShadowRef = useRef({ sessionId: null, textHash: null, status: 'idle' });

  // Простой и быстрый строковый hash (DJB2-вариант) — без crypto, чисто
  // для сравнения "не изменилось ли" между событиями редактора.
  const quickStringHash = useCallback((s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return String(h >>> 0);
  }, []);

  useEffect(() => {
    let detach = null;
    let waitInterval = null;
    let debounceTimer = null;

    const tryFireShadow = () => {
      const e = window.docEngine;
      if (!e || !e.doc || typeof e.doc.getText !== 'function') return;
      const text = String(e.doc.getText({}) || '');
      if (text.length < 500) return;                       // слишком короткий
      const hash = quickStringHash(text);
      if (hash === editorShadowRef.current.textHash) return; // не менялся
      if (editorShadowRef.current.status === 'loading') return; // уже греется
      editorShadowRef.current.status = 'loading';
      editorShadowRef.current.textHash = hash;
      console.log(`[Editor Shadow] Triggering for ${text.length}ch document`);
      streamUploadDocument({ documentText: text })
        .then(shadowReady => {
          if (shadowReady && shadowReady.sessionId) {
            // Сохраняем sessionId ТОЛЬКО если хэш текста до сих пор актуален
            // (юрист мог продолжить редактировать пока shadow обрабатывался).
            // Если он редактировал — sessionId всё равно полезен:
            // text hash mismatch на бэке заставит /analyze идти полным путём.
            // Поэтому всегда сохраняем — это безопасно.
            editorShadowRef.current.sessionId = shadowReady.sessionId;
            editorShadowRef.current.status = 'ready';
            console.log(`[Editor Shadow] ✓ session=${shadowReady.sessionId.slice(0,8)} | segments=${shadowReady.segmentCount} | skip=${shadowReady.skipCount} | audit=${shadowReady.auditCount} | took ${shadowReady.elapsedSec}s`);
          } else {
            editorShadowRef.current.status = 'failed';
          }
        })
        .catch(err => {
          console.warn('[Editor Shadow] upload failed:', err.message);
          editorShadowRef.current.status = 'failed';
        });
    };

    const onEditorUpdate = () => {
      // Debounce: сбрасываем таймер на каждое изменение, ждём пока юрист
      // перестанет печатать на 4 секунды.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryFireShadow, 4000);
    };

    // SuperDoc не эмитит 'update' как TipTap — изменения приходят через
    // проп onEditorUpdate на <SuperDocEditor>, который дёргает этот мост.
    window.__shadowTrigger = onEditorUpdate;
    detach = () => { if (window.__shadowTrigger === onEditorUpdate) delete window.__shadowTrigger; };
    // Один прогон сразу — на случай если документ уже загружен.
    onEditorUpdate();
    return () => {
      if (detach) detach();
      if (waitInterval) clearInterval(waitInterval);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [quickStringHash]);

  const processAttFile=useCallback(async(file)=>{
    const id=++attachCounterRef.current;
    const isImage=file.type.startsWith('image/');
    setAttachments(p=>[...p,{id,name:file.name,size:file.size,isImage,status:'loading',file}]);
    try{
      if(isImage){
        const dataUrl=await new Promise((res,rej)=>{
          const r=new FileReader();
          r.onload=()=>res(r.result);
          r.onerror=()=>rej(new Error('Ошибка чтения'));
          r.readAsDataURL(file);
        });
        setAttachments(p=>p.map(a=>a.id===id?{...a,dataUrl,status:'ready'}:a));
      }else{
        const text=await extractAttText(file);
        if(text==null) setAttachments(p=>p.map(a=>a.id===id?{...a,status:'error',error:'Формат не поддерживается'}:a));
        else if(!text.trim()) setAttachments(p=>p.map(a=>a.id===id?{...a,status:'error',error:'Пустой текст'}:a));
        else {
          setAttachments(p=>p.map(a=>a.id===id?{...a,text,status:'ready',shadowStatus:'loading'}:a));
          // ⚡ PR3 Shadow Pipeline: запускаем фоновый прогрев СРАЗУ как только текст готов.
          // Бэкенд за фоновое время делает context+segment+triage и возвращает sessionId.
          // Когда юрист нажмёт "Проверить" — pipeline пропустит эти 3 шага и стартует с verify.
          // Fire-and-forget — если /upload упадёт, analyze просто запустится без sessionId (full pipeline).
          if (text.length >= 100) {
            streamUploadDocument({documentText: text})
              .then(shadowReady => {
                if (shadowReady && shadowReady.sessionId) {
                  console.log(`[Shadow] ✓ session=${shadowReady.sessionId.slice(0,8)} | segments=${shadowReady.segmentCount} | skip=${shadowReady.skipCount} | audit=${shadowReady.auditCount} | took ${shadowReady.elapsedSec}s`);
                  setAttachments(p=>p.map(a=>a.id===id?{...a,sessionId:shadowReady.sessionId,shadowStats:shadowReady,shadowStatus:'ready'}:a));
                } else {
                  setAttachments(p=>p.map(a=>a.id===id?{...a,shadowStatus:'failed'}:a));
                }
              })
              .catch(err => {
                console.warn('[Shadow] upload skipped:', err.message);
                setAttachments(p=>p.map(a=>a.id===id?{...a,shadowStatus:'failed'}:a));
              });
          }
        }
      }
    }catch(e){
      console.error('[attach]',e);
      setAttachments(p=>p.map(a=>a.id===id?{...a,status:'error',error:e.message}:a));
    }
  },[extractAttText]);
  const removeAttachment=useCallback((id)=>setAttachments(p=>p.filter(a=>a.id!==id)),[]);
  const buildAttPrefix=useCallback((atts)=>{
    const ready=atts.filter(a=>a.status==='ready');
    if(!ready.length) return '';
    const parts=[];
    for(const a of ready){
      if(a.isImage) parts.push(`🖼 Прикреплено изображение: ${a.name} (${fmtSizeAtt(a.size)})\n[Изображение пока не передаётся в AI — опишите его в запросе.]`);
      else if(a.text){
        const MAX=30000;
        const body=a.text.length>MAX?a.text.slice(0,MAX)+`\n…[обрезано, всего ${a.text.length} символов]`:a.text;
        parts.push(`📎 Файл: ${a.name} (${fmtSizeAtt(a.size)})\n"""\n${body}\n"""`);
      }
    }
    return parts.join('\n\n')+'\n\n';
  },[fmtSizeAtt]);

  // Speech-to-text (Web Speech API, ru-RU only, auto-stop after 4.5s silence)
  const [listening,setListening]=useState(false);
  const recogRef=useRef(null);
  const silenceTimerRef=useRef(null);
  const inpRef=useRef(inp);
  useEffect(()=>{inpRef.current=inp},[inp]);
  const SILENCE_MS=4500;
  const stopVoice=useCallback(()=>{
    if(silenceTimerRef.current){ clearTimeout(silenceTimerRef.current); silenceTimerRef.current=null; }
    if(recogRef.current){ try{recogRef.current.stop()}catch(e){} }
    setListening(false);
  },[]);
  const startVoice=useCallback(()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){ alert('Голосовой ввод не поддерживается. Используйте Chrome/Edge.'); return; }
    if(recogRef.current){ try{recogRef.current.stop()}catch(e){} }
    const r=new SR();
    r.lang='ru-RU';
    r.continuous=true;
    r.interimResults=true;
    let baseText=inpRef.current||'';
    if(baseText && !baseText.endsWith(' ')) baseText+=' ';
    let lastFinal='';
    const resetSilence=()=>{
      if(silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current=setTimeout(()=>stopVoice(), SILENCE_MS);
    };
    r.onresult=(ev)=>{
      resetSilence();
      let interim='';
      for(let i=ev.resultIndex;i<ev.results.length;i++){
        const t=ev.results[i][0].transcript;
        if(ev.results[i].isFinal) lastFinal+=t;
        else interim+=t;
      }
      setInp(baseText+lastFinal+interim);
    };
    r.onspeechstart=()=>resetSilence();
    r.onerror=(ev)=>{
      console.warn('[voice]',ev.error);
      if(ev.error==='not-allowed'||ev.error==='service-not-allowed'){
        alert('Доступ к микрофону запрещён. Разрешите в настройках браузера.');
      }
      stopVoice();
    };
    r.onend=()=>{
      if(silenceTimerRef.current){ clearTimeout(silenceTimerRef.current); silenceTimerRef.current=null; }
      setListening(false);
      recogRef.current=null;
    };
    try{ r.start(); recogRef.current=r; setListening(true); resetSilence(); }
    catch(e){ console.error(e); setListening(false); }
  },[stopVoice]);
  const toggleVoice=useCallback(()=>{ listening?stopVoice():startVoice() },[listening,startVoice,stopVoice]);
  // Cleanup on unmount
  useEffect(()=>()=>{
    if(silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if(recogRef.current){try{recogRef.current.stop()}catch(e){}}
  },[]);
  const abortRef=useRef(null);
  const scrollRef=useRef(null);

  const activeChat=useMemo(()=>{
    let list=chats||[];
    let id=activeId;
    if(!list.length){
      const created={id:uid(),title:'Дело 1',createdAt:Date.now(),messages:[]};
      list=[created];
      id=created.id;
    }
    let found=list.find(c=>c.id===id);
    if(!found){found=list[0];id=found.id;}
    return {list,id,chat:found};
  },[chats,activeId]);

  useEffect(()=>{
    if(activeChat.list!==chats){
      setChats(activeChat.list);
      saveIdeChats(activeChat.list);
    } else {
      saveIdeChats(chats);
    }
    if(activeChat.id!==activeId){
      setActiveId(activeChat.id);
      saveIdeActive(activeChat.id);
    } else {
      saveIdeActive(activeId);
    }
  },[activeChat.id]);

  useEffect(()=>{saveIdeMode(mode)},[mode]);

  const isNearBottom=useCallback((pad=140)=>{
    const el=scrollRef.current;
    if(!el) return true;
    const dist=(el.scrollHeight - el.scrollTop - el.clientHeight);
    return dist < pad;
  },[]);

  // ── Inline-цитаты [N]: клик по chip → скролл к соответствующему источнику ──
  // event-delegation, потому что markdown рендерится через dangerouslySetInnerHTML
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onClick = (e) => {
      const chip = e.target.closest('.cite-chip');
      if (!chip || !root.contains(chip)) return;
      e.preventDefault();
      const num = parseInt(chip.dataset.cite, 10);
      if (!num || num < 1) return;
      // Ищем ближайший SourceList после текущего AI-сообщения
      let aiMsg = chip.closest('.ai-md')?.parentElement;
      while (aiMsg && aiMsg.parentElement) {
        const srcList = aiMsg.querySelector?.('.msg-sources') || aiMsg.parentElement.querySelector?.('.msg-sources');
        if (srcList) {
          const items = srcList.querySelectorAll('.src-item, .source-item-rich');
          const target = items[num - 1];
          if (target) {
            target.scrollIntoView({behavior:'smooth', block:'center'});
            target.classList.remove('is-cite-target');
            void target.offsetWidth; // force reflow для рестарта анимации
            target.classList.add('is-cite-target');
            setTimeout(() => target.classList.remove('is-cite-target'), 2200);
          }
          break;
        }
        aiMsg = aiMsg.parentElement;
      }
    };
    const onKey = (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('cite-chip')) {
        e.preventDefault();
        e.target.click();
      }
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
    };
  }, []);

  const scrollToBottom=useCallback((smooth=false)=>{
    const el=scrollRef.current;
    if(!el) return;
    try{
      el.scrollTo({top:el.scrollHeight,behavior:smooth?'smooth':'auto'});
    }catch(e){
      el.scrollTop=el.scrollHeight;
    }
  },[]);

  useEffect(()=>{
    const el=scrollRef.current;
    if(!el) return;
    const onScroll=()=>setStick(isNearBottom(140));
    el.addEventListener('scroll',onScroll,{passive:true});
    onScroll();
    return()=>el.removeEventListener('scroll',onScroll);
  },[isNearBottom]);

  const updateChatMessages=(updater)=>{
    setChats(prev=>{
      const list=[...(prev||[])];
      const idx=list.findIndex(c=>c.id===activeChat.id);
      if(idx<0) return prev;
      const cur={...list[idx],messages:[...(list[idx].messages||[])]};
      cur.messages=updater(cur.messages);
      list[idx]=cur;
      saveIdeChats(list);
      return list;
    });
  };

  const newCase=()=>{
    const n= (chats?.length||0)+1;
    const c={id:uid(),title:`Дело ${n}`,createdAt:Date.now(),messages:[]};
    const next=[c,...(chats||[])];
    setChats(next);
    saveIdeChats(next);
    setActiveId(c.id);
    saveIdeActive(c.id);
    onToast&&onToast('plus','Новое дело');
  };

  const stop=()=>{
    try{abortRef.current?.abort()}catch(e){}
    abortRef.current=null;
    setThinking(false);
    setStreamStatus('');
  };

  const analyzeLargeDocument = async (fileText, userQuery) => {
    const chunkText = (text, maxChars) => {
      const chunks = [];
      let i = 0;
      const overlap = 200;
      while (i < text.length) {
        let end = i + maxChars;
        if (end < text.length) {
          const nextBreak = text.lastIndexOf('\n', end);
          if (nextBreak > i + maxChars / 2) end = nextBreak;
        }
        chunks.push(text.substring(i, end));
        i = end - overlap;
        if (i < 0) i = 0;
        if (end >= text.length) break;
      }
      return chunks;
    };

    setThinking(true);
    setAgentSteps(['[⏳] Нарезаю документ на части...']);
    const ts = Date.now();
    const userMsg = { id: uid(), role: 'user', text: userQuery + '\n\n[Анализ большого документа]', ts, agentReq: agent };
    const aiId = uid();
    const aiMsg = { id: aiId, role: 'ai', text: '', ts, status: '', sources: [], metadata: [], agentMode: agent, appliedCmds: {} };
    updateChatMessages(m => [...m, userMsg, aiMsg]);
    
    const controller = new AbortController();
    abortRef.current = controller;
    
    try {
      if (incognito) fileText = anonymizeText(fileText);
      // Gemini Flash спокойно жуёт 30K+ токенов. До 12000 символов нет смысла
      // тратить лишние API-вызовы на map-reduce — отдаём документ целиком.
      // Только для реально больших документов (книги, длинные дела) — нарезка.
      const SHOULD_CHUNK_THRESHOLD = 12000;
      const CHUNK_SIZE = 8000;
      const chunks = fileText.length <= SHOULD_CHUNK_THRESHOLD
        ? [fileText]
        : chunkText(fileText, CHUNK_SIZE);
      let summaries = [];

      if (chunks.length === 1) {
        setAgentSteps(prev => [...prev, `[🔍] Читаю документ...`]);
        await new Promise(r => setTimeout(r, 200));
        summaries.push(chunks[0]);
      } else {
        // ПАРАЛЛЕЛЬНАЯ обработка частей через Promise.all — было последовательно,
        // что давало N×латенси. Skip RAG (skipRetrieval:true) — для summarization
        // он не нужен, только тратит время и токены.
        setAgentSteps(prev => [...prev, `[🔍] Анализирую ${chunks.length} частей параллельно...`]);
        const summaryPromises = chunks.map((chunk, i) => (async () => {
          let chunkSummary = '';
          try {
            await streamChat({
              message: `Пользователь просит: ${userQuery}\n\nВот часть длинного документа:\n"""\n${chunk}\n"""\nИзвлеки только те факты, которые помогут ответить на запрос. Если информации нет, ответь строго 'SKIP'.`,
              history: [],
              mode: 'fast',
              skipRetrieval: true,        // ▸ не делать RAG для summarization
              signal: controller.signal,
              onText: (text) => { chunkSummary += text; }
            });
          } catch (chunkErr) {
            console.warn(`[Pipeline] chunk ${i+1} failed:`, chunkErr.message);
          }
          const cln = chunkSummary.trim();
          return (cln && !cln.includes('SKIP') && cln !== 'SKIP') ? cln : null;
        })());
        const results = await Promise.all(summaryPromises);
        summaries = results.filter(Boolean);
      }
      
      setAgentSteps(prev => [...prev, 'Формирую итоговое заключение...']);
      const finalCombined = summaries.length ? summaries.join('\n\n') : 'Релевантной информации в документе не найдено.';
      
      let messageToSend;
      let agentDocCtx2=null;
      if (agent) {
         // buildAgentPrompt expects {text, selection, hasSelection} — wrap the summary text
         const built = buildAgentPrompt(userQuery, { text: finalCombined, selection: '', hasSelection: false });
         messageToSend = built.prompt;
         agentDocCtx2 = built.documentContext;   // концентрат фактов — отдельным полем
      } else {
         messageToSend = `Пользователь запросил: ${userQuery}\n\nВот концентрат фактов из документа:\n"""\n${finalCombined}\n"""\nНапиши финальный ответ.`;
      }

      let gotAnyText = false;
      await streamChat({
        message: messageToSend,
        history: (activeChat.chat?.messages || []).map(m=>({role:m.role==='ai'?'model':'user',parts:[{text:String(m.text||'')}]})),
        mode: mode,
        agentMode: agent,
        userQuery: agent ? userQuery : null,    // ▸ короткий запрос для прицельного RAG-retrieval
        documentContext: agentDocCtx2,          // ▸ текст документа отдельным полем (без regex-костыля)
        signal: controller.signal,
        onStatus: (s) => {
          setStreamStatus(s);
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, status: s } : x));
        },
        onText: (chunk) => {
          gotAnyText = true;
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + chunk } : x));
        }
      });
      onToast && onToast('law', gotAnyText ? 'AI ответил' : 'Готово');
    } catch (e) {
      const msg = String(e?.message || 'Неизвестная ошибка');
      const debugInfo = `\n\n⚠️ **Ошибка:**\n\`\`\`\n${msg}\n\`\`\`\n`;
      updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + debugInfo } : x));
      onToast && onToast('warning', 'Ошибка — см. чат');
    } finally {
      abortRef.current = null;
      setThinking(false);
      setAgentSteps([]);
      setStreamStatus('');
    }
  };

  // ── Document-Grounded Analysis client (pipeline /api/analyze-document) ──
  const runAnalyzeDocumentSmart = async (documentText, userQuery, sessionId = null, file = null) => {
    setThinking(true);
    startTiming();
    const ts = Date.now();
    const userMsg = { id: uid(), role: 'user', text: userQuery + '\n\n[Document-Grounded Analysis]', ts, agentReq: true };
    const aiId = uid();
    // ВАЖНО: agentMode:false — Synthesizer возвращает обычный markdown (не agent JSON).
    // thinkSteps/thinkRunning/thinkCollapsed — состояние степпера "мыслей" (ThinkingBox).
    const aiMsg = {
      id: aiId, role: 'ai', text: '', ts, status: '',
      sources: [], metadata: [], agentMode: false, appliedCmds: {}, confidence: null,
      tableRows: [], purityIndex: undefined,
      thinkSteps: [], thinkRunning: true, thinkCollapsed: false
    };
    updateChatMessages(m => [...m, userMsg, aiMsg]);

    const controller = new AbortController();
    abortRef.current = controller;
    // Локальный флаг — чтобы автосворот сработал ТОЛЬКО на первом content-чанке
    let collapsedByContent = false;

    const upsertStep = (step) => {
      updateChatMessages(m => m.map(x => {
        if (x.id !== aiId) return x;
        const prev = Array.isArray(x.thinkSteps) ? x.thinkSteps : [];
        const idx = prev.findIndex(s => s.id === step.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...step };
          return { ...x, thinkSteps: copy };
        }
        return { ...x, thinkSteps: [...prev, step] };
      }));
    };

    try {
      let gotAnyText = false;
      await streamAnalyzeDocument({
        documentText,
        userQuery,
        sessionId,                  // ⚡ PR3: если фоновый прогрев был — пропустит context+segment+triage
        file,                       // V2: если есть физический файл — улетит multipart → Cloud Run/Docling
        signal: controller.signal,
        onStatus: (s) => {
          setStreamStatus(s);
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, status: s } : x));
        },
        onStep: (step) => {
          if (step && step.id && step.status) upsertStep(step);
        },
        onConfidence: (conf) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, confidence: conf } : x));
        },
        onTableRow: (row) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, tableRows: [...(x.tableRows || []), row] } : x));
        },
        onPurityIndex: (idx) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, purityIndex: idx } : x));
        },
        onText: (chunk) => {
          gotAnyText = true;
          // Микро-UX: при первом content-чанке сворачиваем "мысли", даём слово финальному ответу.
          if (!collapsedByContent) {
            collapsedByContent = true;
            updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, thinkCollapsed: true } : x));
          }
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + chunk } : x));
        },
        onSources: (sources) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, sources } : x));
        },
        onMetadata: (metadata) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, metadata } : x));
        },
        onTelemetry: handleTelemetry
      });
      onToast && onToast('law', gotAnyText ? 'Анализ готов' : 'Готово');
    } catch (e) {
      const msg = String(e?.message || 'Неизвестная ошибка');
      updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + `\n\n⚠️ **Ошибка анализа:**\n\`\`\`\n${msg}\n\`\`\`` } : x));
      onToast && onToast('warning', 'Ошибка анализа документа');
    } finally {
      abortRef.current = null;
      setThinking(false);
      stopTiming();
      setStreamStatus('');
      // Закрываем все ещё «крутящиеся» шаги и помечаем степпер завершённым.
      // Если финального ответа так и не было — оставляем мысли развёрнутыми,
      // чтобы пользователь увидел, где упал pipeline.
      updateChatMessages(m => m.map(x => {
        if (x.id !== aiId) return x;
        const finalSteps = (x.thinkSteps || []).map(s => s.status === 'loading' ? { ...s, status: 'success' } : s);
        const collapsed = collapsedByContent ? true : false;
        return { ...x, thinkRunning: false, thinkSteps: finalSteps, thinkCollapsed: collapsed };
      }));
    }
  };

  // ── Deep Analysis (PRO) client (Router-Worker /api/deep-analyze-document) ──
  const runDeepAnalysisPipeline = async ({documentText, userQuery, perspective, modules}) => {
    setThinking(true);
    startTiming();
    const ts = Date.now();
    const persp = perspective || 'audit';
    const mods  = (modules && modules.length) ? modules : ['audit', 'strategy'];
    const moduleLabel = mods.length === 4 ? 'все модули' : mods.join(' + ');
    const perspLabel = persp === 'opponent' ? 'Против нас' : persp === 'ours' ? 'Наш документ' : 'Аудит';
    const userMsg = {
      id: uid(), role: 'user',
      text: (userQuery || '') + `\n\n[Глубокий анализ (PRO) · ${perspLabel} · ${moduleLabel}]`,
      ts, agentReq: true
    };
    const aiId = uid();
    const aiMsg = {
      id: aiId, role: 'ai', text: '', ts, status: '',
      sources: [], metadata: [], agentMode: false, appliedCmds: {}, confidence: null,
      segmentReport: null, deepReport: null,
      thinkSteps: [], thinkRunning: true, thinkCollapsed: false
    };
    updateChatMessages(m => [...m, userMsg, aiMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const upsertStep = (step) => {
      updateChatMessages(m => m.map(x => {
        if (x.id !== aiId) return x;
        const prev = Array.isArray(x.thinkSteps) ? x.thinkSteps : [];
        const idx = prev.findIndex(s => s.id === step.id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], ...step };
          return { ...x, thinkSteps: copy };
        }
        return { ...x, thinkSteps: [...prev, step] };
      }));
    };

    try {
      let gotReport = false;
      await streamDeepAnalyze({
        documentText, userQuery, perspective: persp, modules: mods,
        signal: controller.signal,
        onStatus: (s) => {
          setStreamStatus(s);
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, status: s } : x));
        },
        onStep: (step) => {
          if (step && step.id && step.status) upsertStep(step);
        },
        onDeepReport: (report) => {
          gotReport = true;
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, deepReport: report, thinkCollapsed: true } : x));
        },
        onText: (chunk) => {
          updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + chunk } : x));
        },
        onTelemetry: handleTelemetry
      });
      onToast && onToast('law', gotReport ? 'Глубокий анализ готов' : 'Готово');
    } catch (e) {
      const msg = String(e?.message || 'Неизвестная ошибка');
      updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: (x.text || '') + `\n\n⚠️ **Ошибка глубокого анализа:**\n\`\`\`\n${msg}\n\`\`\`` } : x));
      onToast && onToast('warning', 'Ошибка глубокого анализа');
    } finally {
      abortRef.current = null;
      setThinking(false);
      stopTiming();
      setStreamStatus('');
      updateChatMessages(m => m.map(x => {
        if (x.id !== aiId) return x;
        const finalSteps = (x.thinkSteps || []).map(s => s.status === 'loading' ? { ...s, status: 'success' } : s);
        return { ...x, thinkRunning: false, thinkSteps: finalSteps };
      }));
    }
  };

  // Намерение «проверить документ» — триггер для analyzeDocumentSmart
  const ANALYSIS_KEYWORDS = /(провер[ьитеамь]+|проанализир|анализ|разбер[иь]|разобрать|оцен[иьитьке]+|найди\s+ошибк|сверь|сверить)/i;

  const send=async()=>{
    let userText=inp.trim();
    if(thinking) return;
    if(attachments.some(a=>a.status==='loading')){ return; } // wait until extraction done

    let largeAtt = attachments.find(a => a.status === 'ready' && a.text && a.text.length > 0);
    let docSnapshot = agent ? getDocSnapshot() : null;
    let editorText = docSnapshot ? docSnapshot.text : '';

    if (incognito) {
      userText = anonymizeText(userText);
      editorText = anonymizeText(editorText);
      if (docSnapshot) {
         docSnapshot.text = anonymizeText(docSnapshot.text);
         if (docSnapshot.selection) docSnapshot.selection = anonymizeText(docSnapshot.selection);
      }
      if (largeAtt && largeAtt.text) {
         largeAtt = { ...largeAtt, text: anonymizeText(largeAtt.text) };
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // ROUTER — три пути работы агента:
    //   0) AI Редактор (Split Execution) → executeAIEdit (если выделен текст)
    //   1) ДОКУМЕНТ + intent-проверка → analyzeDocumentSmart (RAG-grounded)
    //   2) ДОКУМЕНТ + другая правка   → analyzeLargeDocument (текущий путь)
    //   3) БЕЗ ДОКУМЕНТА              → обычный handleAgent (логика ниже)
    // ─────────────────────────────────────────────────────────────────
    
    // Path 0: AI Редактор выделенного фрагмента. Запускается, если есть выделение + промпт.
    if (docSnapshot && docSnapshot.selection && userText) {
      setStick(true);
      setInp('');
      setAttachments([]);
      setThinking(true);
      setStreamStatus('Miyzamchi AI: Редактирую выделенный текст...');
      const ts = Date.now();
      const userMsg = { id: uid(), role: 'user', text: `[Редактирование выделенного]: ${userText}`, ts, agentReq: agent };
      const aiId = uid();
      const aiMsg = { id: aiId, role: 'ai', text: 'Применяю правки к документу...', ts, status: 'success' };
      updateChatMessages(m => [...m, userMsg, aiMsg]);

      try {
        const r = await executeAIEdit({ instruction: userText, text: docSnapshot.selection, documentContext: docSnapshot.text, onToast });
        const summary = (r.analysis || '').trim()
          + (r.total ? `\n\n✓ Применено правок: ${r.applied}/${r.total}` : '\n\n_Правок не предложено._');
        updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: summary || 'Готово.' } : x));
      } catch(e) {
        console.error("AI Edit error:", e);
        updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, text: '⚠️ Не удалось выполнить правку: ' + e.message, status: 'warning' } : x));
      } finally {
        setThinking(false);
        setStreamStatus('');
      }
      return;
    }

    const documentSource = largeAtt ? largeAtt.text : editorText;
    const isAnalysisIntent = userText && ANALYSIS_KEYWORDS.test(userText);

    if (documentSource && userText && isAnalysisIntent) {
      // Path 1: умный document-grounded анализ
      // ⚡ PR3: используем sessionId из теневого прогрева — берём из:
      //   1. attachment (если юрист прикрепил файл) → largeAtt.sessionId
      //   2. editor (если работает через TipTap) → editorShadowRef.current.sessionId
      // Backend по hash текста сам проверит актуальность sessionId.
      const shadowSessionId = (largeAtt && largeAtt.sessionId)
        ? largeAtt.sessionId
        : (editorShadowRef.current?.sessionId || null);
      if (shadowSessionId) {
        console.log(`[Send] Using shadow sessionId=${shadowSessionId.slice(0,8)} (${largeAtt?.sessionId ? 'from attachment' : 'from editor'})`);
      }
      setStick(true);
      setInp('');
      setAttachments([]);
      // V2: в обычном режиме шлём ФИЗИЧЕСКИЙ файл вложения (→ Cloud Run/Docling).
      // В incognito файл НЕ шлём (он не анонимизирован) — уходит анонимизированный текст.
      const analyzeFile = (!incognito && largeAtt && largeAtt.file) ? largeAtt.file : null;
      runAnalyzeDocumentSmart(documentSource, userText, shadowSessionId, analyzeFile);
      return;
    }

    if ((largeAtt || editorText.length > 0) && userText) {
      // Path 2: правки документа (старый путь)
      setStick(true);
      setInp('');
      setAttachments([]);
      analyzeLargeDocument(largeAtt ? largeAtt.text : editorText, userText);
      return;
    }
    // Path 3 — без документа → обычный agent (handleAgent через /api/chat) — логика ниже

    const attPrefix=buildAttPrefix(attachments);
    if(!userText && !attPrefix) return;

    const t=(attPrefix+userText).trim();
    setStick(true);
    setInp('');
    setAttachments([]);
    setThinking(true);
    startTiming();
    setStreamStatus(agent?'Читаю документ…':'Запускаю мультиагентный анализ…');
    const ts=Date.now();
    const userMsg={id:uid(),role:'user',text:t,ts,agentReq:agent};
    const aiId=uid();
    // В режиме «Чат» (agent=false) сервер запускает 5-этапную DeepThinking-цепочку
    // и стримит step-события для ThinkingBox — поэтому заводим thinkSteps state.
    const aiMsg={
      id:aiId,role:'ai',text:'',ts,status:'',
      sources:[],metadata:[],agentMode:agent,appliedCmds:{},
      thinkSteps: agent ? undefined : [],
      thinkRunning: !agent,
      thinkCollapsed: false
    };
    updateChatMessages(m=>[...m,userMsg,aiMsg]);

    // Локальный флаг автосворачивания ThinkingBox на первом content-чанке (chat-режим)
    let collapsedByContent = false;

    const history=(activeChat.chat?.messages||[])
      .filter(m=>m.role==='user'||m.role==='ai')
      .map(m=>({role:m.role==='ai'?'model':'user',parts:[{text:String(m.text||'')}]}));

    let messageToSend=t;
    let agentDocCtx=null;
    if(agent){
      const doc=getDocSnapshot();
      // [DEBUG] verify document text is actually captured before LLM call
      console.log('[Agent] Document snapshot:',{
        editorReady:(!!window.docEngine),
        hasDocEngine:!!window.docEngine,
        textLength:(doc.text||'').length,
        textPreview:(doc.text||'').slice(0,160)+((doc.text||'').length>160?'…':''),
        hasSelection:doc.hasSelection
      });
      const built=buildAgentPrompt(t,doc);
      messageToSend=built.prompt;
      agentDocCtx=built.documentContext;   // документ уходит отдельным полем
    }

    const controller=new AbortController();
    abortRef.current=controller;
    let gotAnyText=false;
    let agentFullText='';   // полный текст ответа агента — для авто-применения команд
    try{
      await streamChat({
        message:messageToSend,
        history,
        mode,
        agentMode:agent,
        userQuery: agent ? t : null,    // ▸ короткий запрос для прицельного RAG-retrieval
        documentContext: agentDocCtx,   // ▸ текст документа отдельным полем (без regex-костыля)
        signal:controller.signal,
        onStatus:(s)=>{
          if(mode!=='thinking') return;
          setStreamStatus(s);
          updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,status:s}:x));
        },
        // step-события из DeepThinking pipeline (reformulate/special/general/process/bylaws/synthesize)
        onStep:(step)=>{
          if (!step || !step.id || !step.status) return;
          updateChatMessages(m => m.map(x => {
            if (x.id !== aiId) return x;
            const prev = Array.isArray(x.thinkSteps) ? x.thinkSteps : [];
            const idx = prev.findIndex(s => s.id === step.id);
            if (idx >= 0) {
              const copy = prev.slice();
              copy[idx] = { ...copy[idx], ...step };
              return { ...x, thinkSteps: copy };
            }
            return { ...x, thinkSteps: [...prev, step] };
          }));
        },
        onText:(chunk)=>{
          gotAnyText=true;
          // Автосворот ThinkingBox в chat-режиме при первом content-чанке
          if (!agent && !collapsedByContent) {
            collapsedByContent = true;
            updateChatMessages(m => m.map(x => x.id === aiId ? { ...x, thinkCollapsed: true } : x));
          }
          agentFullText+=chunk;
          updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,text:(x.text||'')+chunk}:x));
        },
        onSources:(sources)=>{
          updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,sources:sources||[]}:x));
          const nums=extractArticleNumbers(sources||[]);
          if(nums.length){
            const n=nums[0];
            onOpenArticle&&onOpenArticle(n);
          }
        },
        onMetadata:(metadata)=>{
          updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,metadata:metadata||[]}:x));
        },
        onTelemetry: handleTelemetry
      });
      onToast&&onToast('law',gotAnyText?'AI ответил':'Готово');
    }catch(e){
      const msg=String(e?.message||'Неизвестная ошибка');
      const debugInfo=`\n\n⚠️ **Ошибка:**\n\`\`\`\n${msg}\n\`\`\`\nBACKEND_URL: \`${BACKEND_URL||'(relative)'}\`\nMode: \`${mode}\`\nTime: \`${new Date().toLocaleTimeString()}\``;
      updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,text:(x.text||'')+debugInfo}:x));
      onToast&&onToast('warning','Ошибка — см. чат');
    }finally{
      abortRef.current=null;
      setThinking(false);
      stopTiming();
      setStreamStatus('');
      // Финализация ThinkingBox в chat-режиме: гасим loading-шаги и схлопываем
      // только если был хоть один content-чанк (иначе оставляем развёрнутым).
      if (!agent) {
        updateChatMessages(m => m.map(x => {
          if (x.id !== aiId) return x;
          const steps = Array.isArray(x.thinkSteps) ? x.thinkSteps : [];
          const finalSteps = steps.map(s => s.status === 'loading' ? { ...s, status: 'success' } : s);
          return { ...x, thinkRunning: false, thinkSteps: finalSteps, thinkCollapsed: collapsedByContent };
        }));
      } else {
        // AGENT: МГНОВЕННОЕ ПРЕВЬЮ. Авто-применяем команды как Tracked Changes сразу
        // после ответа — юрист видит дифф (жёлтое зачёркнуто / зелёное добавлено) без
        // клика. Кнопки в карточке чата = принять/отклонить именно эту правку.
        try{
          const parsed=parseAgentCommands(agentFullText);
          if(parsed.commands && parsed.commands.length){
            // Статус «✍️ Применяю правки…» — даём кадру отрисоваться, чтобы пауза
            // между концом ответа и появлением диффа не читалась как «завис».
            updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,applyingEdits:true}:x));
            await new Promise(r=>setTimeout(r,40));
            const changeIds={}; const applied={};
            parsed.commands.forEach((cmd,idx)=>{
              const r=applyCommandCaptureIds(cmd,onToast);
              if(r.ok){ changeIds[idx]=r.ids; applied[idx]='previewing'; }
            });
            updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,autoApplied:true,applyingEdits:false,changeIds,appliedCmds:{...(x.appliedCmds||{}),...applied}}:x));
            console.log('[auto-apply] applied commands:', parsed.commands.length, changeIds);
          } else {
            // Агент ответил текстом без правок — не молчим, сообщаем юристу.
            onToast&&onToast('law','Агент не предложил правок к документу');
          }
        }catch(e){ console.error('[auto-apply] failed:', e); updateChatMessages(m=>m.map(x=>x.id===aiId?{...x,applyingEdits:false}:x)); }
      }
    }
  };

  const stageFromStatus=useCallback((s)=>{
    const t=String(s||'').toLowerCase();
    if(!t) return 0;
    if(/вектор|эмбед|ищу|поиск|баз/.test(t)) return 0;
    if(/ранж|релевант|коллиз|норм|анализир/.test(t)) return 1;
    if(/вердикт|формулирую|пишу|ответ/.test(t)) return 2;
    return 1;
  },[]);

  const stages=useMemo(()=>[
    {k:'search',label:'Поиск НПА'},
    {k:'law',label:'Юр. анализ'},
    {k:'send',label:'Вердикт'}
  ],[]);

  const renderThinkingBar=(status)=>{
    const idx=stageFromStatus(status);
    const pct=Math.min(1,Math.max(0,(idx+0.18)/stages.length));
    return (
      <div style={{marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginBottom:8}}>
          <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}>
            <div style={{width:26,height:26,borderRadius:9,background:'var(--accent-dim)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 0 18px var(--accent-glow)',flexShrink:0}}>
              <Ico k={stages[idx]?.k||'law'} sz={14} col="var(--accent)" grad glow/>
            </div>
            <div style={{minWidth:0}}>
              <div style={{fontSize:11,fontWeight:700,color:'var(--text)',letterSpacing:'-.01em',lineHeight:1.15}}>{stages[idx]?.label||'Анализ'}</div>
              <div style={{fontSize:10.5,color:'var(--muted)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'52ch'}}>{status||'Подготовка…'}</div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
            <span style={{fontSize:10.5,color:'var(--muted)',fontFamily:'var(--font-mono)'}}>{Math.round(pct*100)}%</span>
            <button onClick={stop} className="btn" style={{fontSize:10.5,color:'var(--muted)',background:'transparent',border:'1px solid var(--border)',borderRadius:9,padding:'5px 8px',cursor:'pointer'}}>Стоп</button>
          </div>
        </div>
        <div style={{height:7,borderRadius:999,background:'var(--hover)',border:'1px solid var(--border)',overflow:'hidden',position:'relative'}}>
          <div style={{height:'100%',width:(pct*100)+'%',borderRadius:999,background:'linear-gradient(90deg,var(--accent),var(--accent2))',boxShadow:'0 0 14px var(--accent-glow)',transition:'width .35s ease'}}/>
          <div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent)',backgroundSize:'200% 100%',animation:'shimmer 2.2s linear infinite',opacity:.55,pointerEvents:'none'}}/>
        </div>
        <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
          {stages.map((st,i)=>(
            <div key={st.label} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:999,border:'1px solid var(--border)',background:i===idx?'var(--accent-dim)':'transparent',color:i===idx?'var(--text)':'var(--muted)',fontSize:10.5,fontWeight:600}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:i<idx?'var(--green)':i===idx?'var(--accent)':'var(--border)',boxShadow:i===idx?'0 0 10px var(--accent-glow)':'none'}}/>
              <span>{st.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Вставка текста (статья НПА / ответ ИИ) в редактор — НАТИВНО через SuperDoc.
  // Раньше звала несуществующую insertIntoQuill (зомби-код TipTap/Quill) → crash.
  const handleInsertToQuill=(text)=>{
    applyAgentCommand({ type:'insert_end', text:String(text||'') }, onToast);
    setArticleModal(null);
  };

  const handleSourceClick=(sourceStr,idx,m)=>{
    // Try to find metadata for this source
    const md=Array.isArray(m.metadata)&&m.metadata[idx]?m.metadata[idx]:null;
    if(md&&md.full_text){
      setArticleModal(md);
    } else {
      // Fallback: try local NPA dict
      const nums=extractArticleNumbers([sourceStr]);
      if(nums.length&&NPA[nums[0]]){
        const art=NPA[nums[0]];
        setArticleModal({npa_title:art.title,article_title:art.full,full_text:art.text});
      } else {
        onToast&&onToast('book',sourceStr);
      }
    }
  };

  // ПРИНЯТЬ правку (Accept): финализируем tracked change(s) этой команды через
  // editor.doc.trackChanges.decide(accept) — жёлтый/зелёный фон исчезает, текст
  // становится постоянным. Команда уже применена авто-превью при ответе агента.
  const handleApplyCmd=(msgId,cmdIdx,cmd)=>{
    const msg=(activeChat.chat?.messages||[]).find(x=>x.id===msgId);
    const ids=(msg && msg.changeIds && msg.changeIds[cmdIdx]) || [];
    let ok=true;
    ids.forEach(id=>{ if(!decideTrackedChange(id,'accept')) ok=false; });
    // Фолбэк: если правка ещё не применялась (нет changeIds) — применяем сейчас.
    if(!ids.length && !(msg && msg.autoApplied)) applyAgentCommand(cmd,onToast);
    updateChatMessages(mm=>mm.map(x=>x.id===msgId?{...x,appliedCmds:{...(x.appliedCmds||{}),[cmdIdx]:'applied'}}:x));
    onToast&&onToast('check', ids.length?(ok?'Правка принята':'Принято (с предупреждениями)'):'Готово');
  };
  // ОТКЛОНИТЬ правку (Reject): откатываем tracked change(s) через decide(reject) —
  // зелёная вставка убирается, исходный текст восстанавливается.
  const handleRejectCmd=(msgId,cmdIdx)=>{
    const msg=(activeChat.chat?.messages||[]).find(x=>x.id===msgId);
    const ids=(msg && msg.changeIds && msg.changeIds[cmdIdx]) || [];
    ids.forEach(id=>decideTrackedChange(id,'reject'));
    updateChatMessages(mm=>mm.map(x=>x.id===msgId?{...x,appliedCmds:{...(x.appliedCmds||{}),[cmdIdx]:'rejected'}}:x));
    onToast&&onToast('check', ids.length?'Правка отклонена':'Отклонено');
  };

  const renderCommandCard=(cmd,idx,msgId,status)=>{
    const meta=COMMAND_META[cmd.type]||{label:cmd.type,icon:'file',color:'var(--muted)'};
    const applied=status==='applied';
    const rejected=status==='rejected';
    const previewing=status==='previewing';
    return(
      <div key={idx} style={{marginTop:6,border:'1px solid '+(applied?'var(--green)':rejected?'var(--border)':previewing?'var(--accent)':'var(--border)'),borderRadius:7,overflow:'hidden',background:'var(--bg-panel)',opacity:rejected?.55:1,transition:'all .2s',boxShadow:previewing?'0 0 0 2px var(--accent-dim)':'none'}}>
        <div style={{padding:'5px 9px',display:'flex',alignItems:'center',gap:6,background:applied?'rgba(31,158,90,.10)':rejected?'transparent':'var(--accent-dim)',borderBottom:'1px solid var(--border)'}}>
          <Ico k={applied?'check':previewing?'sparkles':meta.icon} sz={11} col={applied?'var(--green)':previewing?'var(--accent)':meta.color} grad={previewing} glow={previewing}/>
          <span style={{fontSize:10.5,fontWeight:600,color:'var(--text)',flex:1}}>{meta.label}</span>
          {applied && <span style={{fontSize:9.5,color:'var(--green)',fontWeight:700,letterSpacing:'.04em'}}>ПРИМЕНЕНО</span>}
          {rejected && <span style={{fontSize:9.5,color:'var(--muted)',fontWeight:700,letterSpacing:'.04em'}}>ОТКЛОНЕНО</span>}
          {previewing && <span style={{fontSize:9.5,color:'var(--accent)',fontWeight:700,letterSpacing:'.04em'}}>В РЕДАКТОРЕ →</span>}
        </div>
        <div style={{padding:'6px 10px',fontSize:11.5,color:'var(--text)',lineHeight:1.45,background:'var(--bg-editor)',maxHeight:120,overflowY:'auto',whiteSpace:'pre-wrap'}}>
          {cmd.type==='replace_smart' && cmd.oldText
            ? (<span><span style={{textDecoration:'line-through',color:'var(--muted)'}}>{cmd.oldText}</span>{'  →  '}<span style={{color:'var(--green)',fontWeight:600}}>{cmd.text}</span></span>)
            : cmd.type==='comment'
            ? (<span><span style={{color:'var(--muted)'}}>На «{String(cmd.anchor||'').slice(0,50)}»:</span>{' '}<span style={{fontStyle:'italic'}}>{cmd.text}</span></span>)
            : cmd.type==='format'
            ? (<span><span style={{color:'var(--muted)'}}>«{String(cmd.anchor||'').slice(0,50)}»</span>{' → '}<span style={{fontWeight:600}}>{Object.keys(cmd.marks||{}).join(', ')}</span></span>)
            : cmd.text}
        </div>
        {!applied && !rejected && (
          <div style={{display:'flex',gap:6,padding:'6px 9px',borderTop:'1px solid var(--border)',background:'var(--bg-panel)'}}>
            <button
              onClick={()=>handleApplyCmd(msgId,idx,cmd)}
              style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:5,padding:'5px 8px',fontSize:11,fontWeight:600,color:'#fff',background:'var(--accent)',border:'none',borderRadius:5,cursor:'pointer'}}>
              <Ico k="check" sz={11} col="#fff"/> {tr('apply')}
            </button>
            <button
              onClick={()=>handleRejectCmd(msgId,idx)}
              style={{display:'flex',alignItems:'center',justifyContent:'center',gap:5,padding:'5px 10px',fontSize:11,fontWeight:600,color:'var(--muted)',background:'transparent',border:'1px solid var(--border)',borderRadius:5,cursor:'pointer'}}>
              {tr('reject')}
            </button>
          </div>
        )}
      </div>
    );
  };

  // Авто-превью команд агента теперь выполняется ИМПЕРАТИВНО в потоке ответа
  // (см. finally в обработчике send: applyCommandCaptureIds → Tracked Changes).
  // Прежний useEffect зависел от window.previewAgentEdit, которого нет — удалён.

  const toggleThinkCollapsed = (msgId) => {
    updateChatMessages(m => m.map(x => x.id === msgId ? { ...x, thinkCollapsed: !x.thinkCollapsed } : x));
  };

  const renderAi=(m)=>{
    const isAgent=!!m.agentMode;
    const parsed=isAgent?parseAgentCommands(m.text||''):null;
    const pending=parsed?parsed.commands.filter((_,i)=>!(m.appliedCmds||{})[i]):[];
    const conf = m.confidence;
    const hasThink = Array.isArray(m.thinkSteps) && m.thinkSteps.length > 0;
    return(
      <div style={{fontSize:'var(--text-base)',color:'var(--text)',lineHeight:1.65,fontFamily:'var(--font-sans)'}}>
        {/* Thinking Box — коллапсируемый степпер "мыслей" для analyze-document */}
        {hasThink && (
          <ThinkingBox
            steps={m.thinkSteps}
            collapsed={!!m.thinkCollapsed}
            onToggle={() => toggleThinkCollapsed(m.id)}
            running={!!m.thinkRunning}
            onStop={m.thinkRunning ? stop : null}
          />
        )}
        {/* Confidence badge с раскрывающимся списком — из /api/analyze-document */}
        {conf && conf.level && conf.level !== 'unknown' && <ConfidenceBadge conf={conf}/>}
        {/* Протокол соответствия НПА — конвейер Ищеек */}
        {m.tableRows && m.tableRows.length > 0 && <ProtocolReport tableRows={m.tableRows} purityIndex={m.purityIndex}/>}
        {/* Глубокий анализ (PRO) — табы Аудит/Стратегия/Проекты/Симулятор */}
        {m.deepReport && <DeepAnalysisReport report={m.deepReport} onInsertDraft={handleInsertToQuill}/>}
        {mode==='thinking' && !m.text && !hasThink && agentSteps.length === 0 && renderThinkingBar(m.status||streamStatus)}
        {isAgent ? (
          <>
            {m.applyingEdits && (
              <div style={{display:'flex',alignItems:'center',gap:8,margin:'6px 0',fontSize:11,color:'var(--accent)',fontWeight:600}}>
                <span className="dot-pulse" style={{width:7,height:7,borderRadius:'50%',background:'var(--accent)',flexShrink:0}}/>
                <span>✍️ Применяю правки в документ…</span>
              </div>
            )}
            {parsed.analysis && <div className="ai-md" dangerouslySetInnerHTML={{__html:renderMarkdown(parsed.analysis)}}/>}
            {!parsed.analysis && !parsed.commands.length && m.text && <div className="ai-md" dangerouslySetInnerHTML={{__html:renderMarkdown(m.text)}}/>}
            {parsed.commands.length>0 && (
              <div style={{marginTop:10}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
                  <Ico k="sparkles" sz={11} col="var(--accent)" grad/>
                  <span style={{fontSize:10.5,color:'var(--muted)',fontWeight:600,letterSpacing:'.06em',textTransform:'uppercase'}}>Предложенные правки ({parsed.commands.length})</span>
                </div>
                {parsed.commands.map((cmd,idx)=>renderCommandCard(cmd,idx,m.id,(m.appliedCmds||{})[idx]))}
              </div>
            )}
          </>
        ) : (
          m.text ? <div className="ai-md" dangerouslySetInnerHTML={{__html:renderMarkdown(m.text)}}/> : null
        )}
        {Array.isArray(m.sources) && m.sources.length > 0 && (
          <SourceList
            sources={m.sources}
            metadata={m.metadata}
            onSourceClick={(s, i) => handleSourceClick(s, i, m)}
          />
        )}
        {m.text && !isAgent && (
          <div className="ai-actions">
            <button className="ai-act-btn" onClick={()=>{navigator.clipboard&&navigator.clipboard.writeText(m.text);onToast&&onToast('copy','Скопировано')}}>
              <Ico k="copy" sz={11}/><span>Копировать</span>
            </button>
            <button className="ai-act-btn" onClick={()=>handleInsertToQuill(m.text)} style={{borderColor:'var(--accent)',color:'var(--accent)'}}>
              <Ico k="file" sz={11} col="var(--accent)"/><span>Вставить в редактор</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const messages=activeChat.chat?.messages||[];
  const exchanges=[];let ii=0;
  while(ii<messages.length){
    if(messages[ii].role==='user'){exchanges.push({user:messages[ii],ai:messages[ii+1]||null});ii+=2}else ii++;
  }
  useEffect(()=>{
    if(stick) scrollToBottom(false);
  },[stick,scrollToBottom,activeChat.chat?.messages,thinking,streamStatus]);

  return(
    <div style={{height:'100%',display:'flex',flexDirection:'column',background:'var(--bg-panel)',borderRadius:'var(--radius-sm)',border:'1px solid var(--border-color)',position:'relative',overflow:'hidden',transition:'background-color .3s ease, border-color .3s ease'}}>
      <div style={{padding:'var(--s-2) var(--s-2h)',borderBottom:'1px solid var(--border-color)',flexShrink:0,background:'var(--bg-panel)',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--s-1h)',transition:'background-color .3s ease, border-color .3s ease'}}>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-2)'}}>
          {/* Переключатель режима Чат / Агент — пилюля с двумя сегментами */}
          <div role="tablist" aria-label="Режим работы ИИ" style={{display:'inline-flex',padding:2,borderRadius:'var(--radius-pill)',background:'var(--bg-app)',border:'1px solid var(--border-color)',fontFamily:'var(--font-sans)'}}>
            {[
              {k:'chat',       labelKey:'mode_chat',      icon:'sparkles',  title:'Чат — консультация без правки документа'},
              {k:'agent',      labelKey:'mode_agent',     icon:'edit',      title:'Агент — редактирует открытый документ'},
              {k:'documents',  labelKey:'mode_documents', icon:'file',      title:'Документы — анализ загруженного файла или создание нового документа'}
            ].map(opt => {
              const active = chatMode === opt.k;
              return (
                <button
                  key={opt.k}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setChatMode(opt.k)}
                  title={opt.title}
                  style={{
                    display:'inline-flex',alignItems:'center',gap:'var(--s-1)',
                    padding:'var(--s-1) var(--s-2h)',
                    borderRadius:'var(--radius-pill)',
                    border:'none',cursor:'pointer',
                    background: active ? 'var(--primary)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-muted)',
                    fontSize:'var(--text-base)',fontWeight:700,
                    transition:'background .15s, color .15s',
                    fontFamily:'var(--font-sans)'
                  }}
                  onMouseEnter={e=>{ if(!active){ e.currentTarget.style.color='var(--text-main)'; } }}
                  onMouseLeave={e=>{ if(!active){ e.currentTarget.style.color='var(--text-muted)'; } }}
                >
                  <Ico k={opt.icon} sz={13} col={active ? '#fff' : 'currentColor'}/>
                  {tr(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:'var(--s-1h)'}}>
          <button className="btn" onClick={()=>{updateChatMessages(()=>[]);onToast&&onToast('trash','Очищено')}} title="Очистить чат" style={{fontSize:'var(--text-sm)',color:'var(--text-muted)',background:'transparent',border:'1px solid var(--border-color)',borderRadius:'var(--radius-sm)',padding:'var(--s-1) var(--s-3)',cursor:'pointer',fontWeight:500,fontFamily:'var(--font-sans)',transition:'color .2s, border-color .2s'}} onMouseEnter={e=>{e.currentTarget.style.color='var(--text-main)';e.currentTarget.style.borderColor='var(--text-main)'}} onMouseLeave={e=>{e.currentTarget.style.color='var(--text-muted)';e.currentTarget.style.borderColor='var(--border-color)'}}>Очистить</button>
          {onCollapse && (
            <button type="button" onClick={onCollapse} title="Свернуть чат" aria-label="Свернуть ИИ-чат" className="btn"
              style={{background:'transparent',border:'none',borderRadius:'var(--radius-sm)',width:26,height:26,padding:0,cursor:'pointer',color:'var(--text-muted)',display:'flex',alignItems:'center',justifyContent:'center',transition:'color .2s, background .2s'}} onMouseEnter={e=>{e.currentTarget.style.color='var(--text-main)';e.currentTarget.style.background='var(--hover)'}} onMouseLeave={e=>{e.currentTarget.style.color='var(--text-muted)';e.currentTarget.style.background='transparent'}}>
              <Ico k="x" sz={14} col="currentColor"/>
            </button>
          )}
        </div>
      </div>
      <div ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions text" aria-label="История диалога с ИИ" style={{flex:1,overflowY:'auto',padding:'var(--s-3h)'}}>
        {chatMode === 'documents' && <DocumentsMode onToast={onToast}/>}
        {chatMode !== 'documents' && exchanges.length === 0 && !thinking && agentSteps.length === 0 && (
          <div style={{display:'flex',flexDirection:'column',padding:'var(--s-1) 0',gap:'var(--s-4)',animation:'fadeIn .35s ease'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div style={{display:'flex',flexDirection:'column',gap:'var(--s-half)'}}>
                <div style={{fontFamily:'var(--font-display)',fontWeight:700,fontSize:'var(--text-3xl)',color:'var(--text-main)',letterSpacing:'-0.025em',lineHeight:'var(--lh-tight)'}}>Здравствуйте, коллега</div>
                <div style={{fontFamily:'var(--font-sans)',fontSize:'var(--text-sm)',color:'var(--text-muted)'}}>{agent ? 'Чем могу помочь с этим документом?' : 'Задайте юридический вопрос — пройдусь по всем слоям закона КР.'}</div>
              </div>
              <LogoIcon sz={32} glow={false} />
            </div>

            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--s-2)'}}>
              {(agent ? [
                {k:'shield', t:'Проверка рисков',     d:'Юридические риски и комплаенс.'},
                {k:'book',   t:'Найти норму',         d:'Поиск законов и прецедентов.'},
                {k:'file',   t:'Сравнить с шаблоном', d:'Сравнение документа с эталоном.'},
                {k:'edit',   t:'Составить пункт',     d:'Генерация условия по запросу.'}
              ] : [
                {k:'book',   t:'Найти норму КР',          d:'Поиск по базе НПА с проверкой.'},
                {k:'shield', t:'Оценить позицию',          d:'Анализ ситуации по 4 слоям закона.'},
                {k:'scale',  t:'Подсудность и госпошлина', d:'Сроки давности, суд, расчёт пошлины.'},
                {k:'sparkles', t:'Объяснить норму',        d:'Разбор статьи простыми словами.'}
              ]).map(c=>(
                 <div key={c.t} className="myz-welcome-card" onClick={()=>setInp(c.t)} style={{background:'var(--bg-panel)',border:'1px solid var(--border-color)',borderRadius:'var(--radius)',padding:'var(--s-3)',cursor:'pointer',display:'flex',flexDirection:'column',gap:'var(--s-1h)',transition:'border-color .2s, background .2s, box-shadow .2s, transform .15s'}} onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--primary)';e.currentTarget.style.background='var(--accent-soft)'}} onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border-color)';e.currentTarget.style.background='var(--bg-panel)'}}>
                   <Ico k={c.k} sz={18} col="var(--primary)" />
                   <div style={{display:'flex',flexDirection:'column',gap:'var(--s-half)'}}>
                     <span style={{fontFamily:'var(--font-sans)',fontWeight:600,fontSize:'var(--text-sm)',color:'var(--text-main)'}}>{c.t}</span>
                     <span style={{fontFamily:'var(--font-sans)',fontSize:'var(--text-xs)',color:'var(--text-muted)',lineHeight:'var(--lh-snug)'}}>{c.d}</span>
                   </div>
                 </div>
               ))}
            </div>

          </div>
        )}
        {chatMode !== 'documents' && exchanges.map((ex,ei)=>(
          <div key={ei} className="myz-exchange">
            {/* User message — pill справа, индиго градиент */}
            <div style={{display:'flex',justifyContent:'flex-end',marginBottom:'var(--s-3)'}}>
              <div style={{maxWidth:'85%'}}>
                <div className="myz-user-bubble">{ex.user.text}</div>
              </div>
            </div>
            {/* AI message — логотип сверху, ответ во всю ширину слева */}
            {ex.ai && (<div className="myz-ai-wrap">
              <div style={{flexShrink:0,display:'flex',alignItems:'center',gap:'var(--s-2)'}}>
                <span className="myz-brand-logo" style={{display:'inline-flex',width:28,height:28,filter:'drop-shadow(0 0 5px var(--accent-glow))'}}>
                  <img src="../logo/Logo.png" alt="" draggable="false"/>
                </span>
                <span style={{fontSize:'var(--text-xs)',fontWeight:600,color:'var(--muted)',fontFamily:'var(--font-sans)',letterSpacing:'.04em',textTransform:'uppercase'}}>Мыйзамчы</span>
              </div>
              <div style={{minWidth:0}}>{renderAi(ex.ai)}</div>
            </div>)}
            {ei<exchanges.length-1 && <div className="myz-exchange-sep"/>}
          </div>
        ))}
        {chatMode !== 'documents' && agentSteps.length > 0 && (
          <div style={{marginBottom:'var(--s-2h)', padding:'var(--s-2h) var(--s-3h)', background:'var(--bg-editor)', border:'1px solid var(--border-color)', borderRadius:'var(--radius-sm)', fontFamily:'var(--font-mono)', fontSize:'var(--text-xs)', color:'var(--text)', lineHeight:'var(--lh-normal)'}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'var(--s-2)'}}>
              <div style={{fontWeight:600, color:'var(--text)', display:'flex', alignItems:'center', gap:'var(--s-1h)'}}>
                <Ico k="loader" sz={14} col="var(--accent)" style={{animation:'spin 1s linear infinite'}} />
                <span>Анализ документа…</span>
              </div>
              <button onClick={stop} className="btn" style={{fontSize:'var(--text-2xs)',color:'var(--text-muted)',background:'transparent',border:'1px solid var(--border-color)',borderRadius:'var(--radius-sm)',padding:'var(--s-half) var(--s-1h)',cursor:'pointer',fontFamily:'var(--font-sans)'}}>Стоп</button>
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:'var(--s-half)'}}>
              {agentSteps.map((s, i) => {
                const {glyph, body} = splitGlyph(s);
                const isLast = i === agentSteps.length - 1;
                return (
                  <div key={i} style={{opacity: isLast ? 1 : 0.65, display:'flex', alignItems:'center', gap:'var(--s-1h)'}}>
                    {glyph
                      ? <Glyph type={glyph} sz={13}/>
                      : <span style={{color:isLast?'var(--accent)':'var(--muted)', flexShrink:0, fontFamily:'var(--font-mono)'}}>›</span>}
                    <span>{body}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {thinking && agentSteps.length === 0 && (
          <div style={{display:'flex',gap:'var(--s-2h)',alignItems:'flex-start'}}>
            <div style={{flexShrink:0,marginTop:'var(--s-half)'}}>
              <span className="myz-brand-logo" style={{display:'inline-flex',width:28,height:28,filter:'drop-shadow(0 0 5px var(--accent-glow))'}}>
                <img src="../logo/Logo.png" alt="" draggable="false"/>
              </span>
            </div>
            <div className="msg-skel" style={{flex:1}}>
              <div className="msg-skel-head">
                <svg width="12" height="12" viewBox="0 0 24 24" style={{animation:'spin 0.9s linear infinite',flexShrink:0}} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeOpacity=".22"/>
                  <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/>
                </svg>
                <span>{streamStatus || 'Анализирую…'}</span>
                <button onClick={stop} className="msg-skel-stop">Стоп</button>
              </div>
              <div className="msg-skel-line" style={{width:'92%'}}/>
              <div className="msg-skel-line" style={{width:'78%'}}/>
              <div className="msg-skel-line" style={{width:'54%'}}/>
            </div>
          </div>
        )}
        <div style={{height:4}}/>
      </div>
      {!stick && (
        <div style={{position:'absolute',right:14,bottom:86}}>
          <button className="btn" onClick={()=>{setStick(true);scrollToBottom(true)}} style={{display:'flex',alignItems:'center',gap:6,padding:'6px 10px',borderRadius:999,border:'1px solid var(--border)',background:'var(--bg-panel)',boxShadow:'var(--shadow-lg)',color:'var(--text)',fontSize:11.5}}>
            <span style={{fontSize:12}}>↓</span><span>Вниз</span>
          </button>
        </div>
      )}
      <div style={{padding:'var(--s-2) var(--s-2h)',borderTop:'1px solid var(--border)',flexShrink:0,background:'var(--bg-bar)',display: chatMode === 'documents' ? 'none' : 'block'}}>
        {exchanges.length === 0 && attachments.length === 0 && (
          <>
          <div style={{display:'flex',gap:'var(--s-1h)',marginBottom:'var(--s-2)',flexWrap:'wrap'}}>{(agent
            ? ['Проверь документ','Перепиши формально','Добавь реквизиты','Сократи','Добавь ссылки на КР']
            : ['Срок исковой давности','Подсудность спора','Расчёт госпошлины','Алгоритм взыскания долга','Судебная практика по…']
          ).map(c=><button key={c} className="btn" onClick={()=>setInp(c)} style={{fontSize:'var(--text-xs)',color:'var(--muted)',background:'var(--hover)',border:'1px solid var(--border)',borderRadius:'var(--radius-pill)',padding:'var(--s-1) var(--s-2h)',cursor:'pointer',fontFamily:'var(--font-sans)',transition:'color .15s, border-color .15s'}} onMouseEnter={e=>{e.currentTarget.style.color='var(--text)';e.currentTarget.style.borderColor='var(--accent)'}} onMouseLeave={e=>{e.currentTarget.style.color='var(--muted)';e.currentTarget.style.borderColor='var(--border)'}}>{c}</button>)}</div>
          </>
        )}
        {attachments.length > 0 && (
          <div style={{display:'flex',flexWrap:'wrap',gap:'var(--s-1h)',marginBottom:'var(--s-1h)'}}>
            {attachments.map(a=>{
              const loading=a.status==='loading', err=a.status==='error';
              return (
                <div key={a.id} title={a.name} style={{display:'inline-flex',alignItems:'center',gap:'var(--s-2)',padding:'var(--s-1h) var(--s-2)',border:'1px solid '+(err?'var(--red)':loading?'var(--accent)':'var(--border)'),background:err?'var(--red-soft)':loading?'var(--accent-dim)':'var(--bg-editor)',borderRadius:'var(--radius)',maxWidth:240,fontSize:'var(--text-sm)',fontFamily:'var(--font-sans)',animation:'fadeInScale .18s ease'}}>
                  {a.isImage && a.dataUrl
                    ? <img src={a.dataUrl} alt="" style={{width:28,height:28,borderRadius:'var(--radius-sm)',objectFit:'cover',flexShrink:0,border:'1px solid var(--border)'}}/>
                    : <span style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',background:err?'var(--red-soft)':'var(--accent-dim)',color:err?'var(--red)':'var(--accent)',borderRadius:'var(--radius-sm)',flexShrink:0,fontSize:'var(--text-base)',animation:loading?'spin 1s linear infinite':'none'}}>
                        {loading?'⟳':err?'!':'📄'}
                      </span>}
                  <div style={{display:'flex',flexDirection:'column',minWidth:0,flex:1,lineHeight:'var(--lh-snug)'}}>
                    <span style={{fontWeight:500,color:'var(--text)',fontSize:'var(--text-sm)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}}>{a.name}</span>
                    <span style={{fontSize:'var(--text-xs)',color:'var(--muted)',whiteSpace:'nowrap'}}>{loading?'Извлечение…':err?(a.error||'Ошибка'):(a.isImage?fmtSizeAtt(a.size):fmtSizeAtt(a.size)+' · '+(a.text?Math.round(a.text.length/100)/10+'k симв.':'—'))}</span>
                  </div>
                  <button onClick={()=>removeAttachment(a.id)} title="Удалить" style={{width:22,height:22,border:'none',background:'transparent',color:'var(--muted)',cursor:'pointer',borderRadius:'var(--radius-sm)',fontSize:'var(--text-base)',lineHeight:1,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:0,flexShrink:0,transition:'color .15s, background .15s'}} onMouseEnter={e=>{e.currentTarget.style.background='var(--red-soft)';e.currentTarget.style.color='var(--red)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--muted)'}}>×</button>
                </div>
              );
            })}
          </div>
        )}
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.doc,.txt,.md,.rtf,image/*" style={{display:'none'}} onChange={(e)=>{const files=Array.from(e.target.files||[]);e.target.value='';files.forEach(processAttFile)}}/>
        {/* Быстрые пресеты — заполняют поле ввода (без авто-отправки, юрист проверяет).
            Контекст: с документом (agent) — разбор/упрощение; без — типовые юр-запросы. */}
        {!inp.trim() && !thinking && (
          <div style={{display:'flex',gap:'var(--s-1h)',marginBottom:'var(--s-1h)',flexWrap:'wrap'}}>
            {(agent
              ? [
                  ['📝 Краткое резюме', 'Сделай краткое резюме этого документа: суть, стороны, ключевые условия и сроки.'],
                  ['⚠️ Найди риски', 'Проверь документ на юридические риски и слабые формулировки, перечисли их с пояснением.'],
                  ['✂️ Упрости', 'Упрости формулировки выделенного фрагмента, сохранив юридический смысл.'],
                  ['🌐 На кыргызский', 'Переведи выделенный фрагмент на кыргызский язык, сохранив юридическую терминологию.'],
                ]
              : [
                  ['⚖️ Применимые нормы', 'Какие нормы законодательства Кыргызской Республики применимы к этой ситуации?'],
                  ['📋 План действий', 'Составь пошаговый план юридических действий по моей ситуации.'],
                  ['💬 Простыми словами', 'Объясни простыми словами правовую суть моего вопроса.'],
                ]
            ).map(([label, text]) => (
              <button key={label} type="button" className="myz-suggest-chip"
                onClick={()=>{ setInp(text); setTimeout(()=>{ const el=document.getElementById('myz-ai-input'); if(el){ el.focus(); el.style.height='auto'; el.style.height=Math.min(160,el.scrollHeight)+'px'; } }, 0); }}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div style={{display:'flex', alignItems:'center', gap:'var(--s-2h)', marginBottom:'var(--s-1h)', flexWrap:'wrap'}}>
          <label style={{display:'flex',alignItems:'center',gap:'var(--s-1h)',fontSize:'var(--text-sm)',color:'var(--muted)',cursor:'pointer',fontFamily:'var(--font-sans)'}}>
            <input type="checkbox" checked={incognito} onChange={e=>setIncognito(e.target.checked)} style={{accentColor:'var(--accent)',cursor:'pointer',width:13,height:13}} />
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={incognito?'var(--accent)':'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            Анонимизировать (скрыть ФИО, даты, реквизиты)
          </label>
        </div>
        <div className="myz-input-ring" style={{position:'relative',display:'flex',alignItems:'flex-end',gap:'var(--s-1h)',border:'1px solid var(--border-color)',borderRadius:'var(--radius)',background:'var(--bg-input)',transition:'border-color .3s, box-shadow .3s',padding:'var(--s-2h) var(--s-3)'}} onFocusCapture={e=>{e.currentTarget.style.borderColor='var(--primary)';e.currentTarget.style.boxShadow='0 0 0 3px var(--accent-dim)'}} onBlurCapture={e=>{e.currentTarget.style.borderColor='var(--border-color)';e.currentTarget.style.boxShadow='none'}}>
          <button
            onClick={()=>fileInputRef.current?.click()}
            className="btn"
            title="Прикрепить файл (PDF / DOCX / TXT / изображение)"
            style={{flexShrink:0,width:28,height:28,border:'none',background:'transparent',cursor:'pointer',color:'var(--text-muted)',display:'flex',alignItems:'center',justifyContent:'center',borderRadius:'var(--radius-sm)',transition:'color .15s, background .15s'}}
            onMouseEnter={e=>{e.currentTarget.style.color='var(--primary)';e.currentTarget.style.background='var(--hover)'}}
            onMouseLeave={e=>{e.currentTarget.style.color='var(--text-muted)';e.currentTarget.style.background='transparent'}}
          >
            <Ico k="clip" sz={16}/>
          </button>
          <textarea
            id="myz-ai-input"
            value={inp}
            onChange={e=>{setInp(e.target.value);e.target.style.height='auto';e.target.style.height=Math.min(160,e.target.scrollHeight)+'px'}}
            rows={1}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}
            placeholder={agent ? ((getDocSnapshot() && getDocSnapshot().selection) ? tr('ws_ph_selection') : tr('ws_ph_doc')) : tr('ws_ph_legal')}
            style={{flex:1,minHeight:24,maxHeight:140,background:'transparent',border:'none',outline:'none',resize:'none',color:'var(--text-main)',fontSize:'var(--text-md)',fontWeight:500,fontFamily:'var(--font-sans)',lineHeight:'var(--lh-normal)',padding:'var(--s-1) var(--s-1)',display:'block',overflowY:'auto'}}
          />
          <button
            onClick={toggleVoice}
            className={`btn ${listening ? 'mic-listening' : ''}`}
            title={listening?'Остановить запись':'Голосовой ввод (Web Speech API)'}
            style={{flexShrink:0,width:28,height:28,border:'none',background:listening?'var(--red)':'transparent',cursor:'pointer',color:listening?'#fff':'var(--text-muted)',display:'flex',alignItems:'center',justifyContent:'center',borderRadius:'var(--radius-sm)',transition:'color .15s, background .15s',boxShadow:listening?'0 0 0 3px var(--red-soft)':'none',animation:listening?'mic-pulse 1.4s ease-in-out infinite':'none'}}
            onMouseEnter={e=>{ if(!listening){e.currentTarget.style.color='var(--primary)';e.currentTarget.style.background='var(--hover)'} }}
            onMouseLeave={e=>{ if(!listening){e.currentTarget.style.color='var(--text-muted)';e.currentTarget.style.background='transparent'} }}
          >
            <Ico k="mic" sz={14}/>
          </button>
          <button
            onClick={send}
            disabled={(!inp.trim()&&attachments.filter(a=>a.status==='ready').length===0)||thinking||attachments.some(a=>a.status==='loading')}
            className="btn"
            title={attachments.some(a=>a.status==='loading')?'Подождите, файлы обрабатываются…':'Отправить (Enter)'}
            style={{flexShrink:0,width:32,height:32,borderRadius:'var(--radius-sm)',border:'none',cursor:((inp.trim()||attachments.filter(a=>a.status==='ready').length>0)&&!thinking&&!attachments.some(a=>a.status==='loading'))?'pointer':'not-allowed',background:((inp.trim()||attachments.filter(a=>a.status==='ready').length>0)&&!thinking&&!attachments.some(a=>a.status==='loading'))?'var(--primary)':'var(--border-color)',color:((inp.trim()||attachments.filter(a=>a.status==='ready').length>0)&&!thinking)?'#fff':'var(--text-muted)',display:'flex',alignItems:'center',justifyContent:'center',transition:'background .2s, color .2s, box-shadow .2s',boxShadow:((inp.trim()||attachments.filter(a=>a.status==='ready').length>0)&&!thinking&&!attachments.some(a=>a.status==='loading'))?'0 1px 3px var(--accent-glow)':'none'}}
          >
            <Ico k="send" sz={16} col={((inp.trim()||attachments.filter(a=>a.status==='ready').length>0)&&!thinking)?'#fff':'var(--text-muted)'}/>
          </button>
        </div>
        <div style={{textAlign:'center',marginTop:'var(--s-1h)',fontSize:'var(--text-xs)',color:'var(--text-muted)',fontFamily:'var(--font-sans)'}}>Перед использованием в производстве сверяйте нормы с <a href="https://cbd.minjust.gov.kg" target="_blank" rel="noopener noreferrer" style={{color:'var(--accent)',textDecoration:'none'}}>cbd.minjust.gov.kg</a>.</div>
      </div>
      {articleModal && <ArticleModal article={articleModal} onClose={()=>setArticleModal(null)} onInsert={handleInsertToQuill}/>}
      {!telemetryHidden && (
        <LeftTelemetryDrawer
          open={telemetryDrawerOpen}
          onToggle={setTelemetryDrawerOpen}
          sessionStats={sessionStats}
          timing={timing}
          onReset={resetSessionStats}
          onHide={()=>setTelemetryHidden(true)}
        />
      )}
      <DeepAnalyzeModal
        open={deepModalOpen}
        hasDocument={(() => {
          // Deep Analysis — документ-ориентированная фича. Читаем редактор ВСЕГДА,
          // независимо от chatMode (в режиме «Чат» обычный pipeline игнорирует
          // редактор, но Deep Analysis должен видеть документ всегда).
          const att = attachments.find(a => a.status === 'ready' && a.text && a.text.length > 0);
          if (att) return true;
          const snap = getDocSnapshot();
          return !!(snap && snap.text && snap.text.trim().length > 0);
        })()}
        defaultPerspective="audit"
        onClose={()=>setDeepModalOpen(false)}
        onRun={({perspective, modules}) => {
          let largeAtt = attachments.find(a => a.status === 'ready' && a.text && a.text.length > 0);
          let docSnap = getDocSnapshot();
          let docText = largeAtt ? largeAtt.text : (docSnap ? docSnap.text : '');
          let userText = inp.trim();
          if (incognito) {
            docText  = anonymizeText(docText);
            userText = anonymizeText(userText);
          }
          if (!docText || docText.trim().length < 50) {
            onToast && onToast('warning', 'Документ слишком короткий для глубокого анализа');
            return;
          }
          setDeepModalOpen(false);
          setStick(true);
          setInp('');
          setAttachments([]);
          runDeepAnalysisPipeline({documentText: docText, userQuery: userText, perspective, modules});
        }}
      />
    </div>
  );
};

/* ═══ Status Bar ═══ */
const StatusBar=({dark,tabCount,unsaved,activeName})=>{
  return (
    <div style={{height:24,flexShrink:0,background:dark?'var(--bg-panel)':'var(--primary)',borderTop:dark?'1px solid var(--border-color)':'none',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 var(--s-3)',fontSize:'var(--text-xs)',userSelect:'none',color:dark?'var(--text-muted)':'#ffffff',transition:'background-color .3s, color .3s, border-color .3s',fontFamily:'var(--font-sans)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-3h)'}}>
        <span style={{display:'flex',alignItems:'center',gap:'var(--s-1h)'}}><StatusDot/><span className={dark?'gt':undefined} style={{fontWeight:500}}>Подключено</span></span>
        <span style={{opacity:.65}}>Вкладок: {tabCount||0}{unsaved>0 && <span style={{color:dark?'var(--orange)':'#fff',fontWeight:600}}> · {unsaved} •</span>}</span>
        {activeName && <span style={{opacity:.6,fontFamily:'var(--font-mono)',maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{activeName}</span>}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s-3h)'}}>
        <span style={{display:'flex',alignItems:'center',gap:'var(--s-1)'}}><Ico k="zap" sz={12} col={dark?'var(--accent)':'rgba(255,255,255,.7)'} grad={dark} glow={dark}/>Gemini Flash</span>
      </div>
    </div>
  );
};

/* ═══ Magic Wand ═══ */

/* ═══ App ═══ */
let _tabIdCounter=10;
const App=()=>{
  const {tr} = useI18n();
  const[dark,setDark]=useState(()=>localStorage.getItem('myz-dk')==='1');
  const[tt,setTt]=useState(false);
  const[leftW,setLeftW]=useState(238);const[rightW,setRightW]=useState(560);const[rightSplit,setRightSplit]=useState(35);
  const[npaCollapsed,setNpaCollapsed]=useState(true);const[chatCollapsed,setChatCollapsed]=useState(false);
  const[leftOpen,setLeftOpen]=useState(false);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);
  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);
  // Both can't be collapsed at once. When one collapses, the other auto-expands.
  const collapseNpa=useCallback(()=>{setNpaCollapsed(true);setChatCollapsed(false)},[]);
  const collapseChat=useCallback(()=>{setChatCollapsed(true);setNpaCollapsed(false)},[]);
  // Reset collapse state when right panel itself closes/opens.
  useEffect(()=>{if(!rightOpen){setNpaCollapsed(false);setChatCollapsed(false)}},[rightOpen]);
  // Mobile detection — viewport < 900px
  const[isMobile,setIsMobile]=useState(()=>typeof window!=='undefined'&&window.innerWidth<900);
  useEffect(()=>{
    const onResize=()=>{
      const m=window.innerWidth<900;
      setIsMobile(prev=>{
        if(prev===m) return prev;
        // When entering mobile mode: close panels by default
        if(m){ setLeftOpen(false); setRightOpen(false); }
        return m;
      });
    };
    window.addEventListener('resize',onResize);
    return ()=>window.removeEventListener('resize',onResize);
  },[]);
  // ── Вкладки НПА: несколько одновременно открытых документов в правой панели ──
  const[npaTabs,setNpaTabs]=useState([]);
  const[activeNpaTabId,setActiveNpaTabId]=useState(null);
  const activeNpaTab = npaTabs.find(t=>t.id===activeNpaTabId);
  const npa = activeNpaTab ? activeNpaTab.art : null;
  // Ключ для идентификации вкладки (чтобы повторное открытие того же НПА не создавало дубль)
  const npaTabKeyOf = (art) => {
    if (art == null) return 'null';
    if (typeof art === 'number' || typeof art === 'string') return 'a_' + String(art);
    if (Array.isArray(art)) return 'arr_' + (art[0]?.documentCode || art[0]?.lastEdition || JSON.stringify(art).slice(0,40));
    if (typeof art === 'object') return 'obj_' + (art.documentCode || art.editionId || JSON.stringify(art).slice(0,40));
    return 'x_' + String(art);
  };
  const npaTabTitleOf = (art) => {
    if (typeof art === 'number') return 'Ст. ' + art;
    if (typeof art === 'string') return art;
    if (Array.isArray(art)) return art[0]?.metadata?.npa_title || 'Документ';
    if (art && typeof art === 'object') return art.title || (art.editionId ? 'Документ #' + art.editionId : 'Документ');
    return 'НПА';
  };
  const openNpa = useCallback((art) => {
    if (art == null) { setNpaTabs([]); setActiveNpaTabId(null); return; }
    const key = npaTabKeyOf(art);
    setNpaTabs(prev => {
      const found = prev.find(t => t.key === key);
      if (found) { setActiveNpaTabId(found.id); return prev; }
      const id = 'npa_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
      setActiveNpaTabId(id);
      return [...prev, { id, key, art, title: npaTabTitleOf(art) }];
    });
  }, []);
  const closeNpaTab = useCallback((id) => {
    setNpaTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.id !== id);
      setActiveNpaTabId(curr => {
        if (curr !== id) return curr;
        const newActive = next[idx] || next[idx - 1] || next[0] || null;
        return newActive ? newActive.id : null;
      });
      return next;
    });
  }, []);
  const setNpa = openNpa; // alias для обратной совместимости с существующими вызовами
  const[showPalette,setShowPalette]=useState(false);const[showTweaks,setShowTweaks]=useState(false);const[showShortcuts,setShowShortcuts]=useState(false);const[showOriginal,setShowOriginal]=useState(false);
  const[showFind,setShowFind]=useState(false);const[showNotif,setShowNotif]=useState(false);const[sideMode,setSideMode]=useState('tree');
  const[tweaks,setTweaks]=useState({accent:'#5C66DE'});
  const[tabs,setTabs]=useState([]);
  const[activeTab,setActiveTab]=useState(null);const[ctxMenu,setCtxMenu]=useState(null);const[toasts,setToasts]=useState([]);
  const[tourStep,setTourStep]=useState(()=>localStorage.getItem('myz-tour')==='1'?null:0);const drag=useRef(null);
  const[fsHandle,setFsHandle]=useState(null);const[fsFiles,setFsFiles]=useState([]);
  

  // ── Динамический zoom правой панели (масштабирует весь текст и UI) ──
  // ВАЖНО: deps только [rightOpen], НЕ rightW. ResizeObserver сам ловит ресайз.
  // Каждое изменение rightW не должно пересоздавать observer — это вызывало
  // дёрганье при перетаскивании Handle.
  useEffect(() => {
    if (!rightOpen) return;
    let raf = 0;
    let debounceId = 0;
    let lastApplied = null;
    let cleanup = () => {};
    // Базовая ширина 560px → zoom 1.0. На узких — плавно ужимаем, на широких —
    // чуть-чуть растим. До этого формула давала 0.81 при 560 px — текст
    // выглядел мелким и нечитаемым (жалоба от 2026-05-18).
    const computeScale = (w) => Math.max(0.82, Math.min(1.12, (w - 400) / 1000 + 0.85));
    const apply = (el) => {
      if (!el) return;
      clearTimeout(debounceId);
      // Если активно перетаскивание Handle — откладываем zoom-recalc, пока
      // не будет короткой паузы. zoom синхронно reflow-ит весь НПА-документ,
      // на каждое движение мыши это вызывает дёрганье.
      const isDragging = drag.current != null;
      const delay = isDragging ? 220 : 50;
      debounceId = setTimeout(() => {
        const w = el.clientWidth;
        const next = computeScale(w).toFixed(3);
        if (next !== lastApplied) {
          el.style.zoom = next;
          lastApplied = next;
        }
      }, delay);
    };
    const init = () => {
      const el = document.getElementById('rp');
      if (!el) { raf = requestAnimationFrame(init); return; }
      // Первое применение — сразу, без debounce, чтобы текст не «прыгал» при открытии
      const initialScale = computeScale(el.clientWidth).toFixed(3);
      el.style.zoom = initialScale;
      lastApplied = initialScale;
      const parent = el.parentElement || el;
      const ro = new ResizeObserver(() => apply(el));
      ro.observe(parent);
      cleanup = () => { ro.disconnect(); clearTimeout(debounceId); };
    };
    raf = requestAnimationFrame(init);
    return () => { cancelAnimationFrame(raf); cleanup(); };
  }, [rightOpen]);

  // ── Недавно открытые файлы (persist в localStorage) ──
  const [recentFiles, setRecentFiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem('myz_recent_files') || '[]'); }
    catch { return []; }
  });
  const addRecent = useCallback((name) => {
    if (!name) return;
    setRecentFiles(prev => {
      const filtered = prev.filter(r => r.name !== name);
      const next = [{ name, addedAt: Date.now() }, ...filtered].slice(0, 20);
      try { localStorage.setItem('myz_recent_files', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  
  const openFolder=async()=>{
    try{
      const handle=await window.showDirectoryPicker({mode:'readwrite'});
      setFsHandle(handle);
      const list=[];
      for await(const entry of handle.values()){
        if(entry.kind==='file') list.push(entry);
      }
      setFsFiles(list);
    }catch(e){console.log('Open folder aborted', e)}
  };

  const addToast=useCallback((icon,text,dur=3)=>{const id=++_tid;setToasts(p=>[...p.slice(-4),{id,icon,text,iconBg:'var(--accent-dim)'}]);setTimeout(()=>setToasts(p=>p.map(t=>t.id===id?{...t,leaving:true}:t)),(dur-.3)*1000);setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),dur*1000)},[]);
  const removeToast=useCallback(id=>{setToasts(p=>p.map(t=>t.id===id?{...t,leaving:true}:t));setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),250)},[]);
  useEffect(()=>{
    localStorage.setItem('myz-dk',dark?'1':'0');
    if (dark) {
      document.body.classList.add('dk', 'dark-mode');
    } else {
      document.body.classList.remove('dk', 'dark-mode');
    }
  },[dark]);
  const toggleTheme=useCallback(()=>{setTt(true);setDark(p=>!p);setTimeout(()=>setTt(false),400);addToast(dark?'sun':'moon',dark?'Светлая тема':'Тёмная тема')},[dark,addToast]);
  useEffect(()=>{const c=tweaks.accent;document.documentElement.style.setProperty('--accent',c);document.documentElement.style.setProperty('--accent-dim',c+'22');document.documentElement.style.setProperty('--accent-glow',c+'18');document.documentElement.style.setProperty('--accent2',c==='#A8C7FA'?'#C4EED0':'#E8A87C');document.documentElement.style.setProperty('--link',c);document.documentElement.style.setProperty('--link-bg',c+'22')},[tweaks.accent]);
  const switchTab=useCallback((newId)=>{
    if(activeTab===newId) return;
    setActiveTab(newId);
  },[activeTab]);

  const closeTab=useCallback(id=>{
    setTabs(p=>p.filter(t=>t.id!==id));
    setActiveTab(prev=>{
      if(prev===id){
        const r=tabs.filter(t=>t.id!==id);
        const nextId=r.length?r[0].id:null;
        return nextId;
      }
      return prev;
    });
  },[tabs]);

  const handleAction=useCallback((action,payload)=>{switch(action){case'openFolder':{openFolder();break}case'openFromDisk':{(async()=>{let handle;try{if(window.showOpenFilePicker){const r=await window.showOpenFilePicker({types:[{description:'Документы',accept:{'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'],'text/plain':['.txt','.md'],'text/html':['.html','.htm']}}],multiple:false,excludeAcceptAllOption:false});handle=r&&r[0]}else{const input=document.createElement('input');input.type='file';input.accept='.docx,.txt,.md,.html,.htm';const file=await new Promise(resolve=>{input.onchange=()=>resolve(input.files&&input.files[0]||null);input.oncancel=()=>resolve(null);input.click()});if(!file)return;handle={name:file.name,kind:'file',getFile:async()=>file}}if(!handle)return;handleAction('openFile',handle)}catch(e){if(e.name!=='AbortError'){addToast('warning','Не удалось открыть файл');console.error(e)}}})();break}case'newDoc':{const id='doc_'+(++_tabIdCounter);const name=payload||'Документ_'+_tabIdCounter+'.txt';setTabs(p=>[...p,{id,name,mod:true,content:'<p><br></p>'}]);switchTab(id);addToast('plus','Создан');break}case'openFile':{const ex=tabs.find(t=>t.name===payload.name);if(ex){switchTab(ex.id);addToast('file','Открыт');addRecent(payload.name)}else{payload.getFile().then(async file=>{if(file.name.endsWith('.docx')){try{const buffer=await file.arrayBuffer();const id='doc_'+(++_tabIdCounter);setTabs(p=>[...p,{id,name:payload.name,mod:false,content:'',handle:payload,buffer}]);switchTab(id);addRecent(payload.name);addToast('file','Открыт: '+payload.name)}catch(e){addToast('warning','Ошибка чтения DOCX');console.error(e)}}else{file.text().then(text=>{const id='doc_'+(++_tabIdCounter);let content=text.includes('<')&&text.includes('>')?text:'<p>'+text.replace(/\\n/g,'<br/>')+'</p>';setTabs(p=>[...p,{id,name:payload.name,mod:false,content,handle:payload}]);switchTab(id);addRecent(payload.name);addToast('file','Открыт: '+payload.name)}).catch(e=>{addToast('warning','Ошибка чтения');console.error(e)})}}).catch(e=>{addToast('warning','Не удалось получить файл');console.error(e)})}break}case'openNPA':{setNpa(payload);setRightOpen(true);if(Array.isArray(payload)){addToast('book', payload[0]?.metadata?.npa_title || 'Весь документ')}else{addToast('book', payload?.metadata ? 'Ст. '+payload.metadata.article_display : 'Ст. '+payload)}break}case'save':{const tt=tabs.find(t=>t.id===activeTab);if(!(!!window.docEngine)){addToast('warning','Редактор не готов');break}const html="";if(true){(async()=>{try{const blob=await window.docEngine.exportDocx();const name=(tt?.name||'Документ').endsWith('.docx')?(tt?.name||'Документ'):(tt?.name||'Документ')+'.docx';downloadBlob(blob,name);setTabs(p=>p.map(t=>t.id===activeTab?{...t,mod:false}:t));addToast('save','Скачано: '+name)}catch(e){console.error('save failed',e);addToast('warning','Ошибка сохранения: '+e.message)}})();}else{if(tt&&tt.handle){tt.handle.createWritable().then(w=>{w.write(html).then(()=>w.close()).then(()=>{setTabs(p=>p.map(t=>t.id===activeTab?{...t,mod:false}:t));addToast('save','Сохранено')})}).catch(()=>addToast('warning','Не удалось сохранить'))}else{const header="<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>Export</title></head><body>";const footer="</body></html>";const fullHtml=header+html+footer;const blob=new Blob(['\\ufeff',fullHtml],{type:'application/msword'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=(tt?.name||'Document').replace('.docx','.doc');document.body.appendChild(link);link.click();document.body.removeChild(link);setTabs(p=>p.map(t=>t.id===activeTab?{...t,mod:false}:t));addToast('save','Скачано')}}break}case'exportWord':{const tt=tabs.find(t=>t.id===activeTab);if(!(!!window.docEngine)){addToast('warning','Редактор не готов');break}const html="";if(true){(async()=>{try{const blob=await window.docEngine.exportDocx();const name=(tt?.name||'Документ').replace(/\\..+$/,'')+'.docx';downloadBlob(blob,name);addToast('save','Word скачан: '+name)}catch(e){console.error(e);addToast('warning','Ошибка экспорта Word')}})();}else{const header="<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>Export</title></head><body>";const footer="</body></html>";const fullHtml=header+html+footer;const blob=new Blob(['\\ufeff',fullHtml],{type:'application/msword'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=(tt?.name||'Document').replace(/\\..+$/,'')+'.doc';document.body.appendChild(link);link.click();document.body.removeChild(link);addToast('save','Word скачан')}break}case'exportPdf':{const tt=tabs.find(t=>t.id===activeTab);if(!(!!window.docEngine)){addToast('warning','Редактор не готов');break}const html=window.docEngine.getHTML();const opt={margin:1,filename:(tt?.name||'Document').replace(/\\..+$/,'')+'.pdf',image:{type:'jpeg',quality:0.98},html2canvas:{scale:2},jsPDF:{unit:'cm',format:'a4',orientation:'portrait'}};const div=document.createElement('div');div.innerHTML=html;div.style.padding='2cm';div.style.fontFamily='Times New Roman, serif';div.style.fontSize='14pt';addToast('copy','Генерация PDF...');window.html2pdf().set(opt).from(div).save().then(()=>addToast('save','PDF скачан')).catch(e=>{console.error(e);addToast('warning','Ошибка PDF')});break;}case'closeTab':if(tabs.length)closeTab(activeTab);break;case'closeAllTabs':setTabs([]);setActiveTab(null);addToast('trash','Все закрыты');break;case'toggleLeft':setLeftOpen(p=>!p);break;case'toggleRight':setRightOpen(p=>!p);break;case'toggleTheme':toggleTheme();break;case'aiCheck':setRightOpen(true);addToast('law','На проверке');break;case'find':setShowFind(true);break;case'outline':setSideMode('tree');setActPanel('outline');setLeftOpen(true);addToast('outline','Структура');break;case'splitEditor':setSplitActive(p=>!p);addToast('split',splitActive?'Обычный':'Раздельный');break;case'showOriginal':{const tt=tabs.find(t=>t.id===activeTab);if(tt&&tt.buffer)setShowOriginal(true);else addToast('warning','Оригинал доступен только для DOCX-файлов');break}}},[tabs,activeTab,addToast,toggleTheme,splitActive,closeTab,switchTab,addRecent]);
  useEffect(()=>{const h=e=>{const m=e.ctrlKey||e.metaKey;if(m&&e.key==='b'){e.preventDefault();handleAction('toggleLeft')}if(m&&e.key==='j'){e.preventDefault();handleAction('toggleRight')}if(m&&e.key==='p'){e.preventDefault();setShowPalette(p=>!p)}if(m&&e.key==='n'){e.preventDefault();handleAction('newDoc')}if(m&&e.key==='o'){e.preventDefault();handleAction('openFromDisk')}if(m&&e.key==='w'){e.preventDefault();handleAction('closeTab')}if(m&&e.key==='f'){e.preventDefault();handleAction('find')}if(m&&e.key==='/'){e.preventDefault();setShowShortcuts(p=>!p)}if(m&&e.key==='\\'){e.preventDefault();handleAction('splitEditor')}/* k shortcut removed */ if(e.key==='Escape'){setShowPalette(false);setShowShortcuts(false);setCtxMenu(null);setShowFind(false);setShowNotif(false);setShowOriginal(false);/* setInlinePrompt */}};window.addEventListener('keydown',h,true);return()=>window.removeEventListener('keydown',h,true)},[handleAction]);
  // Глобальный мост: NPAView перехватывает ссылки и вызывает этот диспатчер
  useEffect(()=>{window.__ideHandleAction=handleAction;return()=>{delete window.__ideHandleAction}},[handleAction]);
  // Жёсткий перехват Ctrl/Cmd+S: ловим на document в capture-фазе, гасим
  // браузерное "сохранить страницу" и вызываем наш .docx-экспорт.
  useEffect(()=>{
    const onSave=(e)=>{
      if((e.ctrlKey||e.metaKey)&&e.key&&e.key.toLowerCase()==='s'){
        e.preventDefault();
        e.stopPropagation();
        if(window.__ideHandleAction)window.__ideHandleAction('save');
      }
    };
    document.addEventListener('keydown',onSave,{capture:true});
    return()=>document.removeEventListener('keydown',onSave,{capture:true});
  },[]);
  useEffect(()=>{const h=()=>setCtxMenu(null);window.addEventListener('scroll',h,true);return()=>window.removeEventListener('scroll',h,true)},[]);
  useEffect(()=>{const h=(e)=>{if(({}).visible&&!e.target.closest('#inline-prompt-menu')){/* setInlinePrompt */}};document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h)},[({}).visible]);
  useEffect(()=>{const handler=e=>{if(e.data&&e.data.type==='__activate_edit_mode')setShowTweaks(true);if(e.data&&e.data.type==='__deactivate_edit_mode')setShowTweaks(false)};window.addEventListener('message',handler);return()=>window.removeEventListener('message',handler)},[]);
  const changeTweak=(k,v)=>{setTweaks(p=>({...p,[k]:v}));if(k==='rightW')setRightW(v);window.parent.postMessage({type:'__edit_mode_set_keys',edits:{[k]:v}},'*')};
  const startDrag=type=>e=>{e.preventDefault();drag.current={type,sx:e.clientX,sy:e.clientY,lw:leftW,rw:rightW,rs:rightSplit};document.body.style.userSelect='none';document.body.style.cursor=type==='rv'?'row-resize':'col-resize'};
  useEffect(()=>{
    // rAF-throttling: ограничиваем setState частотой кадра — иначе при быстром
    // движении мыши вызывается множество re-render-ов в один кадр.
    let pending=null;let rafId=0;
    const flush=()=>{
      rafId=0;
      if(!pending||!drag.current){pending=null;return;}
      const{type,sx,sy,lw,rw,rs,x,y}=pending;
      pending=null;
      if(type==='l')setLeftW(Math.max(160,Math.min(420,lw+x-sx)));
      if(type==='r')setRightW(Math.max(220,Math.min(800,rw-(x-sx))));
      if(type==='rv'){const el=document.getElementById('rp');if(el)setRightSplit(Math.max(20,Math.min(78,rs+(y-sy)/el.getBoundingClientRect().height*100)));}
    };
    const move=e=>{
      if(!drag.current)return;
      const{type,sx,sy,lw,rw,rs}=drag.current;
      pending={type,sx,sy,lw,rw,rs,x:e.clientX,y:e.clientY};
      if(!rafId)rafId=requestAnimationFrame(flush);
    };
    const up=()=>{
      if(rafId){cancelAnimationFrame(rafId);rafId=0;}
      // финальный flush (если что-то ожидало)
      if(pending&&drag.current){flush();}
      drag.current=null;
      document.body.style.userSelect='';
      document.body.style.cursor='';
    };
    window.addEventListener('mousemove',move);
    window.addEventListener('mouseup',up);
    return()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);if(rafId)cancelAnimationFrame(rafId);};
  },[]);
  const handleRef=art=>{setNpa(art);setHilite(art);setRightOpen(true);setTimeout(()=>setHilite(null),2200);addToast('book','Ст. '+art)};
  const handleActPanel=id=>{if(id==='outline'){setSideMode('outline');setLeftOpen(true)}else{setSideMode('tree');setActPanel(id);if(id&&!leftOpen)setLeftOpen(true);else if(!id)setLeftOpen(false)}};
  const nextTour=()=>{if(tourStep!==null){if(tourStep<TOUR_STEPS.length-1)setTourStep(tourStep+1);else{setTourStep(null);localStorage.setItem('myz-tour','1')}}};
  const closeTour=()=>{setTourStep(null);localStorage.setItem('myz-tour','1')};
  const unsavedCount=tabs.filter(t=>t.mod).length;

  useEffect(() => {
    const el = document.getElementById('superdoc-wrapper');
    if (!el) return;
    let timeoutId = null;
    const observer = new ResizeObserver(() => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        if (window.docEngine && typeof window.docEngine.layout === 'function') {
          window.docEngine.layout();
        }
      }, 80); // 80ms debounce for smoother resizing
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return(
    <div className={(dark?'dk ':'')+(tt?'tt ':'')+'grain'} style={{width:'100vw',height:'100vh',display:'flex',flexDirection:'column',backgroundColor:'var(--bg-editor)',backgroundImage:'var(--grad-mesh)',color:'var(--text)',overflow:'hidden',fontFamily:'var(--font-sans)',letterSpacing:'-.01em'}}>
      <MenuBar dark={dark} onToggle={toggleTheme} onPalette={()=>setShowPalette(p=>!p)} showNotif={showNotif} onToggleNotif={()=>setShowNotif(p=>!p)} onAction={handleAction} rightOpen={rightOpen} onToggleRight={()=>setRightOpen(p=>!p)} isMobile={isMobile} unsavedCount={unsavedCount} hasActiveDoc={tabs.length > 0}/>
      {({}).visible && (
        <div id="inline-prompt-menu" style={{
          position: 'fixed', zIndex: 9999,
          top: Math.max(0, ({}).top - 40), left: Math.max(0, ({}).left - 10),
          background: 'var(--bg-panel)', borderRadius: '8px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
          padding: '6px 12px', border: '1px solid var(--accent)',
          display: 'flex', alignItems: 'center', gap: '8px',
          width: '380px', maxWidth: '90vw',
          animation: 'myz-fade-up 0.2s ease-out forwards',
          transformOrigin: 'top left'
        }}>
          <style>{`
            @keyframes myz-fade-up {
              from { opacity: 0; transform: translateY(10px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .myz-badge-fade {
              animation: myz-fade-in 0.3s ease-out forwards;
            }
            @keyframes myz-fade-in {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>
          <Ico k="sparkles" sz={16} col="var(--accent)" grad glow />
          <input 
            type="text" autoFocus disabled={({}).isStreaming}
            placeholder={
              ({}).isStreaming ? "Генерация текста..." : 
              ({}).streamStartPos !== null ? "Нажмите Tab чтобы принять, Esc чтобы отменить" : 
              "Спросите ИИ (изменить или дополнить текст)..."
            }
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              fontSize: '13.5px', color: 'var(--text)', fontFamily: 'inherit',
              opacity: ({}).isStreaming ? 0.6 : 1,
              transition: 'all 0.3s ease'
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (({}).isStreaming && window.__inlineAbort) {
                  window.__inlineAbort.abort();
                }
                try {
                  if (({}).streamStartPos !== null && ({}).streamEndPos !== null && window.docEngine) {
                    const view = window.docEngine.view;
                    const tr = view.state.tr;
                    if (({}).streamEndPos <= view.state.doc.content.size) {
                      tr.delete(({}).streamStartPos, ({}).streamEndPos);
                      view.dispatch(tr);
                    }
                  }
                } catch(err) { console.error('Delete error', err); }
                /* setInlinePrompt */
                window.docEngine?.commands.focus();
              } else if (e.key === 'Tab') {
                if (({}).streamStartPos !== null && ({}).streamEndPos !== null && window.docEngine) {
                  e.preventDefault();
                  try {
                    const view = window.docEngine.view;
                    const { tr, schema } = view.state;
                    if (schema.marks.agentPending && ({}).streamEndPos <= view.state.doc.content.size) {
                      tr.removeMark(({}).streamStartPos, ({}).streamEndPos, schema.marks.agentPending);
                      view.dispatch(tr);
                    }
                  } catch(err) { console.error('Accept error', err); }
                  /* setInlinePrompt */
                  window.docEngine?.commands.focus();
                }
              } else if (e.key === 'Enter' && !({}).isStreaming && ({}).streamStartPos === null) {
                e.preventDefault();
                const val = e.target.value.trim();
                if (val) {
                  const startPos = ({}).pos;
                  /* setInlinePrompt */
                  let currentPos = startPos;
                  
                  const abortController = new AbortController();
                  window.__inlineAbort = abortController;

                  const streamAIResponse = async (prompt, documentContext, onChunk) => {
                    try {
                      const res = await fetch(`${_ensureBackend()}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          message: prompt,
                          history: [{ role: 'user', content: `Контекст документа:\n${documentContext}\n\nЗапрос на вставку текста. В ответе только сгенерированный новый юридический текст, без вводных слов и пояснений.` }],
                          mode: 'fast'
                        }),
                        signal: abortController.signal
                      });
                      if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
                      const reader = res.body.getReader();
                      const decoder = new TextDecoder();
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n');
                        for (const line of lines) {
                          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                            try {
                              const data = JSON.parse(line.slice(6));
                              if (data.text) onChunk(data.text);
                            } catch (e) {}
                          }
                        }
                      }
                    } catch (err) {
                      if (err.name === 'AbortError') {
                        console.log('Stream aborted');
                      } else {
                        console.error('Stream error:', err);
                        addToast('warning', 'Сбой ИИ: ' + err.message);
                      }
                      throw err;
                    } finally {
                      window.__inlineAbort = null;
                    }
                  };

                  let context = '';
                  if (window.docEngine) {
                    const txt = window.docEngine.doc.getText({});
                    context = txt.slice(Math.max(0, currentPos - 1500), currentPos + 1500);
                  }

                  streamAIResponse(val, context, (textToken) => {
                    if (!window.docEngine) return;
                    try {
                      const view = window.docEngine.view;
                      const { tr, schema } = view.state;
                      
                      // Защита от смещения курсора (выхода за границы)
                      if (currentPos > view.state.doc.content.size) {
                        currentPos = view.state.selection.from;
                      }

                      tr.insertText(textToken, currentPos);
                      const from = ({}).pos;
                      const to = currentPos + textToken.length;
                      
                      if (schema.marks.agentPending) {
                        tr.addMark(from, to, schema.marks.agentPending.create({ kind: 'insert' }));
                      }

                      view.dispatch(tr);
                      currentPos += textToken.length;
                    } catch(err) {
                       console.warn('Chunk insert error:', err);
                    }
                  }).then(() => {
                    /* setInlinePrompt */
                  }).catch(() => {
                    /* setInlinePrompt */
                  });
                }
              }
            }}
          />
          {({}).streamStartPos !== null && !({}).isStreaming && (
            <div className="myz-badge-fade" style={{display:'flex', gap:4, whiteSpace:'nowrap'}}>
              <span style={{fontSize: 11, color: 'var(--text)', background: 'var(--accent-dim)', padding: '3px 6px', borderRadius: 4, border: '1px solid var(--accent)'}}>Tab - Принять</span>
              <span style={{fontSize: 11, color: 'var(--text)', background: 'var(--bg-editor)', padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)'}}>Esc - Отменить</span>
            </div>
          )}
        </div>
      )}
      <div style={{flex:1,display:'flex',overflow:'hidden',position:'relative'}}>
        <ActBar active={actPanel} onSet={handleActPanel}/>
        {/* LEFT PANEL — desktop: inline-flex; mobile: fixed overlay */}
        <div style={isMobile
          ? {position:'fixed',top:0,left:48,bottom:0,width:'min(360px, calc(100vw - 60px))',background:'var(--bg-panel)',borderRight:'1px solid var(--border)',transform:leftOpen?'translateX(0)':'translateX(-110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:leftOpen?'4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {width:leftOpen?leftW:0,flexShrink:0,overflow:'hidden',borderRight:leftOpen?'1px solid var(--border)':'none',background:'var(--bg-panel)',transition:'none'}}>
          {leftOpen && <LeftPanel mode={sideMode} actPanel={actPanel} onClose={()=>{setLeftOpen(false);setActPanel(null)}} onCtx={(x,y,items)=>setCtxMenu({x,y,items})} onToast={addToast} onOpenFile={name=>handleAction('openFile',name)} fsHandle={fsHandle} fsFiles={fsFiles} onOpenFolder={openFolder} onPickFile={()=>handleAction('openFromDisk')} onAction={handleAction} tabs={tabs} activeTab={activeTab} onSwitchTab={switchTab} onCloseTab={closeTab} recentFiles={recentFiles}/>}
        </div>
        {leftOpen && !isMobile && <Handle onMD={startDrag('l')}/>}
        {/* EDITOR — always full width on mobile */}
        <div id="superdoc-wrapper" className="superdoc-workspace-wrapper" style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {useMemo(() => {
            const currentTab = tabs.find(t => t.id === activeTab);
            const isValidDocx = currentTab?.buffer && currentTab.buffer instanceof ArrayBuffer;
            const docFile = isValidDocx ? new Blob([currentTab.buffer]) : null;
            return (
              <>
              <SuperDocEditor 
                key={`${activeTab}_${currentTab?.buffer?.byteLength || 0}`}
                document={docFile} 
                documentMode="editing" 
                fonts={{ assetBaseUrl: '/superdoc-fonts/' }}
                toolbar={{ groups: ['history', 'text', 'paragraph', 'insert', 'list', 'indent', 'font-controls', 'table', 'tools'], fonts: [{ label: 'Times New Roman', key: 'Times New Roman, serif' }] }}
                onReady={(e) => { window.superdoc = e.superdoc; }}
                onEditorCreate={(e) => { window.docEngine = e.editor; }}
                onEditorUpdate={() => { if (window.__shadowTrigger) window.__shadowTrigger(); }}
              />
            </>
            );
          }, [activeTab, tabs.find(t => t.id === activeTab)?.buffer])}
        </div>
        {rightOpen && !isMobile && <Handle onMD={startDrag('r')}/>}
        {/* RIGHT PANEL — desktop: inline-flex; mobile: fixed overlay */}
        <div style={isMobile
          ? {position:'fixed',top:0,right:0,bottom:0,width:'min(420px, 100vw)',background:'var(--bg-app)',borderLeft:'1px solid var(--border)',transform:rightOpen?'translateX(0)':'translateX(110%)',transition:'transform .25s ease',zIndex:1100,boxShadow:rightOpen?'-4px 0 24px rgba(0,0,0,.25)':'none',overflow:'hidden'}
          : {width:rightOpen?rightW:0,flexShrink:0,overflow:'hidden',background:'var(--bg-app)',borderLeft:rightOpen?'1px solid var(--border)':'none',transition:'none'}}>
          {rightOpen && (
            <div id="rp" style={{height:'100%',display:'flex',flexDirection:'column',padding:4,gap:4,boxSizing:'border-box',zoom:0.85}}>
              {/* Шрифт правой панели масштабируется через CSS `zoom` — управляется ResizeObserver в App */}
              {/* Tab-strip to RESTORE collapsed NPA (если NPA свёрнут) */}
              {npaCollapsed && (
                <button type="button" className="myz-pane-tab" onClick={()=>setNpaCollapsed(false)}
                  title="Развернуть НПА" aria-label="Развернуть НПА">
                  <Ico k="book" sz={12} col="var(--primary)"/>
                  <span>{tr('pane_npa')}</span>
                  <span className="myz-pane-tab-chev">▾</span>
                </button>
              )}

              {/* NPA section */}
              {!npaCollapsed && (
                <div style={{
                  height: chatCollapsed ? '100%' : (rightSplit+'%'),
                  flex: chatCollapsed ? '1 1 0' : '0 0 auto',
                  overflow:'hidden',
                  minHeight:0
                }}>
                  <NPAView
                    art={npa}
                    npaTabs={npaTabs}
                    activeNpaTabId={activeNpaTabId}
                    onSwitchNpaTab={setActiveNpaTabId}
                    onCloseNpaTab={closeNpaTab}
                    onClose={()=>setRightOpen(false)}
                    onCollapse={collapseNpa}
                    onNav={openNpa}
                  />
                </div>
              )}

              {/* Resize handle — only when both panes are visible */}
              {!isMobile && !npaCollapsed && !chatCollapsed && <Handle vert onMD={startDrag('rv')}/>}

              {/* Chat section */}
              {!chatCollapsed && (
                <div style={{flex:'1 1 0', overflow:'hidden', minHeight:0}}>
                  <AIChat onToast={addToast} onCollapse={collapseChat} onOpenArticle={(art)=>{setNpa(art);setHilite(art);setRightOpen(true);setNpaCollapsed(false);setTimeout(()=>setHilite(null),2200);addToast('book','Ст. '+art);}}/>
                </div>
              )}

              {/* Tab-strip to RESTORE collapsed Chat (если Chat свёрнут) */}
              {chatCollapsed && (
                <button type="button" className="myz-pane-tab" onClick={()=>setChatCollapsed(false)}
                  title="Развернуть ИИ-чат" aria-label="Развернуть ИИ-чат">
                  <Ico k="sparkles" sz={12} col="var(--accent)"/>
                  <span>{tr('pane_chat')}</span>
                  <span className="myz-pane-tab-chev">▴</span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* Mobile backdrop — close panels on tap outside */}
        {isMobile && (leftOpen||rightOpen) && (
          <div onClick={()=>{setLeftOpen(false);setRightOpen(false);setActPanel(null)}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.45)',zIndex:1050,backdropFilter:'blur(2px)',animation:'fadeIn .2s ease'}}/>
        )}
      </div>
      {showPalette && <Palette onClose={()=>setShowPalette(false)} dark={dark} onAction={handleAction}/>}
      {showShortcuts && <ShortcutOverlay onClose={()=>setShowShortcuts(false)}/>}
      {showOriginal && (()=>{const tt=tabs.find(t=>t.id===activeTab);return tt&&tt.buffer?<DocxPreview buffer={tt.buffer} name={tt.name} onClose={()=>setShowOriginal(false)}/>:null})()}
      {showTweaks && (
        <div style={{position:'fixed',bottom:40,right:16,width:220,background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'10px',boxShadow:'var(--shadow-lg)',zIndex:500,overflow:'hidden',animation:'fadeInScale .2s ease'}}>
          <div style={{padding:'8px 12px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <span style={{fontSize:11,fontWeight:600,color:'var(--muted)',letterSpacing:'.06em',textTransform:'uppercase'}}>Параметры</span>
            <button onClick={()=>setShowTweaks(false)} style={{background:'transparent',border:'none',cursor:'pointer',color:'var(--muted)'}}>
              <Ico k="x" sz={13}/>
            </button>
          </div>
          <div style={{padding:'10px 12px'}}>
            <div style={{fontSize:11,color:'var(--muted)',marginBottom:5}}>Акцент</div>
            <div style={{display:'flex',gap:6,marginTop:4}}>
              {['#D97757','#5B8DEF','#2EA043','#A855F7','#E8505B'].map(c=>(
                <button
                  key={c}
                  type="button"
                  aria-label={'Акцент '+c}
                  aria-pressed={tweaks.accent===c?'true':'false'}
                  onClick={()=>changeTweak('accent',c)}
                  style={{
                    width:22,
                    height:22,
                    borderRadius:'var(--radius-circle)',
                    background:c,
                    cursor:'pointer',
                    padding:0,
                    border:tweaks.accent===c?'2px solid var(--text)':'2px solid transparent',
                    boxShadow:tweaks.accent===c?'0 0 10px '+c+'44':'none',
                    transition:'transform .1s'
                  }}
                  onMouseEnter={e=>e.currentTarget.style.transform='scale(1.15)'}
                  onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <ToastContainer toasts={toasts} onRemove={removeToast}/>
      {ctxMenu && <CtxMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={()=>setCtxMenu(null)}/>}
      {tourStep!==null && <TourStep step={TOUR_STEPS[tourStep]} total={TOUR_STEPS.length} onNext={nextTour} onClose={closeTour}/>}
    </div>
  );
};
export default App;
