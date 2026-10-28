"use strict";
// ALIFE-19. The last link: move one load across a real gate, and never claim it happened.
//
// The decision (space/coopNpcDistribution.js) already says what to ship and what it pays.
// This module owns the ONLY thing left: a durable, one-at-a-time crossing of a real native
// hull through a real reciprocal gate, with the native transfer's own verdict as the sole
// evidence. Nothing here warps, transfers or sells on its own initiative: a run exists only
// because an operator journaled one, and every step is driven by injected authorities.
//
// Rules it never breaks:
//  - a crossing is ARRIVED only on the native adapter's full proof: success, the same
//    entityID, the source really absent, the destination really present (docs forbid any
//    virtual system jump or synthetic coordinates);
//  - a refused crossing is retried a bounded number of times and then BLOCKED with the
//    adapter's own reason, never silently dropped;
//  - the journal is written atomically before and after every step, so a crash leaves a
//    readable state instead of an ambiguous ship.
const fs = require("node:fs");
const path = require("node:path");

const MAX_ATTEMPTS = 5;
const DEFAULT_GATE_RANGE_M = 2500;

const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);

function root() {
  return process.env.EVEJS_COOP_GATE_CROSSING_DIR ||
    path.join(process.env.EVEJS_COOP_NPC_MARKET_ROOT || "/var/lib/evejs/coop-native-market",
      "gate-crossing");
}

// Surface separation, the same rule the pinned client uses for a gate jump.
function surfaceGap({ship, gate} = {}) {
  if (!ship || !gate || !ship.position || !gate.position) return null;
  const dx = ship.position.x - gate.position.x;
  const dy = ship.position.y - gate.position.y;
  const dz = ship.position.z - gate.position.z;
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return Math.max(0, Math.hypot(dx, dy, dz) -
    Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(gate.radius) || 0));
}

function inRange({ship, gate, maxMeters = DEFAULT_GATE_RANGE_M} = {}) {
  const gap = surfaceGap({ship, gate});
  return gap !== null && gap <= Math.max(1, Number(maxMeters) || DEFAULT_GATE_RANGE_M);
}

/**
 * The native adapter's verdict, and nothing else, decides whether a ship crossed.
 * A partial result (re-materialized but the source still there, or a different entityID)
 * is a FAILURE: that is exactly the half-truth the docs call a fake jump.
 */
function judgeCrossing({result, expectedEntityID, expectedSystemID} = {}) {
  const entityID = pos(expectedEntityID);
  const systemID = pos(expectedSystemID);
  if (!result || typeof result !== "object") return {ok: false, reason: "NO_RESULT"};
  if (result.success !== true) {
    return {ok: false, reason: String(result.errorMsg || result.reason || "TRANSFER_REFUSED").slice(0, 90)};
  }
  if (result.verifiedSourceAbsent !== true) return {ok: false, reason: "SOURCE_STILL_PRESENT"};
  if (result.verifiedDestinationPresent !== true) return {ok: false, reason: "DESTINATION_ABSENT"};
  if (pos(result.entityID) !== entityID) return {ok: false, reason: "ENTITY_CHANGED"};
  if (pos(result.systemID) !== systemID) return {ok: false, reason: "WRONG_DESTINATION_SYSTEM"};
  return {ok: true, reason: "SAME_NATIVE_SHIP_ARRIVED"};
}

function journalFile(id) {
  return path.join(root(), String(pos(id)) + ".json");
}

function write(entry) {
  const file = journalFile(entry.entityID);
  fs.mkdirSync(root(), { recursive: true });
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(entry));
  fs.renameSync(temp, file);
  return entry;
}

function read() {
  let names = [];
  try { names = fs.readdirSync(root()).filter((n) => n.endsWith(".json")); }
  catch (_error) { return []; }
  const out = [];
  for (const name of names) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(root(), name), "utf8"));
      if (row && pos(row.entityID)) out.push(row);
    } catch (_error) { /* one unreadable journal must not hide the others */ }
  }
  return out;
}

/** Journal one crossing. Refuses without the real gate pair it would use. */
function plan({entityID, pilotID = null, gate = null, now = Date.now()} = {}) {
  const id = pos(entityID);
  const sourceGateID = pos(gate && (gate.sourceGateID || gate.itemID));
  const destinationGateID = pos(gate && gate.destinationGateID);
  const fromSystemID = pos(gate && gate.sourceSystemID);
  const toSystemID = pos(gate && gate.destinationSystemID);
  if (!id) return { status: "INVALID_ENTITY" };
  if (!sourceGateID || !fromSystemID || !toSystemID) return { status: "INVALID_GATE" };
  const existing = read().find((row) => pos(row.entityID) === id &&
    ["APPROACH", "AT_GATE", "CROSSING"].includes(String(row.phase)));
  if (existing) return { status: "ALREADY_PENDING", entry: existing };
  const entry = {
    version: 1, entityID: id, pilotID: pilotID ? String(pilotID) : null,
    phase: "APPROACH", sourceGateID, destinationGateID, fromSystemID, toSystemID,
    attempts: 0, createdAt: now, updatedAt: now, warpAt: 0, lastReason: null,
  };
  write(entry);
  return { status: "PLANNED", entry };
}

