require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const os = require("os");
const path = require("path");
const cfg = require("./config");
const logger = require("./utils/logger");

let dbModule = null;
try {
  dbModule = require("./db/mongo");
} catch (_) {}

const { seedFirstPages } = require("./scrape/urlCollector");
let processListing = null;
try {
  processListing = require("./scrape/detailScraper").processListing;
} catch (_) {}

let exporter = null;
try {
  exporter = require("./exporter");
} catch (_) {}

let tg = { init: () => {}, notify: async () => {} };
try {
  tg = require("./utils/telegram");
} catch (_) {}

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
  if (!processListing) {
    logger.warn("processListing not available — skipping details scraping");
    return;
  }
  logger.info({ batch: docs.length, concurrency }, "🚦 starting worker pool");
  const tabs = Math.min(concurrency, docs.length);
  const pages = [];
  for (let i = 0; i < tabs; i++) {
    const p = await browser.newPage();
    pages.push(p);
  }

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
      await sleep(200);
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
  try {
    tg.init(cfg.telegram.token);
  } catch {}
  const chatId = cfg.telegram.chatId;

  let _db = null;
  if (dbModule && typeof dbModule.db === "function") {
    _db = await dbModule.db(cfg.mongo.uri, cfg.mongo.dbName);
  }

  const browser = await puppeteer.launch({
    headless: "new",
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
    try {
      await tg.notify(chatId, "🚀 *Pipeline started*");
    } catch {}

    for (const target of cfg.targets) {
      const { url: searchUrl, name, startPage } = target;

      let urlsCol = null;
      let detailsCol = null;
      if (_db) {
        urlsCol = _db.collection(`${name}_urls`);
        detailsCol = _db.collection(name);
        await urlsCol.createIndex({ url: 1 }, { unique: true });
        await detailsCol.createIndex({ url: 1 }, { unique: true });
      }

      logger.info({ target: name, searchUrl }, "🎯 starting target");
      try {
        await tg.notify(chatId, `🧭 Target: *${name}*\n🔗 ${searchUrl}`);
      } catch {}

      // === 1) SEED ===
      await seedFirstPages({
        browser,
        searchUrl,
        listSelector: cfg.scraping.listSelector,
        pagesCount: cfg.seed.firstPages, // 0 = امسح كل الصفحات
        viewport: cfg.scraping.viewport,
        userAgents: cfg.scraping.userAgents,
        startPage: startPage || 1,
        resumeStrategy: cfg.resumeStrategy,
        progressKey: `seed:${name}`,
        saveUrl: async (url) => {
          if (!url) return;
          if (!urlsCol) return;
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
      try {
        await tg.notify(chatId, `✅ Seeding finished for *${name}*`);
      } catch {}

      // === 2) DETAILS ===
      if (_db && processListing) {
        const concurrency = calcOptimalConcurrency(
          cfg.scraping.maxConcurrentPages
        );
        try {
          await tg.notify(chatId, `⚙️ Using *${concurrency}* tabs for details`);
        } catch {}
        let batch;
        do {
          batch = await _db
            .collection(`${name}_urls`)
            .find({ scraped: { $ne: true } })
            .limit(cfg.scraping.batchSize)
            .toArray();
          if (!batch.length) break;
          logger.info({ target: name, batch: batch.length }, "📦 new batch");
          await workerPool({
            browser,
            urlsCol: _db.collection(`${name}_urls`),
            detailsCol: _db.collection(name),
            docs: batch,
            concurrency,
          });
        } while (batch.length);
      }

      // === 3) EXPORT (اختياري) ===
      if (
        _db &&
        exporter &&
        typeof exporter.exportCollectionToExcel === "function"
      ) {
        const out = path.join(
          process.cwd(),
          `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`
        );
        try {
          await exporter.exportCollectionToExcel(_db.collection(name), out);
          try {
            await tg.notify(chatId, `📦 Exported: *${path.basename(out)}*`);
          } catch {}
          logger.info({ target: name, file: out }, "✅ target finished");
        } catch (e) {
          logger.warn({ target: name, e: String(e) }, "export failed");
        }
      }
    }

    try {
      await tg.notify(chatId, "🎉 *All targets completed*");
    } catch {}
    logger.info("🎉 All targets completed");
  } catch (e) {
    const msg = String((e && e.message) || e);
    logger.fatal({ err: msg }, "💥 fatal");
    try {
      await tg.notify(chatId, `💥 Fatal: \`${msg}\``);
    } catch {}
    throw e;
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
