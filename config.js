// src/config.js
module.exports = {
  // Telegram
  telegram: {
    token:
      process.env.TELEGRAM_TOKEN ||
      "8050522429:AAHca5Cev0T3YxXo9V9qTFFSdGky1b9AQ_0",
    chatId: process.env.TELEGRAM_CHAT_ID || "6899264218",
  },

  // Mongo
  mongo: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017",
    dbName: "aqarmap_scraper",
  },

  // General
  baseUrl: "https://aqarmap.com.eg",
  cookiesFile: "./cookies.json",
  authFile: "./auth.json",
  progressFile: "./progress.json",
  resumeStrategy: "config",

  // Targets (url = صفحة البحث الأساسية، name = اسم كولكشن الداتا النهائية)
  targets: [
    {
      url: "https://aqarmap.com.eg/ar/for-sale/property-type/cairo/heliopolis/?location=cairo/heliopolis,cairo/nasr-city&amp;sort=publishedAt&amp;byOwnerOnly=1&amp;direction=desc",
      name: "link1",
      startPage: 148,
    },
    {
      url: "https://aqarmap.com.eg/ar/for-rent/property-type/cairo/heliopolis/?location=cairo%2Fheliopolis%2Ccairo%2Fnasr-city&amp;sort=publishedAt&amp;byOwnerOnly=1&amp;direction=desc",
      name: "link2",
      startPage: 1,
    },
  ],

  // Seeding & scraping
  seed: { firstPages: 0 },
  scraping: {
    maxConcurrentPages: 999, // هنحسب الأفضل بناءً على الجهاز، القيمة هنا سقف فقط
    batchSize: 50, // كل Batch من الـ URLs
    userAgents: [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
    viewport: { width: 1920, height: 1080 },
    listSelector: "a.p-2x.flex.flex-col.gap-y-2x", // نفس السلكتور الموجود عندك
  },

  // Phones
  phones: {
    apiBase: "https://aqarmap.com.eg/api/v4/listing",
    leadEndpoint: "/lead",
    rotateEvery: 8, // تدوير IP بعد كل 8 طلبات
    delayBetween: 1000, // ms
    maxRetries: 3,
  },
};
