"use strict";
// Pure decision policy; never orders an attack or creates assets.
const clamp = x => Math.max(0, Math.min(1, x));
function chooseOpportunity({intel, targetRole, hunterHealth, escapeReady,
  escortCount = 0, playerContacts = 0, caution = 0.5,
  distanceMeters = 0, competingJobValue = 10} = {}) {
  if (!intel || !["miner", "hauler"].includes(targetRole) ||
      intel.targetRole !== targetRole || !Number.isFinite(intel.confidence) ||
      intel.confidence < 0.55 || !Number.isFinite(intel.ageMs) || intel.ageMs < 0)
    return {decision: "SCOUT", reason: "NO_FRESH_WITNESS"};
  if (!Number.isFinite(hunterHealth) || hunterHealth <= 0 || hunterHealth > 1 ||
      escapeReady !== true) return {decision: "RETREAT", reason: "SURVIVAL_UNVERIFIED"};
  if (![escortCount, playerContacts].every(x => Number.isSafeInteger(x) && x >= 0 && x <= 20) ||
      !Number.isFinite(caution) || caution < 0 || caution > 1 ||
      !Number.isFinite(distanceMeters) || distanceMeters < 0 ||
      !Number.isFinite(competingJobValue) || competingJobValue < 0)
    return {decision: "SCOUT", reason: "UNKNOWN_RISK"};
  if (hunterHealth < 0.6) return {decision: "RETREAT", reason: "SHIP_DAMAGED"};
  // Conservative lower-confidence bound based ONLY on actual visible contacts,
  // a witnessed NPC fleet role and the attacker's native current health.
  // This is a tunable gameplay estimate, not a prediction of native combat DPS.
  const pWinLower = clamp((targetRole === "hauler" ? 0.89 : 0.85) -
    escortCount * 0.22 - playerContacts * 0.21 -
    (1 - intel.confidence) * 0.18 - (1 - hunterHealth) * 0.3 - caution * 0.05);
  const threshold = 0.69 + caution * 0.18;
  const opportunity = targetRole === "hauler" ? 105 : 60;
  const utility = pWinLower * opportunity - (1 - pWinLower) * 115 -
    Math.min(20, distanceMeters / 15000);
  if (pWinLower < threshold) return {decision: "WORK", reason: "RISK_TOO_HIGH",
    pWinLower, threshold, utility};
  if (utility <= competingJobValue) return {decision: "WORK", reason: "BETTER_NONCOMBAT_WORK",
    pWinLower, threshold, utility};
  return {decision: "RAID", reason: "WITNESSED_VULNERABLE_NPC_CONVOY",
    pWinLower, threshold, utility};
}
module.exports = {chooseOpportunity};
