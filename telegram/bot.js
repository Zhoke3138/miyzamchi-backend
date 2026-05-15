const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();
const { getAIAnswer, extractTextFromMedia } = require('../logic/ai_service');

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
  if (!sessions.has(key)) {
    sessions.set(key, []);
  }
  return sessions.get(key);
}

function saveToHistory(chatId, userId, userText, aiText) {
  const key = `${chatId}_${userId}`;
  const history = getHistory(chatId, userId);
  history.push({ role: 'user', text: userText });
  history.push({ role: 'assistant', text: aiText });
  if (history.length > 6) history.splice(0, 2); // Помнит 3 последних вопроса-ответа
}
// -----------------------

bot.start((ctx) => {
  ctx.reply('Привет! Я Мыйзамчы — ваш ИИ-ассистент по праву. Задайте мне вопрос, отправьте фото документа или запишите голосовое сообщение!');
});

// Обрабатываем текст, голос и фото
bot.on(['text', 'voice', 'photo'], async (ctx) => {
  const isGroup = ctx.chat.type !== 'private';
  const isReplyToBot = ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id;
  const botUsername = ctx.botInfo.username || '';
  
  // Умный триггер: реагирует на "Мыйзамчы", "Мыйзамчыга", "Бот", "/ask" и тег @бота
  const triggerRegex = new RegExp(`^(@${botUsername}\\s*|мыйзамч[а-я]*\\s*|мизамч[а-я]*\\s*|бот[а-я]*\\s*|\\/ask\\s*)`, 'i');

  let question = "";
  let isMedia = false;
  let fileId = null;
  let mimeType = "";

  // 1. ОПРЕДЕЛЯЕМ ТИП СООБЩЕНИЯ
  if (ctx.message.text) {
    const text = ctx.message.text.trim();
    const match = text.match(triggerRegex);
    if (isGroup && !isReplyToBot && !match) return; // Анти-спам
    question = match ? text.substring(match[0].length).trim() : text;
    if (!question && !isReplyToBot) return ctx.reply('Слушаю! Напишите или наговорите ваш вопрос.', { reply_to_message_id: ctx.message.message_id });

  } else if (ctx.message.voice) {
    if (isGroup && !isReplyToBot) return; // В группе слушаем голос только по Reply к боту
    isMedia = true;
    fileId = ctx.message.voice.file_id;
    mimeType = ctx.message.voice.mime_type || 'audio/ogg';

  } else if (ctx.message.photo) {
    const caption = ctx.message.caption || "";
    const match = caption.match(triggerRegex);
    if (isGroup && !isReplyToBot && !match) return; // Анти-спам для фото
    question = match ? caption.substring(match[0].length).trim() : caption;
    isMedia = true;
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id; // Берем картинку лучшего качества
    mimeType = 'image/jpeg';
  }

  try {
    await ctx.sendChatAction('typing');
    let statusMsg = null;

    // 2. ОБРАБОТКА МУЛЬТИМЕДИА
    if (isMedia) {
      statusMsg = await ctx.reply(ctx.message.voice ? '🎧 Распознаю аудио...' : '👁️ Изучаю фото...', { reply_to_message_id: ctx.message.message_id });

      // Скачиваем файл с серверов Telegram
      const fileUrl = await ctx.telegram.getFileLink(fileId);
      const response = await axios.get(fileUrl.href, { responseType: 'arraybuffer' });
      const base64Data = Buffer.from(response.data).toString('base64');

      // Извлекаем текст
      const mediaText = await extractTextFromMedia(mimeType, base64Data);
      
      // Объединяем подпись к фото и вытащенный текст
      question = question ? `${question}\n\n[Текст из медиа: ${mediaText}]` : mediaText;

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
    ctx.reply('Произошла ошибка при обработке. Возможно, файл слишком большой или сервисы перегружены.', { reply_to_message_id: ctx.message.message_id });
  }
});

module.exports = bot;
