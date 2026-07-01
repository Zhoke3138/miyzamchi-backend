import fs from 'fs';
import path from 'path';
import url from 'url';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const INPUT_DIR  = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output', 'npa');

if (!fs.existsSync(INPUT_DIR))  fs.mkdirSync(INPUT_DIR,  { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const genAI      = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

// ═══════════════════════════════════════════════════════════════
// 1. МАППИНГИ: аббревиатура → код для ID, домен
// ═══════════════════════════════════════════════════════════════

const ABBREV_CODE = {
    'НК КР': 'nk-kr',  'ГК КР': 'gk-kr',   'ТК КР':  'tk-kr',
    'УК КР': 'uk-kr',  'УПК КР': 'upk-kr',  'КоАО КР':'koao-kr',
    'КоАО':  'koao-kr','ЖК КР': 'zhk-kr',   'ЗК КР':  'zk-kr',
    'БК КР': 'bk-kr',  'СК КР': 'sk-kr',    'ТмК КР': 'tmk-kr',
};

function abbrevToCode(abbrev) {
    if (ABBREV_CODE[abbrev]) return ABBREV_CODE[abbrev];
    // Fallback для неизвестных аббревиатур
    return abbrev.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, 'x').slice(0, 15);
}

const DOMAIN_RULES = [
    { re: /НК КР|налог|акциз|таможен/i,                              domain: 'tax'      },
    { re: /ТК КР|трудов|занятост|профсоюз/i,                         domain: 'labor'    },
    { re: /ГК КР|ЖК КР|ЗК КР|СК КР|семейн|жилищн|земельн|гражданск/i, domain: 'civil' },
    { re: /УПК КР|уголовно-процессуальн/i,                           domain: 'criminal' },
    { re: /УК КР|уголовн/i,                                           domain: 'criminal' },
    { re: /КоАО|административн|госзакупк|нотариат/i,                  domain: 'admin'   },
];

function detectDomain(abbrev, npa_title) {
    const s = `${abbrev} ${npa_title}`;
    for (const { re, domain } of DOMAIN_RULES) if (re.test(s)) return domain;
    return 'other';
}

// ═══════════════════════════════════════════════════════════════
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════

function convertSuperscripts(html) {
    const m = { '1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','0':'⁰' };
    return html.replace(/<sup>(\d)<\/sup>/gi, (_, d) => m[d] || `-${d}`);
}

async function extractMetadataWithGemini(rawText) {
    try {
        const prompt = `Извлеки название акта и дату из текста. Верни строго JSON без пояснений:\n{"npa_title":"НАЗВАНИЕ","adoption_date":"ДАТА","abbrev":"АББРЕВИАТУРА (например НК КР)"}\n\nТекст:\n${rawText.substring(0, 3000)}`;
        const r = await geminiModel.generateContent(prompt);
        return JSON.parse(r.response.text().replace(/```json|```/gi, '').trim());
    } catch {
        return { npa_title: 'Неизвестный акт', adoption_date: 'Без даты', abbrev: 'НПА' };
    }
}

// FIX: заменяет async LLM checkChunkIndependence — экономия ~10 000 API-вызовов на 138 НПА
function isStandalone(text) {
    const t = text.trim();
    if (/^[а-яА-Я]\)\s?/.test(t)) return false;   // подпункты а), б) → всегда клеить
    if (t.length < 40) return false;                // слишком короткий
    if (t.length >= 120) return true;               // достаточно длинный
    // 40–119 символов: самостоятельный если есть юридическая субстанция
    return /[—–]|обязан|вправе|запрещ|признает|является|считает|применяет|устанавлив/i.test(t);
}

function tableToMarkdown($, el) {
    let md = '\n';
    $(el).find('tr').each((i, tr) => {
        const row = [];
        $(tr).find('th, td').each((_, td) => row.push($(td).text().trim().replace(/\n/g, ' ')));
        if (!row.length) return;
        md += '| ' + row.join(' | ') + ' |\n';
        if (i === 0) md += '|' + row.map(() => '---').join('|') + '|\n';
    });
    return md + '\n';
}

// Нормализация: 101¹ → "101-1", 197-1 → "197-1"
function normalizeArticleNum(base, suffix) {
    if (!suffix) return String(base);
    const sup = { '¹':1,'²':2,'³':3,'⁴':4,'⁵':5,'⁶':6,'⁷':7,'⁸':8,'⁹':9 };
    return `${base}-${sup[suffix] ?? suffix}`;
}

