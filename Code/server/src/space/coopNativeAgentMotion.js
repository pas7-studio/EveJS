"use strict";
// Native motion primitives for a server-driven character.
//
// Why this module exists: an NPC that must actually *move* (undock, warp, dock)
// has no client session, but every native transition takes one. The identity
// object below is only read by those transitions - it is never registered in
// the session registry, so no code that expects a real socket ever sees it.
//
// Two invariants learned the hard way, both generic to any future live-agent
// role (hauler, miner, patrol, trader), not just couriers:
//   1. One identity object per character must survive undock -> warp -> dock.
//      The native undock attaches `_space` to it; a fresh object at dock time
//      detaches nothing and leaves the ship behind as a ghost entity.
//   2. The session-less warp facade is `startSessionlessWarpIngress(systemID,
//      entity, point, options)` while the scene method is `(entity, point,
//      options)`. Passing an entity id into the facade looks like a missing
//      scene, so the real scene is resolved first.
//
// Every action is exactly one native call and any doubt returns AMBIGUOUS
// without a retry: repeating a transition can duplicate real state.
const OK = "OK";
const FAILED = "FAILED";
const AMBIGUOUS = "AMBIGUOUS";

const liveSessions = new Map();

function createAgentSession(character, stationID) {
  const characterID = Number(character && character.characterID) || 0;
  if (!(characterID > 0)) return null;
  const locationID = Number(stationID) || 0;
  return {
    // Identity only; no sendNotification on purpose.
    characterID,
    charid: characterID,
    userid: Number(character.accountId) || 0,
    corpid: Number(character.corporationID) || 0,
    corporationID: Number(character.corporationID) || 0,
    allianceid: Number(character.allianceID) || 0,
    locationid: locationID,
    stationID: locationID,
    _transitionState: null,
    isNpcCourier: true,
    // Native transitions push their result through the session. A server-driven
    // character has no client, so these are no-ops.
    sendSessionChange() { return undefined; },
  };
}

// The cached identity object for one character, created on first use.
function agentSessionFor(character, stationID) {
  const characterID = Number(character && character.characterID) || 0;
  if (!(characterID > 0)) return null;
  const existing = liveSessions.get(characterID);
  if (existing) return existing;
  const session = createAgentSession(character, stationID);
  if (session) liveSessions.set(characterID, session);
  return session;
}

// `stationID` is the only field that changes: origin while docked, 0 in space.
function sessionFor(ctx, stationID) {
  const locationID = Number(stationID) || 0;
  const live = ctx && ctx.session;
  if (live && Number(live.characterID) > 0) {
    live.locationid = locationID;
    live.stationID = locationID;
    if (live._transitionState === undefined) live._transitionState = null;
    return live;
  }
  const session = agentSessionFor(ctx && ctx.character, locationID);
  if (session) {
    session.locationid = locationID;
    session.stationID = locationID;
  }
  return session;
}

// Forgets a character's identity object (tests, or a deliberate reset).
function releaseAgentSession(characterID) {
  const id = Number(characterID) || 0;
  if (id > 0) liveSessions.delete(id);
}

function resolveScene(ctx, systemID) {
  if (ctx && typeof ctx.sceneForSystem === "function") {
    try {
      const scene = ctx.sceneForSystem(Number(systemID) || 0);
      if (scene) return scene;
    } catch (_error) {
      /* a missing scene is reported by the caller */
    }
  }
  return (ctx && ctx.scene) || null;
}

function resolveEntity(scene, entityID) {
  const id = Number(entityID) || 0;
  if (!(id > 0) || !scene || typeof scene.getEntityByID !== "function") return null;
  return scene.getEntityByID(id) || null;
}

function preflight(ctx) {
  const missing = [];
  if (!ctx || typeof ctx !== "object") return { status: "NOT_READY", missing: ["runtime"] };
  if (!ctx.transitions || typeof ctx.transitions.undockSession !== "function") missing.push("transitions.undockSession");
  if (!ctx.transitions || typeof ctx.transitions.dockSession !== "function") missing.push("transitions.dockSession");
  if (!ctx.space || typeof ctx.space.warpToPoint !== "function") missing.push("space.warpToPoint");
  return missing.length ? { status: "NOT_READY", missing } : { status: "READY" };
}

function result(state, extra) {
  return Object.assign({}, extra || {}, { status: state });
}

