"use strict";
// Best-effort, append-only native telemetry. Never modify gameplay state.
// Missing configuration or an unwritable volume MUST be visible in container
// logs, rather than silently misreported as a missing EVE client.
const fs = require("node:fs");
const path = require("node:path");
const {randomUUID}=require("node:crypto");
// Unique for this Node process boot, not user-supplied or a game state ID.
const runtimeRunID=randomUUID();
let lastWarning = "";
// Opt-in, additive subscribers (e.g. the ALIFE news digest). They receive the
// exact record that was appended, can never change it, and are isolated so a
// broken listener cannot stop telemetry.
const subscribers = new Set();
function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
function positive(value){const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null;}
function describe(session,ship){
  return {
    characterID:positive(session?.characterID),
    shipID:positive(ship?.itemID||session?._space?.shipID||session?.shipid),
    systemID:positive(ship?.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid),
    clientID:positive(session?.clientID),
  };
}
function warnOnce(code){
  const marker=String(code||"UNKNOWN");
  if(lastWarning===marker)return;
  lastWarning=marker;
  try { console.warn("[CoopProbe] BLOCKED_TELEMETRY_"+marker+"; inspect effective EVEJS_COOP_EVENTS_FILE and /var/lib/evejs mount"); }catch(_ignored){}
}
function observe(event,session,ship,extra={}){
  // Evaluating at event time is intentional: environment may be configured
  // after module preload in local tests or startup plugins.
  const destination=process.env.EVEJS_COOP_EVENTS_FILE;
  if(typeof destination!=="string"||!destination.trim()){
    warnOnce("CONFIG");
    return false;
  }
  try {
    const record={
      at:new Date().toISOString(),
      event,
      ...describe(session,ship),
      ...extra,
      // Reserved final key: callers cannot counterfeit a prior process run.
      runtimeRunID,
    };
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.appendFileSync(destination,JSON.stringify(record)+"\n",{encoding:"utf8",flag:"a"});
    lastWarning="";
    // Listeners get the record after it is durable; failures are isolated.
    for(const listener of subscribers){
      try{listener(record);}catch(_ignored){}
    }
    return true;
  } catch(err) {
    // Optional diagnostics must NEVER interrupt login, disconnect or combat.
    // Log only the error code, not potentially sensitive filesystem paths.
    warnOnce("WRITE_"+(String(err?.code||"UNKNOWN").replace(/[^A-Z0-9_]/g,"_").slice(0,40)));
    return false;
  }
}
module.exports={observe,subscribe};