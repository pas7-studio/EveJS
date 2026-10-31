"use strict";
// A wreck pickup writes two stores: the destination inventory (itemStore) and the wreck source
// (nativeNpcStore). They are not one transaction, so a crash between them can duplicate or lose
// loot. Every pickup therefore opens a durable intent before touching either store, and the intent
// is closed only when both stores agree. Leftovers are resolved on the next boot by comparing the
// stores with what the intent recorded, never by assuming the failed call did what it meant to.
const fs = require("node:fs");
const path = require("node:path");
const journal = require(path.join(__dirname, "./coopNativeWreckTransferJournal"));

const FILE_ENV = "EVEJS_COOP_WRECK_TRANSFER_GUARD_FILE";
const MAX_PENDING = 512;
const EMPTY_LOCK_GRACE_MS = 5000;
let counter = 0;

function readOwner(wreckItemID) {
  try {
    const raw = fs.readFileSync(lockPath(wreckItemID), "utf8").trim();
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch (error) {
    return 0;
  }
}

function lockAgeMs(wreckItemID) {
  try {
    return Date.now() - fs.statSync(lockPath(wreckItemID)).mtimeMs;
  } catch (error) {
    return Infinity;
  }
}

function filePath() {
  if (process.env[FILE_ENV]) return process.env[FILE_ENV];
  // Keep the guard beside the game store it protects: a test fixture and a container volume both
  // get their own file, and no repository checkout is ever written to.
  const dataDir = process.env.EVEJS_GAMESTORE_DATA_DIR;
  if (dataDir) return path.join(path.resolve(dataDir, ".."), "coop-wreck-transfer-guard.json");
  return path.join(process.env.EVEJS_DATA_ROOT || process.cwd(), "coop-wreck-transfer-guard.json");
}

function lockPath(wreckItemID) {
  return filePath() + ".lock-" + String(wreckItemID);
}

function trace(event, detail) {
  if (process.env.EVEJS_WRECK_GUARD_TRACE !== "1") return;
  try {
    process.stderr.write("[guard] " + process.pid + " " + event + " " + JSON.stringify(detail) + "\n");
  } catch (error) { /* tracing must never break the guard */ }
}

function ownerAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function acquire(wreckItemID) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath(wreckItemID), "wx");
    } catch (error) {
      if (!error || error.code !== "EEXIST") return false;
      const owner = readOwner(wreckItemID);
      if (owner > 0) {
        if (owner === process.pid || ownerAlive(owner)) {
          trace("lock-busy", { wreckItemID, owner });
          return false;
        }
        trace("lock-stale", { wreckItemID, owner });
        release(wreckItemID);
        continue;
      }
      // The file exists but carries no owner yet: either another process is between creating it and
      // writing its pid, or it died in that window. Only age separates the two, so a young empty
      // lock is treated as owned.
      if (lockAgeMs(wreckItemID) < EMPTY_LOCK_GRACE_MS) {
        trace("lock-publishing", { wreckItemID });
        return false;
      }
      trace("lock-empty-stale", { wreckItemID });
      release(wreckItemID);
      continue;
    }
    try {
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch (error) {
      try { fs.closeSync(fd); } catch (_closeError) { /* nothing left to close */ }
      release(wreckItemID);
      return false;
    }
    trace("lock-acquired", { wreckItemID });
    return true;
  }
  return false;
}

function release(wreckItemID) {
  try {
    fs.unlinkSync(lockPath(wreckItemID));
  } catch (error) {
    // already gone
  }
}

function valid(record) {
  return record && typeof record === "object" &&
    Number.isSafeInteger(record.id) && record.id > 0 &&
    Number.isSafeInteger(record.characterID) && record.characterID > 0 &&
    Number.isSafeInteger(record.wreckID) && record.wreckID > 0 &&
    Number.isSafeInteger(record.wreckItemID) && record.wreckItemID > 0 &&
    Number.isSafeInteger(record.typeID) && record.typeID > 0 &&
    Number.isSafeInteger(record.quantityBefore) && record.quantityBefore > 0 &&
    Number.isSafeInteger(record.quantity) && record.quantity > 0 &&
    Array.isArray(record.destinationBefore);
}

