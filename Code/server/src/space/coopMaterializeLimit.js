"use strict";
// FW-013C: the materializer bridge accepts a per-system spawn cap of 1..10.
// A configured value outside that range used to make createBridge() THROW, which
// aborted observeSession() before `bridge` was ever assigned - so every
// bridge-driven phase (raids, loot delivery, market assignments) silently
// stopped existing while the world looked healthy. A configuration value is not
// a programming error: clamp it, report it, and keep the bridge.
const MIN = 1;
const MAX = 10;
const DEFAULT = 2;
function resolveMaterializeLimit(value) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  const parsed = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { configured: raw, limit: DEFAULT, clamped: raw !== "", reason: raw ? "NOT_AN_INTEGER" : "DEFAULT" };
  }
  if (parsed < MIN) return { configured: raw, limit: MIN, clamped: true, reason: "BELOW_MINIMUM" };
  if (parsed > MAX) return { configured: raw, limit: MAX, clamped: true, reason: "ABOVE_MAXIMUM" };
  return { configured: raw, limit: parsed, clamped: false, reason: "IN_RANGE" };
}
module.exports = { resolveMaterializeLimit, MIN, MAX, DEFAULT };
