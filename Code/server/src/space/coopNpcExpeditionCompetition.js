"use strict";
// CH22+23 / EX-01: read-only, native-witnessed exploration rivalry.
// This is NOT a scanner, site spawner, bookmark provider, inventory authority,
// flight controller, reward system, or new 30s game loop.
// An adapter must resolve sites from signatureRuntime and NPC pilot ownership
// from the existing durable materialization registry + native controller.
const positive = n => Number.isSafeInteger(n) && n > 0;
const finiteVector = p => Boolean(p) && ["x", "y", "z"].every(k =>
  typeof p[k] === "number" && Number.isFinite(p[k]));
const namedPilot = id => typeof id === "string" && /^coop-pilot-[0-9]{3,}$/.test(id);
const copy = x => JSON.parse(JSON.stringify(x));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function createExpeditionCompetition({resolveNativeSite, resolveNativeNpcPilot,
  clock = () => Date.now(), maxObservationMeters = 150000,
  maxSites = 256, maxAgeMs = 24 * 60 * 60 * 1000} = {}) {
  if (typeof resolveNativeSite !== "function" ||
      typeof resolveNativeNpcPilot !== "function" || typeof clock !== "function" ||
      !Number.isSafeInteger(maxObservationMeters) || maxObservationMeters < 1000 ||
      maxObservationMeters > 200000 || !Number.isSafeInteger(maxSites) ||
      maxSites < 1 || maxSites > 2000 || !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 60000 || maxAgeMs > 7 * 86400000)
    throw Error("EXPEDITION_NATIVE_READ_AUTHORITIES_REQUIRED");

  const sites = new Map();
  const siteKey = (systemID, siteID) => `${systemID}:${siteID}`;
  const time = () => {
    const at = clock();
    return Number.isSafeInteger(at) && at > 0 ? at : null;
  };
  function currentSite(scene, siteID) {
    if (!positive(scene?.systemID) || !positive(siteID) ||
        typeof scene.getEntityByID !== "function") return null;
    let site;
    try { site = resolveNativeSite(scene.systemID, siteID); }
    catch { return null; }
    if (!site || site.siteID !== siteID ||
        site.systemID !== scene.systemID || !finiteVector(site.actualPosition)) return null;
    const p = site.actualPosition;
    // Original identity and coordinates are tied together. Reusing siteID
    // must not inherit an older exploration result or expose remote positions.
    const fingerprint = JSON.stringify([site.systemID, site.siteID,
      site.targetID ?? null, site.siteKind ?? null, site.family ?? null,
      site.typeID ?? null, site.instanceID ?? null, site.pairID ?? null,
      p.x, p.y, p.z]);
    return {site, fingerprint};
  }
  function physicalWitness(scene, shipID, point) {
    if (!positive(shipID) || !finiteVector(point)) return null;
    const ship = scene.getEntityByID(shipID);
    if (!ship || ship.kind !== "ship" || ship.itemID !== shipID ||
        !finiteVector(ship.position) || ship.transient === true ||
        (positive(ship.systemID) && ship.systemID !== scene.systemID) ||
        ship.pendingWarp || ship.warpState || ship.isWarping ||
        String(ship.mode || "").toUpperCase().includes("WARP") ||
        distance(ship.position, point) > maxObservationMeters) return null;
    return ship;
  }
  function actorFromNativeScene(scene, shipID, ship) {
    const matches = Array.from(scene.sessions?.values?.() || []).filter(s =>
      s?._space?.shipID === shipID && s?._space?.systemID === scene.systemID &&
      s?._space?.initialStateSent === true && positive(s.characterID) &&
      s.socket?.destroyed !== true);
    // A real player's native session is never an NPC scout. Duplicated
    // sessions and an NPC hull claiming a session both fail closed.
    if (matches.length > 1 || (matches.length && ship.nativeNpc === true)) return null;
    if (matches.length === 1) {
      if (ship.session?.characterID && ship.session.characterID !== matches[0].characterID)
        return null;
      return {kind:"PLAYER", characterID:matches[0].characterID};
    }
    if (ship.nativeNpc !== true || ship.session?.characterID) return null;
    let pilot;
    try { pilot = resolveNativeNpcPilot(scene.systemID, shipID); }
    catch { return null; }
    // The adapter must prove both a durable pilot->hull mapping and an active
    // native controller; a caller-provided role label is insufficient.
    if (!namedPilot(pilot?.pilotID) || pilot.systemID !== scene.systemID ||
        pilot.entityID !== shipID || pilot.nativeControllerVerified !== true ||
        pilot.durableLinkVerified !== true) return null;
    return {kind:"NPC", pilotID:pilot.pilotID};
  }
  function checked({scene, siteID, shipID}) {
    const native = currentSite(scene, siteID);
    if (!native) return {status:"NATIVE_SITE_UNAVAILABLE"};
    const ship = physicalWitness(scene, shipID, native.site.actualPosition);
    if (!ship) return {status:"NO_NATIVE_ON_GRID_SHIP"};
    const actor = actorFromNativeScene(scene, shipID, ship);
    if (!actor) return {status:"ACTOR_AUTHORITY_UNAVAILABLE"};
    return {status:"VERIFIED_NATIVE_WITNESS", actor, fingerprint:native.fingerprint};
  }
  function purge(now) {
    for (const [key, row] of sites) {
      if (row.createdAt > now || row.createdAt + maxAgeMs <= now) sites.delete(key);
    }
  }
  function observe({scene, siteID, shipID} = {}) {
    const at = time();
    if (!at) return {status:"INVALID_CLOCK"};
    const witness = checked({scene, siteID, shipID});
    if (witness.status !== "VERIFIED_NATIVE_WITNESS") return {status:witness.status};
    purge(at);
    const key = siteKey(scene.systemID, siteID);
    const old = sites.get(key);
    const fresh = !old || old.fingerprint !== witness.fingerprint;
    if (fresh && !old && sites.size >= maxSites) return {status:"EXPEDITION_OBSERVATION_CAP"};
    const row = fresh ? {systemID:scene.systemID,siteID,
      fingerprint:witness.fingerprint,createdAt:at,
      firstNpc:null,firstPlayer:null,firstKind:null,npcPilots:[],playerCharacters:[]} : copy(old);
    const actor = witness.actor;
    const property = actor.kind === "NPC" ? "npcPilots" : "playerCharacters";
    const who = actor.kind === "NPC" ? actor.pilotID : actor.characterID;
    const field = actor.kind === "NPC" ? "firstNpc" : "firstPlayer";
    const firstForActor = !row[property].includes(who);
    if (firstForActor) {
      if (row[property].length >= 32) return {status:"EXPEDITION_PARTICIPANT_CAP"};
      row[property].push(who);
      if (!row[field]) row[field] = {id:who,at};
      if (!row.firstKind) row.firstKind = actor.kind;
    }
    sites.set(key,row);
    return {status:firstForActor ? "NATIVE_SITE_OBSERVED" : "ALREADY_OBSERVED",
      siteID,systemID:scene.systemID,actor:copy(actor),
      contested:Boolean(row.firstNpc && row.firstPlayer),
      firstKind:row.firstKind,
      // Never include actualPosition, private scan IDs, loot or bookmarks.
      nativeMutation:false,itemsTransferred:0};
  }
  function plan({scene,siteID,shipID} = {}) {
    const at = time();
    if (!at) return {status:"INVALID_CLOCK"};
    const witness = checked({scene,siteID,shipID});
    if (witness.status !== "VERIFIED_NATIVE_WITNESS" || witness.actor.kind !== "NPC")
      return {status:"NPC_SURVEY_PROOF_REQUIRED"};
    const row = sites.get(siteKey(scene.systemID,siteID));
    if (!row || row.fingerprint !== witness.fingerprint ||
        row.createdAt > at || row.createdAt + maxAgeMs <= at ||
        !row.npcPilots.includes(witness.actor.pilotID))
      return {status:"NPC_SITE_NOT_OBSERVED"};
    const contested = Boolean(row.firstPlayer);
    return {status:"INTENT_ONLY",kind:contested ? "OBSERVE_RIVAL" : "SURVEY_SITE",
      pilotID:witness.actor.pilotID,entityID:shipID,
      systemID:scene.systemID,siteID,contested,
      // Existing order arbiter must eventually accept/order this intention;
      // this module cannot issue movement, inventory, hacking or a reward.
      nativeOrderIssued:false,nativeMutation:false};
  }
  function inspect({systemID,siteID} = {}) {
    const at = time();
    if (!at || !positive(systemID) || !positive(siteID)) return null;
    const row = sites.get(siteKey(systemID,siteID));
    if (!row || row.createdAt > at || row.createdAt + maxAgeMs <= at) return null;
    const {fingerprint,...publicRow} = row;
    return copy(publicRow);
  }
  return Object.freeze({observe,plan,inspect});
}
module.exports = {createExpeditionCompetition};
