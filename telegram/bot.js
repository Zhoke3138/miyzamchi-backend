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

// Слушатель текстовых сообщений с УМНЫМ анти-спам фильтром
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  // 1. Проверяем, ответил ли студент прямо на сообщение бота (свайп влево / Reply)
  const isReplyToBot = ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id;

  // 2. Умная регулярка: ищет корни слов со всеми окончаниями в начале текста, либо тег @бота
  const botUsername = ctx.botInfo.username;
  const triggerRegex = new RegExp(`^(@${botUsername}\\s*|мыйзамч[а-я]*\\s*|мизамч[а-я]*\\s*|бот[а-я]*\\s*|\\/ask\\s*)`, 'i');
  
  const match = text.match(triggerRegex);

  // Если студент не ответил боту напрямую и не использовал триггер — бот молчит (не спамит в группе)
  if (!isReplyToBot && !match) {
    return;
  }

  // Вытаскиваем сам вопрос, отрезая слово-триггер (если оно было)
  let question = text;
  if (match) {
    question = text.substring(match[0].length).trim();
  }

  // Если написали просто "бот" или тегнули, а вопроса нет
  if (!question) {
    return ctx.reply('Да? Я слушаю. Напишите свой юридический вопрос.', { reply_to_message_id: ctx.message.message_id });
  }

  try {
    // Индикация печатания
    await ctx.sendChatAction('typing');
    
    // Временное сообщение с привязкой (Reply) к вопросу студента
    const statusMsg = await ctx.reply('Анализирую законодательство...', { reply_to_message_id: ctx.message.message_id });

    // Получение ответа от ИИ
    const answer = await getAIAnswer(question);

    // Удаляем статус и отправляем финальный ответ с привязкой к автору
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    await ctx.reply(answer, { 
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id 
    });
  } catch (error) {
    console.error('Ошибка в обработчике сообщений бота:', error);
    ctx.reply('Произошла ошибка. Пожалуйста, попробуйте позже.', { reply_to_message_id: ctx.message.message_id });
  }
});

module.exports = bot;
