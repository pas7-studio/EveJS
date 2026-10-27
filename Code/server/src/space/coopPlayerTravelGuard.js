"use strict";
// Chat 06: opt-in, read-only preflight and conservation witness for native player travel.
// This module never transfers a ship, edits a session, retries a jump or writes inventory.
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const finiteVector = p => p && ["x", "y", "z"].every(k => Number.isFinite(p[k]));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const live = s => !!s?.socket && s.socket.destroyed !== true;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const immutableFields = ["itemID", "typeID", "ownerID", "locationID", "flagID", "quantity", "singleton", "stacksize", "isOnline", "customInfo", "damage", "damageState", "conditionState"];
function manifest(items, shipID) {
  if (!Array.isArray(items) || !positive(shipID)) return null;
  const seen = new Set(), children = new Map(), out = [];
  for (const item of items) {
    const id = positive(item?.itemID), parentID = positive(item?.locationID);
    if (!id || !parentID || id === shipID || seen.has(id)) return null;
    seen.add(id);
    if (!children.has(parentID)) children.set(parentID, []);
    children.get(parentID).push(id);
    const row = {};
    for (const key of immutableFields) if (own(item, key)) row[key] = item[key];
    out.push(row);
  }
  const reachable = new Set(), queue = [shipID];
  for (let index = 0; index < queue.length; index++) {
    for (const childID of children.get(queue[index]) || []) {
      if (reachable.has(childID)) return null;
      reachable.add(childID); queue.push(childID);
    }
  }
  if (reachable.size !== items.length) return null;
  out.sort((a, b) => a.itemID - b.itemID);
  return JSON.stringify(out);
}
function condition(record) {
  const state = record?.conditionState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  // Native itemStore retains the normalized conditionState across moveShipToSpace.
  try { return JSON.stringify(Object.keys(state).sort().map(k => [k, state[k]])); }
  catch (_) { return null; }
}
function dockConditionPreserved(before, after) {
  if (!before || !after) return false;
  const old = new Map(JSON.parse(before));
  const next = new Map(JSON.parse(after));
  if (old.size !== next.size) return false;
  for (const [key, value] of old) {
    if (!next.has(key)) return false;
    const current = next.get(key);
    if (["charge", "shieldCharge"].includes(key)) {
      if (!Number.isFinite(value) || !Number.isFinite(current) || current < value || current > 1) return false;
    } else if (JSON.stringify(value) !== JSON.stringify(current)) return false;
  }
  return true;
}
function createPlayerTravelGuard({
  getActiveShipRecord, getCharacterRecord, getSceneForSession, getSessions, listContainerItems,
  getStargateByID = () => null, clock = () => Date.now(), maxAgeMs = 180000
} = {}) {
  if (![getActiveShipRecord, getCharacterRecord, getSceneForSession, getSessions, listContainerItems,
    getStargateByID, clock].every(f => typeof f === "function") ||
    !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) {
    throw Error("native player travel dependencies required");
  }
  const pending = new Map();
  const reject = reason => ({ok: false, reason});
  function nativeIdentity(session, {systemID = null, requireSpace = true} = {}) {
    const charID = positive(session?.characterID);
    if (!charID || !live(session)) return reject("NO_ACTIVE_CHARACTER_SESSION");
    let sessions, ship, character;
    try {
      sessions = getSessions(); ship = getActiveShipRecord(charID);
      character = getCharacterRecord(charID);
    }
    catch (_) { return reject("NATIVE_IDENTITY_UNAVAILABLE"); }
    if (!Array.isArray(sessions) || !sessions.includes(session)) return reject("SESSION_NOT_REGISTERED");
    if (!positive(session.userid) || positive(character?.accountId) !== positive(session.userid))
      return reject("NATIVE_ACCOUNT_OWNERSHIP_MISMATCH");
    const shipID = positive(ship?.itemID);
    if (!shipID || positive(ship?.ownerID) !== charID) return reject("SHIP_OWNERSHIP_MISMATCH");
    const advertised = [session.shipID, session.shipid, session.activeShipID,
      session._space?.shipID].map(positive).filter(Boolean);
    if (advertised.length === 0 || advertised.some(id => id !== shipID)) return reject("SESSION_SHIP_MISMATCH");
    if (sessions.some(other => other !== session && live(other) &&
      (positive(other.characterID) === charID ||
      [other.shipID, other.shipid, other.activeShipID, other._space?.shipID]
        .map(positive).includes(shipID)))) return reject("DUPLICATE_CHARACTER_OR_SHIP_SESSION");
    const actualSystem = positive(session._space?.systemID);
    if (requireSpace && (!actualSystem || (systemID && systemID !== actualSystem)))
      return reject("WRONG_SOURCE_SYSTEM");
    if (!requireSpace) return {ok: true, characterID: charID, shipID, ship, systemID: actualSystem};
    let scene;
    try { scene = getSceneForSession(session); }
    catch (_) { return reject("NATIVE_SCENE_UNAVAILABLE"); }
    if (!scene || Number(scene.systemID) !== actualSystem ||
      !scene.sessions?.values || ![...scene.sessions.values()].includes(session) ||
      typeof scene.getEntityByID !== "function" ||
      typeof scene.getShipEntityForSession !== "function") return reject("NATIVE_SCENE_UNAVAILABLE");
    let physical, physicalForSession;
    try { physical = scene.getEntityByID(shipID);
      physicalForSession = scene.getShipEntityForSession(session); }
    catch (_) { return reject("NATIVE_SCENE_UNAVAILABLE"); }
    const pilot = positive(physical?.pilotCharacterID ?? physical?.characterID);
    if (!physical || physical.kind !== "ship" || Number(physical.itemID) !== shipID ||
      physicalForSession !== physical ||
      (pilot && pilot !== charID) || !finiteVector(physical.position)) return reject("PHYSICAL_SHIP_OWNERSHIP_UNVERIFIED");
    if (Number(ship.spaceState?.systemID) !== actualSystem ||
      Number(ship.locationID) !== actualSystem) return reject("NATIVE_SHIP_LOCATION_MISMATCH");
    return {ok: true, characterID: charID, shipID, ship, systemID: actualSystem, scene, physical};
  }
  function sameGate({source, destination, sourceSystemID, destinationSystemID, scene, ship}) {
    if (!source || !destination || Number(source.destinationID) !== Number(destination.itemID) ||
      Number(destination.destinationID) !== Number(source.itemID) ||
      Number(source.solarSystemID) !== sourceSystemID ||
      Number(destination.solarSystemID) !== destinationSystemID ||
      sourceSystemID === destinationSystemID) return reject("NON_RECIPROCAL_STARGATE");
    let gate;
    try { gate = scene.getEntityByID(Number(source.itemID)) ||
      scene.staticEntities?.find(entry => entry?.kind === "stargate" &&
        Number(entry.itemID) === Number(source.itemID)); }
    catch (_) { return reject("PHYSICAL_STARGATE_MISSING"); }
    if (!gate || gate.kind !== "stargate" || Number(gate.itemID) !== Number(source.itemID) ||
      !finiteVector(gate.position)) return reject("PHYSICAL_STARGATE_MISSING");
    const surface = Math.max(0, distance(ship.position, gate.position) -
      Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(gate.radius) || 0));
    if (surface > 2500) return reject("STARGATE_OUT_OF_RANGE");
    return {ok: true};
  }
  function captureItems(shipID) {
    const queue = [shipID], visited = new Set(), rows = [], seenIDs = new Set();
    try {
      for (let index = 0; index < queue.length; index++) {
        const parentID = queue[index];
        if (visited.has(parentID)) return null;
        visited.add(parentID);
        const children = listContainerItems(null, parentID, null);
        if (!Array.isArray(children)) return null;
        for (const item of children) {
          const id = positive(item?.itemID);
          if (!id || seenIDs.has(id) || Number(item?.locationID) !== parentID)
            return null;
          seenIDs.add(id); rows.push(item); queue.push(id);
          // Avoid unbounded scans on malformed inventories or cyclical data.
          if (rows.length > 5000) return null;
        }
      }
      return manifest(rows, shipID);
    } catch (_) { return null; }
  }
  function begin({session, kind, destinationSystemID = null, sourceGateID = null,
    destinationGateID = null, destinationLocationID = null} = {}) {
    if (!["stargate", "solar-jump", "dock", "undock"].includes(kind))
      return reject("UNSUPPORTED_TRANSITION_KIND");
    const inSpace = kind === "stargate" || kind === "dock" ||
      (kind === "solar-jump" && Boolean(session?._space));
    if (kind === "undock" && session?._space) return reject("UNDOCK_REQUIRES_DOCKED_SESSION");
    const identity = nativeIdentity(session, {requireSpace: inSpace});
    if (!identity.ok) return identity;
    if (inSpace && session._space?.initialStateSent !== true)
      return reject("SOURCE_BALLPARK_NOT_READY");
    if (inSpace && (String(identity.physical?.mode || "").toUpperCase().includes("WARP") ||
      identity.physical?.pendingWarp || identity.physical?.warpState))
      return reject("ACTIVE_WARP_BLOCKS_TRANSITION");
    if (!inSpace) {
      const dockedLocation = positive(session.stationid || session.stationID ||
        session.structureid || session.structureID);
      if (!dockedLocation || Number(identity.ship.locationID) !== dockedLocation ||
        identity.ship.spaceState) return reject("NATIVE_DOCKED_SOURCE_UNVERIFIED");
    }
    if (session._transitionState && ![
      kind === "stargate" ? "stargate-jump" : kind, null
    ].includes(session._transitionState.kind)) return reject("CONCURRENT_NATIVE_TRANSITION");
    const systemID = positive(destinationSystemID);
    const locationID = positive(destinationLocationID);
    if (kind === "dock" && !locationID) return reject("INVALID_DOCKING_DESTINATION");
    if (["stargate", "solar-jump", "undock"].includes(kind) && (!systemID || systemID === identity.systemID))
      return reject("INVALID_DESTINATION_SYSTEM");
    if (kind === "stargate") {
      let source, destination;
      try { source = getStargateByID(sourceGateID); destination = getStargateByID(destinationGateID); }
      catch (_) { return reject("STARGATE_DATA_UNAVAILABLE"); }
      const gateResult = sameGate({source, destination, sourceSystemID: identity.systemID,
        destinationSystemID: systemID, scene: identity.scene, ship: identity.physical});
      if (!gateResult.ok) return gateResult;
    }
    const other = pending.get(identity.characterID);
    if (other) {
      // Stale sessions may be replaced by the native reconnect flow; never
      // allow the old asynchronous timer to complete on behalf of the new one.
      if (live(other.session))
        return reject("PLAYER_TRANSITION_ALREADY_PENDING");
      pending.delete(identity.characterID);
    }
    const contents = captureItems(identity.shipID);
    const hp = condition(identity.ship);
    if (contents === null || hp === null) return reject("SHIP_SNAPSHOT_UNAVAILABLE");
    const ticket = Object.freeze({characterID: identity.characterID, shipID: identity.shipID,
      sourceSystemID: identity.systemID, destinationSystemID: systemID,
      destinationLocationID: locationID, sourceScene: identity.scene || null,
      kind, sourceInSpace: inSpace, shipTypeID: positive(identity.ship.typeID),
      startedAt: clock(), contents, hp, session});
    pending.set(identity.characterID, ticket);
    return {ok: true, ticket};
  }
  function handoff(ticket, session) {
    if (!ticket || pending.get(ticket.characterID) !== ticket || ticket.session !== session)
      return reject("STALE_TRANSITION_TICKET");
    if (clock() - ticket.startedAt > maxAgeMs) return reject("TRANSITION_EXPIRED");
    const x = nativeIdentity(session, {systemID: ticket.sourceSystemID,
      requireSpace: ticket.sourceInSpace});
    if (!x.ok) return x;
    if (x.characterID !== ticket.characterID || x.shipID !== ticket.shipID)
      return reject("TRANSITION_OWNER_CHANGED");
    return {ok: true};
  }
  function finish(ticket, session, {docked = false, expectedArrivalPoint = null,
    arrivalToleranceMeters = 2500} = {}) {
    if (docked !== (ticket?.kind === "dock")) return reject("TRANSITION_KIND_MISMATCH");
    if (!ticket || pending.get(ticket.characterID) !== ticket || ticket.session !== session)
      return reject("STALE_TRANSITION_TICKET");
    const expectedSystem = ticket.destinationSystemID;
    const x = nativeIdentity(session, {systemID: expectedSystem,
      requireSpace: !docked});
    if (!x.ok) return x;
    if (x.characterID !== ticket.characterID || x.shipID !== ticket.shipID)
      return reject("TRANSITION_OWNER_CHANGED");
    if (docked) {
      const locationID = ticket.destinationLocationID;
      if (session._space || Number(x.ship.locationID) !== locationID || x.ship.spaceState ||
        ![session.stationid, session.stationID, session.structureid, session.structureID]
          .some(id => Number(id) === locationID)) return reject("DOCKED_NATIVE_STATE_MISMATCH");
    } else if (expectedSystem && (x.systemID !== expectedSystem ||
      Number(x.ship?.spaceState?.systemID) !== expectedSystem ||
      Number(x.ship?.locationID) !== expectedSystem)) return reject("DESTINATION_IDENTITY_MISMATCH");
    if (ticket.sourceScene) {
      let sourceShip;
      try { sourceShip = ticket.sourceScene.getEntityByID?.(ticket.shipID); }
      catch (_) { return reject("SOURCE_SCENE_UNAVAILABLE"); }
      if (ticket.sourceScene === x.scene || sourceShip)
        return reject("SOURCE_SCENE_SHIP_STILL_PRESENT");
    }
    if (ticket.shipTypeID && Number(x.ship.typeID) !== ticket.shipTypeID)
      return reject("SHIP_TYPE_CHANGED");
    if (expectedArrivalPoint !== null && (!finiteVector(expectedArrivalPoint) ||
      !Number.isFinite(arrivalToleranceMeters) || arrivalToleranceMeters < 0 ||
      arrivalToleranceMeters > 100000 || !x.physical ||
      distance(x.physical.position, expectedArrivalPoint) > arrivalToleranceMeters))
      return reject("NATIVE_ARRIVAL_COORDINATES_MISMATCH");
    if (ticket.contents !== captureItems(ticket.shipID)) return reject("FITTING_OR_CARGO_CHANGED");
    const resultingCondition = condition(x.ship);
    if (docked ? !dockConditionPreserved(ticket.hp, resultingCondition) :
      ticket.hp !== resultingCondition) return reject("SHIP_CONDITION_CHANGED");
    pending.delete(ticket.characterID);
    return {ok: true, status: "NATIVE_TRAVEL_STATE_VERIFIED",
      characterID: ticket.characterID, shipID: ticket.shipID,
      sourceSystemID: ticket.sourceSystemID, destinationSystemID: expectedSystem,
      // Physical position against the native spawn anchor is only proven when
      // the source transition supplies its own spawnState.position.
      nativeArrivalCoordinatesVerified: expectedArrivalPoint !== null,
      // Visual arrival is a separate human-client test.
      clientArrivalVerified: false};
  }
  function cancel(ticket) {
    if (ticket && pending.get(ticket.characterID) === ticket) {
      pending.delete(ticket.characterID); return true;
    }
    return false;
  }
  function pendingFor(session) {
    const ticket = pending.get(positive(session?.characterID));
    return ticket && ticket.session === session ? ticket : null;
  }
  return {begin, handoff, finish, cancel, pendingFor, pendingCount: () => pending.size};
}
module.exports = {createPlayerTravelGuard, manifest};
