const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { MongoClient } = require("mongodb");
const fs = require("fs").promises;
const TelegramBot = require("node-telegram-bot-api");
const os = require("os");
const { performance } = require("perf_hooks");

// Add stealth plugin with all evasions
puppeteer.use(StealthPlugin());

// Configuration
const config = {
  // MongoDB
  mongoUri: "mongodb://localhost:27017",
  dbName: "aqarmap_scraper",
  urlsCollection: "listings",
  detailsCollection: "listing_details",

  // Scraping
  cookiesFile: "./cookies.json",
  baseUrl: "https://aqarmap.com.eg",

  // Telegram
  telegramToken: "8050522429:AAHca5Cev0T3YxXo9V9qTFFSdGky1b9AQ_0",
  telegramChatId: "6899264218",

  // Performance
  maxConcurrentPages: 5, // Reduced for stability
  batchSize: 50, // Reduced batch size
  notificationInterval: 10,

  // Browser
  viewport: { width: 1920, height: 1080 },
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ],
};

// Global variables
let browser = null;
let bot = null;
let db = null;
let urlsCollection = null;
let detailsCollection = null;
let isRunning = true;
let stats = {
  processed: 0,
  successful: 0,
  failed: 0,
  startTime: Date.now(),
  errors: [],
};

// Initialize Telegram bot
function initTelegramBot() {
  bot = new TelegramBot(config.telegramToken, { polling: true });

  bot.onText(/\/screenshot/, async (msg) => {
    try {
      const pages = await browser.pages();
      for (let i = 1; i < pages.length && i <= 3; i++) {
        const screenshot = await pages[i].screenshot({ fullPage: false });
        await bot.sendPhoto(config.telegramChatId, screenshot, {
          caption: `📸 Page ${i} of ${pages.length - 1} active pages`,
        });
      }
    } catch (error) {
      await bot.sendMessage(
        config.telegramChatId,
        `❌ Screenshot error: ${error.message}`
      );
    }
  });

  bot.onText(/\/status/, async (msg) => {
    const runtime = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(2);
    const rate = (stats.processed / runtime).toFixed(2);
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const totalUrls = await urlsCollection.countDocuments();
    const scrapedUrls = await urlsCollection.countDocuments({ scraped: true });

    const status = `
📊 *Scraper Status*
━━━━━━━━━━━━━━━
⏱ Runtime: ${runtime} minutes
📄 Total Ads: ${stats.processed} / ${totalUrls}
✅ Successful: ${stats.successful}
❌ Failed: ${stats.failed}
⚡ Rate: ${rate} ads/min
📈 Progress: ${((scrapedUrls / totalUrls) * 100).toFixed(2)}%

🖥 *System Resources*
━━━━━━━━━━━━━━━
💾 Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(
      memUsage.heapTotal /
      1024 /
      1024
    ).toFixed(2)} MB
🔧 CPU Time: ${(cpuUsage.user / 1000000).toFixed(2)}s user, ${(
      cpuUsage.system / 1000000
    ).toFixed(2)}s system
🌐 Active Pages: ${(await browser.pages()).length - 1}
━━━━━━━━━━━━━━━`;

    await bot.sendMessage(config.telegramChatId, status, {
      parse_mode: "Markdown",
    });
  });

  bot.onText(/\/stats/, async (msg) => {
    const recentErrors = stats.errors.slice(-5);
    const errorMsg =
      recentErrors.length > 0
        ? `\n\n🚨 *Recent Errors:*\n${recentErrors
            .map((e, i) => `${i + 1}. ${e.url}\n   ${e.error}`)
            .join("\n")}`
        : "";

    await bot.sendMessage(
      config.telegramChatId,
      `📊 *Detailed Stats*\n━━━━━━━━━━━━━━━\n` +
        `Success Rate: ${((stats.successful / stats.processed) * 100).toFixed(
          2
        )}%` +
        errorMsg,
      { parse_mode: "Markdown" }
    );
  });

  bot.onText(/\/run (.+)/, async (msg, match) => {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);

    try {
      const { stdout, stderr } = await execPromise(match[1]);
      const output = stdout || stderr || "Command executed";
      await bot.sendMessage(
        config.telegramChatId,
        `\`\`\`\n${output.slice(0, 4000)}\n\`\`\``,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      await bot.sendMessage(
        config.telegramChatId,
        `❌ Error: ${error.message}`
      );
    }
  });
}

