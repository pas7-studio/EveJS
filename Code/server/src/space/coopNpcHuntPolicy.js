"use strict";
// Adapter for existing EveJS native NPC-vs-NPC raids. NEVER authorizes PvP.
// Overlay copies .cjs source as .js. Resolve the matching sibling format in both trees.
const suffix = __filename.endsWith(".cjs") ? ".cjs" : "";
const {createIntelLedger} = require("./coopNpcIntelLedger" + suffix);
const {chooseOpportunity} = require("./coopNpcOpportunityPlanner" + suffix);
const positive = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const vec = p => p && ["x", "y", "z"].every(k => Number.isFinite(p[k]));
const range = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function createHuntPolicy({file, clock = () => Date.now(),
  onDecision = () => {}} = {}) {
  const ledger = createIntelLedger({file, clock});
  const lastNotices = new Map();
  const report = (data, pilotID, targetID) => {
    const key = pilotID + ":" + targetID + ":" + data.reason;
    const now = clock();
    if (!lastNotices.has(key) || now - lastNotices.get(key) >= 120000) {
      lastNotices.set(key, now);
      if (lastNotices.size > 1000) lastNotices.clear();
      try { onDecision({pilotID, targetID, decision: data.decision, reason: data.reason,
        pWinLower: data.pWinLower ?? null}); } catch (_error) { /* telemetry is optional */ }
    }
    return data;
  };
  function assess({systemID, scene, pirateID, targetID, targetRole,
    piratePilotID, contacts = [], getHealth, isScrambled, sharedIntel = null} = {}) {
    const system = positive(systemID), attackerID = positive(pirateID), preyID = positive(targetID);
    const fail = reason => ({decision: "SCOUT", reason});
    if (!system || !attackerID || !preyID || attackerID === preyID ||
        Number(scene?.systemID) !== system || typeof scene.getEntityByID !== "function" ||
        !/^coop-pilot-[0-9]{3,}$/.test(String(piratePilotID || "")) ||
        !["miner", "hauler"].includes(targetRole)) return fail("INVALID_NATIVE_CONTEXT");
    const attacker = scene.getEntityByID(attackerID);
    const prey = scene.getEntityByID(preyID);
    if (!attacker || !prey || attacker.kind !== "ship" || prey.kind !== "ship" ||
        attacker.nativeNpc !== true || prey.nativeNpc !== true ||
        attacker.session?.characterID || prey.session?.characterID ||
        !vec(attacker.position) || !vec(prey.position)) return fail("PHYSICAL_NPC_REQUIRED");
    if (typeof getHealth !== "function" || typeof isScrambled !== "function")
      return fail("NATIVE_SAFETY_INPUT_UNAVAILABLE");
    const distance = range(attacker.position, prey.position);
    try {
      if (distance <= 200000) {
        ledger.observe({pilotID: piratePilotID, targetID: preyID, systemID: system,
          targetRole, position: prey.position, distanceMeters: distance});
      }
    } catch (_error) { return fail("INTEL_PERSISTENCE_FAILED"); }
    let intel = ledger.recall({pilotID: piratePilotID, targetID: preyID, systemID: system});
    let sharedWitness = null;
    // Shared report must come from a unique, physically nearby named NPC
    // whose *real* grid contact is still verifiable. Squad faction/legal
    // membership is enforced by the calling native squad director.
    if (sharedIntel && sharedIntel.targetID === preyID &&
        sharedIntel.recipientEntityID === attackerID &&
        sharedIntel.targetRole === targetRole && sharedIntel.systemID === system &&
        Number.isSafeInteger(sharedIntel.observedAt) &&
        Number.isSafeInteger(sharedIntel.firstSeenAt) &&
        sharedIntel.firstSeenAt <= sharedIntel.observedAt &&
        clock() - sharedIntel.firstSeenAt >= 15000 &&
        clock() >= sharedIntel.observedAt &&
        clock() - sharedIntel.observedAt <= 60000 &&
        vec(sharedIntel.position) &&
        range(sharedIntel.position, prey.position) <= 100000) {
      const sourceID = positive(sharedIntel.sourceEntityID);
      const sourcePilot = sharedIntel.sourcePilotID;
      const sourceLinks = (Array.isArray(contacts) ? contacts : [])
        .filter(link => Number(link.entityID) === sourceID &&
          link.pilotID === sourcePilot && link.role === "pirate" &&
          Number(link.systemID) === system);
      const recipientLinks = (Array.isArray(contacts) ? contacts : [])
        .filter(link => Number(link.entityID) === attackerID &&
          link.pilotID === piratePilotID && link.role === "pirate" &&
          Number(link.systemID) === system);
      const sameFaction = sourceLinks.length === 1 &&
        recipientLinks.length === 1 &&
        typeof sourceLinks[0].faction === "string" &&
        sourceLinks[0].faction.length > 0 &&
        sourceLinks[0].faction === recipientLinks[0].faction;
      const source = sourceID && scene.getEntityByID(sourceID);
      if (sourceID !== attackerID && sameFaction &&
          source?.kind === "ship" && source.nativeNpc === true &&
          !source.session?.characterID && vec(source.position) &&
          range(source.position, prey.position) <= 180000) {
        const ageMs = clock() - sharedIntel.observedAt;
        if (!intel || sharedIntel.observedAt > intel.at) {
          intel = {pilotID: piratePilotID, targetID: preyID, systemID: system,
            targetRole, position: {...sharedIntel.position},
            at: sharedIntel.observedAt, ageMs,
            confidence: Math.max(0.6, 0.82 - ageMs * 0.22 / 60000)};
          sharedWitness = source;
        }
      }
    }
    if (!intel) return report(fail("NO_FRESH_WITNESS"), piratePilotID, preyID);
    // No tracking hidden, fast-moving targets beyond last observed grid.
    if (range(intel.position, prey.position) > 250000)
      return report(fail("TARGET_MOVED_BEYOND_INTEL"), piratePilotID, preyID);
    let health, scramble;
    try { health = getHealth(attacker); scramble = isScrambled(attacker); }
    catch (_error) { return report(fail("NATIVE_SAFETY_INPUT_UNAVAILABLE"), piratePilotID, preyID); }
    if (!Number.isFinite(health) || typeof scramble !== "boolean")
      return report(fail("NATIVE_SAFETY_INPUT_UNAVAILABLE"), piratePilotID, preyID);
    const near = e => !!e && e.kind === "ship" && vec(e.position) &&
      (range(attacker.position, e.position) <= 200000 ||
        (sharedWitness && range(sharedWitness.position, e.position) <= 200000)) &&
      range(prey.position, e.position) <= 130000;
    let escorts = 0;
    for (const c of Array.isArray(contacts) ? contacts.slice(0, 100) : []) {
      const id = positive(c?.entityID);
      if (!id || id === attackerID || id === preyID || c.role !== "patrol") continue;
      const guard = scene.getEntityByID(id);
      if (guard?.nativeNpc === true && near(guard)) escorts++;
    }
    let humans = 0;
    for (const session of scene.sessions?.values?.() || []) {
      if (!positive(session?.characterID) ||
          session?._space?.initialStateSent !== true ||
          Number(session?._space?.systemID) !== system) continue;
      const id = positive(session?._space?.shipID);
      const ship = id && scene.getEntityByID(id);
      if (ship?.nativeNpc !== true && near(ship)) humans++;
    }
    const result = chooseOpportunity({intel, targetRole,
      hunterHealth: health, escapeReady: scramble === false,
      escortCount: escorts, playerContacts: humans, distanceMeters: distance});
    return report(result, piratePilotID, preyID);
  }
  return {assess, intel: ledger};
}
module.exports = {createHuntPolicy};
