"use strict";
// FW-009B: military control requires a pre-bound native defender structure,
// verified combat-origin destruction, then sustained uncontested native
// occupancy. Ship losses, empty scenes, elapsed offline time and admin
// destruction never themselves authorize sovereignty changes.
const core=require("./coopFactionWarCore"+(__filename.endsWith(".js")?"":".cjs"));
const {TABLE,KEY:WAR_KEY}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const {KEY:FLEET_KEY,validate:validateFleet}=require("./coopWarFleetRegistry"+
 (__filename.endsWith(".js")?"":".cjs"));
const KEY="coop-faction-war\u001fstructure-objectives-v1";
const POS=x=>Number.isSafeInteger(x)&&x>0;
const VALID=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const position=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k])&&
 Math.abs(p[k])<1e16);
const empty=()=>({version:1,objectives:{},usedStructureIDs:{},captureSeries:{},processed:{},history:[]});
function validate(s){
 if(!s||s.version!==1||!s.objectives||typeof s.objectives!=="object"||
  Array.isArray(s.objectives)||!s.usedStructureIDs||typeof s.usedStructureIDs!=="object"||
  Array.isArray(s.usedStructureIDs)||!s.captureSeries||typeof s.captureSeries!=="object"||
  Array.isArray(s.captureSeries)||!s.processed||typeof s.processed!=="object"||
  Array.isArray(s.processed)||!Array.isArray(s.history)||
  Object.keys(s.objectives).length>128||
  Object.keys(s.usedStructureIDs).length>128||
  Object.keys(s.processed).length>1024||s.history.length>256)
  throw Error("WAR_OBJECTIVE_STATE_UNSUPPORTED");
 for(const [campaignID,o] of Object.entries(s.objectives)){
  if(!VALID(campaignID)||o?.campaignID!==campaignID||!VALID(o.warID)||
   !POS(o.structureID)||!POS(o.systemID)||!POS(o.ownerCorporationID)||
   !POS(o.ownerFactionID)||!POS(o.typeID)||!position(o.position)||
   !POS(o.boundAt)||!["BOUND","NEUTRALIZED","CAPTURED"].includes(o.state)||
   s.usedStructureIDs[String(o.structureID)]!==campaignID||
   (o.state!=="BOUND"&&(!POS(o.destroyedAt)||
    !VALID(o.combatProofID)||o.destroyedAt<o.boundAt)))
   throw Error("WAR_OBJECTIVE_RECORD_CORRUPT");
 }
 for(const [campaignID,v] of Object.entries(s.captureSeries)){
  const obj=s.objectives[campaignID];
  if(!obj||obj.state==="BOUND"||!Number.isSafeInteger(v?.count)||
   v.count<0||v.count>4||!Number.isSafeInteger(v.startedAt)||
   v.startedAt<0||!Number.isSafeInteger(v.lastAt)||v.lastAt<0||
   (v.count>0&&(!POS(v.startedAt)||!POS(v.lastAt)||
    v.lastAt<v.startedAt)))
   throw Error("WAR_OBJECTIVE_OCCUPANCY_CORRUPT");
 }
 return s;
}
function createWarObjectiveAdjudicator({gameStore,getNativeStructure,
 getFactionForCorporation,verifyNativeCombatDestruction=()=>false,
 observeNativeControl=()=>null,clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  [getNativeStructure,getFactionForCorporation,verifyNativeCombatDestruction,
   observeNativeControl,clock].some(fn=>typeof fn!=="function"))
  throw Error("WAR_OBJECTIVE_NATIVE_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_OBJECTIVES==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const txCall=fn=>gameStore.coopAtomicNativeRows.transact([TABLE],fn);
 let busy=false;
 function process(request,kind){
  if(!enabled())return {status:"DISABLED"};
  const {campaignID,eventID}=request||{};
  if(!VALID(campaignID)||!VALID(eventID))
   return {status:"BLOCKED",reason:"WAR_OBJECTIVE_COMMAND_INVALID"};
  if(busy)return {status:"BLOCKED",reason:"WAR_OBJECTIVE_MUTATION_BUSY"};
  busy=true;
  try{return txCall(tx=>{
   const state=validate(tx.get(TABLE,KEY)||empty());
   const sig=JSON.stringify({kind,...request});
   const previous=state.processed[eventID];
   if(previous)return previous.signature===sig?
    {status:"DUPLICATE",receipt:structuredClone(previous.receipt)}:
    {status:"BLOCKED",reason:"OBJECTIVE_EVENT_REPLAY_CONFLICT"};
   if(Object.keys(state.processed).length>=1024||
    state.history.length>=256)
    return {status:"BLOCKED",reason:"OBJECTIVE_EVENT_CAP"};
   const war=tx.get(TABLE,WAR_KEY);
   if(!war)return {status:"BLOCKED",reason:"WAR_STATE_UNAVAILABLE"};
   core.validateState(war);
   const campaign=war.campaigns[campaignID],
    active=campaign&&war.wars[campaign.warID],
    territory=campaign&&war.territories[String(campaign.targetSystemID)];
   if(!campaign||!active||active.state!=="ACTIVE"||
    campaign.state!=="ASSAULT"||
    territory?.state!=="CONTESTED"||
    territory.militaryControllerFactionID!==active.defenderFactionID)
    return {status:"BLOCKED",reason:"NO_NATIVE_CONTESTED_ASSAULT"};
   const now=clock();
   if(!POS(now))throw Error("WAR_OBJECTIVE_CLOCK_INVALID");
   let obj=state.objectives[campaignID],receipt;
   if(kind==="BIND"){
    const id=request.structureID;
    if(obj||!POS(id)||state.usedStructureIDs[String(id)]||
     !POS(request.expectedRevision)||
     request.expectedRevision!==campaign.revision)
     return {status:"BLOCKED",reason:"OBJECTIVE_BIND_NOT_AVAILABLE"};
    let n,faction;
    try{
     n=getNativeStructure(id);
     faction=getFactionForCorporation(n?.ownerCorpID);
    }catch{return {status:"BLOCKED",reason:"OBJECTIVE_NATIVE_STRUCTURE_UNAVAILABLE"}}
    if(n?.structureID!==id||n.solarSystemID!==campaign.targetSystemID||
     !POS(n.ownerCorpID)||faction!==active.defenderFactionID||
     !POS(n.typeID)||!position(n.position)||
     n.destroyedAt!=null||
     n.state===undefined||n.state===null)
     return {status:"BLOCKED",reason:"OBJECTIVE_STRUCTURE_NOT_DEFENDER_NATIVE"};
    obj={campaignID,warID:campaign.warID,structureID:id,
     typeID:n.typeID,systemID:campaign.targetSystemID,
     ownerCorporationID:n.ownerCorpID,ownerFactionID:faction,
     position:{x:n.position.x,y:n.position.y,z:n.position.z},
     boundAt:now,state:"BOUND"};
    state.objectives[campaignID]=obj;
    state.usedStructureIDs[String(id)]=campaignID;
    receipt={kind,structureID:id,systemID:obj.systemID,campaignID};
   }else if(kind==="NEUTRALIZE"){
    if(!obj||obj.state!=="BOUND"||
     !VALID(request.combatProofID)||!POS(request.structureID)||
     request.structureID!==obj.structureID||
     !POS(request.expectedRevision)||
     request.expectedRevision!==campaign.revision)
     return {status:"BLOCKED",reason:"OBJECTIVE_NEUTRALIZATION_NOT_ALLOWED"};
    let n,proof;
    try{
     n=getNativeStructure(obj.structureID);
     proof=verifyNativeCombatDestruction({
      structureID:obj.structureID,systemID:obj.systemID,
      campaignID,warID:campaign.warID,combatProofID:request.combatProofID,
      ownerCorporationID:obj.ownerCorporationID,
      typeID:obj.typeID,boundAt:obj.boundAt,proofTx:tx
     });
    }catch{return {status:"BLOCKED",reason:"NATIVE_STRUCTURE_COMBAT_PROOF_UNAVAILABLE"}}
    if(n?.structureID!==obj.structureID||
     n.solarSystemID!==obj.systemID||
     n.ownerCorpID!==obj.ownerCorporationID||
     n.typeID!==obj.typeID||
     !POS(n.destroyedAt)||n.destroyedAt<obj.boundAt||
     proof!==true)
     return {status:"BLOCKED",reason:"NATIVE_COMBAT_DESTRUCTION_NOT_PROVEN"};
    // Apply objective to authoritative core in the SAME SQLite commit as
    // source-bound objective evidence. Replays cannot increment revision.
    const coreResult=core.transition(war,{
     type:"RECORD_OBJECTIVE",eventID:"fwo:"+eventID,
     campaignID,objectiveID:"structure:"+obj.structureID,
     proofID:request.combatProofID
    },{now,proofs:{objective:({campaign:c,objectiveID,proofID})=>
     c.campaignID===campaignID&&c.revision===campaign.revision&&
     objectiveID==="structure:"+obj.structureID&&
     proofID===request.combatProofID}});
    if(coreResult.status!=="APPLIED")
     return {status:"BLOCKED",reason:coreResult.reason||"FW_OBJECTIVE_CORE_REJECTED"};
    tx.put(TABLE,WAR_KEY,coreResult.state);
    obj.state="NEUTRALIZED";
    obj.destroyedAt=n.destroyedAt;
    obj.combatProofID=request.combatProofID;
    receipt={kind,campaignID,structureID:obj.structureID,
     coreReceipt:coreResult.receipt,revision:coreResult.state.campaigns[campaignID].revision};
   }else if(kind==="SAMPLE"){
    if(!obj||obj.state!=="NEUTRALIZED"||
     !POS(request.expectedRevision)||
     campaign.revision!==request.expectedRevision)
     return {status:"BLOCKED",reason:"OBJECTIVE_NEEDS_COMBAT_NEUTRALIZATION"};
    let n,witness;
    try{
     n=getNativeStructure(obj.structureID);
     const fleet=tx.get(TABLE,FLEET_KEY);
     if(!fleet)return {status:"BLOCKED",reason:"FLEET_STATE_UNAVAILABLE"};
     validateFleet(fleet);
     witness=observeNativeControl({campaignID,warID:campaign.warID,
      structureID:obj.structureID,systemID:obj.systemID,
      position:{...obj.position},attackerFactionID:active.attackerFactionID,
      defenderFactionID:active.defenderFactionID,fleetState:fleet,
      warState:war,
      observationAt:now,objectiveDestroyedAt:obj.destroyedAt});
    }catch{return {status:"BLOCKED",reason:"NATIVE_CONTROL_OBSERVATION_FAILED"}}
    if(n?.structureID!==obj.structureID||n.destroyedAt!==obj.destroyedAt)
     return {status:"BLOCKED",reason:"OBJECTIVE_NATIVE_STRUCTURE_DRIFT"};
    // Presence requires physically loaded native ships in range; missing
    // scene / ambiguous fighter identity is UNKNOWN, not enemy absent.
    const present=witness?.status==="UNCONTESTED_NATIVE_ATTACKER"&&
     witness.systemID===obj.systemID&&
     witness.attackerFactionID===active.attackerFactionID&&
     witness.defenderFactionID===active.defenderFactionID&&
     Number.isSafeInteger(witness.attackerCount)&&witness.attackerCount>0&&
     witness.defenderCount===0&&witness.physicalProof===true;
    const old=state.captureSeries[campaignID]||{count:0,startedAt:0,lastAt:0};
    const gap=now-old.lastAt;
    let next;
    if(!present)next={count:0,startedAt:0,lastAt:0};
    else if(old.count>0&&gap>=20000&&gap<=45000&&
      now-old.startedAt<=3600000)
     next={count:Math.min(4,old.count+1),startedAt:old.startedAt,lastAt:now};
    else if(old.count>0&&gap<20000)
     return {status:"BLOCKED",reason:"OCCUPANCY_SAMPLE_TOO_SOON"};
    else next={count:1,startedAt:now,lastAt:now};
    state.captureSeries[campaignID]=next;
    receipt={kind,campaignID,
     status:present?"NATIVE_UNCONTESTED":"NATIVE_CONTESTED_OR_UNKNOWN",
     consecutiveSamples:next.count,elapsedMs:next.count?now-next.startedAt:0,
     captureReady:next.count===4&&now-next.startedAt>=90000};
   }else if(kind==="CAPTURE"){
    if(!obj||obj.state!=="NEUTRALIZED"||
     !POS(request.expectedRevision)||
     campaign.revision!==request.expectedRevision||
     !VALID(request.captureProofID))
     return {status:"BLOCKED",reason:"CAPTURE_REVISION_OR_OBJECTIVE_INVALID"};
    const series=state.captureSeries[campaignID];
    if(!series||series.count!==4||
     now-series.startedAt<90000||
     now-series.lastAt>45000||now<series.lastAt)
     return {status:"BLOCKED",reason:"CAPTURE_NATIVE_OCCUPANCY_NOT_SUSTAINED"};
    let witness,n;
    try{
     n=getNativeStructure(obj.structureID);
     const fleet=tx.get(TABLE,FLEET_KEY);
     if(!fleet)return {status:"BLOCKED",reason:"FLEET_STATE_UNAVAILABLE"};
     validateFleet(fleet);
     witness=observeNativeControl({campaignID,warID:campaign.warID,
      structureID:obj.structureID,systemID:obj.systemID,
      position:{...obj.position},attackerFactionID:active.attackerFactionID,
      defenderFactionID:active.defenderFactionID,fleetState:fleet,
      warState:war,
      observationAt:now,objectiveDestroyedAt:obj.destroyedAt});
    }catch{return {status:"BLOCKED",reason:"NATIVE_CAPTURE_WITNESS_UNAVAILABLE"}}
    if(n?.structureID!==obj.structureID||n.destroyedAt!==obj.destroyedAt||
     witness?.status!=="UNCONTESTED_NATIVE_ATTACKER"||
     witness.systemID!==obj.systemID||
     witness.attackerFactionID!==active.attackerFactionID||
     witness.defenderFactionID!==active.defenderFactionID||
     !POS(witness.attackerCount)||witness.defenderCount!==0||
     witness.physicalProof!==true)
     return {status:"BLOCKED",reason:"NATIVE_CAPTURE_CURRENT_CONTROL_UNPROVEN"};
    const result=core.transition(war,{
     type:"CAPTURE_TERRITORY",eventID:"fwc:"+eventID,
     campaignID,proofID:request.captureProofID,
    },{now,proofs:{capture:({campaign:c,war:w,territory:t,proofID})=>
     c.campaignID===campaignID&&c.revision===request.expectedRevision&&
     w.warID===campaign.warID&&
     t.revision===territory.revision&&
     t.militaryControllerFactionID===active.defenderFactionID&&
     proofID===request.captureProofID}});
    if(result.status!=="APPLIED")
     return {status:"BLOCKED",reason:result.reason||"NATIVE_CORE_CAPTURE_REJECTED"};
    tx.put(TABLE,WAR_KEY,result.state);
    obj.state="CAPTURED";
    receipt={kind,campaignID,systemID:obj.systemID,
     coreReceipt:result.receipt,revision:result.state.campaigns[campaignID].revision,
     mode:"MILITARY_CONTROL_ONLY_NOT_SDE_SOVEREIGNTY"};
   }else return {status:"BLOCKED",reason:"OBJECTIVE_ACTION_UNKNOWN"};
   state.processed[eventID]={signature:sig,receipt};
   state.history.push({at:now,eventID,...receipt});
   validate(state);
   tx.put(TABLE,KEY,state);
   return {status:"APPLIED",receipt};
  });}finally{busy=false}
 }
 function snapshot({campaignID}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!VALID(campaignID))return {status:"INVALID_CAMPAIGN_ID"};
  return txCall(tx=>{
   const s=validate(tx.get(TABLE,KEY)||empty());
   return {status:"OBSERVED",objective:s.objectives[campaignID]?
    structuredClone(s.objectives[campaignID]):null,
    captureSeries:s.captureSeries[campaignID]?
     structuredClone(s.captureSeries[campaignID]):null};
  });
 }
 return Object.freeze({
  bind:args=>process(args,"BIND"),
  neutralize:args=>process(args,"NEUTRALIZE"),
  sample:args=>process(args,"SAMPLE"),
  capture:args=>process(args,"CAPTURE"),snapshot
 });
}
module.exports={KEY,TABLE,empty,validate,createWarObjectiveAdjudicator};
