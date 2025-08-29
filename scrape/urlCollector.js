// src/scrape/urlCollector.js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { randomInt } = require("crypto");
const logger = require("../utils/logger");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    function delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    let total = 0;
    const step = Math.floor(window.innerHeight * 0.7);
    while (total < document.body.scrollHeight) {
      window.scrollBy(0, step);
      total += step;
      await delay(500 + Math.random() * 2500);
      if (Math.random() < 0.2) {
        window.scrollBy(0, -Math.floor(Math.random() * 200));
        await delay(Math.random() * 1000);
      }
    }
  });
}

async function withStealthPage(browser, { viewport, userAgents }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(ua);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en", "ar"],
    });
  });

  // Logging للشبكة أثناء الـ seeding
  page.on("requestfailed", (req) => {
    const fail = req.failure()?.errorText;
    logger.debug(
      { url: req.url(), method: req.method(), fail },
      "[seed] request failed"
    );
  });
  page.on("response", (res) => {
    const s = res.status();
    if (s >= 400)
      logger.debug({ url: res.url(), status: s }, "[seed] response >= 400");
  });

  return page;
}

/**
 * يجمع URLs من أول N صفحات (seeding) — بدون لمس السلكتور
 * يوقف لو مفيش روابط جديدة (بدأ تكرار) أو خلّص العدد المطلوب من الصفحات.
 *
 * @param {object} params
 *  - browser
 *  - baseUrl
 *  - searchUrl       (رابط البحث الأساسي)
 *  - listSelector    (سلكتور العناصر — ما بنلمسوش)
 *  - pagesCount      (عدد الصفحات اللي هنسيدها، مثلاً 5)
 *  - viewport
 *  - userAgents
 *  - saveUrl(url)    (callback لحفظ الرابط في DB)
 */
async function seedFirstPages({
  browser,
  baseUrl,
  searchUrl,
  listSelector,
  pagesCount,
  viewport,
  userAgents,
  saveUrl,
}) {
  const page = await withStealthPage(browser, { viewport, userAgents });

  const seen = new Set();
  let pageNum = 1;
  let ended = false;

  logger.info({ searchUrl, pagesCount }, "[seed] start");

  while (pageNum <= pagesCount && !ended) {
    const url = `${searchUrl}${
      searchUrl.includes("?") ? "&" : "?"
    }page=${pageNum}`;
    logger.debug({ pageNum, url }, "[seed] opening page");

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await humanLikeScroll(page);
      await page.waitForSelector(listSelector, { timeout: 15000 });
    } catch (e) {
      const msg = String((e && e.message) || e);
      logger.warn(
        { pageNum, url, err: msg },
        "[seed] navigation/selector error — retry once"
      );

      // محاولة تانية خفيفة
      try {
        await sleep(1200);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await humanLikeScroll(page);
        await page.waitForSelector(listSelector, { timeout: 15000 });
      } catch (e2) {
        logger.error(
          { pageNum, url, err: String((e2 && e2.message) || e2) },
          "[seed] failed after retry — skip page"
        );
        pageNum++;
        continue;
      }
    }

    // اجمع الروابط من الصفحة
    let links = [];
    try {
      links = await page.evaluate(
        (sel, base) => {
          return Array.from(document.querySelectorAll(sel))
            .map((a) => {
              const href = a.getAttribute("href");
              return href && (href.startsWith("http") ? href : base + href);
            })
            .filter(Boolean);
        },
        listSelector,
        baseUrl
      );
    } catch (e) {
      logger.error(
        { pageNum, err: String((e && e.message) || e) },
        "[seed] evaluate links error"
      );
      pageNum++;
      continue;
    }

    // كشف التكرار
    const beforeCount = seen.size;
    for (const l of links) seen.add(l);
    const savedNow = seen.size - beforeCount;

    logger.debug(
      { pageNum, links: links.length, newSaved: savedNow },
      "[seed] page parsed"
    );

    // خزّن في DB عبر callback
    for (const link of links) {
      try {
        await saveUrl(link);
      } catch (e) {
        logger.debug(
          { link, err: String((e && e.message) || e) },
          "[seed] saveUrl error (likely duplicate)"
        );
      }
    }

    if (savedNow === 0) {
      logger.info(
        { pageNum },
        "[seed] no new links — stopping early (likely repetition)"
      );
      ended = true;
      break;
    }

    await sleep(1000 + randomInt(2500));
    pageNum++;
  }

  if (!ended && pageNum > pagesCount) {
    logger.info(
      { pagesCount },
      "[seed] reached configured pagesCount — stopping"
    );
  }

  logger.info({ totalUnique: seen.size }, "[seed] done");
  await page.close();
}

module.exports = { seedFirstPages };