// Helper functions
async function loadCookies() {
  try {
    const cookiesData = await fs.readFile(config.cookiesFile, "utf8");
    return JSON.parse(cookiesData);
  } catch (error) {
    console.log("No cookies file found");
    return [];
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay() {
  const ms = Math.floor(Math.random() * 3000) + 2000;
  await delay(ms);
}

// Calculate optimal concurrent pages based on system resources
function calculateOptimalConcurrency() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuCount = os.cpus().length;

  // Estimate ~200MB per browser page
  const memBasedLimit = Math.floor(freeMem / (200 * 1024 * 1024));
  const cpuBasedLimit = cpuCount * 2;

  const optimal = Math.min(
    memBasedLimit,
    cpuBasedLimit,
    config.maxConcurrentPages
  );
  return Math.max(optimal, 3); // At least 3 concurrent pages
}

// Initialize browser
async function initBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
    "--window-size=1920,1080",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-web-security",
    "--disable-features=CrossSiteDocumentBlockingIfIsolating",
    "--disable-site-isolation-trials",
  ];

  browser = await puppeteer.launch({
    headless: false,
    args,
    defaultViewport: config.viewport,
  });
}

// Create new page with stealth settings
async function createStealthPage() {
  const page = await browser.newPage();

  // Random user agent
  const userAgent =
    config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
  await page.setUserAgent(userAgent);

  // Set viewport
  await page.setViewport(config.viewport);

  // Load cookies
  const cookies = await loadCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }

  // Anti-detection measures
  await page.evaluateOnNewDocument(() => {
    // Override webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // Chrome object
    window.chrome = { runtime: {} };

    // Permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // Plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // Languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en", "ar"],
    });
  });

  return page;
}

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    function delay(ms) {
      return new Promise((res) => setTimeout(res, ms));
    }

    let totalHeight = 0;
    const distance = window.innerHeight * 0.7; // scroll step (حوالي 70% من الشاشة)

    while (totalHeight < document.body.scrollHeight) {
      // scroll خطوة خطوة
      window.scrollBy(0, distance);

      totalHeight += distance;

      // عشوائية الوقوف (بين نص ثانية لـ 3 ثواني)
      const pause = Math.floor(Math.random() * 2500) + 500;
      await delay(pause);

      // احتمال 1 من 5 يطلع شوية لفوق
      if (Math.random() < 0.2) {
        window.scrollBy(0, -Math.floor(Math.random() * 200));
        await delay(Math.floor(Math.random() * 1000));
      }
    }
  });
}

