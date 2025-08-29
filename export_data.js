// export_mongo.js
const { MongoClient } = require("mongodb");
const ExcelJS = require("exceljs");

const config = {
  uri: "mongodb://localhost:27017",
  database: "aqarmap_scraper",
  collection: "listing_details",
};

async function exportMongoToExcel(outputFile) {
  const client = new MongoClient(config.uri);

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db(config.database);
    const collection = db.collection(config.collection);

    // هنجمع كل البيانات
    const docs = await collection.find({}).toArray();
    console.log(`📦 Found ${docs.length} documents`);

    // الحقول اللي مش عايزينها
    const excludeFields = [
      "_id",
      "scrapedAt",
      "phoneUpdatedAt",
      "whatsappUpdatedAt",
    ];

    if (docs.length === 0) {
      console.log("⚠️ No data found");
      return;
    }

    // تجهيز الأعمدة بناءً على أول سجل
    const sample = docs[0];
    const columns = Object.keys(sample)
      .filter((key) => !excludeFields.includes(key))
      .map((key) => ({ header: key, key }));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Ads Data");
    worksheet.columns = columns;

    // إضافة البيانات
    docs.forEach((row) => {
      const filteredRow = {};
      for (let key of Object.keys(row)) {
        if (!excludeFields.includes(key)) {
          if (Array.isArray(row[key])) {
            filteredRow[key] = row[key].join(", ");
          } else if (typeof row[key] === "object" && row[key] !== null) {
            filteredRow[key] = JSON.stringify(row[key]);
          } else {
            filteredRow[key] = row[key];
          }
        }
      }
      worksheet.addRow(filteredRow);
    });

    await workbook.xlsx.writeFile(outputFile);
    console.log(`✅ Excel file created: ${outputFile}`);
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.close();
  }
}

// تشغيل السكربت
exportMongoToExcel("aqarmap_ads.xlsx");
