const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const config = require("../config");

let mongo = null;
try {
  // لو ماعندكش ./db/mongo عادي هيكمل بدون حفظ DB
  mongo = require("../db/mongo");
} catch (_) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function preparePage(page, optUA) {
  const ua =
    optUA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  await page.setUserAgent(ua);
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

/**
 * API متوافق مع index.js:
 * seedFirstPages({ browser, searchUrl, listSelector, pagesCount, viewport, userAgents,
 *                  startPage, resumeStrategy, progressKey, saveUrl })
 *
 * - pagesCount = 0  => امسح كل الصفحات حتى آخر صفحة
 * - startPage يأتي من الـ config.target.startPage (أو 1)
 * - resumeStrategy = "config" | "progress"
 * - progressKey (اختياري) مفتاح التخزين في progress.json
 */
async function seedFirstPages(opts) {
  if (!opts || typeof opts !== "object") {
    throw new Error("seedFirstPages: options object is required");
  }

  const {
    browser,
    searchUrl,
    listSelector,
    pagesCount = 0,
    viewport,
    userAgents = [],
    startPage = 1,
    resumeStrategy = "config",
    progressKey,
    saveUrl,
  } = opts;

  if (!browser || typeof browser.createIncognitoBrowserContext !== "function") {
    throw new Error("seedFirstPages: valid puppeteer browser is required");
  }
  if (!searchUrl || typeof searchUrl !== "string") {
    throw new Error("seedFirstPages: searchUrl (string) is required");
  }
  if (typeof saveUrl !== "function") {
    throw new Error("seedFirstPages: saveUrl callback is required");
  }

  // طهّر أي &amp; في الرابط
  const seedUrl = searchUrl.replace(/&amp;/g, "&");
  const pKey =
    progressKey ||
    "seed:" +
      Buffer.from(seedUrl).toString("base64").replace(/=+$/, "").slice(0, 16);

  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  if (viewport) {
    try {
      await page.setViewport(viewport);
    } catch {}
  }
  await preparePage(page, userAgents[0]);

  // حدّد صفحة البداية
  let from = Math.max(1, parseInt(startPage, 10) || 1);
  if (resumeStrategy === "progress") {
    const saved = readProgress(config.progressFile, pKey);
    if (saved && Number.isInteger(saved.lastPage)) {
      from = Math.max(1, saved.lastPage + 1);
    }
  }

  // حدّد صفحة النهاية
  let to;
  const st = await openAndStatus(page, seedUrl);
  if (st === 403) {
    logger.warn(
      "[seed] seed page 403 — will still attempt pagination detection"
    );
  }
  const detectedMax = await detectMaxPage(page);

  if (pagesCount && pagesCount > 0) {
    to = from + pagesCount - 1;
  } else {
    to = detectedMax;
  }

  logger.info("[seed] plan", { from, to, pagesCount, resumeStrategy, pKey });

  for (let p = from; p <= to; p++) {
    const pageUrl = seedUrl + (seedUrl.includes("?") ? "&" : "?") + `page=${p}`;
    logger.debug("[seed] opening page", { pageNum: p, url: pageUrl });

    const status = await openAndStatus(page, pageUrl);
    if (status === 403) {
      logger.warn("[seed] 403 — skip page", { pageNum: p });
      writeProgress(config.progressFile, pKey, {
        lastPageTried: p,
        lastPage: p - 1,
      });
      await sleep(1500 + Math.random() * 1500);
      continue;
    }

    // استنّى وجود عناصر القايمة
    const selector =
      (typeof listSelector === "string" && listSelector.trim()) ||
      'a[href^="/ar/for-"], a[href^="/ar/listing"]';
    try {
      await page.waitForSelector(selector, { timeout: 15000 });
    } catch (err) {
      logger.warn("[seed] selector wait failed — retry after scroll", {
        pageNum: p,
        err: String(err),
      });
      try {
        await humanLikeScroll(page);
        await page.waitForSelector(selector, { timeout: 12000 });
      } catch (err2) {
        logger.error("[seed] failed after retry — skip page", {
          pageNum: p,
          err: String(err2),
        });
        writeProgress(config.progressFile, pKey, {
          lastPageTried: p,
          lastPage: p - 1,
        });
        continue;
      }
    }

    // استخراج الروابط
    let links = [];
    try {
      // لو السيلكتور Anchor — خُده مباشرة
      links = await page.$$eval(selector, (nodes) =>
        Array.from(
          new Set(
            nodes
              .map((n) => {
                // يدعم لو السيلكتور عنصر داخلي جوّا الكارت
                const a =
                  n.tagName === "A" ? n : n.closest && n.closest("a[href]");
                return a ? a.href : null;
              })
              .filter(Boolean)
          )
        )
      );
    } catch {
      // fallback شامل
      links = await page.$$eval('a[href^="/ar/"]', (as) =>
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
    }

    // حفظ الروابط (عبر callback)
    for (const u of links) {
      try {
        await saveUrl(u);
      } catch (e) {
        logger.debug("[seed] saveUrl failed", { url: u, err: String(e) });
      }
    }

    logger.info("[seed] collected", { pageNum: p, count: links.length });

    // حفظ التقدم
    writeProgress(config.progressFile, pKey, {
      lastPageTried: p,
      lastPage: p,
    });

    // تبطيء بسيط
    await sleep(2000 + Math.random() * 3000);
  }

  try {
    await context.close();
  } catch {}
  logger.info("[seed] done", { progressKey: pKey });
}

module.exports = {
  seedFirstPages,
};
