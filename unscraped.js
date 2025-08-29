const { MongoClient } = require("mongodb");

const uri = "mongodb://localhost:27017";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("aqarmap_scraper");

    // تجيب كل الـ listings
    const listings = await db.collection("listings").find({}).toArray();
    console.log("Total listings:", listings.length);

    // تشيل scraped لو قيمته true
    const result = await db
      .collection("listings")
      .updateMany({ scraped: true }, { $unset: { scraped: "" } });

    console.log("Modified documents:", result.modifiedCount);
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();
