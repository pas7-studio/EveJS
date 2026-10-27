"use strict";
// Generic "player-like NPC" journey machinery.
//
// Any server-driven character that must look like a real player (courier,
// hauler, miner, patrol, trader) needs the same four things, and none of them
// are role specific:
//   1. a leg (undock -> warp -> arrive -> dock) that survives a restart,
//   2. resume from the physical truth (where the hull really is), never from
//      a stale record and never by flying back to the start,
//   3. an honest history: when it departed, what actually went wrong,
//   4. a duration for the report the owner reads.
//
// Roles stay outside: this module never decides *why* an agent travels, what it
// carries or whom it notifies. It only moves one agent through one leg and
// remembers it. Motion primitives come from `coopNativeAgentMotion`.
const motion = require("./coopNativeAgentMotion" + (typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs"));

const LEG_STEPS = Object.freeze(["undock", "warp", "arrive", "dock", "done"]);

function positive(value) {
  const numeric = Number(value) || 0;
  return numeric > 0 ? numeric : 0;
}

// ---- persisted legs -------------------------------------------------------
// A leg is { legID, agentID, shipItemID, fromStationID, toStationID, systemID,
// entityID, step, stepStartedAtMs }. Anything unreadable is dropped instead of
// guessed, so a corrupt file can never send a ship to an invented station.
function createLegStore(options) {
  const opts = options || {};
  const fs = opts.fs || require("node:fs");
  const file = String(opts.file || "/var/lib/evejs/coop-living-agent-legs.json");
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const legs = new Map();

  function load() {
    legs.clear();
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_error) {
      return legs;
    }
    for (const [key, value] of Object.entries(parsed && parsed.legs || {})) {
      if (!value || typeof value !== "object") continue;
      if (!LEG_STEPS.includes(String(value.step))) continue;
      if (!positive(value.agentID) || !positive(value.toStationID)) continue;
      legs.set(String(key), Object.assign({}, value, { legID: String(key) }));
    }
    return legs;
  }

  function save() {
    try {
      const out = {};
      for (const [key, value] of legs) out[key] = value;
      fs.writeFileSync(file, JSON.stringify({ legs: out }));
    } catch (error) {
      log(`[LivingAgent] leg store write failed: ${String(error && error.message || error)}`);
    }
  }

  function put(leg) {
    if (!leg || !leg.legID) return null;
    legs.set(String(leg.legID), Object.assign({}, leg));
    return legs.get(String(leg.legID));
  }

  function get(legID) {
    return legs.get(String(legID)) || null;
  }

  function drop(legID) {
    return legs.delete(String(legID));
  }

  return { legs, load, save, put, get, drop };
}

// ---- persisted history ----------------------------------------------------
// { legID: { departedAtMs, incidents: [{atMs, kind, detail}] } }
function createHistoryStore(options) {
  const opts = options || {};
  const fs = opts.fs || require("node:fs");
  const file = String(opts.file || "/var/lib/evejs/coop-living-agent-history.json");
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const rows = new Map();

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed && parsed.history || {})) {
      if (!value || typeof value !== "object") continue;
      rows.set(String(key), {
        departedAtMs: positive(value.departedAtMs),
        incidents: Array.isArray(value.incidents) ? value.incidents.slice(-20) : [],
      });
    }
  } catch (_error) {
    /* no history yet */
  }

  function save() {
    try {
      const out = {};
      for (const [key, value] of rows) out[key] = value;
      fs.writeFileSync(file, JSON.stringify({ history: out }));
    } catch (_error) {
      /* a lost history line must never break a journey */
    }
  }

  function forLeg(legID) {
    const key = String(legID);
    let row = rows.get(key);
    if (!row) {
      row = { departedAtMs: 0, incidents: [] };
      rows.set(key, row);
    }
    return row;
  }

  function noteDeparture(legID) {
    const row = forLeg(legID);
    if (!(positive(row.departedAtMs) > 0)) row.departedAtMs = now();
    save();
    return row.departedAtMs;
  }

  function noteIncident(legID, kind, detail) {
    const row = forLeg(legID);
    row.incidents.push({ atMs: now(), kind: String(kind), detail: String(detail || "") });
    if (row.incidents.length > 20) row.incidents.shift();
    save();
    return row;
  }

  function durationMs(legID) {
    const row = rows.get(String(legID));
    const departed = positive(row && row.departedAtMs);
    return departed > 0 ? now() - departed : 0;
  }

  function incidents(legID) {
    const row = rows.get(String(legID));
    return row && Array.isArray(row.incidents) ? row.incidents.slice() : [];
  }

  function forget(legID) {
    rows.delete(String(legID));
    save();
  }

  return { noteDeparture, noteIncident, durationMs, incidents, forget, departedAtMs: (id) => positive((rows.get(String(id)) || {}).departedAtMs) };
}

