// src/auth/refresh.js
require("dotenv").config();
const fs = require("fs").promises;
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const logger = require("../utils/logger");

puppeteer.use(StealthPlugin());

/**
 * يفتح الـ baseUrl لتوليد access_token من الكوكيز
 * - Headless يتحكم فيه ENV: HEADLESS=1 (افتراضي) / 0
 * - بيستنى لحد ما يلاقي cookie: access_token أو لحد مهلة قصوى
 * - يحفظ cookies.json و auth.json (authorization + cookie header)
 */
async function refreshAuthViaBrowser({
  baseUrl,
  cookiesFile = "./cookies.json",
  authFile = "./auth.json",
  viewport = { width: 1920, height: 1080 },
  maxWaitMs = 45000,
} = {}) {
  const headless = process.env.HEADLESS !== "0"; // افتراضيًا Headless

  logger.info({ baseUrl, headless }, "[auth] refreshing token via browser");

  const browser = await puppeteer.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: viewport,
  });

  try {
    const page = await browser.newPage();

    // لو فيه كوكيز قديمة، حمّلها
    try {
      const cookies = JSON.parse(await fs.readFile(cookiesFile, "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        await page.setCookie(...cookies);
        logger.debug({ n: cookies.length }, "[auth] loaded old cookies");
      }
    } catch {}

    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // انتظر لغاية ما يظهر access_token في document.cookie (ديناميكي)
    const deadline = Date.now() + maxWaitMs;
    let accessToken = null;
    while (Date.now() < deadline) {
      const cookieString = await page.evaluate(() => document.cookie);
      const m = cookieString.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (m && m[1]) {
        accessToken = decodeURIComponent(m[1]);
        break;
      }
      await page.waitForTimeout(1500);
    }

    if (!accessToken) {
      logger.warn(
        "[auth] access_token not detected within maxWait; continuing with cookies anyway"
      );
    }

    // خزّن الكوكيز كاملة + auth.json
    const cookiesArr = await page.cookies();
    const cookieHeader = cookiesArr
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    await fs.writeFile(cookiesFile, JSON.stringify(cookiesArr, null, 2));

    const authObj = {
      authorization: accessToken ? `Bearer ${accessToken}` : "",
      cookie: cookieHeader,
      refreshedAt: new Date().toISOString(),
    };
    await fs.writeFile(authFile, JSON.stringify(authObj, null, 2));

    logger.info({ haveToken: !!accessToken }, "[auth] auth files written");
    return authObj;
  } finally {
    await browser.close();
  }
}

module.exports = { refreshAuthViaBrowser };
