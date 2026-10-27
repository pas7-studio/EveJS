"use strict";
// A raider's native home anchor.
//
// Why it exists: a stock NPC that flies beyond its own leash clears its combat
// state and returns home on every think, so an order it cannot legally reach can
// never become fire. Measured live in New Caldari 30000145: an armed blaster
// cruiser with 300 real charges was spawned at the system anchor, the mining
// fleet works a belt 2.5 AU away, its leash is 90 000 m, and every raid order it
// received was cancelled by its own leash return (mode GOTO, currentTargetID 0).
//
// The honest fix is not a bigger leash or a teleport into a fight: a raider that
// lives at the belt its prey works is a normal pirate. This module moves the
// hull's own durable home to a REAL scene entity (the belt the fleet is mining),
// only while the hull is idle, and publishes the exact anchor it used. No
// distance constant of ours is involved and no hull is moved.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";

const pos = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

function vec(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x), y = Number(value.y), z = Number(value.z);
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x, y, z };
}

function distance(left, right) {
  const a = vec(left), b = vec(right);
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function defaultAuthorities() {
  const store = require("./npc/nativeNpcStore" + siblingSuffix);
  const registry = require("./npc/npcRegistry" + siblingSuffix);
  return {
    getNativeEntity: (id) => store.getNativeEntity(id),
    getNativeController: (id) => store.getNativeController(id),
    upsertNativeController: (record) => store.upsertNativeController(record),
    getLiveController: (id) => registry.getControllerByEntityID(id),
    observe: (event, detail) => {
      try { require("./coopRuntimeProbe" + siblingSuffix).observe(event, null, null, detail); }
      catch (_error) { /* telemetry must never block a relocation */ }
    },
  };
}

const REQUIRED_KEYS = Object.freeze([
  "getNativeEntity",
  "getNativeController",
  "upsertNativeController",
  "getLiveController",
]);

function createRaidHomeAnchor(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  let authorities = null;
  const a = () => {
    if (authorities) return authorities;
    const missing = REQUIRED_KEYS.filter((key) => typeof base[key] !== "function");
    let defaults = {};
    if (missing.length) {
      try { defaults = defaultAuthorities(); } catch (_error) { defaults = {}; }
    }
    authorities = Object.assign(defaults, base);
    if (typeof authorities.observe !== "function") authorities.observe = () => {};
    const stillMissing = REQUIRED_KEYS.filter((key) => typeof authorities[key] !== "function");
    if (stillMissing.length) throw Error("RAID_HOME_ANCHOR_AUTHORITIES_REQUIRED:" + stillMissing.join(","));
    return authorities;
  };

  // Decide only; nothing is written here. Every refusal is a measured reason.
  function plan({ entityID, anchorID, anchor } = {}) {
    const auth = a();
    const id = pos(entityID), anchorKey = pos(anchorID);
    if (!id) return { status: "REFUSED", reason: "ENTITY_ID_INVALID" };
    if (!anchorKey) return { status: "REFUSED", reason: "ANCHOR_ID_INVALID" };
    const entity = auth.getNativeEntity(id);
    if (!entity || Number(entity.entityID) !== id) return { status: "REFUSED", reason: "NOT_A_NATIVE_NPC" };
    const anchorPosition = vec(anchor && anchor.position);
    if (!anchorPosition) return { status: "REFUSED", reason: "ANCHOR_POSITION_INVALID" };
    if (Number(anchor.systemID) !== Number(entity.systemID)) {
      return { status: "REFUSED", reason: "ANCHOR_NOT_IN_SAME_SYSTEM" };
    }
    // A hull that is fighting keeps its home: moving it would be moving a fight.
    const live = auth.getLiveController(id);
    if (!live) return { status: "REFUSED", reason: "LIVE_CONTROLLER_MISSING" };
    const manualType = String(live.manualOrder && live.manualOrder.type || "").toLowerCase();
    if (manualType && manualType !== "resumebehavior") {
      return { status: "REFUSED", reason: "HULL_HAS_MANUAL_ORDER" };
    }
    if (pos(live.currentTargetID)) return { status: "REFUSED", reason: "HULL_HAS_TARGET" };
    if (live.returningHome === true) return { status: "REFUSED", reason: "HULL_RETURNING_HOME" };
    const home = vec(live.homePosition);
    const gap = home ? distance(home, anchorPosition) : null;
    // Already anchored at this real entity: nothing to do, and no record write.
    if (gap !== null && gap <= Math.max(1, Number(anchor.radius) || 0)) {
      return { status: "REFUSED", reason: "ALREADY_AT_ANCHOR", anchorID: anchorKey, gapMeters: gap };
    }
    const record = auth.getNativeController(id);
    if (!record) return { status: "REFUSED", reason: "CONTROLLER_RECORD_MISSING" };
    return {
      status: "PLANNED",
      entityID: id,
      systemID: Number(entity.systemID),
      anchorID: anchorKey,
      anchorKind: String(anchor.kind || anchor.category || "asteroidBelt"),
      anchorPosition,
      previousHome: home,
      gapMeters: gap,
      record,
    };
  }

  // Write the real controller record and the live controller. The hull's
  // position, modules, cargo, orders and wallet are untouched.
  function apply(decision) {
    if (!decision || decision.status !== "PLANNED") return decision || { status: "REFUSED", reason: "NO_PLAN" };
    const auth = a();
    const record = {
      ...decision.record,
      entityID: decision.entityID,
      systemID: decision.systemID,
      anchorKind: decision.anchorKind,
      anchorID: decision.anchorID,
      homePosition: decision.anchorPosition,
      returningHome: false,
    };
    try { auth.upsertNativeController(record); }
    catch (error) {
      return { status: "REFUSED", reason: "CONTROLLER_WRITE_FAILED:" + String(error && error.message || error).slice(0, 80) };
    }
    const live = auth.getLiveController(decision.entityID);
    if (live) {
      live.homePosition = decision.anchorPosition;
      live.anchorKind = decision.anchorKind;
      live.anchorID = decision.anchorID;
      live.returningHome = false;
      live.lastHomeCommandAtMs = 0;
    }
    const detail = {
      status: "RELOCATED",
      entityID: decision.entityID,
      systemID: decision.systemID,
      anchorID: decision.anchorID,
      anchorKind: decision.anchorKind,
      previousHomeGapMeters: decision.gapMeters,
      evidence: "NATIVE_CONTROLLER_RECORD_HOME_POSITION_AT_REAL_SCENE_ENTITY",
    };
    auth.observe("living-native-raid-home-relocated", detail);
    return detail;
  }

  return { plan, apply, relocate: (input) => apply(plan(input)) };
}

let shared = null;
function sharedRaidHomeAnchor() {
  if (!shared) shared = createRaidHomeAnchor();
  return shared;
}

module.exports = { createRaidHomeAnchor, shared: sharedRaidHomeAnchor, distance };
