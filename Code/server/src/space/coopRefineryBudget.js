"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BUDGET_FILE = "refinery-budget.json";
const COMMITMENTS_FILE = "refinery-commitments.jsonl";

const ROUND = (v) => Math.round(v * 100) / 100;

function budgetFileFor(root) {
  return path.join(root, BUDGET_FILE);
}

function commitmentsFileFor(root) {
  return path.join(root, COMMITMENTS_FILE);
}

// Append-only durability: the row is written, then the FILE is fsynced through a descriptor that is
// always closed. Every commitment row goes through here.
function syncFile(file, fsApi) {
  const fd = fsApi.openSync(file, "r+");
  try { fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
}
function readBudget(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const file = budgetFileFor(root);
  try {
    const raw = fsApi.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.limitISK !== "number" || !Number.isFinite(parsed.limitISK) || parsed.limitISK < 0) {
      return { status: "BUDGET_UNREADABLE", reason: "limitISK_not_valid" };
    }
    if (typeof parsed.sinceAt !== "number" || !Number.isFinite(parsed.sinceAt)) {
      return { status: "BUDGET_UNREADABLE", reason: "sinceAt_not_valid" };
    }
    return { status: "OK", budget: parsed };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { status: "ABSENT" };
    }
    return { status: "BUDGET_UNREADABLE", reason: err.message };
  }
}

function setBudget(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { corporationID, stationID, limitISK, sinceAt, setBy, now } = opts;
  if (typeof corporationID !== "number" || !Number.isFinite(corporationID)) {
    return { status: "INVALID", reason: "corporationID" };
  }
  if (typeof stationID !== "number" || !Number.isFinite(stationID)) {
    return { status: "INVALID", reason: "stationID" };
  }
  if (typeof limitISK !== "number" || !Number.isFinite(limitISK) || limitISK < 0) {
    return { status: "INVALID", reason: "limitISK" };
  }
  if (typeof sinceAt !== "number" || !Number.isFinite(sinceAt)) {
    return { status: "INVALID", reason: "sinceAt" };
  }
  const budget = { corporationID, stationID, limitISK: ROUND(limitISK), sinceAt: ROUND(sinceAt), setBy: setBy || null, updatedAt: ROUND(now || Date.now()) };
  const file = budgetFileFor(root);
  const tmp = file + ".tmp";
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.writeFileSync(tmp, JSON.stringify(budget, null, 2));
  // Durable, and the descriptor is closed: an fsync on an unclosed fd leaks one per call, and an
  // fsync on a PATH is not a valid call at all (measured on this module's first cut).
  syncFile(tmp, fsApi);
  fsApi.renameSync(tmp, file);
  syncFile(file, fsApi);
  return { status: "SET", budget };
}

function readCommitments(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const file = commitmentsFileFor(root);
  try {
    const raw = fsApi.readFileSync(file, "utf8");
    const rows = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch (err) {
        break;
      }
    }
    return { rows, skipped: 0 };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { rows: [], skipped: 0 };
    }
    return { rows: [], skipped: 0 };
  }
}

function spent(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { rows } = readCommitments(root, opts);
  const terminal = new Set();
  for (const row of rows) {
    if (row.type === "REFUSED" || row.type === "VOID") {
      terminal.add(row.operationID);
    }
  }
  let spentISK = 0;
  const open = [];
  for (const row of rows) {
    if (row.type === "RESERVED" && !terminal.has(row.operationID)) {
      spentISK += row.amountISK;
      open.push(row.operationID);
    }
  }
  return { spentISK: ROUND(spentISK), open, rows };
}

function reserve(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { operationID, amountISK, corporationID, stationID, balanceBefore, limitISK, sinceAt, now } = opts;
  const { rows } = readCommitments(root, opts);
  for (const row of rows) {
    if (row.operationID === operationID) {
      return { status: "OPERATION_ALREADY_COMMITTED" };
    }
  }
  const spentNow = spent(root, opts).spentISK;
  if (spentNow + amountISK > limitISK) {
    const at = ROUND(now || Date.now());
    const file = commitmentsFileFor(root);
    fsApi.appendFileSync(file, JSON.stringify({ type: "REFUSED", operationID, amountISK: ROUND(amountISK), reason: "SPEND_SCOPE_EXHAUSTED", at }) + "\n");
    syncFile(file, fsApi);
    return { status: "SPEND_SCOPE_EXHAUSTED", spentISK: ROUND(spentNow), limitISK: ROUND(limitISK) };
  }
  const at = ROUND(now || Date.now());
  const file = commitmentsFileFor(root);
  fsApi.appendFileSync(file, JSON.stringify({ type: "RESERVED", operationID, amountISK: ROUND(amountISK), corporationID, stationID, balanceBefore: ROUND(balanceBefore), at }) + "\n");
  syncFile(file, fsApi);
  return { status: "RESERVED" };
}

