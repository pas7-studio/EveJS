"use strict";
// A durable personal intent for named NPC pilots. No wallet/item/ship mutations.
const fs = require("node:fs");
const path = require("node:path");
const named = x => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);
const positive = x => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null;
const INTENTS = new Set(["SCOUT_GATE", "WATCH_BELT", "LAY_LOW", "HUNT"]);
const plain = value => JSON.parse(JSON.stringify(value));
function createPersonalGoals({file, clock = () => Date.now(), minDwellMs = 120000,
  maxPilots = 100} = {}) {
  if (typeof file !== "string" || !file || typeof clock !== "function" ||
      !Number.isSafeInteger(minDwellMs) || minDwellMs < 30000 || minDwellMs > 900000 ||
      !Number.isSafeInteger(maxPilots) || maxPilots < 1 || maxPilots > 100)
    throw Error("INVALID_NPC_PERSONAL_GOALS_CONFIG");
  let state = {version: 1, pilots: {}};
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved?.version !== 1 || !saved.pilots || Array.isArray(saved.pilots) ||
        typeof saved.pilots !== "object" || Object.keys(saved.pilots).length > maxPilots ||
        Object.entries(saved.pilots).some(([pilot, goal]) =>
          !named(pilot) || !INTENTS.has(goal?.intent) || !positive(goal?.systemID) ||
          !Number.isSafeInteger(goal?.changedAt) || goal.changedAt < 0 ||
          !Number.isSafeInteger(goal?.expiresAt) || goal.expiresAt < goal.changedAt))
      throw Error("INVALID_SAVED_NPC_PERSONAL_GOALS");
    state = saved;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  function persist(next) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = file + ".tmp-" + process.pid;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      state = next;
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  function preference(pilotID) {
    // Stable individual personality without randomness or resetting old pilots.
    const index = Number(pilotID.split("-").at(-1));
    return index % 3 === 0 ? "WATCH_BELT" : "SCOUT_GATE";
  }
  function decide({pilotID, systemID, assessment = "SCOUT", danger = false,
    gateCount = 0, beltCount = 0, stationCount = 0, verifiedRaid = false} = {}) {
    const sys = positive(systemID), now = clock();
    if (!named(pilotID) || !sys || !Number.isSafeInteger(now) || now < 0 ||
      typeof danger !== "boolean" || typeof verifiedRaid !== "boolean" ||
      ![gateCount, beltCount, stationCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
      !["RAID", "WORK", "RETREAT", "SCOUT"].includes(assessment))
      return {status: "INVALID"};
    const prior = state.pilots[pilotID];
    let intent = "SCOUT_GATE", reason = "SEEK_CONVOY";
    if (danger || assessment === "RETREAT") {
      intent = stationCount ? "LAY_LOW" : gateCount ? "SCOUT_GATE" : "WATCH_BELT";
      reason = "PRESERVE_NATIVE_SHIP";
    } else if (verifiedRaid && assessment === "RAID") {
      intent = "HUNT"; reason = "VERIFIED_NATIVE_ORDER";
    } else if (assessment === "WORK") {
      intent = beltCount ? "WATCH_BELT" : gateCount ? "SCOUT_GATE" : "LAY_LOW";
      reason = "RAID_NOT_WORTH_RISK";
    } else if (assessment === "SCOUT") {
      intent = preference(pilotID);
      if (intent === "WATCH_BELT" && !beltCount) intent = "SCOUT_GATE";
      if (intent === "SCOUT_GATE" && !gateCount) intent = beltCount ? "WATCH_BELT" : "LAY_LOW";
      reason = "SEARCH_FOR_OPPORTUNITY";
    } else {
      // Planner may want to raid, but without a confirmed native command
      // there is no active hunt. Keep scouting, never invent an engagement.
      intent = gateCount ? "SCOUT_GATE" : beltCount ? "WATCH_BELT" : "LAY_LOW";
      reason = "NATIVE_RAID_UNCONFIRMED";
    }
    // Never assign a waypoint that doesn't exist in the real native scene.
    if (intent === "WATCH_BELT" && !beltCount)
      intent = gateCount ? "SCOUT_GATE" : "LAY_LOW";
    if (intent === "SCOUT_GATE" && !gateCount)
      intent = beltCount ? "WATCH_BELT" : "LAY_LOW";
    const urgent = danger || assessment === "RETREAT" || (verifiedRaid && assessment === "RAID");
    if (prior && prior.systemID === sys && now >= prior.changedAt &&
        now < prior.expiresAt && prior.intent !== intent && !urgent &&
        prior.intent !== "HUNT")
      return {status: "HELD", ...plain(prior)};
    if (prior && prior.systemID === sys && prior.intent === intent &&
        prior.reason === reason && now >= prior.changedAt && now < prior.expiresAt)
      return {status: "UNCHANGED", ...plain(prior)};
    if (!prior && Object.keys(state.pilots).length >= maxPilots)
      return {status: "CAP_REACHED"};
    const next = {pilotID, systemID: sys, intent, reason, changedAt: now,
      expiresAt: now + minDwellMs, nativeOrdersObserved: prior?.nativeOrdersObserved || 0};
    const draft = {version: 1, pilots: {...state.pilots, [pilotID]: next}};
    persist(draft);
    return {status: "PLANNED", ...plain(next)};
  }
  function routeRole({pilotID, systemID} = {}) {
    if (!named(pilotID) || !positive(systemID)) return null;
    const goal = state.pilots[pilotID];
    if (!goal || goal.systemID !== Number(systemID)) return null;
    return goal.intent === "SCOUT_GATE" ? "scout" :
      goal.intent === "WATCH_BELT" ? "watch" :
      goal.intent === "LAY_LOW" ? "lay-low" : null;
  }
  function observeNativeOrder({pilotID, systemID, entityID, action, targetID} = {}) {
    if (!named(pilotID) || !positive(systemID) || !positive(entityID) ||
        !positive(targetID) || !["warp", "orbit"].includes(action))
      return {status: "INVALID"};
    const existing = state.pilots[pilotID];
    if (!existing || existing.systemID !== Number(systemID) || existing.intent === "HUNT")
      return {status: "IGNORED"};
    const next = {...existing, nativeOrdersObserved: existing.nativeOrdersObserved + 1,
      lastNativeOrder: {entityID:Number(entityID),targetID:Number(targetID),action,at:clock()}};
    persist({version: 1, pilots: {...state.pilots,[pilotID]:next}});
    return {status: "RECORDED"};
  }
  return {decide, routeRole, observeNativeOrder, snapshot:()=>plain(state)};
}
module.exports = {createPersonalGoals};