// FIX: детерминированный ID — upsert работает без дублей
function buildId(abbrev, article_num_str, part_base, item_base, subitem_base) {
    let id = `kg_${abbrevToCode(abbrev)}`;
    if (article_num_str != null) id += `_art-${article_num_str}`;
    if (part_base  != null)      id += `_part-${part_base}`;
    if (item_base  != null)      id += `_item-${item_base}`;
    if (subitem_base)             id += `_sub-${subitem_base}`;
    return id;
}

function makeTextToEmbed(abbrev, hierarchy, article_title, parent_context, element_type, part_base, part_total, full_text) {
    const typeLabel = part_base != null
        ? `${element_type} ${part_base} из ${part_total ?? '?'}`
        : element_type;
    // Не дублируем article_title если parent_context уже начинается с него
    const ctx = parent_context && parent_context.startsWith(article_title)
        ? parent_context
        : [article_title, parent_context].filter(Boolean).join('\n');
    // Не дублируем full_text если он уже начинается с article_title
    const body = full_text.startsWith(article_title)
        ? full_text.slice(article_title.length).trimStart()
        : full_text;
    return `[${abbrev}] ${hierarchy}\n${ctx}\nТип: ${typeLabel}\nТекст: ${body || full_text}`.trim();
}

// ═══════════════════════════════════════════════════════════════
// 3. СОЗДАНИЕ ЧАНКА
// ═══════════════════════════════════════════════════════════════

