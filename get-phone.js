const { MongoClient } = require("mongodb");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// Configuration
const config = {
  mongodb: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017",
    database: "aqarmap_scraper",
    collection: "listing_details",
  },
  api: {
    baseUrl: "https://aqarmap.com.eg/api/v4/listing",
    leadEndpoint: "/lead",
  },
  request: {
    maxRetries: 3,
    retryDelay: 1000,
    batchSize: 10,
    requestDelay: 1000, // Delay between requests to avoid rate limiting
  },
};

// Headers configuration
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Expires: "-1",
  Origin: "https://aqarmap.com.eg",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Sec-GPC": "1",
  DNT: "1",
  TE: "Trailers",
};

// Lead request payload
const leadPayload = {
  fullName: "Abdo Diab",
  email: "awkward.anaconda.pszq@rapidletter.net",
  phone: {
    number: "+447414848196",
    country_code: "+44",
  },
  source: "ws-listing_details_fixed_buttons",
  type: 1,
};

// Cookie and authorization configuration (load from file or environment)
class AuthConfig {
  constructor() {
    this.configPath = path.join(__dirname, "auth.json");
  }

  async load() {
    try {
      const data = await fs.readFileSync(this.configPath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      console.log("No auth config file found, using default");
      return {
        cookie: process.env.AQARMAP_COOKIE || "",
        authorization: process.env.AQARMAP_AUTH || "",
      };
    }
  }

  async save(authData) {
    await fs.writeFileSync(this.configPath, JSON.stringify(authData, null, 2));
  }
}

// Main scraper class
class AqarmapPhoneScraper {
  constructor() {
    this.client = new MongoClient(config.mongodb.uri);
    this.authConfig = new AuthConfig();
    this.stats = {
      processed: 0,
      success: 0,
      errors: 0,
      unauthorized: 0,
      rateLimited: 0,
      whatsappProcessed: 0,
      whatsappSuccess: 0,
    };
  }

  // Extract ID from URL
  extractListingId(url) {
    const match = url.match(/listing\/(\d+)/);
    return match ? match[1] : null;
  }

  // Delay function
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Handle rate limiting (placeholder for future implementation)
  async handleRateLimit(listingId) {
    console.log(
      `⚠️ Rate limit hit for listing ${listingId}. Implement your rate limit handling here.`
    );
    this.stats.rateLimited++;

    await restartWG();
    await this.delay(5000); // Default 5 second delay
    this.run();
  }

  // Fetch phone numbers from API
  async fetchPhoneNumbers(listingId, auth, isWhatsApp = false) {
    const url = `${config.api.baseUrl}/${listingId}${config.api.leadEndpoint}`;

    // Create payload based on type
    const payload = {
      ...leadPayload,
      type: isWhatsApp ? 11 : 1, // type 11 for WhatsApp, type 1 for regular phone
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          ...headers,
          Cookie: auth.cookie,
          authorization: auth.authorization,
          Referer: `https://aqarmap.com.eg/ar/listing/${listingId}/`,
        },
        timeout: 30000,
      });

      if (response.data && response.data.lead && response.data.lead.listing) {
        const phoneNumbers = response.data.lead.listing.listing_phones || [];
        return {
          success: true,
          phoneNumbers: phoneNumbers.map((phone) => phone.number),
          leadId: response.data.lead_id,
        };
      }

