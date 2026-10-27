"use strict";
// FW-017: a real warp disruption point on a raider, fitted and activated through
// the native module path.
//
// Why it exists: a stock mining fleet answers the first aggression with
// `retreatFleetToOrigin`, which warps EVERY hull 2.5 AU away in one tick. The
// native behaviour loop then finds its prey out of combat range, clears the
// attacker's manual order (`currentTargetID` -> 0 within seconds) and shield
// regeneration outpaces the delivered damage (measured: 146.45 -> 225.00 over
// 5 minutes, 0 wrecks). The stock runtime already refuses a warp for a scrambled
// hull (`SpaceRuntime.warpToPoint` -> `WARP_SCRAMBLED`,
// `beginNpcWarpToPoint` -> `isEntityWarpScrambled`), so the missing piece is a
// REAL point module on the raider, not a relaxed gate.
//
// Nothing here invents damage, ISK or a kill:
//   * the module type must resolve in the real item registry (category 7, group
//     52) and carry a real hostile effect the native hostile-module runtime
//     already maps to the warpScrambler/warpDisruptor family;
//   * the slot comes from the real native auto-fit authority, and a hull with no
//     free slot is refused, never forced;
//   * the fit is a real native module record (owner, flag, moduleState) written
//     through `nativeNpcStore`, and the live hull's projection is rebuilt with
//     the same `buildNativeFittedItems` the stock presentation uses;
//   * the activation is `scene.activateGenericModule` - the exact call the stock
//     `syncNpcHostileModules` loop makes - so range, lock, capacitor and dogma
//     all stay native. A refusal is reported verbatim, never retried as success.
const POINT_GROUPS = new Set([52]);
const MODULE_CATEGORY_ID = 7;
// Candidate seeds only: every one of them is verified against the real registry,
// dogma effects and hostile-module runtime before it may be fitted.
const DEFAULT_CANDIDATE_TYPE_IDS = Object.freeze([
  3242, // Warp Disruptor I
  3244, // Warp Disruptor II
  5399, // J5 Enduring Warp Disruptor
  5401, // Fleeting Warp Disruptor I
  5403, // Faint Scoped Warp Disruptor
  447,  // Warp Scrambler I
  448,  // Warp Scrambler II
]);
const DISRUPT_EFFECT = "warpDisrupt";
const SCRAM_EFFECT = "warpScrambleBlockMWDWithNPCEffect";
const SLOT_EFFECT = "medPower";
const NOTE_THROTTLE_MS = 60_000;

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});
const distance = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null);

// The same sessionless pseudo session the native NPC loops build
// (`npcBehaviorLoop.buildNpcPseudoSession`), so a generic module activation lands
// on the NPC hull instead of a character.
function pseudoSessionFor(entity) {
  return {
    characterID: Number(entity && (entity.pilotCharacterID ?? entity.characterID)) || 0,
    corporationID: Number(entity && entity.corporationID) || 0,
    allianceID: Number(entity && entity.allianceID) || 0,
    _space: {
      systemID: Number(entity && entity.systemID) || 0,
      shipID: Number(entity && entity.itemID) || 0,
    },
  };
}

function defaultAuthorities() {
  const registry = require("../services/inventory/itemTypeRegistry");
  const fitting = require("../services/fitting/liveFittingState");
  const hostile = require("./modules/hostileModuleRuntime");
  const store = require("./npc/nativeNpcStore");
  return {
    resolveItemByTypeID: registry.resolveItemByTypeID,
    typeHasEffectName: fitting.typeHasEffectName,
    resolveHostileDefinition: hostile.resolveHostileDefinition,
    selectAutoFitFlag: fitting.selectAutoFitFlagForType,
    normalizeModuleState: fitting.normalizeModuleState,
    maxRangeOf: (typeID) => {
      const attributes = fitting.getTypeAttributeMap(typeID) || {};
      const attributeID = fitting.getAttributeIDByNames("maxRange");
      const value = Number(attributeID > 0 ? attributes[attributeID] : NaN);
      return Number.isFinite(value) ? value : null;
    },
    store,
    isScrambled: hostile.isEntityWarpScrambled,
    scrambleStatusOf: hostile.getEntityWarpScrambleStatus,
    hostileModulesOf: (entity) => {
      try { return require("./npc/npcEquipment").getNpcHostileModules(entity).length; }
      catch (_error) { return null; }
    },
    observe: (event, status, detail) => {
      try { require("./coopRuntimeProbe").observe(event, null, null, status ? { status, ...detail } : detail); }
      catch (_error) { /* telemetry must never block a fit or an activation */ }
    },
    clock: () => Date.now(),
  };
}

