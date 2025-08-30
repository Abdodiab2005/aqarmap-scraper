// urlCollector.js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const { upsertMany } = require("../db/mongo"); // تأكد من وجود دالة لحفظ الروابط (أو استبدلها بما لديك)
const config = require("../config");

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

async function openAndStatus(page, url) {
  const res = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  const status = res ? res.status() : 0;
  if (status >= 400) {
    logger.debug("[seed] response >= 400", { url, status });
  }
  return status;
}

/**
 * يجمع روابط الإعلانات من صفحات النتائج
 * @param {object} target { url, name, startPage, maxPage }
 * @param {object} opts { resumeStrategy }
 */
async function collectTarget(target, opts = {}) {
  const { resumeStrategy = "config" } = opts;
  const {
    url: seedUrlRaw,
    name,
    startPage: cfgStart,
    maxPage: cfgMax,
  } = target;

  // إصلاح أي &amp; في الرابط إن وجدت
  const seedUrl = seedUrlRaw.replace(/&amp;/g, "&");

  // تحضير progress key
  const progressKey = `urlCollector:${name}`;

  // تحديد صفحة البداية
  let startPage = 1;
  if (resumeStrategy === "progress") {
    const saved = readProgress(config.progressFile, progressKey);
    if (saved && Number.isInteger(saved.lastPage)) {
      startPage = Math.max(1, saved.lastPage + 1); // كمّل بعد آخر صفحة ناجحة
    } else {
      startPage = cfgStart || 1;
    }
  } else {
    startPage = cfgStart || 1; // بناءً على طلبك: نبدأ من 148 الآن
  }

  logger.info("[seed] start", { name, resumeStrategy, startPage });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let context = await browser.createIncognitoBrowserContext();
  let page = await context.newPage();
  await preparePage(page);

  // جلب حدّ الصفحات إن لم يكن محددًا
  let maxPage = cfgMax;
  if (!maxPage) {
    const st = await openAndStatus(page, seedUrl);
    if (st === 403) {
      logger.warn("[seed] got 403 on seed page, سنحاول الاستمرار لاحقًا");
    }
    maxPage = await detectMaxPage(page);
  }

  for (let p = startPage; p <= maxPage; p++) {
    const pageUrl = seedUrl + (seedUrl.includes("?") ? "&" : "?") + `page=${p}`;
    logger.debug("[seed] opening page", { pageNum: p, url: pageUrl });

    const status = await openAndStatus(page, pageUrl);
    if (status === 403) {
      // في السيناريو الحالي انت قلت إنه اشتغل تاني، فهنتخطى الصفحة ونكمل
      logger.warn("[seed] 403 — تخطي الصفحة والانتقال للتي بعدها", {
        pageNum: p,
      });
      // حفظ التقدّم (آخر صفحة حاولناها)
      writeProgress(config.progressFile, progressKey, {
        lastPageTried: p,
        lastPage: p - 1,
      });
      await sleep(2000 + Math.random() * 1500);
      continue;
    }

    // انتظار ظهور الكروت
    try {
      await page.waitForSelector(
        'a[href^="/ar/"][class*="card"], a[href^="/ar/for-"]',
        { timeout: 15000 }
      );
    } catch (err) {
      // إعادة محاولة بسيطة بعد scroll
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

    // استخراج الروابط
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

    // حفظ الروابط (بدّل باسم الدالة/الكولكشن حسب مشروعك)
    if (links.length) {
      await upsertMany(
        "seed_urls",
        links.map((u) => ({ url: u, source: name, state: "new" }))
      );
    }

    logger.info("[seed] collected", { pageNum: p, count: links.length });

    // حفظ التقدم (آخر صفحة ناجحة)
    writeProgress(config.progressFile, progressKey, {
      lastPageTried: p,
      lastPage: p,
    });

    // تهدئة بسيطة بين الصفحات
    await sleep(2500 + Math.random() * 3000);
  }

  try {
    await context.close();
  } catch {}
  try {
    await browser.close();
  } catch {}

  logger.info("[seed] done", { name, maxPage, endedAtPage: maxPage });
}

async function runAllTargets() {
  for (const t of config.targets) {
    try {
      await collectTarget(t, { resumeStrategy: config.resumeStrategy });
    } catch (err) {
      logger.error("[seed] target failed", { name: t.name, err: String(err) });
    }
  }
}

module.exports = {
  runAllTargets,
  collectTarget,
};
