"use strict";
// Announce only actions already accepted by native EveJS. This is an intel
// signal, not a generated objective, a kill claim or a reward grant.
const positive = value => {
 const n = Number(value);
 return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const position = value => Boolean(value) && ["x", "y", "z"].every(axis =>
 typeof value[axis] === "number" && Number.isFinite(value[axis]));
const clean = text => String(text || "").replace(/[<>\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
const ACTIONS = new Set(["attack", "warp-to-hauler"]);
const duoTactics = require("./coopDuoRaidTactics");

function createBroadcaster({
 send = (session, message) => require("../services/chat/chatHub").sendSystemMessage(session, message),
 locate = (scene, target) => require("./coopSystemIntel").nearest(scene, target),
 clock = () => Date.now(),
 cooldownMs = 240000,
 maxEntries = 1024,
 resolveFleetRuntime = () => require("../services/fleets/fleetRuntime")
} = {}) {
 if (typeof send !== "function" || typeof locate !== "function" || typeof clock !== "function" ||
  !Number.isSafeInteger(cooldownMs) || cooldownMs < 1000 ||
  !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
  typeof resolveFleetRuntime !== "function") throw Error("invalid raid beacon options");
 const last = new Map();
 function notifyRaid(scene, actions = []) {
  if (!scene?.sessions || typeof scene.sessions.values !== "function" ||
   typeof scene.getEntityByID !== "function" || !Array.isArray(actions)) return {sent: 0, status: "NO_NATIVE_SCENE"};
  const now = clock();
  if (!Number.isFinite(now) || now < 0) return {sent: 0, status: "INVALID_CLOCK"};
  // A supplied ID or action string alone is NOT proof of a native ship.
  const playerShipIDs = new Set(Array.from(scene.sessions.values())
   .map(session => positive(session?._space?.shipID)).filter(Boolean));
  const valid = actions.filter(item => ACTIONS.has(item?.action) &&
   positive(item.pirateID) && positive(item.targetID) &&
   positive(item.pirateID) !== positive(item.targetID) &&
   !playerShipIDs.has(positive(item.pirateID)) &&
   !playerShipIDs.has(positive(item.targetID)) &&
   ["miner", "hauler"].includes(item.targetRole)).map(item => ({
   ...item, pirateID: positive(item.pirateID), targetID: positive(item.targetID),
   pirate: scene.getEntityByID(positive(item.pirateID)),
   target: scene.getEntityByID(positive(item.targetID))
  })).filter(item => item.pirate?.kind === "ship" && item.target?.kind === "ship" &&
   position(item.pirate.position) && position(item.target.position))
   .sort((a, b) => Number(b.action === "attack") - Number(a.action === "attack"));
  if (!valid.length) return {sent: 0, status: "NO_VERIFIED_NATIVE_ACTION"};
  // A native order accepted by the real raid director is a real incident,
  // even if nobody is online to receive a Local message. Optional and safe.
  if(process.env.EVEJS_COOP_CONVOY_OPERATIONS==="1") for(const action of valid){
   try{require("./coopConvoyOperations").noteRaid(scene,action)}
   catch(error){console.warn("[CoopConvoyOperations] raid",String(error?.message||error))}
  }
  // Real, already validated native raid actions become discoverable events.
  // Failure of the optional board never changes native NPC combat.
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD==="1")for(const action of valid){
   if(action.action!=="attack")continue;
   try{require("./coopWorldOpportunityBoard").noteNativeRaid(scene,action)}
   catch(error){console.warn("[CoopOpportunityBoard] raid",String(error?.message||error).slice(0,120))}
  }
  // A real attack supersedes an earlier approach for the same pair.
  const attackingPairs = new Set(valid.filter(item => item.action === "attack")
   .map(item => item.pirateID + ":" + item.targetID));
  const currentSystem = positive(scene.systemID || scene.solarSystemID);
  let sent = 0, ready = 0;
  // Compute native fleet authorization once per verified raid pair, never
  // from client-supplied party names or a virtual co-op fleet.
  let fleetRuntime = null;
  try { fleetRuntime = resolveFleetRuntime(); } catch (_error) { /* stock solo fallback */ }
  const duoByPair = new Map();
  const seenCharacters = new Set();
  for (const session of scene.sessions.values()) {
   const characterID = positive(session?.characterID);
   const space = session?._space;
   const shipID = positive(space?.shipID);
   const systemID = positive(space?.systemID);
   if (!characterID || seenCharacters.has(characterID) || !shipID || !systemID ||
    (currentSystem && currentSystem !== systemID) || space.initialStateSent !== true ||
    session.socket?.destroyed === true || scene.getEntityByID(shipID)?.kind !== "ship") continue;
   seenCharacters.add(characterID);
   ready++;
   for (const action of valid) {
    if (action.action !== "attack" && attackingPairs.has(action.pirateID + ":" + action.targetID)) continue;
    const key = [characterID, systemID, action.pirateID, action.targetID, action.action].join(":");
    const previous = last.get(key);
    if (previous !== undefined && now >= previous && now - previous < cooldownMs) continue;
    // The nearest waypoint is real native scene topology, not a fake marker.
    // If lookup fails, fall back to the system rather than losing the signal.
    let location = "у цій системі";
    try {
     const nearby = locate(scene, action.target);
     const name = clean(nearby?.name);
     if (name) location = "біля " + name;
    } catch (error) {
     console.warn("[CoopWorldSignals] Location lookup", error.message);
    }
    const victim = action.targetRole === "hauler" ? "транспорт з рудою" : "шахтарський корабель";
    const pairKey = action.pirateID + ":" + action.targetID;
    if (!duoByPair.has(pairKey))
     duoByPair.set(pairKey, duoTactics.plan({
      scene,raid:action,fleetRuntime
     }));
    const assignment = duoByPair.get(pairKey).roles.get(characterID);
    const tactic = assignment?.role === "intercept"
     ? " Ваша роль у флоті: ПЕРЕХОПЛЕННЯ — зблизьтесь із піратом, утримуйте його увагу та прикривайте напарника."
     : assignment?.role === "escort"
     ? " Ваша роль у флоті: ЕСКОРТ — тримайтесь біля конвою, захищайте його й підтримуйте напарника."
     : "";
    const message = action.action === "attack"
     ? "[Living Universe] Пірат атакує " + victim + " " + location + ". Можна захистити конвой або втрутитися в сутичку разом із флотом." + tactic
     : "[Living Universe] Пірат здійснює варп до " + (action.targetRole === "hauler" ? "рудовозу" : "шахтаря") + " " + location + ". Це лише наближення, не підтверджений бій; можна підготувати перехоплення чи захист." + tactic;
    try {
     send(session, message);
     last.delete(key);
     last.set(key, now);
     sent++;
    } catch (error) {
     console.warn("[CoopWorldSignals] Local notification", error.message);
    }
    // At most one actionable alert per player per native raid tick.
    break;
   }
  }
  // Bounded, process-local cache. A restart may repeat an alert, but never
  // suppresses a real incident indefinitely or grows memory without limit.
  for (const [key, at] of last) if (now < at || now - at >= cooldownMs) last.delete(key);
  while (last.size > maxEntries) last.delete(last.keys().next().value);
  return {sent, ready, status: sent ? "NATIVE_RAID_NOTIFIED" : "NO_NEW_NOTICE"};
 }
 return {notifyRaid};
}
const broadcaster = createBroadcaster();
function notifyRaid(scene, actions = [], send) {
 // Keep existing caller signature; tests and operators can inject delivery
 // without ever writing to real EveJS chat.
 if (send) return createBroadcaster({send}).notifyRaid(scene, actions);
 return broadcaster.notifyRaid(scene, actions);
}
module.exports = {createBroadcaster, notifyRaid};
