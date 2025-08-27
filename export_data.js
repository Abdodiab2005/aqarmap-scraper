const { MongoClient } = require("mongodb");
const XLSX = require("xlsx");

async function exportToExcel() {
  // بيانات الاتصال
  const uri = "mongodb://localhost:27017"; // عدلها لو DB مش لوكال
  const dbName = "aqarmap_scraper";
  const collectionName = "listing_details";

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // هات كل الداتا
    const docs = await collection.find({}).toArray();

    // جهز الداتا للـ Excel (تجاهل _id و scrapedAt)
    const data = docs.map(doc => ({
      title: doc.title || "",
      area: doc.area || "",
      price: doc.price || "",
      advertiserName: doc.advertiserName || "",
      advertiserLink: doc.advertiserLink || "",
      advertiserAdsCount: doc.advertiserAdsCount || "",
      buildingType: doc.buildingType || "",
      adDate: doc.adDate || "",
      description: doc.description || "",
      adData: Array.isArray(doc.adData) ? doc.adData.join(" - ") : "",
      phoneNumber: doc.phoneNumber || "",
      whatsappNumber: doc.whatsappNumber || "",
      url: doc.url || ""
    }));

    // اعمل شيت
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Listings");

    // اكتب الملف
    XLSX.writeFile(workbook, "listings.xlsx");

    console.log("✅ تم تصدير البيانات بنجاح إلى listings.xlsx");
  } catch (err) {
    console.error("❌ حصل خطأ:", err);
  } finally {
    await client.close();
  }
}

exportToExcel();
