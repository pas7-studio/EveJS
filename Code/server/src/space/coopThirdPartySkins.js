"use strict";
// Third-party SKIN licences (eve_public.cosmetic.ship.skin.thirdparty.license.*).
//
// A third-party skin is a player-designed skin identified by a hex string, which is NOT the
// catalogue skin id that services/ship/shipCosmeticsState uses (that one is a type id), so
// it needs its own store. This module owns the per-character licence rows:
//
//   { skin: hex, activated, unactivated, escrowed, firstAcquiredMs, name, shipTypeID }
//
// and the applied map. A licence exists because a row exists: GetOwned lists rows, Get
// answers one row, Activate turns an unactivated copy into a usable licence, and the admin
// Grant / Revoke calls are the only way a row appears or disappears.
//
// Applying a licence to a ship only ever records a real ship the character owns: the item is
// looked up in the inventory and must be a ship, and the licence must already be activated.
// Unapply removes exactly that record. Nothing else in the world claims a ship's appearance.
//
// The rows live inside the character record through its single owner (characterState), like
// the career and daily-goal state, so nothing reads a second copy.
const path = require("path");

const STATE_KEY = "thirdPartySkins";
const VERSION = 1;
const MAX_LICENCES = 256;
const HEX = /^[0-9a-fA-F]{4,128}$/;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function pos(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeHex(value) {
  const hex = String(value || "").trim();
  return HEX.test(hex) ? hex.toLowerCase() : "";
}

function emptyState() {
  return { version: VERSION, licences: {}, applied: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== VERSION || !raw.licences ||
    typeof raw.licences !== "object" || Array.isArray(raw.licences)) {
    return emptyState();
  }
  const licences = {};
  for (const [key, row] of Object.entries(raw.licences)) {
    const hex = normalizeHex(key);
    if (!hex || !row || typeof row !== "object") continue;
    licences[hex] = {
      skin: hex,
      activated: row.activated === true,
      unactivated: Math.max(0, int(row.unactivated)),
      escrowed: Math.max(0, int(row.escrowed)),
      firstAcquiredMs: Math.max(0, int(row.firstAcquiredMs)),
      firstSequencedMs: Math.max(0, int(row.firstSequencedMs)),
      name: String(row.name || ""),
      lineName: String(row.lineName || ""),
      layout: String(row.layout || ""),
      creatorID: Math.max(0, int(row.creatorID)),
      shipTypeID: Math.max(0, int(row.shipTypeID)),
    };
  }
  const applied = {};
  for (const [key, hex] of Object.entries(raw.applied || {})) {
    const shipID = int(key);
    const skin = normalizeHex(hex);
    if (shipID > 0 && skin && licences[skin]) applied[String(shipID)] = skin;
  }
  return { version: VERSION, licences, applied };
}

function createThirdPartySkins({
  characterState = null,
  shipLookup = null,
  clock = () => Date.now(),
  env = process.env,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const enabled = () => env.EVEJS_COOP_THIRD_PARTY_SKINS === "1";

  function stateOf(characterID) {
    try {
      const record = owner().getCharacterRecord(characterID);
      return normalizeState(record && record[STATE_KEY]);
    } catch (_error) {
      return emptyState();
    }
  }

  function save(characterID, state) {
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      [STATE_KEY]: state,
    }));
    if (!result || result.success !== true) {
      throw Error("THIRD_PARTY_SKIN_STATE_WRITE_FAILED");
    }
    return state;
  }

  function list(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    const state = stateOf(id);
    return Object.values(state.licences).sort((left, right) =>
      (left.firstAcquiredMs - right.firstAcquiredMs) || left.skin.localeCompare(right.skin));
  }

  function get(characterID, skinHex) {
    const id = int(characterID);
    const hex = normalizeHex(skinHex);
    if (!enabled() || id <= 0 || !hex) return null;
    return stateOf(id).licences[hex] || null;
  }

  // The admin grant is the only creator: a licence with no row does not exist.
  function grant(characterID, {
    skin, unactivated = 1, name = "", shipTypeID = 0, lineName = "", layout = "", creatorID = 0,
  } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const hex = normalizeHex(skin);
    if (!hex) return { status: "SKIN_REQUIRED" };
    const count = Math.max(0, int(unactivated));
    if (count <= 0) return { status: "COUNT_REQUIRED" };
    const state = stateOf(id);
    if (!state.licences[hex] && Object.keys(state.licences).length >= MAX_LICENCES) {
      return { status: "TOO_MANY_LICENCES" };
    }
    const nowMs = Math.max(0, int(clock()));
    const existing = state.licences[hex];
    state.licences[hex] = {
      skin: hex,
      activated: existing ? existing.activated : false,
      unactivated: (existing ? existing.unactivated : 0) + count,
      escrowed: existing ? existing.escrowed : 0,
      firstAcquiredMs: existing && existing.firstAcquiredMs ? existing.firstAcquiredMs : nowMs,
      name: String(name || (existing && existing.name) || ""),
      lineName: String(lineName || (existing && existing.lineName) || ""),
      layout: String(layout || (existing && existing.layout) || ""),
      creatorID: Math.max(0, int(creatorID) || (existing ? existing.creatorID : 0)),
      // Only a sequencing job records a design and its creator; an admin grant does not, so it
      // must stay honestly "not sequenced" instead of pretending a date it never had.
      firstSequencedMs: (existing && existing.firstSequencedMs)
        || (String(layout || "").trim() && int(creatorID) > 0 ? nowMs : 0),
      shipTypeID: pos(int(shipTypeID)) ? int(shipTypeID) : (existing ? existing.shipTypeID : 0),
    };
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "GRANTED", licence: state.licences[hex] };
  }

  function revoke(characterID, skinHex) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const hex = normalizeHex(skinHex);
    if (!hex) return { status: "SKIN_REQUIRED" };
    const state = stateOf(id);
    if (!state.licences[hex]) return { status: "NOT_FOUND" };
    delete state.licences[hex];
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "REVOKED" };
  }

  // Activating turns one un-activated copy into a usable licence; it never invents one.
  function activate(characterID, skinHex) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const hex = normalizeHex(skinHex);
    if (!hex) return { status: "SKIN_REQUIRED" };
    const state = stateOf(id);
    const row = state.licences[hex];
    if (!row) return { status: "NOT_FOUND" };
    if (row.activated) return { status: "ALREADY_ACTIVATED" };
    if (row.unactivated <= 0) return { status: "NOTHING_TO_ACTIVATE" };
    row.unactivated -= 1;
    row.activated = true;
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "ACTIVATED", licence: row };
  }

  // The ship must be a real item this character owns and it must be a ship. The lookup is
  // injectable so a test can prove the ownership rules without a database.
  function shipBelongsTo(characterID, shipID) {
    if (typeof shipLookup === "function") {
      return shipLookup(characterID, shipID) || { status: "SHIP_LOOKUP_FAILED" };
    }
    try {
      const item = require(path.join(__dirname, "../services/inventory/itemStore"))
        .findItemById(shipID);
      if (!item) return { status: "SHIP_NOT_FOUND" };
      if (int(item.ownerID) !== int(characterID)) return { status: "SHIP_NOT_OWNED" };
      const type = require(path.join(__dirname, "../services/inventory/itemTypeRegistry"))
        .resolveItemByTypeID(int(item.typeID));
      if (!type || int(type.categoryID) !== 6) return { status: "NOT_A_SHIP" };
      return { status: "OK" };
    } catch (_error) {
      return { status: "SHIP_LOOKUP_FAILED" };
    }
  }

  function appliedFor(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return {};
    return { ...stateOf(id).applied };
  }

  function apply(characterID, { skin, shipID } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const hex = normalizeHex(skin);
    if (!hex) return { status: "SKIN_REQUIRED" };
    const ship = int(shipID);
    if (!ship) return { status: "SHIP_REQUIRED" };
    const state = stateOf(id);
    const row = state.licences[hex];
    if (!row) return { status: "LICENCE_NOT_FOUND" };
    if (!row.activated) return { status: "LICENCE_NOT_ACTIVATED" };
    const ownership = shipBelongsTo(id, ship);
    if (ownership.status !== "OK") return ownership;
    state.applied[String(ship)] = hex;
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "APPLIED", skin: hex, shipID: ship };
  }

  function unapply(characterID, { skin, shipID } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const ship = int(shipID);
    if (!ship) return { status: "SHIP_REQUIRED" };
    const hex = normalizeHex(skin);
    const state = stateOf(id);
    const current = state.applied[String(ship)];
    if (!current) return { status: "NOT_APPLIED" };
    if (hex && hex !== current) return { status: "SKIN_MISMATCH" };
    delete state.applied[String(ship)];
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "UNAPPLIED", skin: current, shipID: ship };
  }

  return Object.freeze({
    enabled,
    list,
    get,
    grant,
    revoke,
    activate,
    appliedFor,
    apply,
    unapply,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createThirdPartySkins();
  }
  return singleton;
}

module.exports = {
  MAX_LICENCES,
  STATE_KEY,
  createThirdPartySkins,
  emptyState,
  normalizeHex,
  normalizeState,
  shared,
};