      return {
        success: false,
        error: "Invalid response structure",
      };
    } catch (error) {
      if (error.response) {
        switch (error.response.status) {
          case 401:
            this.stats.unauthorized++;
            console.error(
              `❌ Unauthorized (401) for listing ${listingId}. Please update cookies and authorization token.`
            );
            return { success: false, error: "unauthorized", status: 401 };

          case 429:
            await this.handleRateLimit(listingId);
            return { success: false, error: "rate_limited", status: 429 };

          default:
            console.error(
              `❌ Error ${error.response.status} for listing ${listingId}: ${error.response.statusText}`
            );
            return {
              success: false,
              error: error.response.statusText,
              status: error.response.status,
            };
        }
      }

      console.error(
        `❌ Network error for listing ${listingId}: ${error.message}`
      );
      return { success: false, error: error.message };
    }
  }

  // Process a single listing
  async processListing(listing, auth) {
    const listingId = this.extractListingId(listing.url);

    if (!listingId) {
      console.error(`❌ Could not extract ID from URL: ${listing.url}`);
      this.stats.errors++;
      return;
    }

    console.log(`📱 Processing listing ${listingId}...`);

    let retries = 0;
    let result;

    while (retries < config.request.maxRetries) {
      result = await this.fetchPhoneNumbers(listingId, auth);

      if (result.success) {
        break;
      }

      if (result.status === 401) {
        // Don't retry on unauthorized
        break;
      }

      if (result.status === 429) {
        // Rate limit handled in fetchPhoneNumbers
        retries++;
        continue;
      }

      retries++;

      await this.delay(config.request.retryDelay);
      if (retries < config.request.maxRetries) {
        console.log(
          `🔄 Retry ${retries}/${config.request.maxRetries} for listing ${listingId}`
        );
        await this.delay(config.request.retryDelay * retries);
      }
    }

    if (result.success) {
      // Update MongoDB with phone numbers
      try {
        const updateResult = await this.collection.updateOne(
          { _id: listing._id },
          {
            $set: {
              phoneNumber: result.phoneNumbers,
              leadId: result.leadId,
              phoneUpdatedAt: new Date(),
            },
          }
        );

        if (updateResult.modifiedCount > 0) {
          console.log(
            `✅ Updated listing ${listingId} with ${result.phoneNumbers.length} phone numbers`
          );
          this.stats.success++;
        }
      } catch (error) {
        console.error(
          `❌ Failed to update MongoDB for listing ${listingId}: ${error.message}`
        );
        this.stats.errors++;
      }
    } else {
      console.error(
        `❌ Failed to fetch phone numbers for listing ${listingId} after ${retries} retries`
      );
      this.stats.errors++;
    }

    this.stats.processed++;

    // Add delay between requests
    await this.delay(config.request.requestDelay);
  }

  // Process WhatsApp numbers for all listings that have phone numbers but no WhatsApp
  async processWhatsAppNumbers(auth) {
    console.log("\n\n🟢 Starting WhatsApp number collection...");

    // Count listings that have phone numbers but no WhatsApp
    const whatsappCount = await this.collection.countDocuments({
      phoneNumber: { $exists: true, $ne: null },
      whatsappNumber: null,
    });

    console.log(
      `📱 Found ${whatsappCount} listings that need WhatsApp numbers`
    );

    if (whatsappCount === 0) {
      console.log("✅ All listings have WhatsApp numbers!");
      return;
    }

    let processedCount = 0;

    while (processedCount < whatsappCount) {
      // Check if we got too many unauthorized errors
      if (this.stats.unauthorized > 5) {
        console.error(
          "❌ Too many unauthorized errors. Please update your authentication credentials."
        );
        break;
      }

      // Fetch batch of documents
      const cursor = this.collection
        .find({
          phoneNumber: { $exists: true, $ne: null },
          whatsappNumber: null,
        })
        .skip(processedCount)
        .limit(config.request.batchSize);

      const listings = await cursor.toArray();

      if (listings.length === 0) {
        break;
      }

      console.log(
        `\n📦 Processing WhatsApp batch ${
          Math.floor(processedCount / config.request.batchSize) + 1
        } (${listings.length} listings)`
      );

      // Process each listing for WhatsApp
      for (const listing of listings) {
        const listingId = this.extractListingId(listing.url);

        if (!listingId) {
          console.error(`❌ Could not extract ID from URL: ${listing.url}`);
          this.stats.errors++;
          continue;
        }

        console.log(`📱 Getting WhatsApp for listing ${listingId}...`);

        const result = await this.fetchPhoneNumbers(listingId, auth, true);

        if (result.success) {
          try {
            const updateResult = await this.collection.updateOne(
              { _id: listing._id },
              {
                $set: {
                  whatsappNumber: result.phoneNumbers,
                  whatsappLeadId: result.leadId,
                  whatsappUpdatedAt: new Date(),
                },
              }
            );

            if (updateResult.modifiedCount > 0) {
              console.log(
                `✅ Updated listing ${listingId} with ${result.phoneNumbers.length} WhatsApp numbers`
              );
              this.stats.whatsappSuccess++;
            }
          } catch (error) {
            console.error(
              `❌ Failed to update MongoDB for listing ${listingId}: ${error.message}`
            );
            this.stats.errors++;
          }
        } else {
          console.error(
            `❌ Failed to fetch WhatsApp numbers for listing ${listingId}`
          );
          this.stats.errors++;
        }

        this.stats.whatsappProcessed++;

        // Add delay between requests
        await this.delay(config.request.requestDelay);
      }

      processedCount += listings.length;

      // Progress update
      console.log(
        `\n📊 WhatsApp Progress: ${
          this.stats.whatsappProcessed
        }/${whatsappCount} (${Math.round(
          (this.stats.whatsappProcessed / whatsappCount) * 100
        )}%)`
      );
      console.log(`   ✅ Success: ${this.stats.whatsappSuccess}`);
    }
  }

  // Main run function
  async run() {
    try {
      // Load authentication config
      const auth = await this.authConfig.load();

      if (!auth.cookie || !auth.authorization) {
        console.error(
          "❌ Missing authentication credentials. Please set cookies and authorization token."
        );
        return;
      }

      // Connect to MongoDB
      console.log("🔗 Connecting to MongoDB...");
      await this.client.connect();

      this.db = this.client.db(config.mongodb.database);
      this.collection = this.db.collection(config.mongodb.collection);

      console.log("✅ Connected to MongoDB");

      // Count total documents
      const totalCount = await this.collection.countDocuments({
        phoneNumber: null,
      });
      console.log(`📊 Found ${totalCount} listings without phone numbers`);

      if (totalCount === 0) {
        console.log("✅ All listings have phone numbers!");
      } else {
        // Process in batches
        let processedCount = 0;

        while (processedCount < totalCount) {
          // Check if we got too many unauthorized errors
          if (this.stats.unauthorized > 5) {
            console.error(
              "❌ Too many unauthorized errors. Please update your authentication credentials."
            );
            break;
          }

          // Fetch batch of documents
          const cursor = this.collection
            .find({ phoneNumber: null })
            .skip(processedCount)
            .limit(config.request.batchSize);

          const listings = await cursor.toArray();

          if (listings.length === 0) {
            break;
          }

          console.log(
            `\n📦 Processing batch ${
              Math.floor(processedCount / config.request.batchSize) + 1
            } (${listings.length} listings)`
          );

          // Process each listing in the batch
          for (const listing of listings) {
            await this.processListing(listing, auth);
          }

          processedCount += listings.length;

          // Progress update
          console.log(
            `\n📊 Progress: ${this.stats.processed}/${totalCount} (${Math.round(
              (this.stats.processed / totalCount) * 100
            )}%)`
          );
          console.log(`   ✅ Success: ${this.stats.success}`);
          console.log(`   ❌ Errors: ${this.stats.errors}`);
          console.log(`   🔐 Unauthorized: ${this.stats.unauthorized}`);
          console.log(`   ⏳ Rate Limited: ${this.stats.rateLimited}`);
        }
      }

      // After finishing phone numbers, process WhatsApp numbers
      await this.processWhatsAppNumbers(auth);
    } catch (error) {
      console.error("❌ Fatal error:", error);
    } finally {
      // Close MongoDB connection
      await this.client.close();
      console.log("\n🔒 MongoDB connection closed");

      // Final stats
      console.log("\n📊 Final Statistics:");
      console.log("📞 Phone Numbers:");
      console.log(`   Total Processed: ${this.stats.processed}`);
      console.log(`   Successful: ${this.stats.success}`);
      console.log("\n🟢 WhatsApp Numbers:");
      console.log(`   Total Processed: ${this.stats.whatsappProcessed}`);
      console.log(`   Successful: ${this.stats.whatsappSuccess}`);
      console.log("\n❌ Errors:");
      console.log(`   Total Errors: ${this.stats.errors}`);
      console.log(`   Unauthorized: ${this.stats.unauthorized}`);
      console.log(`   Rate Limited: ${this.stats.rateLimited}`);
    }
  }
}

// Run the scraper
if (require.main === module) {
  const scraper = new AqarmapPhoneScraper();
  scraper.run().catch(console.error);
}

async function restartWG() {
  exec("wg-quick down wgcf && wg-quick up wgcf", (err, stdout, stderr) => {
    if (err) {
      console.error(`Error restarting wgcf: ${err.message}`);
      return;
    }
    console.log("✅ wgcf restarted successfully");
  });
}

module.exports = AqarmapPhoneScraper;
