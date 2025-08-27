const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { MongoClient } = require('mongodb');
const fs = require('fs').promises;
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Configuration
const config = {
  mongoUri: 'mongodb://localhost:27017',
  dbName: 'aqarmap_scraper',
  collectionName: 'listings',
  baseUrl: 'https://aqarmap.com.eg',
  targetUrl: 'https://aqarmap.com.eg/ar/for-sale/property-type/?byOwnerOnly=1',
  selector: 'a.p-2x.flex.flex-col.gap-y-2x',
  cookiesFile: './cookies.json',
  progressFile: './progress.json',
  telegramToken: '8050522429:AAHca5Cev0T3YxXo9V9qTFFSdGky1b9AQ_0',
  telegramChatId: '6899264218',
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Initialize Telegram bot
const bot = new TelegramBot(config.telegramToken, { polling: true });

// Global variables
let browser = null;
let page = null;
let db = null;
let collection = null;
let isRunning = false;

// Telegram command handlers
bot.onText(/\/screenshot/, async (msg) => {
  if (!page) {
    await bot.sendMessage(config.telegramChatId, '❌ No active page to screenshot');
    return;
  }
  
  try {
    const screenshot = await page.screenshot({ fullPage: true });
    await bot.sendPhoto(config.telegramChatId, screenshot, { caption: '📸 Current page screenshot' });
  } catch (error) {
    await bot.sendMessage(config.telegramChatId, `❌ Screenshot error: ${error.message}`);
  }
});

bot.onText(/\/status/, async (msg) => {
  try {
    const progress = await getProgress();
    const dbStats = await collection.stats();
    const { stdout: memUsage } = await execPromise('ps aux | grep node | head -1');
    
    const status = `
📊 *Scraper Status*
━━━━━━━━━━━━━━━
🚦 Running: ${isRunning ? '✅ Yes' : '❌ No'}
📄 Current Page: ${progress.currentPage}
🔗 Total URLs Scraped: ${dbStats.count}
💾 Database Size: ${(dbStats.size / 1024 / 1024).toFixed(2)} MB
🧠 Memory Usage: ${memUsage.split(/\s+/)[3]}
━━━━━━━━━━━━━━━`;
    
    await bot.sendMessage(config.telegramChatId, status, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(config.telegramChatId, `❌ Status error: ${error.message}`);
  }
});

bot.onText(/\/run (.+)/, async (msg, match) => {
  const command = match[1];
  
  try {
    const { stdout, stderr } = await execPromise(command);
    const output = stdout || stderr || 'Command executed successfully';
    
    // Split long messages
    if (output.length > 4000) {
      const chunks = output.match(/.{1,4000}/g);
      for (const chunk of chunks) {
        await bot.sendMessage(config.telegramChatId, `\`\`\`\n${chunk}\n\`\`\``, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(config.telegramChatId, `\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    await bot.sendMessage(config.telegramChatId, `❌ Command error: ${error.message}`);
  }
});

// Helper functions
async function loadCookies() {
  try {
    const cookiesData = await fs.readFile(config.cookiesFile, 'utf8');
    return JSON.parse(cookiesData);
  } catch (error) {
    console.log('No cookies file found, proceeding without cookies');
    return [];
  }
}

async function saveProgress(currentPage) {
  const progress = { currentPage, lastUpdate: new Date().toISOString() };
  await fs.writeFile(config.progressFile, JSON.stringify(progress, null, 2));
}

async function getProgress() {
  try {
    const data = await fs.readFile(config.progressFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { currentPage: 1, lastUpdate: null };
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function randomDelay() {
  const min = 2000;
  const max = 5000;
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await delay(ms);
}

// Main scraping function
async function scrapePage(pageNum) {
  const pageUrl = `${config.targetUrl}&page=${pageNum}`;
  
  try {
    // Navigate with retry logic
    let retries = 3;
    while (retries > 0) {
      try {
        await page.goto(pageUrl, { 
          waitUntil: 'networkidle2',
          timeout: 30000 
        });
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await delay(5000);
      }
    }
    
    // Wait for content to load
    await page.waitForSelector(config.selector, { timeout: 10000 });
    await randomDelay();
    
    // Extract URLs
    const urls = await page.evaluate((selector, baseUrl) => {
      const links = document.querySelectorAll(selector);
      return Array.from(links).map(link => {
        const href = link.getAttribute('href');
        return href.startsWith('http') ? href : baseUrl + href;
      });
    }, config.selector, config.baseUrl);
    
    // Save to MongoDB with deduplication
    const savedCount = await saveUrls(urls);
    
    // Update progress
    await saveProgress(pageNum);
    
    // Send Telegram notification
    await bot.sendMessage(
      config.telegramChatId, 
      `✅ Page ${pageNum} scraped!\n📊 Found: ${urls.length} URLs\n💾 Saved: ${savedCount} new URLs`
    );
    
    return urls.length;
  } catch (error) {
    console.error(`Error scraping page ${pageNum}:`, error);
    await bot.sendMessage(
      config.telegramChatId, 
      `❌ Error on page ${pageNum}: ${error.message}`
    );
    throw error;
  }
}

async function saveUrls(urls) {
  let savedCount = 0;
  
  for (const url of urls) {
    try {
      await collection.updateOne(
        { url },
        { 
          $setOnInsert: { 
            url,
            scrapedAt: new Date(),
            pageScraped: false 
          }
        },
        { upsert: true }
      );
      savedCount++;
    } catch (error) {
      if (error.code !== 11000) { // Ignore duplicate key errors
        console.error('Error saving URL:', error);
      }
    }
  }
  
  return savedCount;
}

// Initialize browser with anti-detection measures
async function initBrowser() {
  browser = await puppeteer.launch({
    headless: false, // Set to true for production
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    defaultViewport: config.viewport
  });
  
  page = await browser.newPage();
  
  // Set user agent
  await page.setUserAgent(config.userAgent);
  
  // Set viewport
  await page.setViewport(config.viewport);
  
  // Load cookies if available
  const cookies = await loadCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }
  
  // Override webdriver detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.navigator.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.HTMLElement.prototype.scrollIntoView = () => {};
  });
}

// Main execution
async function main() {
  try {
    isRunning = true;
    
    // Connect to MongoDB
    const client = new MongoClient(config.mongoUri);
    await client.connect();
    db = client.db(config.dbName);
    collection = db.collection(config.collectionName);
    
    // Create index for URL deduplication
    await collection.createIndex({ url: 1 }, { unique: true });
    
    console.log('Connected to MongoDB');
    await bot.sendMessage(config.telegramChatId, '🚀 Scraper started!');
    
    // Initialize browser
    await initBrowser();
    
    // Get starting page
    const progress = await getProgress();
    let currentPage = progress.currentPage;
    
    // Start scraping
    while (true) {
      try {
        console.log(`Scraping page ${currentPage}...`);
        const urlCount = await scrapePage(currentPage);
        
        // If no URLs found, might be the end
        if (urlCount === 0) {
          await bot.sendMessage(config.telegramChatId, '⚠️ No URLs found on page. Might be the end.');
          break;
        }
        
        currentPage++;
        await randomDelay();
        
      } catch (error) {
        console.error('Scraping error:', error);
        await bot.sendMessage(config.telegramChatId, `🔴 Fatal error: ${error.message}\nRestarting in 30 seconds...`);
        await delay(30000);
      }
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    await bot.sendMessage(config.telegramChatId, `💀 Fatal error: ${error.message}`);
  } finally {
    isRunning = false;
    if (browser) await browser.close();
    if (db) await db.close();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nGraceful shutdown initiated...');
  isRunning = false;
  if (browser) await browser.close();
  if (db) await db.close();
  process.exit(0);
});

// Start the scraper
main().catch(console.error);
