"use strict";
// Third-party SKIN component licences
// (eve_public.cosmetic.ship.skin.thirdparty.component.license.*).
//
// The skin designer lets a player use pattern/coating components. A component is identified by
// its coating id (component.Identifier.coating.sequential), and a character owns two kinds of
// licence for it:
//
//   finite   - a capacity that is spent down (capacity is what is left, not the original size)
//   infinite - usable freely (free: true), never spent
//
// A licence exists because a row exists: the admin Grant calls are the only way one appears and
// Revoke is the only way one disappears. Nothing here invents a licence for a component the
// character was never granted, and taking a finite amount refuses rather than going negative.
//
// Rows live inside the character record through its single owner (characterState), like the
// licence, draft, career and daily-goal state.
const path = require("path");

const STATE_KEY = "componentLicences";
const VERSION = 1;
const MAX_COMPONENT = 1e9;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

// A component id is a positive integer; 0 is "no component" and is never a licence.
function componentID(value) {
  const id = int(value);
  return id > 0 && id <= MAX_COMPONENT ? id : 0;
}

function emptyState() {
  return { version: VERSION, finite: {}, infinite: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION) {
    return emptyState();
  }
  const finite = {};
  const infinite = {};
  for (const [key, row] of Object.entries(raw.finite || {})) {
    const id = componentID(key);
    if (!id || !row || typeof row !== "object") continue;
    finite[String(id)] = {
      component: id,
      capacity: Math.max(0, int(row.capacity)),
      firstAcquiredMs: Math.max(0, int(row.firstAcquiredMs)),
    };
  }
  for (const [key, row] of Object.entries(raw.infinite || {})) {
    const id = componentID(key);
    if (!id || !row || typeof row !== "object") continue;
    infinite[String(id)] = {
      component: id,
      free: row.free !== false,
      firstAcquiredMs: Math.max(0, int(row.firstAcquiredMs)),
    };
  }
  return { version: VERSION, finite, infinite };
}

function createComponentLicences({
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
      throw Error("COMPONENT_LICENCE_STATE_WRITE_FAILED");
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
    if (!enabled() || id <= 0) return { finite: [], infinite: [] };
    const state = stateOf(id);
    const byComponent = (left, right) => left.component - right.component;
    return {
      finite: Object.values(state.finite).sort(byComponent).map((row) => ({ ...row })),
      infinite: Object.values(state.infinite).sort(byComponent).map((row) => ({ ...row })),
    };
  }

  function finite(characterID, componentValue) {
    const id = int(characterID);
    const component = componentID(componentValue);
    if (!enabled() || id <= 0 || !component) return null;
    const row = stateOf(id).finite[String(component)];
    return row ? { ...row } : null;
  }

  function infinite(characterID, componentValue) {
    const id = int(characterID);
    const component = componentID(componentValue);
    if (!enabled() || id <= 0 || !component) return null;
    const row = stateOf(id).infinite[String(component)];
    return row ? { ...row } : null;
  }

  function grantFinite(characterID, { component, capacity } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = componentID(component);
    if (!key) return { status: "COMPONENT_REQUIRED" };
    const amount = int(capacity);
    if (amount <= 0) return { status: "CAPACITY_REQUIRED" };
    const state = stateOf(id);
    const existing = state.finite[String(key)];
    // A grant adds capacity to the copy the character already has, keeping the first date.
    state.finite[String(key)] = {
      component: key,
      capacity: (existing ? existing.capacity : 0) + amount,
      firstAcquiredMs: (existing && existing.firstAcquiredMs) || (int(clock()) || Date.now()),
    };
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "GRANTED", licence: { ...state.finite[String(key)] } }
      : written;
  }

  function grantInfinite(characterID, { component } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = componentID(component);
    if (!key) return { status: "COMPONENT_REQUIRED" };
    const state = stateOf(id);
    const existing = state.infinite[String(key)];
    state.infinite[String(key)] = {
      component: key,
      free: true,
      firstAcquiredMs: (existing && existing.firstAcquiredMs) || (int(clock()) || Date.now()),
    };
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "GRANTED", licence: { ...state.infinite[String(key)] } }
      : written;
  }

  function revoke(characterID, { component, kind } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = componentID(component);
    if (!key) return { status: "COMPONENT_REQUIRED" };
    const state = stateOf(id);
    const bucket = kind === "infinite" ? state.infinite : state.finite;
    if (!bucket[String(key)]) return { status: "NOT_FOUND" };
    delete bucket[String(key)];
    const written = persist(id, state);
    return written.status === "OK" ? { status: "REVOKED" } : written;
  }

  // Used when a design spends a component: infinite is always enough, finite must have it.
  function takeFinite(characterID, componentValue, amount = 1) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = componentID(componentValue);
    if (!key) return { status: "COMPONENT_REQUIRED" };
    const wanted = Math.max(1, int(amount));
    const state = stateOf(id);
    if (state.infinite[String(key)]) return { status: "FREE", remaining: 0 };
    const row = state.finite[String(key)];
    if (!row) return { status: "LICENCE_NOT_FOUND" };
    if (row.capacity < wanted) return { status: "NOT_ENOUGH_CAPACITY", remaining: row.capacity };
    row.capacity -= wanted;
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "SPENT", remaining: row.capacity }
      : written;
  }

  return Object.freeze({
    enabled,
    list,
    finite,
    infinite,
    grantFinite,
    grantInfinite,
    revoke,
    takeFinite,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createComponentLicences();
  }
  return singleton;
}

module.exports = {
  STATE_KEY,
  componentID,
  createComponentLicences,
  emptyState,
  normalizeState,
  shared,
};