function read() {
  return journal.read(filePath());
}

function begin(fields = {}) {
  const record = {
    id: 0, // assigned inside the journal transaction, where it is unique across processes
    characterID: Number(fields.characterID),
    wreckID: Number(fields.wreckID),
    wreckItemID: Number(fields.wreckItemID),
    typeID: Number(fields.typeID),
    singleton: fields.singleton === true,
    destinationLocationID: Number(fields.destinationLocationID),
    destinationFlagID: Number(fields.destinationFlagID),
    quantityBefore: Number(fields.quantityBefore),
    quantity: Number(fields.quantity),
    destinationBefore: (fields.destinationBefore || []).map((row) => ({
      itemID: Number(row.itemID),
      quantity: Number(row.quantity),
    })),
    phase: "PENDING",
    startedAt: new Date().toISOString(),
  };
  if (!valid({ ...record, id: 1 })) return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_INVALID" };
  if (acquire(record.wreckItemID) !== true) {
    return { ok: false, errorMsg: "WRECK_TRANSFER_BUSY" };
  }
  let refusal = null;
  let written = null;
  try {
    written = journal.update(filePath(), (state) => {
    if (settledFor(state.entries, record.wreckItemID)) {
      // This item was already settled. A second caller may still hold a stale copy of the wreck
      // row from before the settlement, so the durable tombstone - not the cache - decides.
      refusal = { ok: false, errorMsg: "ITEM_NOT_FOUND" };
      return null;
    }
    if (Object.keys(state.entries).length >= MAX_PENDING) {
      refusal = { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_FULL" };
      return null;
    }
    const highest = Object.keys(state.entries).reduce((max, key) => Math.max(max, Number(key) || 0), 0);
    record.id = Math.max(Number(state.nextId) || 0, highest) + 1;
    state.nextId = record.id;
    state.entries[String(record.id)] = record;
    return state;
    });
  } catch (error) {
    release(record.wreckItemID);
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  }
  if (!written || !written.ok || refusal) {
    release(record.wreckItemID);
    return refusal || { ok: false, errorMsg: (written && written.errorMsg) || "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  }
  trace("intent-written", { id: record.id, wreckItemID: record.wreckItemID });
  return { ok: true, id: record.id, record };
}

function finish(id) {
  let settled = null;
  const outcome = journal.update(filePath(), (state) => {
    const key = String(id);
    const record = state.entries[key];
    // An unknown id, or one that is already settled, is a no-op that still reports success.
    if (!record || record.phase === "SETTLED") return state;
    // Keep a bounded tombstone: a stale reader in another process must be refused by the durable
    // record, and a settled item must never be payable twice.
    trace("settle", { id: record.id, wreckItemID: record.wreckItemID });
    settled = record;
    state.entries[key] = { ...record, phase: "SETTLED", settledAt: new Date().toISOString() };
    pruneSettled(state);
    return state;
  });
  if (!outcome.ok) return { ok: false, errorMsg: outcome.errorMsg || "WRECK_TRANSFER_GUARD_UNAVAILABLE" };
  if (!settled) return { ok: true, alreadyGone: true };
  release(settled.wreckItemID);
  return { ok: true };
}

function pending() {
  try {
    return Object.values(read().entries).filter((entry) => entry.phase !== "SETTLED");
  } catch (error) {
    throw new Error("WRECK_TRANSFER_GUARD_UNREADABLE");
  }
}

function settledFor(entries, wreckItemID) {
  return Object.values(entries).some((entry) => entry.phase === "SETTLED" &&
    Number(entry.wreckItemID) === Number(wreckItemID));
}

function pruneSettled(state, keep = 256) {
  const settled = Object.entries(state.entries)
    .filter(([, entry]) => entry.phase === "SETTLED")
    .sort((a, b) => String(a[1].settledAt || "").localeCompare(String(b[1].settledAt || "")));
  for (const [key] of settled.slice(0, Math.max(0, settled.length - keep))) {
    delete state.entries[key];
  }
  return state;
}

function delta(record, now) {
  const before = new Map((record.destinationBefore || []).map((r) => [Number(r.itemID), Number(r.quantity)]));
  const items = [];
  let quantity = 0;
  for (const row of now || []) {
    const id = Number(row.itemID);
    const had = before.has(id) ? before.get(id) : 0;
    const gained = Number(row.quantity) - had;
    if (gained > 0) {
      items.push({ itemID: id, quantity: gained, previous: had });
      quantity += gained;
    }
  }
  return { quantity, items };
}

// Resolution is driven by what the stores now contain.
//   untouched : the wreck row still holds exactly what it held before the call
//   debited   : it holds exactly what the call was going to leave behind
// anything else is an outcome this guard refuses to guess about.
function recover({ getWreckItem, listDestination, undoItems, restoreWreckItem } = {}) {
  if (typeof getWreckItem !== "function" || typeof listDestination !== "function" ||
      typeof undoItems !== "function" || typeof restoreWreckItem !== "function") {
    return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_RECOVERY_INCOMPLETE", resolved: [], blocked: [] };
  }
  const resolved = [];
  const blocked = [];
  let entries;
  try {
    entries = pending();
  } catch (error) {
    if (error && error.message === "WRECK_TRANSFER_GUARD_UNREADABLE") {
      return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_UNREADABLE", resolved: [], blocked: [] };
    }
    throw error;
  }
  for (const record of entries) {
    // A live pickup holds this lock. Recovery must never resolve an intent that another process is
    // still working on: that would undo a grant mid-flight and let a second caller take the item.
    if (acquire(record.wreckItemID) !== true) {
      blocked.push(record.id);
      continue;
    }
    let row = null;
    try {
      row = getWreckItem(record.wreckItemID);
    } catch (error) {
      release(record.wreckItemID);
      blocked.push(record.id);
      continue;
    }
    const remaining = row ? Number(row.quantity) : 0;
    const untouched = remaining === record.quantityBefore;
    const debitedFull = row === null && record.quantity === record.quantityBefore;
    const debitedPartial = remaining === record.quantityBefore - record.quantity;
    const debited = debitedFull || debitedPartial;
    let granted;
    try {
      granted = delta(record, listDestination(record));
    } catch (error) {
      release(record.wreckItemID);
      blocked.push(record.id);
      continue;
    }
    let done = false;
    try {
      if (untouched && granted.quantity === 0) {
        done = true;
      } else if (untouched && granted.quantity > 0 && granted.quantity <= record.quantity) {
        done = undoItems(record, granted.items) === true;
      } else if (debited && granted.quantity === record.quantity) {
        done = true;
      } else if (debited && granted.quantity === 0) {
        done = restoreWreckItem(record) === true;
      }
    } catch (error) {
      done = false;
    }
    if (done) {
      finish(record.id);
      resolved.push(record.id);
    } else {
      release(record.wreckItemID);
      blocked.push(record.id);
    }
  }
  // A lock with no intent behind it can only be debris from a killed process.
  const live = new Set(entries.map((r) => String(r.wreckItemID)));
  try {
    const dir = path.dirname(filePath());
    const prefix = path.basename(filePath()) + ".lock-";
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const wreckItemID = name.slice(prefix.length);
      if (live.has(wreckItemID)) continue;
      // Only debris. A lock younger than a minute may belong to a pickup that has just written its
      // intent, and deleting it would let a second caller in.
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(path.join(dir, name)).mtimeMs;
      } catch (error) {
        age = Infinity;
      }
      if (age > 60000) release(wreckItemID);
    }
  } catch (error) {
    // the directory may not exist yet
  }
  return { ok: blocked.length === 0, resolved, blocked };
}

module.exports = { begin, finish, pending, recover, filePath };
