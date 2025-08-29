// src/db/mongo.js
const { MongoClient } = require("mongodb");
let client;

async function connect(uri) {
  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 50, minPoolSize: 5 });
    await client.connect();
  }
  return client;
}

async function db(uri, name) {
  const c = await connect(uri);
  return c.db(name);
}

module.exports = { connect, db };
