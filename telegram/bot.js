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
    // Игнорируем ошибки Телеграма
  }
}

// --- ТЕКСТ ИНСТРУКЦИИ ---
const helpMessage = `*Как пользоваться ботом Мыйзамчы?* ⚖️\n\n` +
  `Я — юридический ИИ-ассистент. Вот что я умею и как ко мне обращаться:\n\n` +
  `*1. Как вызвать меня в группе:*\n` +
  `• Напиши мое имя: \`Мыйзамчы\`, \`Бот\` (в любом падеже)\n` +
  `• Используй команду: \`/ask ваш вопрос\`\n` +
  `• Тегни меня: \`@имя_бота ваш вопрос\`\n` +
  `• *Самое удобное:* Сделай свайп влево (Reply/Ответить) на любое мое сообщение и напиши вопрос или отправь файл!\n\n` +
  `*2. Что мне можно отправлять:*\n` +
  `• 📝 *Текст:* Опиши ситуацию подробно.\n` +
  `• 🎧 *Голосовые:* Просто наговори проблему, я переведу в текст.\n` +
  `• 📸 *Фото:* Скинь фото документа, я его прочитаю.\n` +
  `• 📄 *Файлы:* Отправь PDF или Word (.docx), и я проведу юридический анализ текста.\n\n` +
  `*Важно:* Я помню контекст беседы (последние 3 вопроса), так что можешь задавать уточняющие вопросы!`;

bot.start((ctx) => ctx.reply(helpMessage, { parse_mode: 'Markdown' }));
bot.help((ctx) => ctx.reply(helpMessage, { parse_mode: 'Markdown' }));

bot.on(['text', 'voice', 'photo', 'document'], async (ctx) => {
  // ЛОГИРОВАНИЕ: Видим в консоли Render, что пришло сообщение
  const username = ctx.from.username || ctx.from.first_name;
  console.log(`[Incoming] Сообщение от ${username} в чате ${ctx.chat.id}`);

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

  if (ctx.message.text) {
    const text = ctx.message.text.trim();
    if (text.startsWith('/start') || text.startsWith('/help')) return;
    
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
    const initText = isMedia ? '⏳ Получаю файл...' : '⏳ Анализирую ваш вопрос...';
    const statusMsg = await ctx.reply(initText, { reply_to_message_id: ctx.message.message_id });
    
    const updateProgress = async (statusText) => {
      await safeEdit(ctx, statusMsg.message_id, statusText);
    };

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

    const answer = await getAIAnswer(question, userHistory, updateProgress);
    saveToHistory(chatId, userId, question, answer);

    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    
    try {
        await ctx.reply(answer, {
            parse_mode: 'Markdown',
            reply_to_message_id: ctx.message.message_id
        });
    } catch (tgError) {
        console.warn('Телеграм ругается на Markdown, отправляю без форматирования...');
        await ctx.reply(answer, {
            reply_to_message_id: ctx.message.message_id
        });
    }

  } catch (error) {
    console.error('Ошибка в обработчике:', error);
    ctx.reply('Произошла ошибка при обработке запроса. Возможно, сервера временно перегружены.', { reply_to_message_id: ctx.message.message_id });
  }
});

// --- ГЛОБАЛЬНАЯ ЗАЩИТА И УПРЯМЫЙ ЗАПУСК ---

bot.catch((err, ctx) => {
  console.error(`[Global Error] Ошибка бота в апдейте ${ctx.updateType}:`, err);
});

async function launchBot(retryCount = 0) {
  try {
    console.log(`[Bot] Попытка запуска #${retryCount + 1}...`);
    await bot.launch();
    console.log('✅ Telegram бот успешно запущен!');
  } catch (err) {
    console.error(`❌ Ошибка запуска бота (попытка ${retryCount + 1}):`, err.message);
    if (retryCount < 10) {
      console.log('Пробую перезапустить через 5 секунд...');
      setTimeout(() => launchBot(retryCount + 1), 5000);
    }
  }
}

launchBot();

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
