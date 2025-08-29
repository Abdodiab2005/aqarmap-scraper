// phones.js
require("dotenv").config();

const { MongoClient } = require("mongodb");
const logger = require("./utils/logger");

// لو عندك الموديول ده بالفعل عندك: src/phones/phoneFetcher.js
// (وده اللي فيه runPhoneStage بالـ wgcf handling، 401/429، refreshAuthViaBrowser، إلخ)
const { runPhoneStage } = require("./phones/phoneFetcher");

// لو عندك إعدادات targets و endpoints؛ وإلا هنقراها من .env
const cfg = {
  baseUrl: process.env.BASE_URL || "https://aqarmap.com.eg",
  cookiesFile: process.env.PHONES_COOKIES_FILE || "./cookies.json",
  authFile: process.env.PHONES_AUTH_FILE || "./auth.json",
  // API conf (ما فيهوش سيلكتور)
  phones: {
    apiBase:
      process.env.PHONES_API_BASE || "https://aqarmap.com.eg/api/listings",
    leadEndpoint: process.env.PHONES_LEAD_ENDPOINT || "/lead",
    rotateEvery: Number(process.env.PHONE_ROTATE_EVERY || 8),
    delayBetween: Number(process.env.PHONE_DELAY_BETWEEN_MS || 1200),
    maxRetries: Number(process.env.PHONE_MAX_RETRIES || 3),
  },
  // targets: array of objects [{ url, name }]
  targets: [], // هنقرى من ENV JSON تحت لو موجود
};

// لو عايز تمشي على أكتر من لينك (collections) بالتتابع:
try {
  if (process.env.TARGETS_JSON) {
    cfg.targets = JSON.parse(process.env.TARGETS_JSON);
  }
} catch (e) {
  logger.warn(
    { err: String(e?.message || e) },
    "[phones] failed to parse TARGETS_JSON"
  );
}

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "aqarmap";

async function main() {
  logger.info("[phones] standalone runner starting…");

  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(DB_NAME);

  // لو محددتش targets في ENV، هنشتغل على Collection افتراضي واحد اسمه "listings"
  const targets = cfg.targets.length
    ? cfg.targets
    : [
        {
          url: cfg.baseUrl,
          name: process.env.DEFAULT_COLLECTION || "listings",
        },
      ];

  for (const target of targets) {
    const detailsCollection = db.collection(target.name);
    logger.info(
      { target: target.name, url: target.url },
      "☎️ starting phones (standalone)"
    );

    await runPhoneStage({
      baseUrl: cfg.baseUrl,
      authFile: cfg.authFile,
      cookiesFile: cfg.cookiesFile,
      detailsCollection,
      targetsName: target.name,
      cfgPhones: cfg.phones,
    });
  }

  await client.close();
  logger.info("[phones] all targets done. bye.");
}

// تشغيل مباشر فقط لو الملف ده هو الـ entry
if (require.main === module) {
  main().catch((err) => {
    logger.error({ err: String(err?.stack || err) }, "[phones] fatal error");
    process.exit(1);
  });
}

module.exports = { main };