// Extract listing details
async function extractListingDetails(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for main content to load
    try {
      await humanLikeScroll(page);
      await page.waitForSelector("h1.text-body_1.text-gray__dark_2", {
        timeout: 10000,
      });
      await page.waitForSelector(
        'button[data-tooltip-target="tooltip-light"][data-tooltip-style="light"][role="button"] p.truncate.whitespace-nowrap'
      );
      console.log("Main content loaded");
      await delay(2000); // Let page fully settle
    } catch (e) {
      console.log("Main content not loaded properly");
    }

    await randomDelay();

    const details = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };

      const getHref = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.href : null;
      };

      // Extract basic details
      const data = {
        title: getText("h1.text-body_1.text-gray__dark_2"),
        area: getText(
          "section.container-fluid div.flex div.text-gray__dark_2 p.text-body_1.truncated-text"
        ),
        price: getText(
          "main.flex.flex-col section#stickyDiv span.text-title_3"
        ),
        advertiserName: getText(
          "section.container-fluid div.justify-between div.flex-1 div.flex-col a"
        ),
        advertiserLink: getHref(
          "section.container-fluid div.justify-between div.flex-1 div.flex-col a"
        ),
        advertiserAdsCount: getText(
          "section.container-fluid div.justify-between div.flex-1 p.pb-2x.text-gray__dark_1.text-body_2"
        ),
        location: getText(
          "section.flex-col-reverse a p.text-body_2.truncated-text"
        ),
      };

      // Building type and ad date
      const buildingInfo = getText(
        "section.flex.justify-between.container-fluid.flex-col-reverse.gap-y-4x span.text-caption.text-gray__dark_1.flex.flex-row"
      );
      if (buildingInfo) {
        const parts = buildingInfo.split(".");
        data.buildingType = parts[0]?.trim();
        data.adDate = parts[1]?.trim();
      }

      // Description
      const descSpans = document.querySelectorAll(
        "section.gap-y-3x div.col-span-9 div span"
      );

      if (descSpans.length > 0) {
        const descArray = Array.from(descSpans)
          // استبعاد أي span عنده class فيها "text-link"
          .filter((span) => !span.classList.contains("text-link"))
          .map((span) => span.textContent.trim());

        data.description = descArray.join("\n");
      }

      // Ad data (dynamic fields)
      const adDataElements = document.querySelectorAll(
        "section.flex.justify-between.container-fluid.flex-col-reverse.gap-y-4x div.flex.flex-col.gap-y-x div.flex.flex.gap-0\\.5x p"
      );
      data.adData = Array.from(adDataElements).map((el) =>
        el.textContent.trim()
      );

      return data;
    });

    details.phoneNumber = null;
    details.whatsappNumber = null;
    details.url = url;
    details.scrapedAt = new Date();

    return details;
  } catch (error) {
    throw new Error(`Failed to extract details: ${error.message}`);
  }
}

