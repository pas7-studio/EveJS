"use strict";
// Atomic journal storage for the wreck-transfer guard.
//
// The guard used to read the whole JSON document, mutate one entry and rename a new file over it.
// Two processes doing that together lose one update while both callers are told ok. This module keeps
// the same document in one row of a small SQLite database and mutates it inside a write transaction,
// so an update is serialised across processes by the database rather than by application code.
// The JSON file is still written after every commit as a read-only mirror for operators.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const BUSY_RETRIES = 200;
const BUSY_SLEEP_MS = 25;
const handles = new Map();

function dbPath(filePath) {
  return filePath + ".sqlite";
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* short busy wait: this runs inside a synchronous call */ }
}

function openDatabase(filePath) {
  const file = dbPath(filePath);
  const existing = handles.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL)");
  handles.set(file, db);
  return db;
}

function empty() {
  return { version: 1, entries: {} };
}

function parseDocument(text) {
  const document = JSON.parse(text);
  if (!document || document.version !== 1 || !document.entries || typeof document.entries !== "object") {
    throw new Error("WRECK_TRANSFER_GUARD_UNREADABLE");
  }
  return document;
}

function mirror(filePath, document) {
  // Best effort: a stale mirror is harmless, a missing transaction is not.
  try {
    const tmp = filePath + ".mirror-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(document));
    fs.renameSync(tmp, filePath);
  } catch (error) {
    // ignore: the database is the source of truth
  }
}

function loadRow(db) {
  const row = db.prepare("SELECT doc FROM journal WHERE id = 1").get();
  return row ? parseDocument(row.doc) : null;
}

function seedFromJson(filePath, db) {
  let document = null;
  try {
    document = parseDocument(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  db.prepare("INSERT OR REPLACE INTO journal (id, doc) VALUES (1, ?)").run(JSON.stringify(document));
}

function read(filePath) {
  let db;
  try {
    db = openDatabase(filePath);
  } catch (error) {
    throw new Error("WRECK_TRANSFER_GUARD_UNREADABLE");
  }
  const current = loadRow(db);
  if (current) return current;
  seedFromJson(filePath, db);
  return loadRow(db) || empty();
}

function update(filePath, mutator) {
  let db;
  try {
    db = openDatabase(filePath);
  } catch (error) {
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  }
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (error && String(error.code || "").startsWith("SQLITE_BUSY")) {
        sleep(BUSY_SLEEP_MS);
        continue;
      }
      return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
    }
    try {
      let document = loadRow(db);
      if (!document) {
        seedFromJson(filePath, db);
        document = loadRow(db) || empty();
      }
      const next = mutator(document);
      if (!next) {
        db.exec("ROLLBACK");
        return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_ABORTED" };
      }
      if (next !== document) parseDocument(JSON.stringify(next));
      db.prepare("INSERT OR REPLACE INTO journal (id, doc) VALUES (1, ?)")
        .run(JSON.stringify(next));
      db.exec("COMMIT");
      mirror(filePath, next);
      return { ok: true, document: next };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch (_rollbackError) { /* already rolled back */ }
      if (error && String(error.code || "").startsWith("SQLITE_BUSY")) {
        sleep(BUSY_SLEEP_MS);
        continue;
      }
      return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE", reason: String(error.message).slice(0, 160) };
    }
  }
  return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE", reason: "busy" };
}

function closeAll() {
  for (const [file, db] of handles) {
    try { db.close(); } catch (error) { /* ignore */ }
    handles.delete(file);
  }
}

module.exports = { read, update, closeAll, dbPath };
