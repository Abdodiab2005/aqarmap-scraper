// src/utils/telegram.js
const TelegramBot = require("node-telegram-bot-api");

let bot;
function init(token) {
  if (!bot) bot = new TelegramBot(token, { polling: false });
  return bot;
}

async function notify(chatId, text, opts = {}) {
  if (!bot) throw new Error("Telegram bot not initialized");
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });
}

async function sendPhoto(chatId, buffer, caption = "") {
  if (!bot) throw new Error("Telegram bot not initialized");
  return bot.sendPhoto(chatId, buffer, { caption });
}

module.exports = { init, notify, sendPhoto };
