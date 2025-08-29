// src/scrape/detailScraper.js
require("dotenv").config();
const logger = require("../utils/logger");

// نضمن تحضير الصفحة مرة واحدة فقط
const preparedPages = new WeakSet();

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    function delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    let total = 0,
      step = Math.floor(window.innerHeight * 0.7);
    while (total < document.body.scrollHeight) {
      window.scrollBy(0, step);
      total += step;
      await delay(500 + Math.random() * 1000);
      if (Math.random() < 0.2) {
        window.scrollBy(0, -Math.floor(Math.random() * 200));
        await delay(Math.random() * 600);
      }
    }
  });
}

// goto مع محاولات/ريتراي للأخطاء الشائعة
async function gotoWithRetries(page, url, opts = {}, maxRetries = 3) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      logger.debug({ url, attempt }, "[details] goto()");
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
        ...opts,
      });
      if (typeof page.waitForNetworkIdle === "function") {
        await page
          .waitForNetworkIdle({ idleTime: 800, timeout: 8000 })
          .catch(() => {});
      }
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retriable =
        msg.includes("net::ERR_ABORTED") ||
        msg.includes("ERR_NETWORK_CHANGED") ||
        msg.includes("Timeout") ||
        msg.includes("Navigation");
      logger.warn(
        { url, attempt, retriable, err: msg },
        "[details] goto failed"
      );
      if (!retriable || attempt >= maxRetries) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// تحضير صفحة واحد مرة واحدة + اعتراض طلبات آمن
async function preparePage(page) {
  if (preparedPages.has(page)) return;
  preparedPages.add(page);

  await page.setDefaultNavigationTimeout(60000);

  page.on("requestfailed", (req) => {
    const fail = req.failure()?.errorText;
    logger.debug(
      { url: req.url(), method: req.method(), fail },
      "[details] request failed"
    );
  });
  page.on("response", (res) => {
    const s = res.status();
    if (s >= 400)
      logger.debug({ url: res.url(), status: s }, "[details] response >= 400");
  });

  await page.setRequestInterception(true).catch(() => {});
  page.on("request", (req) => {
    try {
      if (
        typeof req.isInterceptResolutionHandled === "function" &&
        req.isInterceptResolutionHandled()
      )
        return;
      const rtype = req.resourceType();
      if (rtype === "media" || rtype === "font")
        return req.abort().catch(() => {});
      return req.continue().catch(() => {});
    } catch (err) {
      try {
        req.continue().catch(() => {});
      } catch {}
      logger.debug(
        { url: req.url(), err: String(err?.message || err) },
        "[details] intercept error"
      );
    }
  });
}

// ـــــ لا نكتب أي scrapedAt هنا نهائيًا ـــــ
async function extractDetails(page, url) {
  await gotoWithRetries(page, url);

  try {
    await humanLikeScroll(page);
    await page.waitForSelector("h1.text-body_1.text-gray__dark_2", {
      timeout: 15000,
    });
    await page.waitForTimeout(1200);
  } catch {}

  const details = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const href = (sel) => document.querySelector(sel)?.href || null;
    const data = {
      title: t("h1.text-body_1.text-gray__dark_2"),
      area: t(
        "section.container-fluid div.flex div.text-gray__dark_2 p.text-body_1.truncated-text"
      ),
      price: t("main.flex.flex-col section#stickyDiv span.text-title_3"),
      advertiserName: t(
        "section.container-fluid div.justify-between div.flex-1 div.flex-col a"
      ),
      advertiserLink: href(
        "section.container-fluid div.justify-between div.flex-1 div.flex-col a"
      ),
      advertiserAdsCount: t(
        "section.container-fluid div.justify-between div.flex-1 p.pb-2x.text-gray__dark_1.text-body_2"
      ),
      location: t("section.flex-col-reverse a p.text-body_2.truncated-text"),
    };
    const info = t(
      "section.flex.justify-between.container-fluid.flex-col-reverse.gap-y-4x span.text-caption.text-gray__dark_1.flex.flex-row"
    );
    if (info) {
      const parts = info.split(".");
      data.buildingType = parts[0]?.trim();
      data.adDate = parts[1]?.trim();
    }
    const descSpans = document.querySelectorAll(
      "section.gap-y-3x div.col-span-9 div span"
    );
    if (descSpans?.length) {
      const arr = Array.from(descSpans)
        .filter((s) => !s.classList.contains("text-link"))
        .map((s) => s.textContent.trim());
      data.description = arr.join("\n");
    }
    const specEls = document.querySelectorAll(
      "section.flex.justify-between.container-fluid.flex-col-reverse.gap-y-4x div.flex.flex-col.gap-y-x div.flex.flex.gap-0\\.5x p"
    );
    data.adData = Array.from(specEls).map((e) => e.textContent.trim());
    return data;
  });

  // نرجّع بس التفاصيل؛ الـ timestamps/flags تتضاف في الـ update
  return { ...details };
}

async function processListing(page, listingUrl, detailsCollection) {
  await preparePage(page);

  logger.info({ listingUrl }, "⛏️ scraping listing");
  const started = Date.now();

  try {
    const details = await extractDetails(page, listingUrl);

    // مهم: تفادي التعارض بين $setOnInsert و $set
    // - $setOnInsert: قيم تُكتب مرة واحدة وقت الإنشاء (مش هتتعدل بعدين)
    // - $set: تفاصيل تتحدث كل مرة + lastScrapedAt
    const now = new Date();
    await detailsCollection.updateOne(
      { url: listingUrl },
      {
        $setOnInsert: {
          url: listingUrl,
          createdAt: now,
          phoneNumber: null,
          whatsappNumber: null,
        },
        $set: {
          ...details,
          lastResult: "ok",
          lastScrapedAt: now,
        },
      },
      { upsert: true }
    );

    logger.info({ listingUrl, ms: Date.now() - started }, "✅ listing done");
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    logger.error({ listingUrl, err: msg }, "❌ listing failed");
    throw e;
  }
}

module.exports = { processListing };