function commit(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { operationID, balanceAfter, now } = opts;
  const { rows } = readCommitments(root, opts);
  for (const row of rows) {
    if (row.operationID === operationID && row.type === "DEBITED") {
      return { status: "ALREADY_COMMITTED" };
    }
  }
  const at = ROUND(now || Date.now());
  const file = commitmentsFileFor(root);
  fsApi.appendFileSync(file, JSON.stringify({ type: "DEBITED", operationID, balanceAfter: ROUND(balanceAfter), at }) + "\n");
  syncFile(file, fsApi);
  return { status: "COMMITTED" };
}

function voidOperation(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { operationID, proof, now } = opts;
  const { rows } = readCommitments(root, opts);
  for (const row of rows) {
    if (row.operationID === operationID && (row.type === "REFUSED" || row.type === "VOID")) {
      return { status: "ALREADY_TERMINAL" };
    }
  }
  const at = ROUND(now || Date.now());
  const file = commitmentsFileFor(root);
  fsApi.appendFileSync(file, JSON.stringify({ type: "VOID", operationID, proof: proof || "MANUAL", at }) + "\n");
  syncFile(file, fsApi);
  return { status: "VOIDED" };
}

function recover(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { balanceNow, corporationID, now } = opts;
  const { rows } = readCommitments(root, opts);
  // An operation is settled for recovery once ANY of these rows exists for it. DEBITED matters here:
  // a committed charge is not "open", and recovering it again would write a second debit row for one
  // fee - the exact double count this log exists to prevent.
  const settled = new Set(rows
    .filter((row) => ["DEBITED", "VOID", "REFUSED", "UNCERTAIN"].includes(row.type))
    .map((row) => row.operationID));
  const pending = [];
  for (const row of rows) {
    if (row.type === "RESERVED" && !settled.has(row.operationID)) {
      pending.push(row);
    }
  }
  const debited = [];
  const voided = [];
  const uncertain = [];
  for (const row of pending) {
    const tolerance = 0.005;
    const diff = Math.abs(balanceNow - (row.balanceBefore - row.amountISK));
    const unchanged = Math.abs(balanceNow - row.balanceBefore);
    let verdict;
    if (diff <= tolerance) {
      verdict = "BALANCE_MOVED";
    } else if (unchanged <= tolerance) {
      verdict = "BALANCE_UNCHANGED";
    } else {
      verdict = "UNCERTAIN";
    }
    const at = ROUND(now || Date.now());
    if (verdict === "BALANCE_MOVED") {
      fsApi.appendFileSync(commitmentsFileFor(root), JSON.stringify({ type: "DEBITED", operationID: row.operationID, balanceAfter: ROUND(row.balanceBefore - row.amountISK), proof: "BALANCE_MOVED", at }) + "\n");
      syncFile(commitmentsFileFor(root), fsApi);
      debited.push(row.operationID);
    } else if (verdict === "BALANCE_UNCHANGED") {
      fsApi.appendFileSync(commitmentsFileFor(root), JSON.stringify({ type: "VOID", operationID: row.operationID, proof: "BALANCE_UNCHANGED", at }) + "\n");
      syncFile(commitmentsFileFor(root), fsApi);
      voided.push(row.operationID);
    } else {
      fsApi.appendFileSync(commitmentsFileFor(root), JSON.stringify({ type: "UNCERTAIN", operationID: row.operationID, balanceBefore: ROUND(row.balanceBefore), balanceNow: ROUND(balanceNow), at }) + "\n");
      syncFile(commitmentsFileFor(root), fsApi);
      uncertain.push(row.operationID);
    }
  }
  return { status: "RECOVERED", debited, voided, uncertain };
}

function resolveUncertain(root, opts = {}) {
  const fsApi = opts.fsApi || fs;
  const { operationID, verdict, actor, now } = opts;
  const { rows } = readCommitments(root, opts);
  const hasUncertain = rows.some((row) => row.operationID === operationID && row.type === "UNCERTAIN");
  if (!hasUncertain) {
    return { status: "NOT_UNCERTAIN" };
  }
  const at = ROUND(now || Date.now());
  const file = commitmentsFileFor(root);
  fsApi.appendFileSync(file, JSON.stringify({ type: verdict, operationID, by: actor, proof: "OPERATOR:" + actor, at }) + "\n");
  syncFile(file, fsApi);
  return { status: "RESOLVED" };
}

module.exports = {
  BUDGET_FILE,
  COMMITMENTS_FILE,
  ROUND,
  budgetFileFor,
  commitmentsFileFor,
  readBudget,
  setBudget,
  readCommitments,
  spent,
  reserve,
  commit,
  voidOperation,
  recover,
  resolveUncertain,
};