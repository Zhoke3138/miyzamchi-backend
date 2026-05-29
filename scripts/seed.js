require('dotenv').config({ path: '../.env' }); // Грузим .env из корня
const fs = require('fs');
const path = require('path');
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация клиентов
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'miyzamchi-index';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  console.log("🚀 Запуск процесса индексации законов...");

  if (!process.env.PINECONE_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("❌ Отсутствуют ключи API в .env (PINECONE_API_KEY, GEMINI_API_KEY)");
    process.exit(1);
  }

  // Проверка папки data
  if (!fs.existsSync(DATA_DIR)) {
      console.error(`❌ Папка с данными 'data' не найдена в корне проекта.`);
      console.log("Пожалуйста, создайте папку 'data' и положите туда JSON-файлы.");
      process.exit(1);
  }

  const index = pc.Index(INDEX_NAME);
  const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

  const files = fs.readdirSync(DATA_DIR).filter(file => file.endsWith('.json'));
  if (files.length === 0) {
      console.log("ℹ️ В папке data/ нет JSON-файлов для загрузки.");
      return;
  }

  for (const file of files) {
      console.log(`\n📄 Обработка файла: ${file}`);
      const filePath = path.join(DATA_DIR, file);
      
      try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const records = JSON.parse(fileContent);

          if (!Array.isArray(records)) {
              console.warn(`⚠️ Файл ${file} не является массивом JSON. Пропускаю.`);
              continue;
          }

          const BATCH_SIZE = 50; 
          let vectors = [];

          for (let i = 0; i < records.length; i++) {
              const record = records[i];
              
              const text = record.text;
              const docTitle = record.document_title || "Неизвестный документ";
              const artNum = record.article_number || "Б/Н";
              const artTitle = record.article_title || "";

              if (!text) {
                  continue;
              }

              try {
                  // Генерируем эмбеддинг через Gemini
                  const result = await embeddingModel.embedContent(text);
                  const embedding = result.embedding.values;

                  // Уникальный ID на основе имени файла и номера для предотвращения дублей
                  const id = `doc_${file.replace('.json', '')}_art_${artNum}_idx_${i}`.replace(/[^a-zA-Z0-9_\-]/g, '_');

                  vectors.push({
                      id: id,
                      values: embedding,
                      metadata: {
                          text: text,
                          document_title: docTitle,
                          article_number: artNum,
                          article_title: artTitle
                      }
                  });

                  // Загрузка батчами для экономии ресурсов и соблюдения лимитов Pinecone
                  if (vectors.length >= BATCH_SIZE) {
                      await index.upsert(vectors);
                      console.log(`✅ Загружен батч из ${vectors.length} векторов...`);
                      vectors = []; // Очистка
                  }

              } catch (embedError) {
                  console.error(`❌ Ошибка генерации эмбеддинга для записи [${i}]:`, embedError.message);
              }
          }

          // Догружаем остаток
          if (vectors.length > 0) {
              await index.upsert(vectors);
              console.log(`✅ Загружен остаток из ${vectors.length} векторов для ${file}`);
          }
          
          console.log(`🎉 Файл ${file} успешно проиндексирован!`);

      } catch (err) {
          console.error(`❌ Ошибка обработки файла ${file}:`, err.message);
      }
  }

  console.log("\n✅ Процесс индексации завершен.");
}

main().catch(console.error);
