import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import url from 'url';
import 'dotenv/config';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY            = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
    console.error('ОШИБКА: Проверьте .env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY)');
    process.exit(1);
}

const supabase   = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI      = new GoogleGenerativeAI(GEMINI_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: 'gemini-embedding-2' });

// Управляемый параллелизм:
//   CONCURRENCY волн по 6 параллельных запросов + WAVE_DELAY мс между волнами
//   → ~50 req/sec стабильно без всплесков
//   (старый вариант: 100 параллельных без пауз → шторм 429)
const CONCURRENCY = 6;    // параллельных эмбеддинг-запросов за волну
const WAVE_DELAY  = 100;  // мс между волнами
const DB_BATCH    = 50;   // чанков за один upsert в БД

const FOLDERS = [
    { category: 'npa',          folderPath: path.join(__dirname, 'output', 'npa')  },
    { category: 'instructions', folderPath: path.join(__dirname, 'output', 'scon') },
    { category: 'court_acts',   folderPath: path.join(__dirname, 'output', 'sud')  },
];

// Экспоненциальный backoff для 429 / 503
async function withBackoff(fn, maxRetries = 6, baseMs = 1000) {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (err) {
            const is429 = err.status === 429 || String(err.message).includes('429');
            const is503 = err.status === 503 || String(err.message).includes('503');
            if ((!is429 && !is503) || i >= maxRetries) throw err;
            const delay = baseMs * Math.pow(2, i) + Math.random() * 500;
            console.warn(`  ⏳ ${err.status ?? '429/503'} — жду ${Math.round(delay)}мс (попытка ${i + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function getEmbedding(text) {
    return withBackoff(async () => {
        const r = await embedModel.embedContent({
            content: { parts: [{ text }] },
            outputDimensionality: 1536
        });
        return r.embedding.values;
    });
}

// Векторизация волнами: CONCURRENCY параллельных за раз + WAVE_DELAY между волнами
// Возвращает [{item, embedding}] — только успешные
async function embedInWaves(items) {
    const results = [];
    const totalWaves = Math.ceil(items.length / CONCURRENCY);

    for (let i = 0; i < items.length; i += CONCURRENCY) {
        const wave = items.slice(i, i + CONCURRENCY);
        const waveIdx = Math.floor(i / CONCURRENCY) + 1;

        const waveResults = await Promise.allSettled(
            wave.map(item => {
                const text = item.content?.text_to_embed || item.content?.full_text;
                if (!text) return Promise.reject(new Error('no text'));
                return getEmbedding(text).then(emb => ({ item, embedding: emb }));
            })
        );

        let ok = 0;
        for (const res of waveResults) {
            if (res.status === 'fulfilled') { results.push(res.value); ok++; }
            else console.error(`  ❌ Эмбеддинг [${res.reason?.message}]`);
        }
        process.stdout.write(`\r  🌊 Волна ${waveIdx}/${totalWaves} — эмбеддинги ${results.length}/${items.length}`);

        if (i + CONCURRENCY < items.length) {
            await new Promise(r => setTimeout(r, WAVE_DELAY));
        }
    }
    console.log(); // перенос строки после \r
    return results;
}

// Запись в БД пачками по DB_BATCH
async function upsertToDB(embedded, category) {
    let saved = 0;
    for (let i = 0; i < embedded.length; i += DB_BATCH) {
        const batch = embedded.slice(i, i + DB_BATCH);
        const records = batch.map(({ item, embedding }) => ({
            id:              String(item.id),
            category,
            content:         item.content?.full_text || '',
            embedding,
            article_num_str: item.article_num_str ?? null,
            article_base:    item.article_base    ?? null,
            part_base:       item.part_base       ?? null,
            item_base:       item.item_base       ?? null,
            subitem_base:    item.subitem_base     ?? null,
            metadata:        item.metadata        ?? {}
        }));
        const { error } = await supabase.from('documents').upsert(records, { onConflict: 'id' });
        if (error) console.error(`  ❌ БД ошибка (batch ${i / DB_BATCH + 1}):`, error.message);
        else saved += records.length;
    }
    return saved;
}

// Загружаем существующие ID для delta-загрузки (не дублируем)
async function fetchExistingIds(category) {
    const ids = new Set();
    let from = 0;
    for (;;) {
        const { data, error } = await supabase
            .from('documents')
            .select('id')
            .eq('category', category)
            .range(from, from + 999);
        if (error || !data?.length) break;
        data.forEach(r => ids.add(r.id));
        if (data.length < 1000) break;
        from += 1000;
    }
    return ids;
}

async function main() {
    console.log('🚀 Hybrid Search Uploader — Sniper RAG 3.0');
    console.log(`   Параллелизм: ${CONCURRENCY} волна | Задержка между волнами: ${WAVE_DELAY}мс | БД-батч: ${DB_BATCH}\n`);
    let grandTotal = 0;

    for (const { category, folderPath } of FOLDERS) {
        let files;
        try { files = await fs.readdir(folderPath); }
        catch { continue; }

        const jsonFiles = files.filter(f => f.endsWith('.json'));
        if (!jsonFiles.length) continue;

        // Загружаем файлы, группируем по НПА (abbrev из первого чанка)
        // Если один закон оказался в двух JSON-файлах — берём файл с бо́льшим числом чанков
        const npaFileMap = new Map(); // abbrev → { filename, chunks[] }

        for (const f of jsonFiles) {
            let chunks;
            try {
                const raw = JSON.parse(await fs.readFile(path.join(folderPath, f), 'utf-8'));
                chunks = Array.isArray(raw) ? raw : [raw];
            } catch (e) {
                console.error(`  ⚠️  Ошибка чтения ${f}:`, e.message);
                continue;
            }
            if (!chunks.length) continue;

            // Ключ дедупликации НПА: npa_title — уникален для каждого документа.
            // abbrev не подходит: ГК КР часть 1 и часть 2 имеют одинаковый abbrev,
            // но разный npa_title → правильно считаются разными НПА.
            const key = chunks[0]?.metadata?.npa_title
                     || chunks[0]?.metadata?.abbrev
                     || f;

            const existing = npaFileMap.get(key);
            if (!existing || chunks.length > existing.chunks.length) {
                if (existing) {
                    console.log(`  ⚠️  Дубль НПА «${key}»: заменяем "${existing.filename}" (${existing.chunks.length} чанков) → "${f}" (${chunks.length} чанков)`);
                }
                npaFileMap.set(key, { filename: f, chunks });
            } else {
                console.log(`  ⚠️  Дубль НПА «${key}»: пропускаем "${f}" (${chunks.length} чанков) — уже есть "${existing.filename}" (${existing.chunks.length} чанков)`);
            }
        }

        let allData = [];
        for (const { chunks } of npaFileMap.values()) allData = allData.concat(chunks);
        console.log(`\n📂 [${category}] Уникальных НПА: ${npaFileMap.size} из ${jsonFiles.length} файлов → ${allData.length} чанков`);

        // DELTA: убираем уже загруженные в БД
        const existingIds = await fetchExistingIds(category);
        const delta = allData.filter(item => !existingIds.has(String(item.id)));

        if (!delta.length) {
            console.log(`✔️  [${category}] — нет новых чанков (${allData.length} уже в БД).`);
            continue;
        }
        console.log(`\n📦 [${category}] Новых чанков: ${delta.length} (всего уникальных: ${allData.length}, в БД уже: ${existingIds.size})`);

        // Эмбеддинги волнами
        const embedded = await embedInWaves(delta);
        console.log(`  ✅ Векторизовано: ${embedded.length}/${delta.length}`);

        // Запись в БД
        const saved = await upsertToDB(embedded, category);
        console.log(`  💾 Сохранено в БД: ${saved} чанков`);

        grandTotal += saved;
    }

    console.log(`\n🎉 Готово! Загружено чанков: ${grandTotal}`);
}

main();
