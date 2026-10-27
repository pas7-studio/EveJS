"use strict";
// FW-009B: durable faction-war merit, paid only from a confirmed native kill.
//
// Why it exists: `coopFactionWarMerit` could compute merit, ranks and command
// size, but no record was ever persisted or paid - the runtime's merit table was
// an empty in-memory object, so every side stayed at a recruit's single ship and
// a real kill produced no career consequence at all.
//
// This ledger is the single owner of a pilot's war record. A payout is accepted
// only with an evidence key that names the exact physical wreck (and the exact
// attacker entity for a kill), so a replay can never pay twice. The merit values
// themselves stay in `coopFactionWarMerit`; this module only persists the result
// and reports a real promotion or demotion.
const {TABLE}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const core=require("./coopFactionWarMerit"+
 (__filename.endsWith(".js")?"":".cjs"));
const KEY="coop-faction-war\u001fmerit-v1",MAX_RECORDS=512,MAX_HISTORY=64;
const KILL_KIND="warship-kill";
const pos=x=>Number.isSafeInteger(x)&&x>0;
const pilot=x=>typeof x==="string"&&/^(coop-pilot|coop-player)-[0-9]{3,}$/.test(x);
const key=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const RANKS=new Set(core.RANKS.map(r=>r.rank));
const empty=()=>({version:1,records:{},paid:{}});
function validate(s){
 if(!s||s.version!==1||!s.records||typeof s.records!=="object"||
  Array.isArray(s.records)||!s.paid||typeof s.paid!=="object"||
  Array.isArray(s.paid)||Object.keys(s.records).length>MAX_RECORDS||
  Object.keys(s.paid).length>MAX_RECORDS*8)
  throw Error("WAR_MERIT_LEDGER_INVALID");
 for(const [id,r] of Object.entries(s.records)){
  if(!pilot(id)||r?.pilotID!==id||!Number.isSafeInteger(r.merit)||r.merit<0||
   !RANKS.has(String(r.rank))||!Array.isArray(r.history)||
   r.history.length>MAX_HISTORY)
   throw Error("WAR_MERIT_RECORD_CORRUPT");
  for(const h of r.history)
   if(!pos(h?.at)||!key(h?.kind)||!Number.isSafeInteger(h?.merit)) 
    throw Error("WAR_MERIT_HISTORY_CORRUPT");
 }
 for(const [id,p] of Object.entries(s.paid))
  if(!key(id)||!pilot(p?.pilotID)||!key(p?.kind)||
   !Number.isSafeInteger(p?.merit)||p.merit===0)
   throw Error("WAR_MERIT_PAYOUT_CORRUPT");
 return s;
}
function createWarMeritLedger({gameStore,clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  typeof clock!=="function")throw Error("WAR_MERIT_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_MERIT==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const transact=fn=>gameStore.coopAtomicNativeRows.transact([TABLE],fn);
 let busy=false;
 function read(){
  if(!enabled())return {status:"DISABLED"};
  return transact(tx=>structuredClone(validate(tx.get(TABLE,KEY)||empty())));
 }
 // The plain table the command-size rule consumes: pilotID -> real record.
 function records(){
  const state=read();
  return state&&state.records?state.records:{};
 }
 function award({pilotID,kind,count=1,evidenceKey,evidence={}}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!pilot(pilotID)||!key(String(kind||""))||!key(String(evidenceKey||"")))
   return {status:"BLOCKED",reason:"INVALID_MERIT_IDENTITY"};
  const payout=core.meritForEvent(kind,count);
  if(payout.status!=="MERIT")return {status:"BLOCKED",reason:"UNKNOWN_MERIT_EVENT"};
  if(busy)return {status:"BLOCKED",reason:"WAR_MERIT_REENTRANT"};
  busy=true;
  try{
   return transact(tx=>{
    const state=validate(tx.get(TABLE,KEY)||empty());
    const paidKey=String(kind)+":"+String(evidenceKey);
    if(own(state.paid,paidKey)){
     const prior=state.paid[paidKey];
     return prior.pilotID===pilotID&&prior.merit===payout.merit?
      {status:"DUPLICATE",pilotID,kind,merit:prior.merit}:
      {status:"BLOCKED",reason:"WAR_MERIT_REPLAY_CONFLICT"};
    }
    const at=clock();
    if(!pos(at))throw Error("WAR_MERIT_CLOCK_UNSAFE");
    const before=own(state.records,pilotID)?state.records[pilotID]:
     {pilotID,merit:0,rank:core.RANKS[0].rank,history:[]};
    const applied=core.applyEvent(before,kind,{count,nowMs:at});
    if(applied.status==="UNKNOWN_EVENT")
     return {status:"BLOCKED",reason:"UNKNOWN_MERIT_EVENT"};
    const record=applied.record;
    state.records[pilotID]={pilotID,merit:record.merit,rank:record.rank,
     history:Array.isArray(record.history)?record.history.slice(-MAX_HISTORY):[]};
    state.paid[paidKey]={pilotID,kind,merit:payout.merit,at,
     evidence:Object.fromEntries(Object.entries(evidence||{})
      .filter(([,v])=>["string","number","boolean"].includes(typeof v))
      .slice(0,8))};
    validate(state);
    tx.put(TABLE,KEY,state);
    return {
     status:applied.status,
     pilotID,kind,merit:record.merit,
     meritDelta:payout.merit,
     from:applied.from,to:applied.to,
     rank:record.rank,
     command:applied.command,
     hullClassID:applied.hullClassID,
     promoted:applied.status==="PROMOTED",
    };
   });
  }finally{busy=false}
 }
 return Object.freeze({read,records,award});
}
module.exports={TABLE,KEY,empty,validate,createWarMeritLedger,KILL_KIND};
