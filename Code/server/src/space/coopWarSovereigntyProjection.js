"use strict";
// FW-011A: project real war control into the sovereignty view.
//
// The native sovereignty model is an ALLIANCE claim backed by a real
// territorial-claim unit or infrastructure hub (`sovState.getSystemSovClaim`
// reads those structures). An NPC faction has neither an alliance claim nor a
// TCU in this world, so writing a sov row for it would fabricate a claim that
// no structure backs.
//
// This module therefore produces an explicit projection: military control is
// always reported, and a native sovereignty claim is reported ONLY where a real
// native sov structure of that faction really exists. Nothing is written here.
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const num = (value) => Number(value) || 0;

// Native sov structures that really back a claim.
const CLAIM_TYPE_IDS = Object.freeze({TERRITORIAL_CLAIM_UNIT: 32226, INFRASTRUCTURE_HUB: 32458});

function planProjection({ warState = null, structures = [], getSystemSovClaim = null } = {}) {
  const territories = warState && warState.territories;
  if (!territories || typeof territories !== "object")
    return {status: "REFUSED", reason: "NO_WAR_TERRITORY"};
  const bySystem = new Map();
  for (const structure of Array.isArray(structures) ? structures : []) {
    const systemID = num(structure?.solarSystemID ?? structure?.systemID);
    const typeID = num(structure?.typeID);
    if (!pos(systemID) || !pos(typeID)) continue;
    if (!Object.values(CLAIM_TYPE_IDS).includes(typeID)) continue;
    if (!bySystem.has(systemID)) bySystem.set(systemID, []);
    bySystem.get(systemID).push(structure);
  }
  const systems = [], counts = {NATIVE_SOV_CLAIM: 0, MILITARY_CONTROL_ONLY_NOT_SDE_SOVEREIGNTY: 0};
  for (const [key, record] of Object.entries(territories)) {
    const systemID = num(key);
    const factionID = num(record && record.militaryControllerFactionID);
    if (!pos(systemID) || !pos(factionID)) continue;
    const owners = bySystem.get(systemID) || [];
    let claim = null;
    try {
      if (typeof getSystemSovClaim === "function") claim = getSystemSovClaim(systemID) || null;
    } catch (_error) { claim = null; }
    const backed = owners.length > 0 && claim !== null;
    const mode = backed ? "NATIVE_SOV_CLAIM" :
      "MILITARY_CONTROL_ONLY_NOT_SDE_SOVEREIGNTY";
    counts[mode]++;
    systems.push({
      systemID, factionID,
      state: String(record?.state || ""),
      mode,
      // The real backing, when it exists. Never synthesised.
      nativeClaimAllianceID: num(claim && claim.allianceID) || 0,
      sovStructureIDs: owners.map((structure) => num(structure.structureID)).filter(pos),
      sovStructureTypeIDs: owners.map((structure) => num(structure.typeID)).filter(pos),
      reason: backed ? "" : (owners.length ? "NATIVE_CLAIM_NOT_WRITTEN"
        : "NO_NATIVE_SOV_STRUCTURE"),
    });
  }
  systems.sort((left, right) => left.systemID - right.systemID);
  return {status: systems.length ? "PLANNED" : "REFUSED",
    reason: systems.length ? "" : "NO_WAR_TERRITORY", systems, counts,
    evidence: "MILITARY_CONTROL_REPORTED_NATIVE_CLAIM_ONLY_WHEN_STRUCTURE_BACKED"};
}

// A write is allowed only for a system that really has a native claim. The
// caller supplies the native writer; this function never invents one.
function applyProjection({ plan, writeClaim } = {}) {
  if (!plan || plan.status !== "PLANNED")
    return {status: "REFUSED", reason: String(plan?.reason || "NO_PLAN")};
  if (typeof writeClaim !== "function")
    return {status: "REFUSED", reason: "NATIVE_SOV_WRITER_REQUIRED"};
  const written = [], refused = [];
  for (const system of plan.systems) {
    if (system.mode !== "NATIVE_SOV_CLAIM") {
      refused.push({systemID: system.systemID, reason: system.reason ||
        "MILITARY_CONTROL_ONLY_NOT_SDE_SOVEREIGNTY"});
      continue;
    }
    let result = null;
    try { result = writeClaim(system); } catch (error) {
      result = {status: "REFUSED", reason: String((error && error.message) || error)};
    }
    if (result && result.status === "APPLIED") written.push(system.systemID);
    else refused.push({systemID: system.systemID,
      reason: String(result?.reason || result?.status || "WRITE_REFUSED")});
  }
  return {status: written.length ? "PROJECTED" : "NO_NATIVE_CLAIM_TO_WRITE",
    written, refused, counts: plan.counts};
}

module.exports = {CLAIM_TYPE_IDS, planProjection, applyProjection};
