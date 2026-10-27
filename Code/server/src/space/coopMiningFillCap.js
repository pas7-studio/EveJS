"use strict";
/**
 * ALIFE-14. A miner must not accumulate more ore than the fleet can actually carry
 * away in one trip.
 *
 * Measured on the live world: miners reached 8 193 -> 12 781 -> 18 777 m3 of ore while
 * the only "hauler" was a Mining Venture and the largest real industrial hull in the
 * native mining pools holds 5 500 m3 (Mammoth; Badger 3 900, Bestower 4 800). The
 * stock dispatch trigger compares the miner's fill against the MINER's own capacity,
 * so it waited for 0.85 x 8 000 m3 - a load no hauler could ever take, and the ore
 * never moved.
 *
 * This module lowers the miner capacity the trigger sees to what the fleet can really
 * transfer right now: the sum of the haulers' real cargo capacity minus what they
 * already carry. Capacity comes from the same SDE rows the transfer itself enforces,
 * so the fleet plans with the hold it actually has - never an invented number.
 *
 * Default OFF (EVEJS_COOP_MINING_FILL_CAP). With it off nothing is touched: the caller
 * keeps the stock value it already computed.
 */

const FLAG = "EVEJS_COOP_MINING_FILL_CAP";

// Below this a "hauler" cannot take a meaningful load. Do not cap the miners to it:
// that would silently stop all mining. Report it instead and let the visible haul
// refusals speak.
const MIN_USABLE_M3 = 1_000;

const pos = (x) => {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function defaultResolveType() {
  try {
    return require("../services/inventory/itemTypeRegistry").resolveItemByTypeID;
  } catch (_error) {
    return null;
  }
}

function defaultStore() {
  try {
    return require("./npc/nativeNpcStore");
  } catch (_error) {
    return null;
  }
}

// What the fleet can still take right now, in m3. null means "cannot be proven",
// which is never the same thing as zero.
function transferableM3({scene, fleet, store, resolveType} = {}) {
  const read = resolveType || defaultResolveType();
  const native = store || defaultStore();
  if (typeof read !== "function" || !native || typeof scene?.getEntityByID !== "function") return null;
  const haulers = Array.isArray(fleet?.haulerEntityIDs) ? fleet.haulerEntityIDs : [];
  let free = 0;
  for (const haulerID of haulers) {
    const id = pos(haulerID);
    if (!id) continue;
    const ship = scene.getEntityByID(id);
    if (!ship || ship.kind !== "ship") continue;
    const capacity = Number(read(pos(ship.typeID))?.capacity);
    if (!(capacity > 0)) continue;
    const rows = typeof native.listNativeCargoForEntity === "function"
      ? native.listNativeCargoForEntity(id) : null;
    if (!Array.isArray(rows)) return null;
    let used = 0;
    let proven = true;
    for (const row of rows) {
      const volume = Number(read(pos(row?.typeID))?.volume);
      const quantity = Number(row?.quantity);
      if (!Number.isFinite(volume) || volume <= 0 || !Number.isFinite(quantity) || quantity < 0) {
        proven = false;
        break;
      }
      used += volume * quantity;
    }
    if (!proven) return null;
    free += Math.max(0, capacity - used);
  }
  return free;
}

// Mutates the fleet cargo state in place: the stock dispatcher reads minerCapacityM3
// and minerFillRatio from this object, and nothing downstream re-derives them.
function apply(scene, fleet, cargoState, options = {}) {
  const env = options.env || process.env;
  try {
    if (String(env[FLAG] || "") !== "1") return cargoState;
    if (!cargoState || !Number.isFinite(Number(cargoState.minerCapacityM3))) return cargoState;
    const free = transferableM3({scene, fleet, store: options.store, resolveType: options.resolveType});
    if (free === null) {
      note(options, "CAP_UNPROVEN", {systemID: pos(scene?.systemID), fleetID: pos(fleet?.fleetID)});
      return cargoState;
    }
    if (free < MIN_USABLE_M3) {
      note(options, "HAULER_HOLD_UNUSABLE", {
        systemID: pos(scene?.systemID), fleetID: pos(fleet?.fleetID), freeM3: Math.round(free * 100) / 100,
      });
      return cargoState;
    }
    const previous = Number(cargoState.minerCapacityM3);
    const cap = Math.min(previous, free);
    if (!(cap > 0) || cap === previous) return cargoState;
    cargoState.minerCapacityM3 = cap;
    cargoState.minerFillRatio = Number(cargoState.minerUsedVolumeM3) > 0
      ? Number(cargoState.minerUsedVolumeM3) / cap : 0;
    cargoState.coopFillCapM3 = cap;
    cargoState.coopHaulerFreeM3 = free;
    note(options, "CAP_APPLIED", {
      systemID: pos(scene?.systemID), fleetID: pos(fleet?.fleetID),
      minerCapacityBeforeM3: previous, capM3: Math.round(cap * 100) / 100,
      haulerFreeM3: Math.round(free * 100) / 100,
    });
    return cargoState;
  } catch (_error) {
    // Observation must never break the mining tick.
    return cargoState;
  }
}

// One event per fleet per change, never per tick.
const lastNote = new Map();
function note(options, status, fields) {
  const key = String(fields.fleetID) + ":" + status;
  const signature = status + "|" + String(fields.freeM3 ?? fields.capM3 ?? "");
  if (lastNote.get(key) === signature) return;
  lastNote.set(key, signature);
  try {
    const observe = options.observe || require("./coopObserve").observe;
    const probe = options.probe || require("./coopRuntimeProbe");
    observe(probe, "living-mining-fill-cap", {systemID: fields.systemID || 0}, {
      fleetID: fields.fleetID || 0,
      status,
      reason: status === "CAP_APPLIED" ? null : status,
      minerCapacityBeforeM3: fields.minerCapacityBeforeM3 ?? null,
      capM3: fields.capM3 ?? null,
      haulerFreeM3: fields.haulerFreeM3 ?? null,
    });
  } catch (_error) { /* telemetry only */ }
}

module.exports = {FLAG, MIN_USABLE_M3, transferableM3, apply};
