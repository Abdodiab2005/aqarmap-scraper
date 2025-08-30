// urlCollector.js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const fs = require("fs");
const logger = require("../utils/logger");
const config = require("../config");
let mongo;
try {
  mongo = require("../db/mongo");
} catch (_) {
  mongo = null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function preparePage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  try {
    await page.emulateTimezone("Africa/Cairo");
  } catch {}
  await page.setViewport({ width: 1366, height: 820 });
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(30000);
}

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let total = 0;
    const step = Math.floor(window.innerHeight * 0.7);
    while (total < document.body.scrollHeight) {
      window.scrollBy(0, step);
      total += step;
      await delay(400 + Math.random() * 2000);
      if (Math.random() < 0.18) {
        window.scrollBy(0, -Math.floor(Math.random() * 180));
        await delay(Math.random() * 900);
      }
    }
  });
}

function readProgress(progressFile, key) {
  try {
    const data = JSON.parse(fs.readFileSync(progressFile, "utf-8"));
    return data[key] || null;
  } catch {
    return null;
  }
}

function writeProgress(progressFile, key, value) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(progressFile, "utf-8"));
  } catch {}
  data[key] = value;
  fs.writeFileSync(progressFile, JSON.stringify(data, null, 2));
}

async function openAndStatus(page, url) {
  const res = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  const status = res ? res.status() : 0;
  if (status >= 400) logger.debug("[seed] response >= 400", { url, status });
  return status;
}

async function detectMaxPage(page) {
  try {
    await page.waitForSelector('nav[aria-label="pagination"] a', {
      timeout: 8000,
    });
    const maxPage = await page.$$eval(
      'nav[aria-label="pagination"] a',
      (as) =>
        as
          .map((a) => parseInt(a.textContent.trim(), 10))
          .filter((n) => !isNaN(n))
          .sort((a, b) => b - a)[0] || 1
    );
    return maxPage || 1;
  } catch {
    return 1;
  }
}

async function collectOneTarget(
  { name, url: rawUrl, startPage, maxPage },
  resumeStrategy
) {
  // نظّف أي &amp; واردة من الـ config بدون ما نطلب منك تغيّرها
  const seedUrl = rawUrl.replace(/&amp;/g, "&");
  const progressKey = `urlCollector:${name}`;

  // حدّد صفحة البداية
  let from = startPage || 1;
  if (resumeStrategy === "progress") {
    const saved = readProgress(config.progressFile, progressKey);
    if (saved && Number.isInteger(saved.lastPage))
      from = Math.max(1, saved.lastPage + 1);
  }

  logger.info("🎯 starting target", { target: name, searchUrl: rawUrl });
  const browser = await puppeteer.launch({
    headless: "new", // يحل التحذير بتاع الهيدلس
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  await preparePage(page);

  // اكتشف آخر صفحة لو مش متحدّد
  let to = maxPage;
  if (!to) {
    const st = await openAndStatus(page, seedUrl);
    if (st === 403) logger.warn("[seed] seed page 403 — هنكمل ونحاول");
    to = await detectMaxPage(page);
  }

  for (let p = from; p <= to; p++) {
    const pageUrl = seedUrl + (seedUrl.includes("?") ? "&" : "?") + `page=${p}`;
    logger.debug("[seed] opening page", { pageNum: p, url: pageUrl });

    const status = await openAndStatus(page, pageUrl);
    if (status === 403) {
      logger.warn("[seed] 403 — skip page", { pageNum: p });
      writeProgress(config.progressFile, progressKey, {
        lastPageTried: p,
        lastPage: p - 1,
      });
      await sleep(1500 + Math.random() * 1500);
      continue;
    }

    // استنّى وجود الكروت
    try {
      await page.waitForSelector(
        'a[href^="/ar/"][class*="card"], a[href^="/ar/for-"]',
        { timeout: 15000 }
      );
    } catch (err) {
      logger.warn("[seed] selector wait failed — retry after scroll", {
        pageNum: p,
        err: String(err),
      });
      try {
        await humanLikeScroll(page);
        await page.waitForSelector(
          'a[href^="/ar/"][class*="card"], a[href^="/ar/for-"]',
          { timeout: 12000 }
        );
      } catch (err2) {
        logger.error("[seed] failed after retry — skip page", {
          pageNum: p,
          err: String(err2),
        });
        writeProgress(config.progressFile, progressKey, {
          lastPageTried: p,
          lastPage: p - 1,
        });
        continue;
      }
    }

    // اجمع الروابط
    const links = await page.$$eval('a[href^="/ar/"]', (as) =>
      Array.from(
        new Set(
          as
            .map((a) => a.href)
            .filter((u) =>
              /aqarmap\.com\.eg\/ar\/(for|listing|realestate)/.test(u)
            )
        )
      )
    );

    if (links.length) {
      if (mongo && typeof mongo.upsertMany === "function") {
        await mongo.upsertMany(
          "seed_urls",
          links.map((u) => ({
            url: u,
            source: name,
            state: "new",
          }))
        );
      }
    }

    logger.info("[seed] collected", { pageNum: p, count: links.length });
    writeProgress(config.progressFile, progressKey, {
      lastPageTried: p,
      lastPage: p,
    });
    await sleep(2000 + Math.random() * 3000);
  }

  try {
    await context.close();
  } catch {}
  try {
    await browser.close();
  } catch {}
  logger.info("[seed] done", { name, ended: true });
}

/**
 * === واجهة متوافقة مع index.js القديم ===
 * seedFirstPages: يبدأ من startPage (أو progress) ويكمل حتى maxPage/الحد الأقصى
 */
async function seedFirstPages(target, opts = {}) {
  const resumeStrategy =
    opts.resumeStrategy || config.resumeStrategy || "config";
  await collectOneTarget(target, resumeStrategy);
}

/**
 * اختياري: تسييد مدى صفحات محدد
 */
async function seedPagesRange(target, fromPage, toPage) {
  const t = { ...target, startPage: fromPage, maxPage: toPage };
  await collectOneTarget(t, "config");
}

module.exports = {
  seedFirstPages,
  seedPagesRange,
};
