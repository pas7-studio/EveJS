"use strict";

const path = require("path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const DB_PATH = process.env.EVEJS_DB || "/var/lib/evejs/gameStore/gamestore.sqlite";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countCargoEntries(db) {
  const row = db.prepare("SELECT json FROM npcCargo WHERE key = ?").get("cargo");
  if (!row || typeof row.json !== "string") return 0;
  try {
    return Object.keys(JSON.parse(row.json)).length;
  } catch (error) {
    return -1;
  }
}

function readCargoChars(db) {
  // SQLite treats double quotes as identifiers: the key must be a string literal or a bound parameter
  const row = db.prepare("SELECT json FROM npcCargo WHERE key = ?").get("cargo");
  return row && typeof row.json === "string" ? row.json.length : null;
}

async function main() {
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.log(JSON.stringify({ error: "DB_MISSING" }));
    process.exit(2);
  }

  const { rowSizeLimits } = require(path.join(__dirname, "..", "src", "space", "coopGameStoreAtomic"));
  const ceiling = rowSizeLimits.maxRowChars("npcCargo");

  const first = readCargoChars(db);
  await sleep(30000);
  const second = readCargoChars(db);

  const bytesPerSecond = (second - first) / 10;
  const secondsToCeiling = bytesPerSecond > 0 ? Math.floor((ceiling - second) / bytesPerSecond) : null;
  const hoursToCeiling = secondsToCeiling === null ? null : Math.round(secondsToCeiling / 3600, 1);

  const usedPct = ceiling > 0 ? Math.round((second / ceiling) * 1000) / 10 : 0;
  let status;
  if (usedPct >= 90) status = "CRITICAL";
  else if (usedPct >= 70) status = "WARN";
  else status = "OK";

  const report = {
    at: new Date().toISOString(),
    dbPath: DB_PATH,
    chars: second,
    ceiling,
    usedPct,
    entries: countCargoEntries(db),
    bytesPerSecond,
    hoursToCeiling,
    status,
  };

  console.log(JSON.stringify(report));
  process.exit(status === "CRITICAL" ? 1 : 0);
}

main().catch((e) => {
  console.log(JSON.stringify({ error: "DB_MISSING" }));
  process.exit(2);
});
