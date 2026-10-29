"use strict";
// Character titles (eve_public.cosmetic.character.title.api.*).
//
// A title is a cosmetic label a character can wear. The catalogue of titles is client content
// (it arrives through a definition checkpoint), so this module owns only what the server really
// knows: which titles a character was granted, and which one that character is wearing.
//
// A title exists for a character because an admin grant created it; Revoke removes it and also
// drops it from the worn slot, so nobody keeps wearing a title they no longer own. Equipping a
// title that was never granted is refused instead of silently remembered.
//
// Rows live inside the character record through its single owner (characterState).
const path = require("path");

const STATE_KEY = "characterTitles";
const VERSION = 1;
const MAX_TITLES = 256;
const UUID_HEX = /^[0-9a-f]{2,128}$/;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

// Title ids arrive as raw bytes; rows are keyed by the hex form.
function uuidKey(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value == null ? "" : value).trim().toLowerCase();
}

function emptyState() {
  return { version: VERSION, owned: {}, equipped: "" };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION) {
    return emptyState();
  }
  const owned = {};
  for (const [key, row] of Object.entries(raw.owned || {})) {
    const uuid = uuidKey(key);
    if (!UUID_HEX.test(uuid)) continue;
    owned[uuid] = { uuid, grantedMs: Math.max(0, int(row && row.grantedMs)) };
  }
  const equipped = uuidKey(raw.equipped);
  return { version: VERSION, owned, equipped: owned[equipped] ? equipped : "" };
}

function createCharacterTitles({
  characterState = null,
  clock = () => Date.now(),
  env = process.env,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const enabled = () => env.EVEJS_COOP_CHARACTER_TITLES === "1";

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
      throw Error("CHARACTER_TITLE_STATE_WRITE_FAILED");
    }
    return state;
  }

  function persist(characterID, state) {
    try {
      save(characterID, state);
      return { status: "OK" };
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
  }

  function list(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    return Object.values(stateOf(id).owned)
      .sort((left, right) => (left.grantedMs - right.grantedMs) || left.uuid.localeCompare(right.uuid));
  }

  function equipped(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return "";
    return stateOf(id).equipped;
  }

  function grant(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!UUID_HEX.test(key)) return { status: "TITLE_REQUIRED" };
    const state = stateOf(id);
    if (!state.owned[key] && Object.keys(state.owned).length >= MAX_TITLES) {
      return { status: "TOO_MANY_TITLES" };
    }
    // A second grant is not an error and does not move the original date.
    if (!state.owned[key]) {
      state.owned[key] = { uuid: key, grantedMs: int(clock()) || Date.now() };
    }
    const written = persist(id, state);
    return written.status === "OK" ? { status: "GRANTED", title: state.owned[key] } : written;
  }

  function revoke(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!UUID_HEX.test(key)) return { status: "TITLE_REQUIRED" };
    const state = stateOf(id);
    if (!state.owned[key]) return { status: "NOT_FOUND" };
    delete state.owned[key];
    // A revoked title cannot stay worn: the appearance claim goes with the ownership.
    if (state.equipped === key) state.equipped = "";
    const written = persist(id, state);
    return written.status === "OK" ? { status: "REVOKED" } : written;
  }

  function equip(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!UUID_HEX.test(key)) return { status: "TITLE_REQUIRED" };
    const state = stateOf(id);
    if (!state.owned[key]) return { status: "NOT_OWNED" };
    state.equipped = key;
    const written = persist(id, state);
    return written.status === "OK" ? { status: "EQUIPPED", title: key } : written;
  }

  function unequip(characterID) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    state.equipped = "";
    const written = persist(id, state);
    return written.status === "OK" ? { status: "UNEQUIPPED" } : written;
  }

  return Object.freeze({
    enabled,
    list,
    equipped,
    grant,
    revoke,
    equip,
    unequip,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createCharacterTitles();
  }
  return singleton;
}

module.exports = {
  STATE_KEY,
  createCharacterTitles,
  emptyState,
  normalizeState,
  shared,
  uuidKey,
};
