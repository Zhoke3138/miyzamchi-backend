const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();
const { getAIAnswer, extractTextFromMedia, extractTextFromDocument } = require('../logic/ai_service');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

const bot = new Telegraf(token);

// --- ПАМЯТЬ ДИАЛОГОВ ---
const sessions = new Map();
function getHistory(chatId, userId) {
  const key = `${chatId}_${userId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}
function saveToHistory(chatId, userId, userText, aiText) {
  const key = `${chatId}_${userId}`;
  const history = getHistory(chatId, userId);
  history.push({ role: 'user', text: userText });
  history.push({ role: 'assistant', text: aiText });
  if (history.length > 6) history.splice(0, 2);
}

// --- БЕЗОПАСНОЕ ОБНОВЛЕНИЕ СТАТУСА ---
async function safeEdit(ctx, messageId, newText) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, newText);
  } catch (e) {
    // Игнорируем ошибки (если текст совпадает или Телеграм просит не спамить)
  }
}

bot.start((ctx) => {
  ctx.reply('Привет! Я Мыйзамчы. Задайте вопрос, отправьте фото документа, голосовое сообщение или файл (PDF/Word)!');
});

bot.on(['text', 'voice', 'photo', 'document'], async (ctx) => {
  const isGroup = ctx.chat.type !== 'private';
  const isReplyToBot = ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id;
  const botUsername = ctx.botInfo.username || '';
  
  // Умный триггер для группы
  const triggerRegex = new RegExp(`^(@${botUsername}\\s*|мыйзамч[а-я]*\\s*|мизамч[а-я]*\\s*|бот[а-я]*\\s*|\\/ask\\s*)`, 'i');

  let question = "";
  let isMedia = false;
  let fileId = null;
  let mimeType = "";
  let isDoc = false;
  let fileName = "";

  // 1. ОПРЕДЕЛЯЕМ ТИП СООБЩЕНИЯ И ФИЛЬТРУЕМ СПАМ
  if (ctx.message.text) {
    const text = ctx.message.text.trim();
    const match = text.match(triggerRegex);
    if (isGroup && !isReplyToBot && !match) return;
    question = match ? text.substring(match[0].length).trim() : text;
    if (!question && !isReplyToBot) return ctx.reply('Слушаю! Напишите или наговорите ваш вопрос.', { reply_to_message_id: ctx.message.message_id });
  } else if (ctx.message.voice) {
    if (isGroup && !isReplyToBot) return;
    isMedia = true;
    fileId = ctx.message.voice.file_id;
    mimeType = ctx.message.voice.mime_type || 'audio/ogg';
  } else if (ctx.message.photo) {
    const caption = ctx.message.caption || "";
    const match = caption.match(triggerRegex);
    if (isGroup && !isReplyToBot && !match) return;
    question = match ? caption.substring(match[0].length).trim() : caption;
    isMedia = true;
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    mimeType = 'image/jpeg';
  } else if (ctx.message.document) {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || "";
    const match = caption.match(triggerRegex);
    if (isGroup && !isReplyToBot && !match) return;
    question = match ? caption.substring(match[0].length).trim() : caption;
    isMedia = true;
    isDoc = true;
    fileId = doc.file_id;
    mimeType = doc.mime_type || '';
    fileName = doc.file_name || '';
  }

  try {
    await ctx.sendChatAction('typing');
    
    // 2. НАЧАЛЬНЫЙ СТАТУС (Отличается для текста и файлов)
    const initText = isMedia ? '⏳ Получаю файл...' : '⏳ Анализирую ваш вопрос...';
    const statusMsg = await ctx.reply(initText, { reply_to_message_id: ctx.message.message_id });
    
    // Функция-передатчик, которую мы отдадим в мозг
    const updateProgress = async (statusText) => {
      await safeEdit(ctx, statusMsg.message_id, statusText);
    };

    // 3. ОБРАБОТКА МЕДИА (Если есть)
    if (isMedia) {
      await updateProgress('📥 Скачиваю файл с серверов Telegram...');
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      let mediaText = "";
      if (isDoc) {
        await updateProgress('📄 Читаю документ (извлекаю текст)...');
        mediaText = await extractTextFromDocument(buffer, mimeType, fileName);
      } else if (ctx.message.voice) {
        await updateProgress('🎧 Распознаю аудио (Voice-to-Text)...');
        const base64Data = buffer.toString('base64');
        mediaText = await extractTextFromMedia(mimeType, base64Data);
      } else {
        await updateProgress('👁️ Распознаю текст на фото...');
        const base64Data = buffer.toString('base64');
        mediaText = await extractTextFromMedia(mimeType, base64Data);
      }
      
      const userPrompt = question || "Проанализируй этот документ.";
      question = `${userPrompt}\n\n[Текст: ${mediaText}]`;
      await updateProgress('✅ Данные извлечены. Начинаю юридический анализ...');
    }

    const chatId = ctx.message.chat.id;
    const userId = ctx.message.from.id;
    const userHistory = getHistory(chatId, userId);

    // 4. ПЕРЕДАЧА В МОЗГ (Он сам обновит статусы: Векторизация -> База -> Генерация)
    const answer = await getAIAnswer(question, userHistory, updateProgress);
    saveToHistory(chatId, userId, question, answer);

    // 5. ФИНАЛ: Удаляем статус, кидаем ответ
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    await ctx.reply(answer, {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id
    });

  } catch (error) {
    console.error('Ошибка в обработчике:', error);
    ctx.reply('Произошла ошибка при обработке запроса. Возможно, сервера временно перегружены.', { reply_to_message_id: ctx.message.message_id });
  }
});

module.exports = bot;
