"use strict";
// Chat 04: fail-closed observer reconciliation against ONE native EveJS scene.
// No independent balls, positions, NPCs, event packets, state stores or timers.
// Only the native scene may decide visibility and emit Destiny updates.
const positive = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const live = (session) => Boolean(session?.socket &&
  session.socket.destroyed !== true && session.socket.writableEnded !== true);
const warping = (entity) => Boolean(entity && (
  String(entity.mode || "").toUpperCase().includes("WARP") ||
  entity.pendingWarp || entity.warpState));
const vector = (point) => Boolean(point && ["x", "y", "z"].every(
  (axis) => Number.isFinite(point[axis])));

function sampleObserver(scene, session) {
  const blocked = (reason) => ({ status: "BLOCKED", reason, missing: [], stale: [] });
  if (!(scene?.sessions instanceof Map) ||
      !(scene?.dynamicEntities instanceof Map) ||
      typeof scene.getEntityByID !== "function" ||
      typeof scene.canSessionSeeDynamicEntity !== "function" ||
      typeof scene.syncDynamicVisibilityForSession !== "function")
    return blocked("NATIVE_SCENE_API_UNAVAILABLE");
  const space = session?._space;
  if (!live(session) || space?.initialStateSent !== true ||
      !(space.visibleDynamicEntityIDs instanceof Set))
    return blocked("BALLPARK_NOT_READY");
  const characterID = positive(session.characterID);
  const shipID = positive(space.shipID);
  const systemID = positive(space.systemID);
  if (!characterID || !shipID || !systemID ||
      positive(scene.systemID) !== systemID)
    return blocked("SESSION_SYSTEM_OR_SHIP_MISMATCH");
  if (![...scene.sessions.values()].includes(session))
    return blocked("SESSION_NOT_IN_SCENE");
  const owners = [...scene.sessions.values()].filter((candidate) =>
    live(candidate) && candidate?._space?.initialStateSent === true &&
    (positive(candidate.characterID) === characterID ||
     positive(candidate._space.shipID) === shipID));
  if (owners.length !== 1 || owners[0] !== session)
    return blocked("DUPLICATE_NATIVE_OWNER");
  const ship = scene.dynamicEntities.get(shipID);
  if (!ship || scene.getEntityByID(shipID) !== ship ||
      ship.kind !== "ship" || positive(ship.itemID) !== shipID)
    return blocked("SHIP_NOT_AUTHORITATIVE");
  const physicalOwner = positive(ship.pilotCharacterID ?? ship.characterID);
  if (physicalOwner && physicalOwner !== characterID)
    return blocked("FOREIGN_SHIP_OWNER");
  if (warping(ship)) return blocked("WARP_IN_PROGRESS");

  const expected = new Set();
  try {
    for (const [key, entity] of scene.dynamicEntities) {
      const id = positive(key);
      if (!id || positive(entity?.itemID) !== id ||
          scene.getEntityByID(id) !== entity)
        return blocked("NATIVE_ENTITY_IDENTITY_DRIFT");
      if (id === shipID) continue; // Ego visibility is managed by EveJS.
      if (!vector(entity.position)) return blocked("INVALID_NATIVE_POSITION");
      if (warping(entity)) return blocked("WARP_IN_PROGRESS");
      if (scene.canSessionSeeDynamicEntity(session, entity)) {
        expected.add(id);
      }
    }
  } catch (_) {
    return blocked("NATIVE_VISIBILITY_EXCEPTION");
  }
  const observed = new Set();
  for (const value of space.visibleDynamicEntityIDs) {
    const id = positive(value);
    if (!id) return blocked("INVALID_VISIBILITY_CACHE_ID");
    if (id !== shipID) observed.add(id);
  }
  const missing = [...expected].filter((id) => !observed.has(id)).sort((a, b) => a - b);
  const stale = [...observed].filter((id) => !expected.has(id)).sort((a, b) => a - b);
  return { status: missing.length || stale.length ? "DIVERGED" : "CONSISTENT",
    characterID, shipID, systemID, missing, stale };
}

function createReconciler({ clock = () => Date.now(), confirmations = 2,
  cooldownMs = 5000, maxRepairsPerPass = 2 } = {}) {
  if (typeof clock !== "function" || !Number.isInteger(confirmations) ||
      confirmations < 1 || confirmations > 10 ||
      !Number.isSafeInteger(cooldownMs) || cooldownMs < 0 ||
      !Number.isInteger(maxRepairsPerPass) || maxRepairsPerPass < 1 ||
      maxRepairsPerPass > 16)
    throw new RangeError("Invalid native observer reconciliation limits");
  const history = new WeakMap();
  function reconcile(scene) {
    if (!(scene?.sessions instanceof Map))
      return { status: "BLOCKED", reason: "NATIVE_SCENE_API_UNAVAILABLE", results: [] };
    const results = [];
    let attempts = 0;
    const visited = new Set();
    for (const session of scene.sessions.values()) {
      if (!session || typeof session !== "object" || visited.has(session)) continue;
      visited.add(session);
      const before = sampleObserver(scene, session);
      if (before.status !== "DIVERGED") {
        history.delete(session);
        results.push(before);
        continue;
      }
      const signature = JSON.stringify([before.systemID, before.shipID,
        before.missing, before.stale]);
      const previous = history.get(session);
      const now = Number(clock());
      if (!Number.isFinite(now)) {
        results.push({ ...before, status: "BLOCKED", reason: "INVALID_CLOCK" });
        continue;
      }
      const consecutive = previous?.signature === signature
        ? previous.consecutive + 1 : 1;
      const lastAttempt = previous?.lastAttempt ?? -Infinity;
      history.set(session, { signature, consecutive, lastAttempt });
      if (consecutive < confirmations) {
        results.push({ ...before, status: "AWAITING_CONFIRMATION" });
        continue;
      }
      if (now < lastAttempt + cooldownMs) {
        results.push({ ...before, status: "COOLDOWN" });
        continue;
      }
      if (attempts >= maxRepairsPerPass) {
        results.push({ ...before, status: "BUDGET_EXHAUSTED" });
        continue;
      }
      attempts++;
      // No direct cache edits or AddBalls/RemoveBalls packets: ONLY the native
      // EveJS method may alter visibility or enqueue Destiny notifications.
      history.set(session, { signature, consecutive, lastAttempt: now });
      try {
        scene.syncDynamicVisibilityForSession(session);
      } catch (_) {
        results.push({ ...before, status: "NATIVE_SYNC_THROWN" });
        continue;
      }
      const after = sampleObserver(scene, session);
      if (after.status === "CONSISTENT") history.delete(session);
      results.push({ ...before,
        status: after.status === "CONSISTENT" ? "NATIVE_CACHE_RECONCILED" : "NATIVE_SYNC_UNVERIFIED",
        afterStatus: after.status,
        afterReason: after.reason || null });
    }
    return { status: "SCANNED", attempts, results };
  }
  return { reconcile, sampleObserver };
}
let installed = null;
function reconcileIfEnabled(scene) {
  if (process.env.EVEJS_COOP_SCENE_OBSERVER_RECONCILE !== "1")
    return { status: "DISABLED", attempts: 0, results: [] };
  if (!installed) installed = createReconciler();
  try { return installed.reconcile(scene); }
  catch (_) { return { status: "BLOCKED", reason: "NATIVE_RECONCILE_EXCEPTION", attempts: 0, results: [] }; }
}
module.exports = { sampleObserver, createReconciler, reconcileIfEnabled };