// The authorities a caller must supply to own the whole decision. A caller that
// supplies all of them is never touched by the deployed overlay's own requires,
// which is what keeps this module loadable from a unit test.
const REQUIRED_KEYS = Object.freeze([
  "resolveItemByTypeID",
  "typeHasEffectName",
  "resolveHostileDefinition",
  "selectAutoFitFlag",
  "store",
]);

function createWarpPoint(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  let authorities = null;
  const a = () => {
    if (authorities) return authorities;
    const provided = {};
    for (const key of Object.keys(base)) {
      if (key === "candidateTypeIDs") continue;
      provided[key] = base[key];
    }
    const missing = REQUIRED_KEYS.filter((key) => provided[key] === undefined);
    authorities = missing.length
      ? Object.assign(defaultAuthorities(), provided)
      : Object.assign({
        normalizeModuleState: null,
        maxRangeOf: () => null,
        isScrambled: () => false,
        observe: () => {},
        clock: () => Date.now(),
      }, provided);
    if (typeof authorities.resolveItemByTypeID !== "function" ||
      typeof authorities.typeHasEffectName !== "function" ||
      typeof authorities.resolveHostileDefinition !== "function" ||
      typeof authorities.selectAutoFitFlag !== "function" ||
      !authorities.store || typeof authorities.store.upsertNativeModule !== "function") {
      throw Error("WARP_POINT_AUTHORITIES_REQUIRED");
    }
    return authorities;
  };
  const candidateTypeIDs = Array.isArray(base.candidateTypeIDs) && base.candidateTypeIDs.length
    ? base.candidateTypeIDs.map(Number).filter(pos)
    : DEFAULT_CANDIDATE_TYPE_IDS.slice();
  const noted = new Map();
  const attemptedAt = new Map();
  const ENGAGE_RETRY_MS = 3_000;

  // A real point module or nothing: the family comes from the native hostile
  // runtime's own effect table, never from this module.
  function verify(typeID) {
    const auth = a();
    if (!pos(typeID)) return { ok: false, typeID: Number(typeID) || 0, reason: "TYPE_ID_INVALID" };
    let item = null;
    try { item = auth.resolveItemByTypeID(typeID); } catch (_error) { item = null; }
    if (!item || Number(item.typeID) !== Number(typeID)) {
      return { ok: false, typeID, reason: "TYPE_UNVERIFIED" };
    }
    if (Number(item.categoryID) !== MODULE_CATEGORY_ID) {
      return { ok: false, typeID, reason: "NOT_A_MODULE" };
    }
    if (!POINT_GROUPS.has(Number(item.groupID))) {
      return { ok: false, typeID, reason: "NOT_A_WARP_DISRUPTION_GROUP" };
    }
    let effectName = "";
    for (const name of [DISRUPT_EFFECT, SCRAM_EFFECT]) {
      let has = false;
      try { has = auth.typeHasEffectName(typeID, name) === true; } catch (_error) { has = false; }
      if (has) { effectName = name; break; }
    }
    if (!effectName) return { ok: false, typeID, reason: "NO_HOSTILE_EFFECT" };
    let definition = null;
    try { definition = auth.resolveHostileDefinition({ name: effectName }); } catch (_error) { definition = null; }
    if (!definition || !String(definition.family || "").trim()) {
      return { ok: false, typeID, reason: "NO_HOSTILE_FAMILY" };
    }
    let slotFamily = "";
    try { slotFamily = auth.typeHasEffectName(typeID, SLOT_EFFECT) === true ? "med" : ""; } catch (_error) { slotFamily = ""; }
    let maxRangeMeters = null;
    try { maxRangeMeters = auth.maxRangeOf(typeID); } catch (_error) { maxRangeMeters = null; }
    return {
      ok: true,
      typeID,
      name: String(item.name || item.typeName || ""),
      groupID: Number(item.groupID),
      family: String(definition.family),
      effectName,
      slotFamily,
      maxRangeMeters,
    };
  }

  // Which real point this hull should carry, and where the native auto-fit puts
  // it. A hull that already carries a verified point keeps exactly that module.
  function choose({ hullTypeID, fittedItems } = {}) {
    const auth = a();
    const fitted = Array.isArray(fittedItems) ? fittedItems : [];
    for (const item of fitted) {
      const verified = verify(Number(item && item.typeID));
      if (verified.ok) {
        return {
          status: "PRESENT", typeID: verified.typeID, name: verified.name,
          family: verified.family, effectName: verified.effectName,
          moduleID: Number(item.itemID) || 0,
          flagID: Number(item.flagID) || 0, maxRangeMeters: verified.maxRangeMeters,
        };
      }
    }
    if (!pos(hullTypeID)) return refuse("HULL_TYPE_REQUIRED");
    const reasons = [];
    let best = null;
    for (const typeID of candidateTypeIDs) {
      const verified = verify(typeID);
      if (!verified.ok) { reasons.push(typeID + ":" + verified.reason); continue; }
      let flagID = null;
      try { flagID = auth.selectAutoFitFlag({ typeID: hullTypeID }, fitted, typeID); }
      catch (_error) { flagID = null; }
      if (!pos(flagID)) { reasons.push(typeID + ":NO_FREE_SLOT"); continue; }
      const range = Number(verified.maxRangeMeters) || 0;
      if (!best || range > Number(best.maxRangeMeters || 0)) {
        best = { ...verified, flagID: Number(flagID) };
      }
    }
    if (!best) return refuse("NO_VERIFIED_POINT", { reasons });
    return { status: "CHOSEN", ...best, reasons };
  }

  // A real native module record on the hull. Idempotent: an existing verified
  // point is reported, never duplicated.
  function fit({ scene, entity, entityRecord } = {}) {
    const auth = a();
    const entityID = Number(entity && entity.itemID || entityRecord && entityRecord.entityID) || 0;
    if (!(entityID > 0)) return refuse("ENTITY_REQUIRED");
    const record = entityRecord || auth.store.getNativeEntity(entityID) || null;
    const live = entity || (scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(entityID) : null);
    const modules = live && Array.isArray(live.fittedItems)
      ? live.fittedItems
      : auth.store.buildNativeFittedItems(entityID);
    const decision = choose({ hullTypeID: Number(record && record.typeID) || Number(live && live.typeID), fittedItems: modules });
    if (decision.status === "PRESENT") return decision;
    if (decision.status !== "CHOSEN") return decision;
    const transient = record && record.transient === true;
    let allocation = null;
    try { allocation = auth.store.allocateModuleID({ transient }); }
    catch (error) { return refuse("MODULE_ID_ALLOCATION_THREW:" + String(error && error.message || error).slice(0, 60)); }
    if (!allocation || allocation.success !== true || !pos(allocation.data)) {
      return refuse("MODULE_ID_ALLOCATION_FAILED");
    }
    const moduleID = Number(allocation.data);
    const item = auth.resolveItemByTypeID(decision.typeID) || {};
    const moduleState = typeof auth.normalizeModuleState === "function"
      ? auth.normalizeModuleState({ online: true, damage: 0, charge: 0, armorDamage: 0, shieldCharge: 0, incapacitated: false })
      : { online: true };
    const moduleRecord = {
      moduleID,
      entityID,
      ownerID: Number(record && (record.ownerID ?? record.corporationID)) || 0,
      typeID: decision.typeID,
      groupID: Number(item.groupID) || 0,
      categoryID: Number(item.categoryID) || MODULE_CATEGORY_ID,
      itemName: String(item.name || decision.name || ""),
      flagID: decision.flagID,
      singleton: true,
      transient,
      moduleState,
    };
    let written = null;
    try { written = auth.store.upsertNativeModule(moduleRecord, { transient }); }
    catch (error) { return refuse("MODULE_WRITE_THREW:" + String(error && error.message || error).slice(0, 60)); }
    if (!written || written.success !== true) {
      return refuse("MODULE_WRITE_FAILED", { errorMsg: String(written && written.errorMsg || "") });
    }
    // The live hull's module projection is rebuilt with the stock builder, so the
    // native hostile loop sees exactly what the store really holds.
    if (live) {
      try {
        live.fittedItems = auth.store.buildNativeFittedItems(entityID);
        live.modules = auth.store.buildNativeSlimModuleTuples(entityID);
        if (scene && typeof scene.broadcastSlimItemChanges === "function") {
          scene.broadcastSlimItemChanges([live]);
        }
      } catch (_error) { /* the store record is already authoritative */ }
    }
    return {
      status: "FITTED", moduleID, typeID: decision.typeID, name: decision.name,
      family: decision.family, flagID: decision.flagID, maxRangeMeters: decision.maxRangeMeters,
      entityID,
    };
  }

  // Read-only numbers that make "the point did not take" a fact instead of a
  // guess: how many hostile modules the hull really carries, how many native
  // target locks it holds, and the prey's real warp-scramble status.
  function diagnostics(pirate, prey) {
    const auth = a();
    const locks = pirate && pirate.targetingState && pirate.targetingState.lockedTargets;
    let lockCount = null;
    try { lockCount = locks && typeof locks.size === "number" ? locks.size : null; } catch (_error) { lockCount = null; }
    let hostileModules = null;
    try { hostileModules = typeof auth.hostileModulesOf === "function" ? auth.hostileModulesOf(pirate) : null; }
    catch (_error) { hostileModules = null; }
    let preyScrambleStatus = null;
    try { preyScrambleStatus = typeof auth.scrambleStatusOf === "function" ? auth.scrambleStatusOf(prey) : null; }
    catch (_error) { preyScrambleStatus = null; }
    return { hostileModules, lockCount, preyScrambleStatus };
  }

  // The real activation: the same generic module call the stock hostile-module
  // loop makes. "ENGAGED" is only reported when the target really reads back as
  // scrambled afterwards.
  function engage({ scene, pirateID, targetID, entityRecord } = {}) {
    const auth = a();
    const pirate = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(Number(pirateID) || 0) : null;
    const prey = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(Number(targetID) || 0) : null;
    if (!pirate || !prey) return refuse("HULL_NOT_IN_SCENE");
    if (auth.isScrambled(prey) === true) {
      return { status: "ENGAGED", alreadyScrambled: true, pirateID: Number(pirateID), targetID: Number(targetID) };
    }
    // A module activation is a real cycle, not a per-tick poll: a refusal is
    // retried at the native hostile-maintenance cadence, never every tick.
    const now = Number(auth.clock()) || 0;
    const attemptKey = Number(pirateID) + ":" + Number(targetID);
    if (now - (attemptedAt.get(attemptKey) || 0) < ENGAGE_RETRY_MS) return { status: "THROTTLED" };
    attemptedAt.set(attemptKey, now);
    const fitted = fit({ scene, entity: pirate, entityRecord });
    if (fitted.status === "REFUSED") return { ...fitted, pirateID: Number(pirateID), targetID: Number(targetID) };
    const moduleItem = (Array.isArray(pirate.fittedItems) ? pirate.fittedItems : [])
      .find((item) => Number(item && item.typeID) === Number(fitted.typeID)) || null;
    if (!moduleItem) return refuse("FITTED_MODULE_NOT_ON_HULL", { typeID: fitted.typeID });
    if (typeof scene.activateGenericModule !== "function") return refuse("ACTIVATION_API_UNAVAILABLE");
    let result = null;
    try {
      result = scene.activateGenericModule(
        pseudoSessionFor(pirate),
        moduleItem,
        fitted.effectName || null,
        { targetID: Number(prey.itemID) },
      );
    } catch (error) {
      return refuse("ACTIVATION_THREW:" + String(error && error.message || error).slice(0, 60), {
        pirateID: Number(pirateID), targetID: Number(targetID),
      });
    }
    const scrambled = auth.isScrambled(prey) === true;
    if (!result || result.success !== true || !scrambled) {
      return {
        status: "REFUSED",
        reason: String(result && result.errorMsg || "SCRAMBLE_NOT_APPLIED"),
        pirateID: Number(pirateID), targetID: Number(targetID),
        moduleID: Number(moduleItem.itemID) || 0, typeID: Number(fitted.typeID) || 0,
        scrambled, distanceMeters: distance(pirate.position, prey.position),
        ...diagnostics(pirate, prey),
      };
    }
    return {
      status: "ENGAGED",
      pirateID: Number(pirateID), targetID: Number(targetID),
      moduleID: Number(moduleItem.itemID) || 0, typeID: Number(fitted.typeID) || 0,
      family: fitted.family, maxRangeMeters: fitted.maxRangeMeters,
      distanceMeters: distance(pirate.position, prey.position), scrambled: true,
      ...diagnostics(pirate, prey),
    };
  }

  // One throttled line per (pirate, target, status): a refused point is measured
  // once, not published on every tick.
  function note(outcome) {
    if (!outcome || !outcome.status) return outcome;
    if (outcome.status !== "ENGAGED" && outcome.status !== "REFUSED") return outcome;
    const auth = a();
    const key = [outcome.status, Number(outcome.pirateID) || 0, Number(outcome.targetID) || 0].join(":");
    const now = Number(auth.clock()) || 0;
    if (now - (noted.get(key) || 0) < NOTE_THROTTLE_MS) return outcome;
    noted.set(key, now);
    const detail = { ...outcome };
    delete detail.status;
    try {
      auth.observe(outcome.status === "ENGAGED" ? "living-native-warp-point-engaged" : "living-native-warp-point-refused",
        outcome.status, detail);
    } catch (_error) { /* telemetry must never block an order */ }
    return outcome;
  }

  return Object.freeze({
    verify,
    choose,
    fit,
    engage,
    note,
    isScrambled: (entity) => a().isScrambled(entity) === true,
    candidates: () => candidateTypeIDs.slice(),
  });
}

let singleton = null;

module.exports = {
  createWarpPoint,
  DEFAULT_CANDIDATE_TYPE_IDS,
  POINT_GROUPS,
  DISRUPT_EFFECT,
  SCRAM_EFFECT,
  shared: () => {
    if (!singleton) singleton = createWarpPoint();
    return singleton;
  },
};
