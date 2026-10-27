"use strict";
/**
 * CH24+31 D2: explicit operator-authorized NPC employer wage schedule ->
 * native Agent preview -> single real GameStore-funded physical mining shift.
 * A market quote or stock NPC ownership is NOT an NPC hiring price.
 * No source of salary => NO OFFER, never a made-up free miner fleet.
 */
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
function loadCompany(){
 try{return require("./coopPlayerMiningCompany");}
 catch(e){
  if(e?.code!=="MODULE_NOT_FOUND"||
     !String(e.message).includes("Cannot find module './coopPlayerMiningCompany'"))
   throw e;
  return require("./coopPlayerMiningCompany.cjs");
 }
}
const {createPlayerMiningCompany,canonicalFleet}=loadCompany();
const pos=x=>Number.isSafeInteger(x)&&x>0;
const CYCLES=3,PREVIEW_TTL_MS=120000;
function readServerWagePolicy({root,io=fs}={}){
 if(typeof root!=="string"||!path.isAbsolute(root))throw Error("MINING_HIRE_POLICY_ROOT_REQUIRED");
 const file=path.join(root,"coop-npc-mining","wage-policy.json");
 return function getPolicy(employerCorpID){
  if(!pos(employerCorpID))return null;
  let contents;try{contents=io.readFileSync(file,"utf8")}
  catch{return null}
  if(typeof contents!=="string"||Buffer.byteLength(contents)>32768)return null;
  let data;try{data=JSON.parse(contents)}catch{return null}
  if(data?.version!==1||!data.employers||typeof data.employers!=="object"||Array.isArray(data.employers))return null;
  const row=data.employers[String(employerCorpID)];
  if(row?.enabled!==true||!Number.isSafeInteger(row.revision)||row.revision<1||
   !pos(row.minerCycleCents)||!pos(row.haulerCycleCents)||
   row.minerCycleCents>100000000||row.haulerCycleCents>100000000||
   !Number.isSafeInteger(row.maxCycles)||row.maxCycles<CYCLES||row.maxCycles>120)
   return null;
  return {revision:row.revision,minerCycleCents:row.minerCycleCents,
   haulerCycleCents:row.haulerCycleCents,maxCycles:row.maxCycles};
 };
}
function createMiningHiring({gameStore,access,getFleet,verifyNativeFleet,
 isNpcCorporation,getPolicy,clock=()=>Date.now(),enabled=()=>false,observe=()=>{}}={}){
 if(typeof gameStore?.read!=="function"||
  gameStore?.coopAtomicNativeRows?.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof gameStore.coopAtomicNativeRows.transact!=="function"||
  typeof gameStore.coopAtomicNativeRows.isPoisoned!=="function"||
  [access?.isMember,access?.canIndustry,access?.canWallet,getFleet,
   verifyNativeFleet,isNpcCorporation,getPolicy,clock,enabled,observe]
   .some(x=>typeof x!=="function"))
  throw Error("MINING_HIRE_NATIVE_AUTHORITIES_REQUIRED");
 const pinned=new WeakMap();
 function validate({session,agentID,corporationID,employerCorpID,systemID,fleetID}){
  if(enabled()!==true||!session||typeof session!=="object"||
   session.socket?.destroyed===true||!pos(session.characterID)||
   ![agentID,corporationID,employerCorpID,systemID,fleetID].every(pos)||
   corporationID===employerCorpID||
   access.isMember(session,corporationID)!==true||
   access.canIndustry(session,corporationID)!==true||
   access.canWallet(session,corporationID,1000)!==true||
   isNpcCorporation(employerCorpID)!==true)return null;
  const f=getFleet({systemID,fleetID});
  const fleet=canonicalFleet(f,systemID,fleetID,employerCorpID);
  if(!fleet||verifyNativeFleet({...fleet,ownerID:employerCorpID})!==true)return null;
  // Do not advertise a second shift to a fleet bound to any corporation.
  // A corrupt or missing table is not an available slot.
  const indexed=gameStore.read("corporationRuntime",
   "/coopPlayerMiningFleet/"+systemID+":"+fleetID);
  if(indexed?.success===true||indexed?.errorMsg!=="ENTRY_NOT_FOUND")return null;
  const rate=getPolicy(employerCorpID);
  if(!rate||!pos(rate.revision)||
   !pos(rate.minerCycleCents)||!pos(rate.haulerCycleCents)||
   rate.minerCycleCents>100000000||rate.haulerCycleCents>100000000||
   !Number.isSafeInteger(rate.maxCycles)||rate.maxCycles<CYCLES||
   rate.maxCycles>120)return null;
  const wageCents=(fleet.minerIDs.length*rate.minerCycleCents+
   fleet.haulerIDs.length*rate.haulerCycleCents)*CYCLES;
  if(!pos(wageCents)||wageCents>1000000000000)return null;
  const seed=[1,corporationID,employerCorpID,agentID,systemID,fleetID,
   rate.revision,fleet.minerIDs.join("."),fleet.haulerIDs.join("."),
   CYCLES,wageCents].join(":");
  const operationID="coop-mining-shift:"+crypto.createHash("sha256").update(seed).digest("hex").slice(0,32);
  return Object.freeze({version:1,agentID,corporationID,employerCorpID,
   systemID,fleetID,cycles:CYCLES,wageCents,rateRevision:rate.revision,
   minerCount:fleet.minerIDs.length,haulerCount:fleet.haulerIDs.length,
   operationID});
 }
 const key=q=>[q.agentID,q.corporationID,q.employerCorpID,q.systemID,q.fleetID].join(":");
 function preview(args,{view=false}={}){
  let q;
  try{q=validate(args)}catch{return {status:"NATIVE_HIRING_SOURCE_UNAVAILABLE"}}
  if(!q)return {status:"NO_NATIVE_EMPLOYER_OFFER"};
  const now=clock();
  if(!pos(now))return {status:"HIRING_CLOCK_UNAVAILABLE"};
  if(view){
   // Ephemeral confirmation is bound to the SAME authenticated session
   // and exact offer. A server restart intentionally requires reopening.
   pinned.set(args.session,{key:key(q),operationID:q.operationID,createdAt:now,
    expiresAt:now+PREVIEW_TTL_MS});
  }
  return {status:"AVAILABLE",quote:q};
 }
 function accept(args){
  if(gameStore.coopAtomicNativeRows.isPoisoned())
   return {status:"NATIVE_HIRING_GAMESTORE_POISONED"};
  let q;try{q=validate(args)}catch{return {status:"NATIVE_HIRING_SOURCE_UNAVAILABLE"}}
  if(!q)return {status:"NO_NATIVE_EMPLOYER_OFFER"};
  const selected=pinned.get(args.session);
  const now=clock();
  if(!selected||selected.operationID!==q.operationID||selected.key!==key(q)||
   !pos(now)||now<selected.createdAt||now>=selected.expiresAt)
   return {status:"REOPEN_AGENT_TO_CONFIRM_WAGE"};
  // Consume BEFORE calling native GameStore. Unknown commits never produce
  // a second automatic charge; deliberate reopening is still idempotent
  // because the original contract/fleet index and corp wallets are durable.
  pinned.delete(args.session);
  const company=createPlayerMiningCompany({gameStore,access,getFleet,
   verifyNativeFleet,verifyNpcCorporation:(id,row)=>
    id===q.employerCorpID&&row?.corporationID===id&&
    isNpcCorporation(id)===true,
   quoteWage:({corporationID,employerCorpID,fleet,cycles})=>{
    const latest=getPolicy(employerCorpID);
    if(!latest||latest.revision!==q.rateRevision||
     latest.maxCycles<cycles||corporationID!==q.corporationID||
     employerCorpID!==q.employerCorpID||
     fleet.fleetID!==q.fleetID||fleet.systemID!==q.systemID||
     fleet.minerIDs.length!==q.minerCount||
     fleet.haulerIDs.length!==q.haulerCount||cycles!==q.cycles||
     (fleet.minerIDs.length*latest.minerCycleCents+
      fleet.haulerIDs.length*latest.haulerCycleCents)*cycles!==q.wageCents)
     return null;
    return {wageCents:q.wageCents,employerCorpID,fleetID:q.fleetID,cycles};
   },clock,enabled});
  try{
   const result=company.hire({session:args.session,corporationID:q.corporationID,
    employerCorpID:q.employerCorpID,systemID:q.systemID,fleetID:q.fleetID,
    cycles:q.cycles,operationID:q.operationID});
   const outcome={...result,quote:q};
   try{observe("player-mining-hire",{status:result?.status||"UNKNOWN",
    operationID:q.operationID,systemID:q.systemID,fleetID:q.fleetID,
    buyerCorpID:q.corporationID,employerCorpID:q.employerCorpID,
    wageCents:q.wageCents});}catch{}
   return outcome;
  }catch{return {status:"NATIVE_HIRING_OUTCOME_UNKNOWN",operationID:q.operationID};}
 }
 return Object.freeze({preview,accept,mode:"NATIVE_POLICY_SOURCE_REAL_ISK"});
}
let runtime;
function native(){
 if(runtime)return runtime;
 const gameStore=require("../gameStore"),access=require("./coopPlayerCorporationAccess"),
  corp=require("../services/corporation/corporationState"),
  flags=require("./coopFlags"),
  fleet=require("./coopPlayerMiningFleetTick");
 const getFleet=fleet.verified,verifyNativeFleet=f=>{
  const now=fleet.verified(f);
  return now&&now.ownerID===f.ownerID&&
   JSON.stringify(now.minerIDs)===JSON.stringify(f.minerIDs)&&
   JSON.stringify(now.haulerIDs)===JSON.stringify(f.haulerIDs);
 };
 runtime=createMiningHiring({gameStore,access,getFleet,verifyNativeFleet,
  isNpcCorporation:id=>corp.isNpcCorporationID(id)===true&&
   corp.getCorporationRecord(id)?.isNPC===true,
  getPolicy:readServerWagePolicy({root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs"}),
  enabled:()=>flags.on("EVEJS_COOP_PLAYER_NPC_MINING_HIRING")&&
   flags.on("EVEJS_COOP_PLAYER_NPC_MINING_COMPANY")&&
   flags.on("EVEJS_COOP_NATIVE_ATOMIC_ROWS"),
  observe:(event,payload)=>{
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    event,{systemID:payload.systemID},payload);
  }});
 return runtime;
}
function preview(args,options){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_HIRING!=="1")return {status:"DISABLED"};
 try{return native().preview(args,options)}catch{return {status:"NATIVE_HIRING_SOURCE_UNAVAILABLE"}}
}
function accept(args){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_HIRING!=="1")return {status:"DISABLED"};
 try{return native().accept(args)}catch{return {status:"NATIVE_HIRING_SOURCE_UNAVAILABLE"}}
}
module.exports={createMiningHiring,readServerWagePolicy,preview,accept};
