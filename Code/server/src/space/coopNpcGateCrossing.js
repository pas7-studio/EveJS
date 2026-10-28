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
const FOLLOW_RANGE_M = 200000;
const MAX_REVIVE_MISSES = 5;
const STANDDOWN_AFTER_WAITS = 10;
const MAX_TARGET_WAITS = 20;

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

// The adapter measures the jump range against the SCENE static stargate (its own radius), not
// against the star-gate row from static data. Measured 2026-10-29: five attempts were refused
// NPC_NOT_AT_PHYSICAL_GATE while this module believed the hull was already close enough,
// because the two records describe different radii. Ask the same authority the verdict uses.
function physicalGate(scene, gateID) {
  const rows = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : null;
  if (!rows) return null;
  return rows.find((row) => Number(row.itemID) === Number(gateID) &&
    String(row.kind) === "stargate") || null;
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
function plan({entityID, pilotID = null, gate = null, now = Date.now(), operatorKind = null} = {}) {
  // A mining fleet hull is not a transport: measured 2026-10-29, its own mining behaviour
  // flew a hauler back to a belt after every order, and the gap oscillated 7-13 km for half
  // an hour, while the fleet also lost that hull from its mining slot.
  if (String(operatorKind || "").startsWith("coop-mining-"))
    return {status: "REFUSED", reason: "HULL_ROLE_CONFLICT:MINING_FLEET"};
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
// The native adapter refuses a crossing for a dozen different reasons and reports one
// opaque code. Measured 2026-10-29: five attempts were spent that way and nothing was
// learned. This reports the actual failing predicate, and separates a hull that is merely
// busy (wait) from one that can never pass (name it and stop).
const PREFLIGHT_TRANSIENT = new Set(["TARGET_LOCKED", "MODULE_EFFECTS", "WARPING"]);
/**
 * Retire a journaled crossing with a reason. This is the only way a run stops for good:
 * measured 2026-10-29, a MINING hauler in Jita was ordered to the gate and its own mining
 * behaviour flew it back to a belt every time, so the gap oscillated for ever. A hull that
 * cannot do the job must be retired honestly, not retried until the journal looks busy.
 */
function abandon(entityID, reason) {
  const id = Number(entityID);
  const entry = read().find((row) => Number(row.entityID) === id);
  if (!entry) return { status: "NOT_FOUND" };
  entry.phase = "ABANDONED";
  entry.lastReason = String(reason || "OPERATOR_ABANDONED").slice(0, 90);
  entry.updatedAt = Date.now();
  write(entry);
  return { status: "ABANDONED", entry };
}
function preflightBlocker({ sourceScene, ship, controller, isScrambled }) {
  const id = Number(ship && (ship.itemID ?? ship.entityID));
  if (!sourceScene) return "SOURCE_SCENE_UNAVAILABLE";
  if (!ship) return "SHIP_NOT_IN_SOURCE_SCENE";
  if (ship.nativeNpc !== true) return "NOT_NATIVE_NPC";
  if (ship.kind !== "ship") return "NOT_SHIP";
  if (ship.session && ship.session.characterID) return "SESSION_OWNED";
  if (!ship.position || [ship.position.x, ship.position.y, ship.position.z]
    .some((v) => !Number.isFinite(Number(v)))) return "NO_POSITION";
  if (!controller || Number(controller.entityID) !== id) return "CONTROLLER_MISMATCH";
  if (Number(controller.systemID) !== Number(sourceScene.systemID))
    return "CONTROLLER_OTHER_SYSTEM";
  if (controller.manualOrder && String(controller.manualOrder.type) === "attack")
    return "ATTACK_ORDER";
  if (typeof isScrambled === "function") {
    try { if (isScrambled(ship)) return "SCRAMBLED"; } catch (_error) { /* fail open */ }
  }
  if (ship.activeModuleEffects && ship.activeModuleEffects.size > 0) return "MODULE_EFFECTS";
  if (String(ship.mode || "").toUpperCase().includes("WARP")) return "WARPING";
  if (Number(controller.currentTargetID) > 0) return "TARGET_LOCKED";
  return null;
}
function tick({ sceneForSystem, getGate, getController, warpToGate, followGate, transfer,
  materialize = null, isScrambled = null, standDown = null,
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
      // The ship may be durable but not live (a restart rebuilt the scene). Bringing it
      // back from its own store record is the narrow road; anything else stays blocked.
      let revived = false;
      try {
        const answer = typeof materialize === "function"
          ? materialize(sourceScene, entry.entityID) : null;
        revived = Boolean(answer && answer.success === true);
      } catch (_error) { revived = false; }
      // Why the hull vanished matters: a live controller without a ship is a different
      // fault from a hull nobody revived, and only one of them is worth retrying.
      let live = false;
      try { live = Boolean(typeof getController === "function" && getController(entry.entityID)); }
      catch (_error) { live = false; }
      entry.updatedAt = now;
      entry.lastReason = revived ? "REMATERIALIZED_FROM_STORE"
        : "SHIP_NOT_IN_SOURCE_SCENE:" + (live ? "CONTROLLER_LIVE" : "CONTROLLER_GONE");
      // A live controller may still be woken by the world itself, so that gets a bounded
      // number of chances; an endless retry would look identical to progress for ever.
      entry.reviveMisses = revived ? 0 : Number(entry.reviveMisses || 0) + 1;
      const revivable = typeof materialize === "function";
      if (!revivable || entry.reviveMisses >= MAX_REVIVE_MISSES) {
        entry.phase = "BLOCKED";
        entry.lastReason = !revivable ? "SHIP_NOT_IN_SOURCE_SCENE:NO_REVIVE_PATH"
          : "SHIP_LOST_REVIVE_FAILED";
      } else {
        entry.phase = "APPROACH";
      }
      write(entry);
      note(entry, { entityID: entry.entityID, status: entry.lastReason });
      advanced.push(entry);
      continue;
    }
    // The scene row is the authority the native verdict re-reads; the static-data row is a
    // fallback for the first approach, never the measurement that authorises an attempt.
    const gate = physicalGate(sourceScene, entry.sourceGateID) ||
      (typeof getGate === "function" ? getGate(entry.sourceGateID) : null);
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
      const gap = surfaceGap({ ship, gate });
      // Close range is a FOLLOW order, not a warp: the native warp refuses a target that
      // is already a few kilometres away, so a warp loop never reaches the gate.
      const closeRange = gap !== null && gap <= FOLLOW_RANGE_M;
      const waitMs = closeRange ? 30000 : 60000;
      if (entry.phase === "APPROACH" && now - Number(entry.warpAt || 0) > waitMs) {
        let issued = false, how = "WARP_TO_GATE";
        try {
          if (closeRange && typeof followGate === "function") {
            issued = followGate(entry.entityID, entry.sourceGateID) === true;
            how = "FOLLOW_GATE";
          } else if (typeof warpToGate === "function") {
            issued = warpToGate(entry.entityID, entry.sourceGateID) !== false;
          }
        } catch (_error) { issued = false; }
        entry.warpAt = now;
        entry.lastReason = issued ? how : (closeRange ? "FOLLOW_GATE_REFUSED" : "WARP_REFUSED");
        entry.updatedAt = now;
        write(entry);
        // Where the hull is, not only how far: a follow that never shrinks the gap must be
        // visible as such instead of looking like patience.
        note(entry, { entityID: entry.entityID, status: entry.lastReason,
          gap: surfaceGap({ ship, gate }),
          ship: ship && ship.position ? [Math.round(ship.position.x), Math.round(ship.position.y), Math.round(ship.position.z)] : null,
          gate: gate && gate.position ? [Math.round(gate.position.x), Math.round(gate.position.y), Math.round(gate.position.z)] : null });
      }
      advanced.push(entry);
      continue;
    }
    entry.phase = "AT_GATE";
    // The gap is re-measured here: the note below needs it, and a name that only exists in
    // the branch above would throw exactly when the hull is close and something blocks it.
    const atGateGap = surfaceGap({ ship, gate });
    const controller = typeof getController === "function" ? getController(entry.entityID) : null;
    const blocker = preflightBlocker({ sourceScene, ship, controller, isScrambled });
    if (blocker) {
      const transient = PREFLIGHT_TRANSIENT.has(blocker);
      // A target lock is cleared by the same legitimate order that closes the distance.
      let acted = false;
      if (blocker === "TARGET_LOCKED" && typeof followGate === "function" &&
        now - Number(entry.warpAt || 0) > 15000) {
        try { acted = followGate(entry.entityID, entry.sourceGateID) === true; }
        catch (_error) { acted = false; }
        entry.warpAt = now;
      }
      // A hull whose behaviour loop keeps re-locking is not a waiting game: measured
      // 2026-10-29 the same miner-hauler held a target through a whole hour of ticks.
      // One sanctioned stand-down, then an honest stop instead of an endless "calm".
      if (blocker === "TARGET_LOCKED") {
        entry.targetWaits = Number(entry.targetWaits || 0) + 1;
        if (entry.targetWaits === STANDDOWN_AFTER_WAITS && typeof standDown === "function") {
          try { acted = standDown(entry.entityID) === true || acted; }
          catch (_error) { /* the refusal is reported below */ }
        }
        if (entry.targetWaits >= MAX_TARGET_WAITS) {
          entry.phase = "BLOCKED";
          entry.lastReason = "TARGET_LOCKED_PERSISTENT";
          entry.updatedAt = now;
          write(entry);
          note(entry, { entityID: entry.entityID, status: entry.lastReason, gap: atGateGap,
            phase: entry.phase, targetWaits: entry.targetWaits });
          advanced.push(entry);
          continue;
        }
      }
      entry.lastReason = (transient ? "WAITING_CALM:" : "PREFLIGHT_IMPOSSIBLE:") + blocker +
        (acted ? ":FOLLOW_ISSUED" : "");
      if (!transient) entry.phase = "BLOCKED";
      entry.updatedAt = now;
      write(entry);
      note(entry, { entityID: entry.entityID, status: entry.lastReason, gap: atGateGap,
        phase: entry.phase });
      advanced.push(entry);
      continue;
    }
    // At most one real attempt every 10 s: a refusal is information, not a retry race.
    if (now - Number(entry.attemptAt || 0) < 10000) {
      advanced.push(entry);
      continue;
    }
    entry.attemptAt = now;
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
      // The adapter expects the proven GATE PAIR, not the stargate record: it re-reads both
      // gates and refuses the crossing unless they are reciprocal in the named systems.
      result = transfer({ pilotID: entry.pilotID, entityID: entry.entityID,
        gate: { sourceGateID: entry.sourceGateID, destinationGateID: entry.destinationGateID,
          sourceSystemID: entry.fromSystemID, destinationSystemID: entry.toSystemID },
        sourceScene, ship,
        controller: typeof getController === "function" ? getController(entry.entityID) : null });
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

module.exports = { abandon, physicalGate, STANDDOWN_AFTER_WAITS, MAX_TARGET_WAITS, MAX_REVIVE_MISSES, preflightBlocker, PREFLIGHT_TRANSIENT, MAX_ATTEMPTS, DEFAULT_GATE_RANGE_M, FOLLOW_RANGE_M, root, surfaceGap, inRange,
  judgeCrossing, plan, tick, read };
