"use strict";
/**
 * ALIFE-15. The native cargo projection drops the ore volume, and the mining fleet
 * cannot plan without it.
 *
 * nativeNpcStore.buildNativeCargoItems() rebuilds a ship's `nativeCargoItems` from the
 * stored rows, and the row shape it emits has no `volume` field. Before a restart the
 * entries created by appendNpcMiningCargo carry `volume`, so the fleet fill ratio is
 * real; after a restart every entry is a projection without it, so
 * getNpcOreCargoVolume() returns 0, minerFillRatio stays 0 and shouldTriggerHauling()
 * is false forever. Measured: the live fleet sat in state "mining" with 333 907 units
 * of ore on one Hulk and never dispatched a hauler, while the same world dispatched
 * before the restart.
 *
 * This annotates an entry with the SDE volume of its own typeID when it is missing.
 * It never changes quantities, ownership or custody: the value is a property of the
 * ore type, and the type is already in the row.
 *
 * Default OFF (EVEJS_COOP_CARGO_VOLUME_FALLBACK); with it off nothing is touched.
 */

const FLAG = "EVEJS_COOP_CARGO_VOLUME_FALLBACK";

function resolveType(typeID) {
  try {
    return require("../services/inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID));
  } catch (_error) {
    return null;
  }
}

// Returns the entry unchanged unless the volume is genuinely missing.
function ensure(entry, options = {}) {
  const env = options.env || process.env;
  try {
    if (String(env[FLAG] || "") !== "1") return entry;
    if (!entry || typeof entry !== "object") return entry;
    const known = Number(entry.volume);
    if (Number.isFinite(known) && known > 0) return entry;
    const typeID = Number(entry.typeID);
    if (!Number.isSafeInteger(typeID) || typeID <= 0) return entry;
    const resolve = options.resolveType || resolveType;
    const type = resolve(typeID);
    const volume = Number(type && type.volume);
    if (!Number.isFinite(volume) || volume <= 0) return entry;
    if (options.freeze === true) return {...entry, volume};
    entry.volume = volume;
    if (!Number.isFinite(Number(entry.stacksize)) || Number(entry.stacksize) <= 0) {
      const quantity = Number(entry.quantity);
      if (Number.isSafeInteger(quantity) && quantity > 0) entry.stacksize = quantity;
    }
    return entry;
  } catch (_error) {
    return entry;
  }
}

module.exports = {FLAG, ensure};