// ---- the leg machine ------------------------------------------------------
// One native action per call. `hooks` let a role attach its own real side
// effects (load cargo before undock, hand it over after dock) without this
// module knowing what the agent carries.
function createLegMachine(options) {
  const opts = options || {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};

  function nextStep(step) {
    const index = LEG_STEPS.indexOf(String(step));
    if (index < 0 || index >= LEG_STEPS.length - 1) return "done";
    return LEG_STEPS[index + 1];
  }

  // Advances one leg by exactly one native action.
  // ctx: { character, transitions, space, sceneForSystem, session }
  function stepLeg(leg, ctx, input) {
    const request = input || {};
    const hooks = request.hooks || {};
    if (!leg || !leg.step) return { leg, observed: { status: motion.FAILED, reason: "no leg" } };
    if (leg.step === "done") return { leg, observed: { status: "DONE" } };

    if (leg.step === "arrive") {
      if (request.arrivalConfirmed !== true) {
        // Re-issue the warp instead of waiting forever; the interval is generic.
        const interval = positive(request.rewarpIntervalMs) || 60000;
        const last = positive(leg.rewarpAtMs);
        if (last > 0 && now() - last <= interval) {
          return { leg, observed: { status: "PENDING", reason: String(request.arrivalDetail || "arrival pending") } };
        }
        const warped = motion.warpAgent(ctx, {
          entityID: leg.entityID,
          systemID: leg.systemID,
          point: request.targetPoint,
          ingressMs: request.ingressMs,
        });
        log(`[LivingAgent] ${leg.agentID} re-warp ${warped.status} ${warped.reason || ""}`.trim());
        const rewarped = Object.assign({}, leg, { rewarpAtMs: now() });
        return {
          leg: rewarped,
          observed: { status: "REWARP", reason: warped.reason || warped.status, rewarped: true },
        };
      }
      const confirmed = Object.assign({}, leg, { step: nextStep("arrive"), stepStartedAtMs: now(), rewarpAtMs: 0 });
      return { leg: confirmed, observed: { status: motion.OK, step: "arrive" } };
    }

    let observed;
    if (leg.step === "undock") {
      observed = motion.undockAgent(ctx, leg.fromStationID);
    } else if (leg.step === "warp") {
      observed = motion.warpAgent(ctx, {
        entityID: leg.entityID,
        systemID: leg.systemID,
        point: request.targetPoint,
        ingressMs: request.ingressMs,
      });
    } else if (leg.step === "dock") {
      observed = motion.dockAgent(ctx, leg.toStationID);
    } else {
      return { leg, observed: { status: motion.FAILED, reason: "unknown leg step: " + leg.step } };
    }

    const advanced = Object.assign({}, leg, {
      step: observed.status === motion.OK ? nextStep(leg.step) : leg.step,
      stepStartedAtMs: observed.status === motion.OK ? now() : positive(leg.stepStartedAtMs),
      entityID: positive(observed.entityID) || positive(leg.entityID),
    });
    return { leg: advanced, observed: Object.assign({ step: leg.step }, observed) };
  }

  return { stepLeg, nextStep };
}

// Physical truth helper: a hull sitting in a station hangar means the agent is
// docked there, whatever the character row still claims.
function hullDockedAt(shipRow, stationID) {
  return positive(shipRow && shipRow.locationID) === positive(stationID) &&
    Number(shipRow && shipRow.flagID) === 4;
}

module.exports = {
  LEG_STEPS,
  createLegStore,
  createHistoryStore,
  createLegMachine,
  hullDockedAt,
};