/**
 * Advance every journaled crossing by at most one step. Never throws.
 * `transfer` is the native adapter (coopNativeGateTransfer.transfer); without it a run
 * stays at AT_GATE and says TRANSFER_UNAVAILABLE instead of pretending to cross.
 */
function tick({ sceneForSystem, getGate, getController, warpToGate, transfer,
  now = Date.now(), observe = null, maxMeters = DEFAULT_GATE_RANGE_M } = {}) {
  const entries = read().filter((row) =>
    ["APPROACH", "AT_GATE", "CROSSING"].includes(String(row.phase)));
  if (!entries.length) return { status: "IDLE", advanced: [] };
  const advanced = [];
  const note = (entry, fields) => {
    try { if (typeof observe === "function") observe("living-npc-gate-crossing", null, null, fields); }
    catch (_error) { /* telemetry only */ }
  };
  for (const entry of entries) {
    const sourceScene = typeof sceneForSystem === "function"
      ? sceneForSystem(entry.fromSystemID) : null;
    const ship = sourceScene && typeof sourceScene.getEntityByID === "function"
      ? sourceScene.getEntityByID(entry.entityID) : null;
    if (!ship) {
      entry.phase = "BLOCKED";
      entry.lastReason = "SHIP_NOT_IN_SOURCE_SCENE";
      entry.updatedAt = now;
      write(entry);
      note(entry, { entityID: entry.entityID, status: entry.lastReason });
      advanced.push(entry);
      continue;
    }
    const gate = typeof getGate === "function" ? getGate(entry.sourceGateID) : null;
    if (!gate) {
      entry.phase = "BLOCKED";
      entry.lastReason = "GATE_UNREADABLE";
      entry.updatedAt = now;
      write(entry);
      note(entry, { entityID: entry.entityID, status: entry.lastReason });
      advanced.push(entry);
      continue;
    }
    if (!inRange({ ship, gate, maxMeters })) {
      // One warp per minute at most: a hull that is already flying must not be re-ordered.
      if (entry.phase === "APPROACH" && now - Number(entry.warpAt || 0) > 60000) {
        let issued = false;
        try { issued = typeof warpToGate === "function" && warpToGate(entry.entityID, entry.sourceGateID) !== false; }
        catch (_error) { issued = false; }
        entry.warpAt = now;
        entry.lastReason = issued ? "WARP_TO_GATE" : "WARP_REFUSED";
        entry.updatedAt = now;
        write(entry);
        note(entry, { entityID: entry.entityID, status: entry.lastReason,
          gap: surfaceGap({ ship, gate }) });
      }
      advanced.push(entry);
      continue;
    }
    entry.phase = "AT_GATE";
    if (typeof transfer !== "function") {
      entry.lastReason = "TRANSFER_UNAVAILABLE";
      entry.updatedAt = now;
      write(entry);
      note(entry, { entityID: entry.entityID, status: entry.lastReason });
      advanced.push(entry);
      continue;
    }
    entry.phase = "CROSSING";
    entry.attempts = Number(entry.attempts || 0) + 1;
    let result = null;
    try {
      result = transfer({ pilotID: entry.pilotID, entityID: entry.entityID, gate,
        sourceScene, ship, controller: typeof getController === "function" ? getController(entry.entityID) : null });
    } catch (error) {
      result = { success: false, errorMsg: String((error && error.message) || error).slice(0, 90) };
    }
    const verdict = judgeCrossing({ result, expectedEntityID: entry.entityID,
      expectedSystemID: entry.toSystemID });
    entry.lastReason = verdict.reason;
    entry.updatedAt = now;
    if (verdict.ok) {
      entry.phase = "ARRIVED";
      entry.arrivedAt = now;
    } else if (entry.attempts >= MAX_ATTEMPTS) {
      entry.phase = "BLOCKED";
    } else {
      entry.phase = "AT_GATE";
    }
    write(entry);
    note(entry, { entityID: entry.entityID, status: verdict.reason,
      phase: entry.phase, attempts: entry.attempts,
      fromSystemID: entry.fromSystemID, toSystemID: entry.toSystemID });
    advanced.push(entry);
  }
  return { status: "ADVANCED", advanced };
}

module.exports = { MAX_ATTEMPTS, DEFAULT_GATE_RANGE_M, root, surfaceGap, inRange,
  judgeCrossing, plan, tick, read };
