require("dotenv").config();
// src/index.js (مقتطفات أساسية — يفضّل استبدال الملف عندك بالنسخة دي)
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const os = require("os");
const path = require("path");
const { db } = require("./db/mongo");
const cfg = require("./config");
const logger = require("./utils/logger");
const { seedFirstPages } = require("./scrape/urlCollector");
const { processListing } = require("./scrape/detailScraper");
// const { runPhoneStage } = require("./phones/phoneFetcher");
const { exportCollectionToExcel } = require("./exporter");
const { init: initTG, notify } = require("./utils/telegram");

function calcOptimalConcurrency(maxCap) {
  const freeMem = os.freemem();
  const cpu = os.cpus().length;
  const memLimit = Math.floor(freeMem / (220 * 1024 * 1024));
  const val = Math.max(3, Math.min(memLimit, cpu * 2, maxCap));
  logger.info({ freeMem, cpu, memLimit, chosen: val }, "concurrency computed");
  return val;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function workerPool({ browser, urlsCol, detailsCol, docs, concurrency }) {
  logger.info({ batch: docs.length, concurrency }, "🚦 starting worker pool");
  const pages = await Promise.all(
    Array.from({ length: Math.min(concurrency, docs.length) }, async () => {
      const p = await browser.newPage();
      return p;
    })
  );

  let idx = 0;
  let ok = 0,
    fail = 0;

  const runWorker = async (page, workerId) => {
    logger.debug({ workerId }, "worker start");
    while (true) {
      const i = idx++;
      if (i >= docs.length) break;
      const doc = docs[i];
      try {
        await processListing(page, doc.url, detailsCol);
        await urlsCol.updateOne(
          { _id: doc._id },
          { $set: { scraped: true, scrapedAt: new Date(), lastErr: null } }
        );
        ok++;
      } catch (e) {
        const msg = String((e && e.message) || e);
        await urlsCol.updateOne(
          { _id: doc._id },
          { $set: { scraped: false, error: msg, failedAt: new Date() } }
        );
        fail++;
      }
      await sleep(200); // بريك بسيط بين جوبات نفس العامل
    }
    try {
      await page.close();
    } catch {}
    logger.debug({ workerId, ok, fail }, "worker end");
  };

  await Promise.all(pages.map((p, i) => runWorker(p, i + 1)));
  logger.info({ ok, fail }, "🏁 pool finished");
}

async function main() {
  initTG(cfg.telegram.token);
  const chatId = cfg.telegram.chatId;
  const _db = await db(cfg.mongo.uri, cfg.mongo.dbName);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=PrivacySandboxAdsAPIs,AttributionReportingCrossAppWeb",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--mute-audio",
      "--unsafely-treat-insecure-origin-as-secure=http://localhost",
    ],
    defaultViewport: cfg.scraping.viewport,
  });

  try {
    logger.info("🚀 Pipeline started");
    await notify(chatId, "🚀 *Pipeline started*");

    for (const target of cfg.targets) {
      const { url: searchUrl, name } = target;
      const urlsCol = _db.collection(`${name}_urls`);
      const detailsCol = _db.collection(name);

      await urlsCol.createIndex({ url: 1 }, { unique: true });
      await detailsCol.createIndex({ url: 1 }, { unique: true });

      logger.info({ target: name, searchUrl }, "🎯 starting target");
      await notify(chatId, `🧭 Target: *${name}*\n🔗 ${searchUrl}`);

      // 1) SEED (أول 5 صفحات)
      await seedFirstPages({
        browser,
        baseUrl: cfg.baseUrl,
        searchUrl,
        listSelector: cfg.scraping.listSelector,
        pagesCount: cfg.seed.firstPages,
        viewport: cfg.scraping.viewport,
        userAgents: cfg.scraping.userAgents,
        saveUrl: async (url) => {
          try {
            await urlsCol.updateOne(
              { url },
              { $setOnInsert: { url, insertedAt: new Date(), scraped: false } },
              { upsert: true }
            );
          } catch {}
        },
      });
      logger.info({ target: name }, "✅ seeding finished");
      await notify(chatId, `✅ Seeding finished for *${name}*`);

      // 2) DETAILS (worker pool)
      const concurrency = calcOptimalConcurrency(
        cfg.scraping.maxConcurrentPages
      );
      await notify(chatId, `⚙️ Using *${concurrency}* tabs for details`);
      let batch;
      do {
        batch = await urlsCol
          .find({ scraped: { $ne: true } })
          .limit(cfg.scraping.batchSize)
          .toArray();
        if (!batch.length) break;
        logger.info({ target: name, batch: batch.length }, "📦 new batch");
        await workerPool({
          browser,
          urlsCol,
          detailsCol,
          docs: batch,
          concurrency,
        });
      } while (batch.length);

      await notify(chatId, `🟢 Details done for *${name}* — starting phones`);
      logger.info({ target: name }, "☎️ starting phones");
      // await runPhoneStage({
      //   baseUrl: cfg.baseUrl,
      //   authFile: cfg.authFile,
      //   cookiesFile: cfg.cookiesFile,
      //   detailsCollection: detailsCol,
      //   targetsName: name,
      //   cfgPhones: {
      //     apiBase: cfg.phones.apiBase,
      //     leadEndpoint: cfg.phones.leadEndpoint,
      //     rotateEvery: cfg.phones.rotateEvery,
      //     delayBetween: cfg.phones.delayBetween,
      //     maxRetries: cfg.phones.maxRetries,
      //   },
      // });

      logger.info({ target: name }, "📤 exporting");
      await notify(chatId, `📱 Phones done for *${name}* — exporting...`);
      const out = path.join(
        process.cwd(),
        `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`
      );
      await exportCollectionToExcel(detailsCol, out);
      await notify(chatId, `📦 Exported: *${path.basename(out)}*`);
      logger.info({ target: name, file: out }, "✅ target finished");
    }

    await notify(chatId, "🎉 *All targets completed*");
    logger.info("🎉 All targets completed");
  } catch (e) {
    const msg = String((e && e.message) || e);
    logger.fatal({ err: msg }, "💥 fatal");
    await notify(chatId, `💥 Fatal: \`${msg}\``);
    throw e;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch(console.error);
}
