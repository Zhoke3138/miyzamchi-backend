const { Telegraf } = require('telegraf');
require('dotenv').config();
const { getAIAnswer } = require('../logic/ai_service');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not defined in .env file');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start((ctx) => {
  ctx.reply('Привет! Я Miyzamchi — ваш ИИ-ассистент по праву. Задайте мне вопрос!');
});

// Слушатель текстовых сообщений с анти-спам фильтром
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();

  // Проверка триггеров: "мизамчы", "бот", или /ask
  const triggers = ['мизамчы', 'бот', '/ask'];
  const matchedTrigger = triggers.find(t => lowerText.startsWith(t));

  if (!matchedTrigger) {
    // Если триггера нет, игнорируем сообщение (анти-спам для групп)
    return;
  }

  // Очистка текста от триггера
  let question = text.substring(matchedTrigger.length).trim();
  
  // Если после триггера пусто, просим задать вопрос
  if (!question) {
    return ctx.reply('Да? Я слушаю. Задайте свой вопрос после слова "бот" или через команду /ask.');
  }

  try {
    // Индикация печатания
    await ctx.sendChatAction('typing');
    
    // Временное сообщение о начале анализа
    const statusMsg = await ctx.reply('Анализирую законодательство...');

    // Получение ответа от ИИ
    const answer = await getAIAnswer(question);

    // Удаляем статусное сообщение и отправляем финальный ответ
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Ошибка в обработчике сообщений бота:', error);
    ctx.reply('Произошла ошибка. Пожалуйста, попробуйте позже.');
  }
});

module.exports = bot;