function createChunk(s, npa_title, adoption_date, abbrev, domain) {
    return {
        id:              buildId(abbrev, s.article_num_str, s.part_base, s.item_base, s.subitem_base),
        article_num_str: s.article_num_str,
        article_base:    s.article_base,
        part_base:       s.part_base,
        item_base:       s.item_base,
        subitem_base:    s.subitem_base || null,
        content: {
            full_text:     s.text_buffer,
            text_to_embed: ''   // заполняется во 2-м проходе после подсчёта part_total
        },
        metadata: {
            npa_title,
            adoption_date,
            abbrev,
            domain,                              // FIX: поле domain теперь присутствует
            hierarchy_path:  s.hierarchy,
            article_title:   s.article_title,    // FIX: добавлено для поиска по названию статьи
            parent_context:  s.parent_context,
            element_type:    s.element_type,
            part_total:      null                 // заполняется во 2-м проходе
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// 4. ГЛАВНЫЙ ПРОЦЕССОР
// ═══════════════════════════════════════════════════════════════

async function processFile(filename) {
    const inputPath = path.join(INPUT_DIR, filename);
    try {
        const rawText = (await mammoth.extractRawText({ path: inputPath })).value;
        console.log(`\n🤖 Анализ шапки: ${filename}...`);
        const { npa_title, adoption_date, abbrev } = await extractMetadataWithGemini(rawText);
        const domain = detectDomain(abbrev, npa_title);
        console.log(`   → "${npa_title}" [${abbrev}] domain:${domain}`);

        const html = convertSuperscripts((await mammoth.convertToHtml({ path: inputPath })).value);
        const $    = cheerio.load(html);
        const chunks = [];

        // Состояние парсера
        const s = {
            section: '', chapter: '', hierarchy: '',
            article_base: null, article_num_str: null, article_title: '',
            part_base: null, item_base: null, subitem_base: null,
            parent_context: '', text_buffer: '', element_type: ''
        };

        for (const el of $('p, table').toArray()) {
            const isTable = el.tagName === 'table';
            let text = isTable
                ? tableToMarkdown($, el)
                : $(el).text().trim().replace(/\s+/g, ' ');
            if (!text || text.length < 2) continue;

            // ── Структурные заголовки (не создают чанки, только обновляют иерархию) ──
            if (/^Раздел\s+[IVXLCDM\d]+/i.test(text)) {
                s.section = text; s.chapter = '';
                s.hierarchy = text;
                continue;
            }
            if (/^Глава\s+\d+/i.test(text)) {
                s.chapter   = text;
                s.hierarchy = [s.section, text].filter(Boolean).join(' > ');
                continue;
            }
            if (/^Параграф\s+\d+/i.test(text)) {
                s.hierarchy = [s.section, s.chapter, text].filter(Boolean).join(' > ');
                continue;
            }
            if (!s.hierarchy) s.hierarchy = [s.section, s.chapter].filter(Boolean).join(' > ');

            // ── 4 уровня вложенности ──────────────────────────────────────────────
            // artMatch — "Статья N", "Статья N-M", "Статья N¹"
            const artMatch = text.match(
                /^Статья\s+(\d+)(?:[-](\d+)|([¹²³⁴⁵⁶⁷⁸⁹]))?(?:[.\-:\s)]+)/i
            );
            // partMatch / itemMatch / subMatch — только внутри активной статьи
            const partMatch = s.article_base != null
                ? text.match(/^Часть\s+(\d+)/i)
                : null;
            // FIX: itemMatch ловит "1. " и "1) " (до 999 чтобы не ловить года)
            const itemMatch = s.article_base != null
                ? text.match(/^(\d{1,3})[.)]\s*/)
                : null;
            const subMatch  = s.article_base != null
                ? text.match(/^([а-яА-Я])\)\s*/)
                : null;

            const newLevel = artMatch || partMatch || itemMatch || subMatch;

            // ── Финализация предыдущего буфера ───────────────────────────────────
            if (newLevel && s.text_buffer) {
                if (isStandalone(s.text_buffer)) {
                    chunks.push(createChunk(s, npa_title, adoption_date, abbrev, domain));
                } else {
                    // Короткий фрагмент клеим к parent_context следующего чанка
                    s.parent_context += '\n' + s.text_buffer;
                }
                s.text_buffer = '';
            }

            // ── Обновление состояния ─────────────────────────────────────────────
            if (artMatch) {
                s.article_base    = parseInt(artMatch[1], 10);
                s.article_num_str = normalizeArticleNum(artMatch[1], artMatch[2] || artMatch[3]);
                s.article_title   = text;
                s.part_base = null; s.item_base = null; s.subitem_base = null;
                s.element_type    = 'статья_целиком';
                s.parent_context  = text;
                s.text_buffer     = text;
            } else if (partMatch) {
                s.part_base       = parseInt(partMatch[1], 10);
                s.item_base = null; s.subitem_base = null;
                s.element_type    = 'часть';
                s.parent_context  = `${s.article_title} > ${text}`;
                s.text_buffer     = text;
            } else if (itemMatch) {
                s.item_base       = parseInt(itemMatch[1], 10);
                s.subitem_base    = null;
                s.element_type    = 'пункт';
                s.parent_context  = `${s.article_title} > Пункт ${s.item_base}`;
                s.text_buffer     = text;
            } else if (subMatch) {
                s.subitem_base    = subMatch[1];
                s.element_type    = 'подпункт';
                s.text_buffer     = text;
            } else {
                s.text_buffer    += '\n' + text;
            }
        }

        // Финализируем последний буфер
        if (s.text_buffer && isStandalone(s.text_buffer)) {
            chunks.push(createChunk(s, npa_title, adoption_date, abbrev, domain));
        }

        // ── Проход 2: подсчёт part_total + финальный text_to_embed ──────────────
        const maxPart = {};
        for (const c of chunks) {
            if (c.article_num_str != null && c.part_base != null) {
                const k = c.article_num_str;
                maxPart[k] = Math.max(maxPart[k] || 0, c.part_base);
            }
        }
        for (const c of chunks) {
            const pt = c.article_num_str != null ? (maxPart[c.article_num_str] || 1) : 1;
            c.metadata.part_total   = pt;
            c.content.text_to_embed = makeTextToEmbed(
                c.metadata.abbrev,
                c.metadata.hierarchy_path,
                c.metadata.article_title,
                c.metadata.parent_context,
                c.metadata.element_type,
                c.part_base,
                pt,
                c.content.full_text
            );
        }

        // Сохраняем JSON
        const safeName   = npa_title.replace(/[/\\:*?"<>|]/g, '_').substring(0, 50);
        const outputPath = path.join(OUTPUT_DIR, `${safeName}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(chunks, null, 2), 'utf-8');
        console.log(`✅ ${chunks.length} чанков → output/npa/${safeName}.json`);
        return { status: 'success', chunks: chunks.length };

    } catch (e) {
        console.error(`❌ Ошибка файла ${filename}:`, e.message);
        return { status: 'error', chunks: 0 };
    }
}

async function runPipeline() {
    console.log('=== 🚀 ПАРСЕР SNIPER RAG 3.0 ===');
    const files = fs.readdirSync(INPUT_DIR).filter(f => /\.docx?$/i.test(f));
    if (!files.length) { console.log('⚠️  Нет .docx файлов в папке input/'); return; }

    let total = 0;
    for (const f of files) {
        const r = await processFile(f);
        if (r.status === 'success') total += r.chunks;
    }
    console.log(`\n🏁 ГОТОВО. Чанков итого: ${total}`);
}

runPipeline();
