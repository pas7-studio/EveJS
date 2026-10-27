"use strict";
// Agent-mission dungeons spawn their follow-up waves in silence.
//
// Measured on 2026-10-27 (play stack, mission "Gone Berserk", dungeon 875):
// wave 1 carries `triggerMessages: [{messageType:2,messageID:123944}]`, waves
// 2..7 carry an empty `triggerMessages: []`. The runtime does spawn them (wave 2
// appeared 4 minutes after wave 1 was cleared) but nothing refreshes the mission
// in the client, so the player sees an empty pocket and a mission that "does not
// count". The same mission also asks for 24 hulls (9+3+3+3+2+2+2) for
// 120k + 45k ISK and 250 LP.
//
// This module only observes and paces. It never spawns, damages, kills or
// completes a mission by itself: a wave stays a real native wave, and the
// objective only completes when the allowed waves are really cleared.
//
//  EVEJS_COOP_MISSION_WAVE_NOTIFY=1  refresh the owner's mission + one telemetry
//                                    event per spawned wave
//  EVEJS_COOP_MISSION_WAVE_CAP=<n>   allow at most n waves; waves above the cap
//                                    are recorded as settled-without-spawn so
//                                    the objective can complete after wave n
const PROBE = "./coopRuntimeProbe";

function enabled() {
  return process.env.EVEJS_COOP_MISSION_WAVE_NOTIFY === "1";
}

function capFor() {
  const raw = process.env.EVEJS_COOP_MISSION_WAVE_CAP;
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 0;
}

function waveKey(index) {
  const wave = Math.max(0, Number(index) || 0);
  return "wave_" + String(wave).padStart(2, "0");
}

// siteKey is the only place the owning character is written down for a mission
// dungeon ("mission:<characterID>:<sequence>").
function parseMissionSiteKey(siteKey) {
  const match = /^mission:(\d+):(\d+)$/.exec(String(siteKey || ""));
  if (!match) return null;
  return { characterID: Number(match[1]) || 0, sequence: Number(match[2]) || 0 };
}

function isAgentMissionInstance(instance) {
  if (!instance) return false;
  if (String(instance.siteKind || "").toLowerCase() !== "mission") return false;
  return String(instance.siteOrigin || "").toLowerCase() === "agentmission" ||
    parseMissionSiteKey(instance.siteKey) !== null;
}

function totalWavesOf(instance, fallback) {
  const counters = instance && instance.objectiveState && instance.objectiveState.counters;
  const metadata = instance && instance.objectiveState && instance.objectiveState.metadata;
  const fromState = Math.max(
    Number(counters && counters.total_waves) || 0,
    Number(metadata && metadata.totalWaves) || 0,
  );
  return Math.max(fromState, Number(fallback) || 0, 1);
}

// Pure description used by the announcement and by tests: no I/O.
function describeWave(instance, plan, totalWaves, spawnedCount) {
  const wave = Math.max(0, Number(plan && plan.waveIndex) || 0);
  const total = Math.max(wave, totalWavesOf(instance, totalWaves));
  const cap = capFor();
  const effectiveTotal = cap > 0 ? Math.min(cap, total) : total;
  return {
    wave,
    total,
    effectiveTotal,
    finalWave: wave >= effectiveTotal,
    key: waveKey(wave),
    label: String((plan && plan.label) || (instance && instance.templateID) || "") || null,
    spawned: Math.max(0, Number(spawnedCount) || 0),
    remainingWaves: Math.max(0, effectiveTotal - wave),
    // The stock data announces a wave only when the plan carries triggerMessages;
    // waves 2..N of most mission templates carry none.
    stockAnnounced: Array.isArray(plan && plan.triggerMessages) && plan.triggerMessages.length > 0,
  };
}

// Waves above the cap are marked settled without a spawn. `armDeferredEncounterPlans`
// and `spawnEncounterPlan` both skip a wave that already has `spawnedAtMs`, and the
// completion check needs `completedAtMs`, so one write stops the chain without
// touching the wave that is currently alive.
function capPlan(instance, cap, nowMs, hasSpawned) {
  const total = totalWavesOf(instance, cap);
  if (cap <= 0 || total <= cap) {
    return { apply: false, reason: cap <= 0 ? "NO_CAP" : "CAP_COVERS_ALL", total, cap, skipped: [], kept: [] };
  }
  const skipped = [];
  for (let index = cap + 1; index <= total; index += 1) {
    const key = waveKey(index);
    if (hasSpawned(key)) continue;
    skipped.push(key);
  }
  const kept = [];
  for (let index = 1; index <= cap; index += 1) kept.push(waveKey(index));
  return { apply: skipped.length > 0, reason: skipped.length > 0 ? "CAP_APPLIED" : "CAP_ALREADY_APPLIED", total, cap, skipped, kept };
}