// One native undock. The caller owns the "is this character really docked at
// the expected station" check, because only it knows the intent.
function undockAgent(ctx, originStationID) {
  const ready = preflight(ctx);
  if (ready.status !== "READY") return result("NOT_READY", { missing: ready.missing });
  const session = sessionFor(ctx, originStationID);
  if (!session) return result("REFUSED", { reason: "character identity is not usable" });
  let outcome;
  try {
    outcome = ctx.transitions.undockSession(session, {});
  } catch (error) {
    return result(AMBIGUOUS, { reason: String(error && error.message || error) });
  }
  if (outcome && outcome.success === true) {
    // The native undock returns the created ship record; its id is what the
    // warp needs. Verified against transitions.js (data.ship).
    const ship = (outcome.data && outcome.data.ship) || {};
    const entityID = Number(ship.entityID || ship.itemID || ship.shipID) || 0;
    return result(OK, { shipID: entityID, entityID });
  }
  return result(FAILED, { reason: String(outcome && outcome.errorMsg || "undock failed") });
}

// One native warp to a real point in space.
function warpAgent(ctx, options) {
  const ready = preflight(ctx);
  if (ready.status !== "READY") return result("NOT_READY", { missing: ready.missing });
  const point = options && options.point;
  if (!point || !Number.isFinite(Number(point.x))) {
    return result("REFUSED", { reason: "a real target point is required" });
  }
  const entityID = Number(options && options.entityID) || 0;
  if (!(entityID > 0)) return result(FAILED, { reason: "ship is not in space (no entity)" });
  const systemID = Number(options && options.systemID) || 0;
  const warpOptions = {
    forceImmediateStart: true,
    broadcastWarpStartToVisibleSessions: true,
    ingressDurationMs: Number(options && options.ingressMs) || 30000,
  };
  try {
    const scene = resolveScene(ctx, systemID);
    const shipEntity = resolveEntity(scene, entityID);
    let firstFailure = null;
    if (scene && typeof scene.startSessionlessWarpIngress === "function") {
      const outcome = scene.startSessionlessWarpIngress(shipEntity || entityID, point, warpOptions);
      if (outcome !== false && !(outcome && outcome.success === false)) return result(OK, { entityID });
      firstFailure = String(outcome && outcome.errorMsg || "sessionless warp refused");
    } else if (typeof ctx.space.startSessionlessWarpIngress === "function") {
      const outcome = ctx.space.startSessionlessWarpIngress(systemID, shipEntity || entityID, point, warpOptions);
      if (outcome !== false && !(outcome && outcome.success === false)) return result(OK, { entityID });
      firstFailure = String(outcome && outcome.errorMsg || "sessionless warp refused");
    }
    // The stock client call, for a ship the session-less path cannot see yet.
    const session = sessionFor(ctx, 0);
    if (session && typeof ctx.space.warpToPoint === "function") {
      const warped = ctx.space.warpToPoint(session, point, warpOptions);
      if (warped !== false && !(warped && warped.success === false)) return result(OK, { entityID });
      firstFailure = String(firstFailure || "") + " / warpToPoint " + String(warped && warped.errorMsg || "refused");
    }
    return result(FAILED, { reason: firstFailure || "warp refused" });
  } catch (error) {
    return result(AMBIGUOUS, { reason: String(error && error.message || error) });
  }
}

// One native dock. A station id on the identity object would make the native
// call answer ALREADY_DOCKED, so the session is always "in space" here.
function dockAgent(ctx, stationID) {
  const ready = preflight(ctx);
  if (ready.status !== "READY") return result("NOT_READY", { missing: ready.missing });
  const session = sessionFor(ctx, 0);
  if (!session) return result("REFUSED", { reason: "character identity is not usable" });
  let outcome;
  try {
    outcome = ctx.transitions.dockSession(session, stationID);
  } catch (error) {
    return result(AMBIGUOUS, { reason: String(error && error.message || error) });
  }
  if (outcome && outcome.success === true) return result(OK);
  // The ship record is already there (a restart between ticks). That is the
  // intended end state, not a failed dock.
  if (String(outcome && outcome.errorMsg) === "ALREADY_DOCKED") return result(OK, { alreadyDocked: true });
  return result(FAILED, { reason: String(outcome && outcome.errorMsg || "dock failed") });
}

module.exports = {
  OK,
  FAILED,
  AMBIGUOUS,
  createAgentSession,
  agentSessionFor,
  sessionFor,
  releaseAgentSession,
  resolveScene,
  resolveEntity,
  preflight,
  undockAgent,
  warpAgent,
  dockAgent,
};
