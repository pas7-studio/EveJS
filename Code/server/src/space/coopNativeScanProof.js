"use strict";
// Authoritative, session-local proof of completed native EveJS probe scanning.
// No synthetic signatures, coordinate grants, bookmark writes, or ship motion.
const PROOF_TTL_MS = 15 * 60 * 1000;
const MAX_PROOFS = 64;
const numberID = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const normalizeTargetID = value =>
  (typeof value === "string" || Number.isSafeInteger(value))
    ? String(value).trim().toUpperCase() : "";
const currentSystem = session => numberID(session &&
  ((session._space && session._space.systemID) || session.solarsystemid2 || session.solarsystemid));
const charID = session => numberID(session && (session.characterID || session.charid));
// The native in-space ship takes precedence over a cached activeShipID value.
const shipID = session => numberID(session &&
  ((session._space && session._space.shipID) ||
   session.shipID || session.shipid || session.activeShipID));
function keyValData(row) {
  if (!row || row.type !== "object" || row.name !== "util.KeyVal" ||
      !row.args || row.args.type !== "dict" || !Array.isArray(row.args.entries)) return null;
  const entries = row.args.entries;
  // The authentic scan serializer produces exactly one of each field.
  if (entries.some(e => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string")) return null;
  const keys = entries.map(e => e[0]);
  if (new Set(keys).size !== keys.length) return null;
  return Object.fromEntries(entries);
}
function findMatchingSite(sites, resultID) {
  const id = normalizeTargetID(resultID);
  if (!id || !Array.isArray(sites)) return null;
  const found = sites.filter(site => numberID(site && site.siteID) > 0 &&
    (normalizeTargetID(site.targetID) === id || String(site.siteID) === id));
  return found.length === 1 ? found[0] : null;
}
function nativePosition(site) {
  const p = site && site.actualPosition;
  if (!p || typeof p !== "object" ||
      ![p.x, p.y, p.z].every(n => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: p.x, y: p.y, z: p.z };
}
function scanPosition(value) {
  const components = Array.isArray(value) ? value :
    value && value.type === "list" && Array.isArray(value.items) ? value.items : null;
  if (!components || components.length !== 3) return null;
  const actual = components.map(component =>
    typeof component === "number" ? component :
    component && component.type === "real" && typeof component.value === "number"
      ? component.value : NaN);
  if (!actual.every(Number.isFinite)) return null;
  return { x: actual[0], y: actual[1], z: actual[2] };
}
function samePosition(a, b) {
  return Boolean(a && b && ["x", "y", "z"].every(k =>
    Math.abs(a[k] - b[k]) <= 0.1));
}
function siteIdentity(site) {
  const position = nativePosition(site);
  const siteID = numberID(site && site.siteID);
  const targetID = normalizeTargetID(site && site.targetID);
  if (!siteID || !targetID || !position) return null;
  return { siteID, targetID, position,
    siteKind: String(site.siteKind || "signature").toLowerCase(),
    family: String(site.family || "unknown").toLowerCase(),
    typeID: numberID(site.typeID), instanceID: numberID(site.instanceID),
    pairID: numberID(site.pairID) };
}
function siteMatches(recorded, live) {
  return recorded && live && recorded.siteID === live.siteID &&
    recorded.targetID === live.targetID && recorded.siteKind === live.siteKind &&
    recorded.family === live.family && recorded.typeID === live.typeID &&
    recorded.instanceID === live.instanceID && recorded.pairID === live.pairID &&
    samePosition(recorded.position, live.position);
}
function record({ session, scanResult, origin, sites, nowMs = Date.now() } = {}) {
  const characterID = charID(session), systemID = currentSystem(session),
    currentShipID = shipID(session), timestamp = Number(nowMs);
  if (!characterID || !systemID || !currentShipID || !origin ||
      numberID(origin.characterID) !== characterID ||
      numberID(origin.systemID) !== systemID ||
      numberID(origin.shipID) !== currentShipID ||
      !session._space || session.socket?.destroyed === true ||
      !Number.isFinite(timestamp) || timestamp < 0 ||
      !Array.isArray(scanResult && scanResult.results) || !Array.isArray(sites)) {
    return { status: "INVALID_NATIVE_SCAN_ORIGIN", count: 0 };
  }
  const old = session._coopNativeScanProof;
  const proofs = old && old.characterID === characterID &&
    old.systemID === systemID && old.shipID === currentShipID &&
    Array.isArray(old.receipts) ? old.receipts.filter(r =>
      r && Number.isFinite(r.expiresAtMs) && r.expiresAtMs > timestamp &&
      r.expiresAtMs <= timestamp + PROOF_TTL_MS) : [];
  const candidates = [], seenIDs = new Set(), ambiguous = new Set();
  for (const raw of scanResult.results) {
    const entry = keyValData(raw);
    if (!entry || typeof entry.certainty !== "number" ||
        !Number.isFinite(entry.certainty) || entry.certainty < 1) continue;
    const site = findMatchingSite(sites, entry.id);
    if (!site) continue;
    const identity = siteIdentity(site);
    if (!identity || !samePosition(identity.position, scanPosition(entry.pos))) continue;
    // Reject duplicate scan rows, even if both individually claim 100%.
    if (seenIDs.has(identity.siteID)) {
      ambiguous.add(identity.siteID);
      continue;
    }
    seenIDs.add(identity.siteID);
    candidates.push(identity);
  }
  let added = 0;
  for (const identity of candidates) {
    if (ambiguous.has(identity.siteID)) continue;
    const next = { ...identity, expiresAtMs: timestamp + PROOF_TTL_MS };
    const idx = proofs.findIndex(r => r.siteID === identity.siteID);
    if (idx >= 0) proofs.splice(idx, 1);
    proofs.push(next);
    added++;
  }
  session._coopNativeScanProof = {
    characterID, systemID, shipID: currentShipID, receipts: proofs.slice(-MAX_PROOFS),
  };
  return { status: "NATIVE_PROBE_SCAN_RECORDED", count: added };
}
function authorize({ session, locationID, resultID, sites, nowMs = Date.now() } = {}) {
  const characterID = charID(session), systemID = currentSystem(session),
    currentShipID = shipID(session), requestedSystem = numberID(locationID), timestamp = Number(nowMs);
  if (!characterID || !systemID || !currentShipID || requestedSystem !== systemID ||
      !session._space || session.socket?.destroyed === true ||
      !Number.isFinite(timestamp) || timestamp < 0) {
    return { ok: false, reason: "INVALID_SESSION_OR_SYSTEM" };
  }
  const proof = session._coopNativeScanProof;
  if (!proof || proof.characterID !== characterID || proof.systemID !== systemID ||
      proof.shipID !== currentShipID || !Array.isArray(proof.receipts)) {
    return { ok: false, reason: "NO_NATIVE_SCAN_RECEIPT" };
  }
  const site = findMatchingSite(sites, resultID);
  if (!site) return { ok: false, reason: "SIGNATURE_NOT_FOUND" };
  const identity = siteIdentity(site);
  if (!identity) return { ok: false, reason: "INVALID_SITE" };
  const recorded = proof.receipts.find(r => siteMatches(r, identity) &&
    Number.isFinite(r.expiresAtMs) && r.expiresAtMs > timestamp &&
    r.expiresAtMs <= timestamp + PROOF_TTL_MS);
  if (!recorded) return { ok: false, reason: "PERFECT_SCAN_REQUIRED" };
  return { ok: true, siteID: identity.siteID, targetID: identity.targetID };
}
function fastFleetBookmarkAccess({ session, bookmarkView, fleetRuntime } = {}) {
  if (!session || session.socket?.destroyed === true ||
      !bookmarkView || !bookmarkView.bookmark ||
      !bookmarkView.folder || bookmarkView.folder.isPersonal !== false ||
      bookmarkView.isActive !== true || !fleetRuntime) return false;
  const caller = charID(session), creator = numberID(bookmarkView.bookmark.creatorID);
  if (!caller || !creator || caller === creator) return false;
  // Only after stock bookmarkRuntime.getBookmarkForCharacter granted access.
  const fleet = typeof fleetRuntime.getFleetForCharacter === "function"
    ? fleetRuntime.getFleetForCharacter(caller) : null;
  return Boolean(fleet && typeof fleetRuntime.getMemberRecord === "function" &&
    fleetRuntime.getMemberRecord(fleet, caller) &&
    fleetRuntime.getMemberRecord(fleet, creator));
}
// Read-only two-pilot physical-arrival witness. Requires TWO already granted
// native bookmark views: cannot grant ACL, warp, spawn sites or settle loot.
function verifyFleetArrival({ scene, scanner, peer, scannerBookmarkView, peerBookmarkView,
  site, fleetRuntime, arrivalToleranceMeters = 50000 } = {}) {
  const fail = reason => ({ verified: false, reason });
  const systemID = numberID(scene && scene.systemID);
  const aID = charID(scanner), bID = charID(peer), point = nativePosition(site);
  if (!systemID || !aID || !bID || aID === bID || !point ||
      typeof scene.getEntityByID !== "function" ||
      !Number.isFinite(arrivalToleranceMeters) || arrivalToleranceMeters <= 0 ||
      arrivalToleranceMeters > 100000 ||
      !scannerBookmarkView || !peerBookmarkView ||
      !fastFleetBookmarkAccess({session:peer,bookmarkView:peerBookmarkView,fleetRuntime}))
    return fail("NATIVE_DUO_OR_BOOKMARK_PERMISSION_MISSING");
  const liveSessions = [...(scene.sessions?.values?.() || [])];
  if (!liveSessions.includes(scanner) || !liveSessions.includes(peer) ||
      currentSystem(scanner) !== systemID || currentSystem(peer) !== systemID ||
      scanner?._space?.initialStateSent !== true ||
      peer?._space?.initialStateSent !== true ||
      scanner?.socket?.destroyed === true || peer?.socket?.destroyed === true)
    return fail("NATIVE_SESSIONS_NOT_READY");
  const aMark=scannerBookmarkView.bookmark, bMark=peerBookmarkView.bookmark;
  const bookmarkID=numberID(aMark && aMark.bookmarkID);
  if (!bookmarkID || numberID(bMark.bookmarkID) !== bookmarkID ||
      numberID(aMark.creatorID) !== aID || numberID(bMark.creatorID) !== aID ||
      numberID(aMark.folderID) !== numberID(bMark.folderID) ||
      numberID(aMark.locationID) !== systemID ||
      numberID(bMark.locationID) !== systemID ||
      !samePosition(point,{x:aMark.x,y:aMark.y,z:aMark.z}) ||
      !samePosition(point,{x:bMark.x,y:bMark.y,z:bMark.z}))
    return fail("NATIVE_BOOKMARK_COORDINATES_NOT_MATCHED");
  const firstShipID=numberID(scanner?._space?.shipID),secondShipID=numberID(peer?._space?.shipID);
  const first=firstShipID&&scene.getEntityByID(firstShipID);
  const second=secondShipID&&scene.getEntityByID(secondShipID);
  if (!firstShipID || !secondShipID || firstShipID===secondShipID ||
      !first || !second || first.kind!=="ship" || second.kind!=="ship" ||
      first.nativeNpc===true || second.nativeNpc===true ||
      first.itemID!==firstShipID || second.itemID!==secondShipID ||
      numberID(first.pilotCharacterID || first.characterID)!==aID ||
      numberID(second.pilotCharacterID || second.characterID)!==bID)
    return fail("TWO_REAL_PLAYER_SHIPS_NOT_FOUND");
  const inRange=entity=>{
    const p=entity.position;
    return p && [p.x,p.y,p.z].every(v=>typeof v==="number"&&Number.isFinite(v)) &&
      Math.hypot(p.x-point.x,p.y-point.y,p.z-point.z)<=arrivalToleranceMeters;
  };
  if(!inRange(first)||!inRange(second))return fail("NATIVE_SHIP_ARRIVAL_NOT_EVIDENCED");
  return {verified:true,status:"TWO_NATIVE_SHIPS_AT_SHARED_BOOKMARK",
    systemID,bookmarkID,scannerShipID:firstShipID,peerShipID:secondShipID};
}
module.exports = { record, authorize, fastFleetBookmarkAccess, verifyFleetArrival,
  _testing: { keyValData, findMatchingSite, nativePosition, scanPosition, samePosition } };