function notifyOwner(instance, described, deps) {
  const site = parseMissionSiteKey(instance && instance.siteKey);
  if (!site || !site.characterID) return { status: "SKIPPED", reason: "NO_OWNER" };
  try {
    const session = deps.sessionFor(site.characterID);
    if (!session) return { status: "SKIPPED", reason: "OWNER_OFFLINE" };
    if (typeof session.sendNotification === "function" && deps.missionUpdates) {
      const updates = deps.missionUpdates(site.characterID);
      if (Array.isArray(updates) && updates.length > 0) {
        session.sendNotification("OnMissionsUpdated", "charid", [updates]);
        return { status: "NOTIFIED", reason: "MISSION_REFRESHED", characterID: site.characterID };
      }
    }
    return { status: "SKIPPED", reason: "NO_MISSION_UPDATES" };
  } catch (error) {
    return { status: "FAILED", reason: String((error && error.message) || error) };
  }
}

function observe(instance, described, extra) {
  try {
    require(PROBE).observe("living-mission-wave", null,
      { spaceState: { systemID: Number(instance && instance.solarSystemID) || 0 } },
      { status: extra && extra.status, reason: extra && extra.reason, ...described, ...(extra || {}) });
  } catch (_error) { /* observation must never break the native spawn */ }
}

// Called once per spawned wave, from the site service, after the wave really
// exists in the scene.
function onWaveSpawn(input, deps = {}) {
  const instance = input && input.instance;
  const plan = input && input.plan;
  const nowMs = Math.max(0, Number(input && input.nowMs) || Date.now());
  if (!instance || !plan) return { status: "SKIPPED", reason: "NO_INSTANCE" };
  if (!isAgentMissionInstance(instance)) return { status: "SKIPPED", reason: "NOT_AGENT_MISSION" };
  if (!enabled() && capFor() <= 0) return { status: "SKIPPED", reason: "FLAG_OFF" };
  const spawnedCount = Array.isArray(input && input.spawned) ? input.spawned.length : 0;
  const described = describeWave(instance, plan, input && input.totalWaves, spawnedCount);
  if (described.wave <= 0) return { status: "SKIPPED", reason: "NO_WAVE_INDEX" };

  const result = { status: "WAVE_OK", reason: "WAVE_SPAWNED", ...described, cap: capFor(), skipped: [], notify: null };

  if (capFor() > 0 && typeof deps.mergeSpawnState === "function") {
    const cap = capPlan(instance, capFor(), nowMs, (key) => deps.hasSpawned && deps.hasSpawned(key));
    result.skipped = cap.skipped;
    result.cap = cap.cap;
    if (cap.apply) {
      for (const key of cap.skipped) {
        deps.mergeSpawnState(instance.instanceID, {
          encounterStatesByKey: {
            [key]: {
              key,
              spawnedAtMs: nowMs,
              completedAtMs: nowMs,
              remainingEntityIDs: [],
              spawnCount: 0,
              trigger: "coop_wave_cap",
              skippedByCap: true,
            },
          },
        }, { nowMs });
      }
      if (typeof deps.trimCompletion === "function") deps.trimCompletion(instance.instanceID, cap.kept, nowMs);
      result.reason = "WAVE_CAPPED";
    }
  }

  if (enabled() && typeof deps.sessionFor === "function") {
    // A wave the stock data already announces must not be announced twice.
    result.notify = described.stockAnnounced
      ? { status: "SKIPPED", reason: "STOCK_ANNOUNCED" }
      : notifyOwner(instance, described, deps);
  }

  if (enabled() || capFor() > 0) observe(instance, result, { notify: result.notify });
  return result;
}

module.exports = {
  enabled,
  capFor,
  waveKey,
  parseMissionSiteKey,
  isAgentMissionInstance,
  totalWavesOf,
  describeWave,
  capPlan,
  onWaveSpawn,
};
