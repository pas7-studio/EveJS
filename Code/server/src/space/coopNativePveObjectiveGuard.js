"use strict";
// Pinned EveJS anomaly lifecycle guard: NEVER awards/creates sites or changes Dogma.
// The native dungeonUniverseSiteService still owns encounter progress, payouts,
// despawn and rotation. This only blocks a premature native completion.
const EXPLICIT_DESTRUCTION_MODES = new Set([
  "objective_target_destroyed", "objective_targets_destroyed",
  "destroy_objective_target", "destroy_objective_targets",
]);
function positiveTime(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function completeOnEncounterClearDisabled(hints = {}) {
  const completion = hints && typeof hints.completion === "object" &&
    hints.completion !== null && !Array.isArray(hints.completion)
    ? hints.completion : {};
  return completion.completeObjectiveOnEncounterClear === false ||
    hints.completeObjectiveOnEncounterClear === false;
}
function requiresExplicitObjective(hints = {}) {
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return true;
  const completion = hints.completion && typeof hints.completion === "object" &&
    !Array.isArray(hints.completion) ? hints.completion : {};
  const mode = String(completion.mode || completion.completionMode || "").trim().toLowerCase();
  return completeOnEncounterClearDisabled(hints) || EXPLICIT_DESTRUCTION_MODES.has(mode);
}
function nativeObjectiveSatisfied(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) return false;
  return positiveTime(instance.objectiveSatisfiedAtMs) ||
    positiveTime(instance.metadata && instance.metadata.objectiveSatisfiedAtMs);
}
function canCompleteAnomaly(instance, populationHints) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) return false;
  if (String(instance.siteKind || "").trim().toLowerCase() !== "anomaly" ||
      String(instance.lifecycleState || "").trim().toLowerCase() !== "active") return false;
  if (!populationHints || typeof populationHints !== "object" || Array.isArray(populationHints))
    return false; // Fail closed only under explicit opt-in.
  return !requiresExplicitObjective(populationHints) || nativeObjectiveSatisfied(instance);
}
module.exports = {
  canCompleteAnomaly, requiresExplicitObjective, nativeObjectiveSatisfied,
  completeOnEncounterClearDisabled, EXPLICIT_DESTRUCTION_MODES,
};