// Process single listing
async function processListing(page, listing) {
  const startTime = performance.now();

  try {
    const details = await extractListingDetails(page, listing.url);

    // Save to MongoDB
    await detailsCollection.insertOne(details);

    // Update original listing
    await urlsCollection.updateOne(
      { _id: listing._id },
      { $set: { scraped: true, scrapedAt: new Date() } }
    );

    stats.successful++;

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Processed: ${listing.url} (${duration}s)`);

    return { success: true, details };
  } catch (error) {
    stats.failed++;
    stats.errors.push({ url: listing.url, error: error.message });

    // Update listing as failed
    await urlsCollection.updateOne(
      { _id: listing._id },
      { $set: { scraped: false, error: error.message, failedAt: new Date() } }
    );

    console.error(`❌ Failed: ${listing.url} - ${error.message}`);

    // Send screenshot on error
    if (stats.failed % 5 === 0) {
      // Every 5 failures
      try {
        const screenshot = await page.screenshot({ fullPage: false });
        await bot.sendPhoto(config.telegramChatId, screenshot, {
          caption: `❌ Error on: ${listing.url}\n${error.message}`,
        });
      } catch (e) {}
    }

    return { success: false, error: error.message };
  } finally {
    stats.processed++;
  }
}

// Worker function for processing listings
async function worker(workerId, listings) {
  let page = null;

  try {
    page = await createStealthPage();
    console.log(`Worker ${workerId} started with ${listings.length} listings`);

    for (const listing of listings) {
      if (!isRunning) break;

      try {
        await processListing(page, listing);
      } catch (error) {
        console.error(`Worker ${workerId} error:`, error.message);
        // If page crashed, create new one
        if (
          error.message.includes("Protocol error") ||
          error.message.includes("Target closed") ||
          error.message.includes("Session closed")
        ) {
          try {
            await page.close();
          } catch (e) {}
          page = await createStealthPage();
          console.log(`Worker ${workerId} created new page after crash`);
        }
      }

      // Send notification every N processed
      if (stats.processed % config.notificationInterval === 0) {
        const msg =
          `📊 Progress Update:\n` +
          `Processed: ${stats.processed}\n` +
          `✅ Success: ${stats.successful}\n` +
          `❌ Failed: ${stats.failed}\n` +
          `⚡ Rate: ${(
            stats.processed /
            ((Date.now() - stats.startTime) / 60000)
          ).toFixed(2)} ads/min`;
        await bot.sendMessage(config.telegramChatId, msg);
      }

      await randomDelay();
    }
  } catch (error) {
    console.error(`Worker ${workerId} fatal error:`, error);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
    console.log(`Worker ${workerId} finished`);
  }
}

// Main execution
async function main() {
  let client = null;

  try {
    console.log("🚀 Starting Advanced Details Scraper...");

    // Initialize Telegram bot
    initTelegramBot();
    await bot.sendMessage(config.telegramChatId, "🚀 Details Scraper Started!");

    // Connect to MongoDB
    client = new MongoClient(config.mongoUri, {
      maxPoolSize: 50,
      minPoolSize: 10,
    });
    await client.connect();
    db = client.db(config.dbName);
    urlsCollection = db.collection(config.urlsCollection);
    detailsCollection = db.collection(config.detailsCollection);

    // Create indexes
    await detailsCollection.createIndex({ url: 1 }, { unique: true });
    await detailsCollection.createIndex({ scrapedAt: -1 });

    console.log("✅ Connected to MongoDB");

    // Initialize browser
    await initBrowser();
    console.log("✅ Browser initialized");

    // Calculate optimal concurrency
    const concurrency = calculateOptimalConcurrency();
    console.log(`⚙️  Using ${concurrency} concurrent workers`);
    await bot.sendMessage(
      config.telegramChatId,
      `⚙️ Optimized for ${concurrency} concurrent workers`
    );

    // Main processing loop
    while (isRunning) {
      // Get unscraped listings
      const listings = await urlsCollection
        .find({ scraped: { $ne: true } })
        .limit(config.batchSize)
        .toArray();

      if (listings.length === 0) {
        console.log("✅ All listings processed!");
        await bot.sendMessage(
          config.telegramChatId,
          "🎉 All listings have been processed!"
        );
        break;
      }

      // Distribute listings among workers
      const listingsPerWorker = Math.ceil(listings.length / concurrency);
      const workers = [];

      for (let i = 0; i < concurrency; i++) {
        const start = i * listingsPerWorker;
        const end = Math.min(start + listingsPerWorker, listings.length);
        const workerListings = listings.slice(start, end);

        if (workerListings.length > 0) {
          workers.push(worker(i + 1, workerListings));
        }
      }

      // Wait for all workers to complete
      await Promise.all(workers);

      // Adjust concurrency based on performance
      const memUsage = process.memoryUsage();
      if (memUsage.heapUsed > memUsage.heapTotal * 0.8) {
        console.log("⚠️ Memory pressure detected, reducing concurrency");
        config.maxConcurrentPages = Math.max(3, config.maxConcurrentPages - 1);
      }
    }
  } catch (error) {
    console.error("Fatal error:", error);
    await bot.sendMessage(
      config.telegramChatId,
      `💀 Fatal error: ${error.message}`
    );
  } finally {
    if (browser) await browser.close();
    if (client) await client.close(); // Fixed: use client instead of db

    // Final stats
    const runtime = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(2);
    const finalMsg = `
📊 *Final Statistics*
━━━━━━━━━━━━━━━
⏱ Total Runtime: ${runtime} minutes
📄 Total Processed: ${stats.processed}
✅ Successful: ${stats.successful}
❌ Failed: ${stats.failed}
📈 Success Rate: ${((stats.successful / stats.processed) * 100).toFixed(2)}%
⚡ Average Rate: ${(stats.processed / runtime).toFixed(2)} ads/min
━━━━━━━━━━━━━━━`;

    await bot.sendMessage(config.telegramChatId, finalMsg, {
      parse_mode: "Markdown",
    });
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n⏹ Graceful shutdown initiated...");
  isRunning = false;
  await delay(5000); // Wait for workers to finish current tasks
  process.exit(0);
});

process.on("SIGTERM", async () => {
  isRunning = false;
  await delay(5000);
  process.exit(0);
});

// Start the scraper
main().catch(console.error);
