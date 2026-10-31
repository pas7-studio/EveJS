"use strict";
const fs = require("node:fs");
const path = require("node:path");

const FILE_ENV = "EVEJS_COOP_WRECK_TRANSFER_GUARD_FILE";
const MAX_PENDING = 512;
let counter = 0;

function filePath() {
  return process.env[FILE_ENV] || path.join(process.env.EVEJS_DATA_ROOT || process.cwd(),
    "coop-wreck-transfer-guard.json");
}

function valid(record) {
  return record && typeof record === "object" &&
    Number.isSafeInteger(record.id) && record.id > 0 &&
    Number.isSafeInteger(record.characterID) && record.characterID > 0 &&
    Number.isSafeInteger(record.wreckID) && record.wreckID > 0 &&
    Number.isSafeInteger(record.wreckItemID) && record.wreckItemID > 0 &&
    Number.isSafeInteger(record.quantityBefore) && record.quantityBefore >= 0 &&
    Number.isSafeInteger(record.quantity) && record.quantity > 0;
}

function read() {
  const file = filePath();
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error && error.code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  }
  const state = JSON.parse(text);
  if (!state || state.version !== 1 || !state.entries || typeof state.entries !== "object") {
    throw new Error("WRECK_TRANSFER_GUARD_UNREADABLE");
  }
  return state;
}

function write(state) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return true;
}

function begin(fields = {}) {
  const record = {
    id: Date.now() * 1000 + (counter++ % 1000),
    characterID: Number(fields.characterID),
    wreckID: Number(fields.wreckID),
    wreckItemID: Number(fields.wreckItemID),
    destinationLocationID: Number(fields.destinationLocationID),
    destinationFlagID: Number(fields.destinationFlagID),
    quantityBefore: Number(fields.quantityBefore),
    quantity: Number(fields.quantity),
    singleton: fields.singleton === true,
    phase: "PENDING",
    startedAt: new Date().toISOString(),
  };
  if (!valid(record)) return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_INVALID" };
  try {
    const state = read();
    if (Object.keys(state.entries).length >= MAX_PENDING) {
      return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_FULL" };
    }
    state.entries[String(record.id)] = record;
    write(state);
    return { ok: true, id: record.id };
  } catch (error) {
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  }
}

function finish(id) {
  try {
    const state = read();
    const key = String(id);
    if (!state.entries[key]) return { ok: true, alreadyGone: true };
    delete state.entries[key];
    write(state);
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  }
}

function pending() {
  try { return Object.values(read().entries); } catch (error) { return []; }
}

function recover({ getWreckItem, undoGrant, restoreWreckItem } = {}) {
  if (typeof getWreckItem !== "function" || typeof undoGrant !== "function" ||
      typeof restoreWreckItem !== "function") {
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_RECOVERY_INCOMPLETE", resolved: [], blocked: [] };
  }
  const resolved = [];
  const blocked = [];
  for (const record of pending()) {
    let row = null;
    try { row = getWreckItem(record.wreckItemID); } catch (error) { row = null; }
    const remaining = row ? Number(row.quantity) : 0;
    const debited = remaining !== record.quantityBefore;
    let granted = false;
    try { granted = undoGrant(record, { dryRun: true }) === "PRESENT"; } catch (error) { granted = false; }
    let done = true;
    try {
      if (debited && !granted) {
        restoreWreckItem(record);
      } else if (!debited && granted) {
        undoGrant(record, { dryRun: false });
      }
    } catch (error) {
      done = false;
    }
    if (done) { finish(record.id); resolved.push(record.id); } else { blocked.push(record.id); }
  }
  return { ok: blocked.length === 0, resolved, blocked };
}

module.exports = { begin, finish, pending, recover, filePath };
