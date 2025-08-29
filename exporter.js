// src/exporter.js
const ExcelJS = require("exceljs");

async function exportCollectionToExcel(
  collection,
  outputFile,
  exclude = ["_id", "scrapedAt", "phoneUpdatedAt", "whatsappUpdatedAt"]
) {
  const docs = await collection.find({}).toArray();
  if (!docs.length) return;

  const sample = docs[0];
  const columns = Object.keys(sample)
    .filter((k) => !exclude.includes(k))
    .map((k) => ({ header: k, key: k }));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ads Data");
  ws.columns = columns;

  for (const row of docs) {
    const filtered = {};
    for (const k of Object.keys(row)) {
      if (exclude.includes(k)) continue;
      if (Array.isArray(row[k])) filtered[k] = row[k].join(", ");
      else if (row[k] && typeof row[k] === "object")
        filtered[k] = JSON.stringify(row[k]);
      else filtered[k] = row[k];
    }
    ws.addRow(filtered);
  }
  await wb.xlsx.writeFile(outputFile);
}

module.exports = { exportCollectionToExcel };
