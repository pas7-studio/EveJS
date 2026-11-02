"use strict";

var HYSTERESIS_REASON = {
  URGENT: "URGENT_EVENT",
  SAME_INTENT: "SAME_INTENT",
  TOO_SOON: "MIN_DECISION_AGE",
  REPLAN: "REPLAN"
};

function shouldReplan(opts) {
  opts = opts || {};
  var urgency = !!opts.urgency;
  var lastDecisionAt = opts.lastDecisionAt;
  var now = opts.now;
  var minDecisionAgeMs = opts.minDecisionAgeMs;
  var lastIntent = opts.lastIntent;
  var nextIntent = opts.nextIntent;

  // A real urgent event always replans first, regardless of age.
  if (urgency === true) {
    return { replan: true, reason: HYSTERESIS_REASON.URGENT };
  }

  // No change of intent: nothing to plan.
  if (nextIntent === lastIntent) {
    return { replan: false, reason: HYSTERESIS_REASON.SAME_INTENT };
  }

  // If we cannot compute a finite elapsed time, treat it as too soon.
  if (
    typeof lastDecisionAt !== "number" ||
    typeof now !== "number" ||
    typeof minDecisionAgeMs !== "number" ||
    !isFinite(lastDecisionAt) ||
    !isFinite(now) ||
    !isFinite(minDecisionAgeMs)
  ) {
    return { replan: false, reason: HYSTERESIS_REASON.TOO_SOON };
  }

  // Replan only after the minimum decision age has elapsed.
  if (now - lastDecisionAt < minDecisionAgeMs) {
    return { replan: false, reason: HYSTERESIS_REASON.TOO_SOON };
  }

  return { replan: true, reason: HYSTERESIS_REASON.REPLAN };
}

module.exports = {
  shouldReplan: shouldReplan,
  HYSTERESIS_REASON: HYSTERESIS_REASON
};
