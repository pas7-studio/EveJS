"use strict";
// Third-party SKIN design drafts
// (eve_public.cosmetic.ship.skin.thirdparty.draft.api.*).
//
// A draft is a design the character saved in the skin editor: a name, an optional line name,
// the layout bytes exactly as the client sent them and the per-slot editor configurations.
// It is NOT a licence and it is NOT a skin: nothing here mints a skin hex, and nothing here
// touches the licence store. Step 4 (sequencing) is what turns a stored draft into a skin.
//
// Why the layout is kept as raw bytes: the server never interprets a design, so re-encoding a
// decoded submessage would risk dropping fields this build of the server does not know. The
// bytes of the `layout` field are stored verbatim and the client gets them back when it reads
// the draft. The editor configurations are plain numbers, so those are kept as decoded values.
//
// The contract is unusually narrow on read: `draft.Attributes` carries only the source skin
// hex and the editor configurations - no name, no line_name, no layout. Those write-only
// fields are still stored, because sequencing needs them; they are simply not part of the
// read answer, and this module does not pretend otherwise.
//
// Rows live inside the character record through its single owner (characterState), like the
// licence, career and daily-goal state, so nothing reads a second copy.
const path = require("path");

const STATE_KEY = "skinDrafts";
const VERSION = 1;
const DEFAULT_CAPACITY = 20;
const MAX_NAME = 128;
const UUID_HEX = /^[0-9a-f]{2,128}$/;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function clampText(value, max) {
  const text = String(value == null ? "" : value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeUuid(value) {
  let hex = "";
  if (Buffer.isBuffer(value)) {
    hex = value.toString("hex");
  } else if (value instanceof Uint8Array) {
    hex = Buffer.from(value).toString("hex");
  } else {
    hex = String(value == null ? "" : value).trim().toLowerCase();
  }
  return UUID_HEX.test(hex) ? hex : "";
}

function normalizeBase64(value) {
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  const text = String(value == null ? "" : value).trim();
  return text;
}

function normalizeConfigurations(value) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const id = row.id && typeof row.id === "object" ? row.id : {};
    const config = row.config && typeof row.config === "object" ? row.config : {};
    rows.push({
      id: { sequential: Math.max(0, int(id.sequential)) },
      config: {
        offsetURatio: Number(config.offsetURatio) || 0,
        offsetVRatio: Number(config.offsetVRatio) || 0,
        yaw: Number(config.yaw) || 0,
        pitch: Number(config.pitch) || 0,
        roll: Number(config.roll) || 0,
        scaling: Number(config.scaling) || 0,
      },
    });
  }
  return rows;
}

function emptyState() {
  return { version: VERSION, drafts: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION ||
    !raw.drafts || typeof raw.drafts !== "object" || Array.isArray(raw.drafts)) {
    return emptyState();
  }
  const drafts = {};
  for (const [key, row] of Object.entries(raw.drafts)) {
    const uuid = normalizeUuid(key);
    if (!uuid || !row || typeof row !== "object") continue;
    drafts[uuid] = {
      uuid,
      name: clampText(row.name, MAX_NAME),
      lineName: clampText(row.lineName, MAX_NAME),
      skinHex: String(row.skinHex || ""),
      layout: normalizeBase64(row.layout),
      configurations: normalizeConfigurations(row.configurations),
      createdAtMs: Math.max(0, int(row.createdAtMs)),
      updatedAtMs: Math.max(0, int(row.updatedAtMs)),
    };
  }
  return { version: VERSION, drafts };
}

function createSkinDrafts({
  characterState = null,
  clock = () => Date.now(),
  randomUuid = () => require("crypto").randomBytes(16),
  env = process.env,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const enabled = () => env.EVEJS_COOP_THIRD_PARTY_SKINS === "1";

  // A real, enforced limit: the client asks for it and saving past it is refused.
  function capacity() {
    const configured = int(env.EVEJS_COOP_SKIN_DRAFT_CAPACITY);
    if (configured < 0) return 0;
    if (configured > 500) return 500;
    return configured || DEFAULT_CAPACITY;
  }

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
      throw Error("SKIN_DRAFT_STATE_WRITE_FAILED");
    }
    return state;
  }

  function list(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    const state = stateOf(id);
    return Object.values(state.drafts).sort((left, right) =>
      (right.updatedAtMs - left.updatedAtMs) || left.uuid.localeCompare(right.uuid));
  }

  function get(characterID, uuid) {
    const id = int(characterID);
    const key = normalizeUuid(uuid);
    if (!enabled() || id <= 0 || !key) return null;
    return stateOf(id).drafts[key] || null;
  }

  function count(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return 0;
    return Object.keys(stateOf(id).drafts).length;
  }

  function payloadOf({ name, lineName, skinHex, layout, configurations } = {}) {
    return {
      name: clampText(name, MAX_NAME),
      lineName: clampText(lineName, MAX_NAME),
      skinHex: String(skinHex || ""),
      layout: normalizeBase64(layout),
      configurations: normalizeConfigurations(configurations),
    };
  }

  function persist(characterID, state) {
    try {
      save(characterID, state);
      return { status: "OK" };
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
  }

  function create(characterID, input = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    if (Object.keys(state.drafts).length >= capacity()) {
      return { status: "CAPACITY_REACHED" };
    }
    const now = int(clock()) || Date.now();
    let uuid = "";
    for (let attempt = 0; attempt < 8 && !uuid; attempt += 1) {
      const candidate = normalizeUuid(randomUuid());
      if (candidate && !state.drafts[candidate]) uuid = candidate;
    }
    if (!uuid) return { status: "UUID_FAILED" };
    const draft = {
      uuid,
      ...payloadOf(input),
      createdAtMs: now,
      updatedAtMs: now,
    };
    state.drafts[uuid] = draft;
    const written = persist(id, state);
    return written.status === "OK" ? { status: "SAVED", draft } : written;
  }

  function update(characterID, input = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = normalizeUuid(input.uuid);
    if (!key) return { status: "UUID_REQUIRED" };
    const state = stateOf(id);
    const current = state.drafts[key];
    if (!current) return { status: "NOT_FOUND" };
    // The whole payload is replaced: Update is a full overwrite of the design.
    state.drafts[key] = {
      uuid: key,
      ...payloadOf(input),
      createdAtMs: current.createdAtMs,
      updatedAtMs: int(clock()) || Date.now(),
    };
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "UPDATED", draft: state.drafts[key] }
      : written;
  }

  function remove(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = normalizeUuid(uuid);
    if (!key) return { status: "UUID_REQUIRED" };
    const state = stateOf(id);
    if (!state.drafts[key]) return { status: "NOT_FOUND" };
    delete state.drafts[key];
    const written = persist(id, state);
    return written.status === "OK" ? { status: "DELETED" } : written;
  }

  return Object.freeze({
    enabled,
    capacity,
    list,
    get,
    count,
    create,
    update,
    remove,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createSkinDrafts();
  }
  return singleton;
}

module.exports = {
  DEFAULT_CAPACITY,
  MAX_NAME,
  STATE_KEY,
  createSkinDrafts,
  emptyState,
  normalizeState,
  normalizeUuid,
  shared,
};
