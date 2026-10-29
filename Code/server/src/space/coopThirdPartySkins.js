"use strict";
// Third-party SKIN licences (eve_public.cosmetic.ship.skin.thirdparty.license.*).
//
// A third-party skin is a player-designed skin identified by a hex string, which is NOT the
// catalogue skin id that services/ship/shipCosmeticsState uses (that one is a type id), so
// it needs its own store. This module owns the per-character licence rows:
//
//   { skin: hex, activated, unactivated, escrowed, firstAcquiredMs, name, shipTypeID }
//
// and nothing else. A licence exists because a row exists: GetOwned lists rows, Get answers
// one row, Activate turns an unactivated copy into a usable licence, and the admin Grant /
// Revoke calls are the only way a row appears or disappears. Applying a licence to a real
// ship is the next step and is deliberately not here yet.
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
  return { version: VERSION, licences: {} };
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
      name: String(row.name || ""),
      shipTypeID: Math.max(0, int(row.shipTypeID)),
    };
  }
  return { version: VERSION, licences };
}

function createThirdPartySkins({
  characterState = null,
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
  function grant(characterID, { skin, unactivated = 1, name = "", shipTypeID = 0 } = {}) {
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

  return Object.freeze({ enabled, list, get, grant, revoke, activate });
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
