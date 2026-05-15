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
// -----------------------

bot.start((ctx) => {
  ctx.reply('Привет! Я Мыйзамчы. Задайте вопрос, отправьте фото документа, голосовое сообщение или файл (PDF/Word)!');
});

// ДОБАВЛЕН 'document' В МАССИВ СЛУШАТЕЛЕЙ
bot.on(['text', 'voice', 'photo', 'document'], async (ctx) => {
  const isGroup = ctx.chat.type !== 'private';
  const isReplyToBot = ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id;
  const botUsername = ctx.botInfo.username || '';
  
  const triggerRegex = new RegExp(`^(@${botUsername}\\s*|мыйзамч[а-я]*\\s*|мизамч[а-я]*\\s*|бот[а-я]*\\s*|\\/ask\\s*)`, 'i');

  let question = "";
  let isMedia = false;
  let fileId = null;
  let mimeType = "";
  let isDoc = false;
  let fileName = "";

  // 1. ОПРЕДЕЛЯЕМ ТИП СООБЩЕНИЯ
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
    
  } else if (ctx.message.document) { // НОВЫЙ БЛОК ДЛЯ ФАЙЛОВ
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
    let statusMsg = null;

    // 2. ОБРАБОТКА ФАЙЛОВ И МУЛЬТИМЕДИА
    if (isMedia) {
      let statusText = '👁️ Изучаю файл...';
      if (ctx.message.voice) statusText = '🎧 Распознаю аудио...';
      else if (isDoc) statusText = '📄 Читаю документ...';

      statusMsg = await ctx.reply(statusText, { reply_to_message_id: ctx.message.message_id });

      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      let mediaText = "";
      if (isDoc) {
        mediaText = await extractTextFromDocument(buffer, mimeType, fileName);
      } else {
        const base64Data = buffer.toString('base64');
        mediaText = await extractTextFromMedia(mimeType, base64Data);
      }
      
      const userPrompt = question || "Проанализируй этот документ.";
      question = `${userPrompt}\n\n[Текст документа/медиа: ${mediaText}]`;

      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, '🧠 Данные получены. Ищу статьи в законах КР...');
    } else {
      statusMsg = await ctx.reply('Анализирую законодательство...', { reply_to_message_id: ctx.message.message_id });
    }

    // 3. ПАМЯТЬ И ПОИСК
    const chatId = ctx.message.chat.id;
    const userId = ctx.message.from.id;
    const userHistory = getHistory(chatId, userId);

    const answer = await getAIAnswer(question, userHistory);
    saveToHistory(chatId, userId, question, answer);

    // 4. ОТПРАВКА ОТВЕТА
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    await ctx.reply(answer, {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id
    });

  } catch (error) {
    console.error('Ошибка в обработчике:', error);
    ctx.reply('Произошла ошибка при обработке. Возможно, файл слишком большой.', { reply_to_message_id: ctx.message.message_id });
  }
});

module.exports = bot;
