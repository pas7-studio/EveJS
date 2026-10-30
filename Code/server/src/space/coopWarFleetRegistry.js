"use strict";
// FW-003: durable exclusive native ship assignment, NOT a ship factory.
// One SQLite atomic row in the same authoritative GameStore as FW-001.
const TABLE="corporationRuntime",KEY="coop-faction-war\u001ffleet-registry-v1",VERSION=1;
const {readRow}=require("./coopNativeRowPath"+
 (typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
const valid=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const pilot=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const empty=()=>({version:VERSION,ships:{},processed:{},history:[]});
function validate(s){
 if(!s||s.version!==VERSION||!s.ships||typeof s.ships!=="object"||
  Array.isArray(s.ships)||!s.processed||typeof s.processed!=="object"||
  Array.isArray(s.processed)||!Array.isArray(s.history)||
  Object.keys(s.ships).length>256||Object.keys(s.processed).length>2048||
  s.history.length>128||
  (s.transfers!==undefined&&(!s.transfers||
   typeof s.transfers!=="object"||Array.isArray(s.transfers)||
   Object.keys(s.transfers).length>128))||
  (s.recoveryAudit!==undefined&&(!Array.isArray(s.recoveryAudit)||
   s.recoveryAudit.length>128))||
  (s.transferHistory!==undefined&&(!Array.isArray(s.transferHistory)||
   s.transferHistory.length>512))||
  (s.nextTransferSerial!==undefined&&(!Number.isSafeInteger(s.nextTransferSerial)||
   s.nextTransferSerial<1||s.nextTransferSerial>Number.MAX_SAFE_INTEGER-1)))
  throw Error("FW_FLEET_REGISTRY_INVALID");
 const pilots=new Set();
 for(const [key,v] of Object.entries(s.ships)){
  if(!pos(Number(key))||String(Number(key))!==key||!pos(v?.entityID)||
   String(v.entityID)!==key||!pos(v.systemID)||!pos(v.corporationID)||
   !pos(v.factionID)||!valid(v.fleetID)||!valid(v.warID)||
   !valid(v.campaignID)||!pilot(v.pilotID)||pilots.has(v.pilotID))
    throw Error("FW_FLEET_REGISTRY_CORRUPT_SHIP");
  pilots.add(v.pilotID);
 }
 // Closed flights remain immutable history after native custody was
 // verified. History is not an authorization to materialize or jump a ship.
 const seenFlights=new Set();
 for(const h of s.transferHistory||[]){
  if(!h||!valid(h.transferID)||!pos(h.entityID)||
   !pilot(h.pilotID)||!pos(h.sourceSystemID)||
   !pos(h.destinationSystemID)||h.sourceSystemID===h.destinationSystemID||
   !["COMPLETE","ABORTED"].includes(h.phase)||
   !/^[a-f0-9]{64}$/.test(h.modulesHash)||
   !/^[a-f0-9]{64}$/.test(h.cargoHash)||
   !pos(h.retiredAt)||seenFlights.has(h.transferID))
   throw Error("FW_FLEET_TRANSFER_HISTORY_CORRUPT");
  seenFlights.add(h.transferID);
 }
 for(const [shipID,t] of Object.entries(s.transfers||{})){
  const hull=s.ships[shipID];
  if(!hull||String(t?.entityID)!==shipID||
   hull.pilotID!==t.pilotID||hull.warID!==t.warID||
   hull.campaignID!==t.campaignID||
   !["PREPARED","NATIVE_COMMITTED","COMPLETE","ABORTED"].includes(t.phase)||
   seenFlights.has(t.transferID)||
   !Number.isSafeInteger(t.sourceSystemID)||t.sourceSystemID<=0||
   !Number.isSafeInteger(t.destinationSystemID)||t.destinationSystemID<=0||
   t.sourceSystemID===t.destinationSystemID||
   (t.phase==="PREPARED"||t.phase==="ABORTED"
    ?hull.systemID!==t.sourceSystemID
    :hull.systemID!==t.destinationSystemID))
   throw Error("FW_FLEET_TRANSFER_LEDGER_CORRUPT");
 }
 return s;
}
function createWarFleetRegistry({gameStore,verifyNativeShip,verifyCampaign,
 verifyRelease,verifyReplacement=null,verifyDemobOrderIdle=()=>false,
 clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  [verifyNativeShip,verifyCampaign,verifyRelease,verifyDemobOrderIdle,clock]
   .some(x=>typeof x!=="function"))
   throw Error("FW_FLEET_NATIVE_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const transact=fn=>gameStore.coopAtomicNativeRows.transact([TABLE],fn);
 let inWrite=false;
 function snapshot(){
  if(!enabled())return {status:"DISABLED"};
  return transact(tx=>structuredClone(validate(tx.get(TABLE,KEY)||empty())));
 }
 function claim(link){
  if(!enabled())return "DISABLED";
  try{
   // Hot A-Life arbiter path: use the GameStore cache, not a new SQLite
   // BEGIN IMMEDIATE for each visible NPC. Native atomic writes refresh it.
   let state;
   if(typeof gameStore.read==="function"){
    const row=readRow(gameStore,TABLE,KEY);
    state=row?validate(row):empty();
   }else state=snapshot(); // only injectable offline fixtures
   const v=state.ships[String(link?.entityID)];
   if(!v)return "UNASSIGNED";
   // A physically moving ship is quarantined until native destination,
   // persistent identity file and SQL fleet custody all agree.
   const flight=state.transfers?.[String(link.entityID)];
   if(flight&&!["COMPLETE","ABORTED"].includes(flight.phase))
    return "UNKNOWN";
   return v.entityID===link.entityID&&v.pilotID===link.pilotID&&
    v.systemID===link.systemID?"ASSIGNED":"UNKNOWN";
  }catch{return "UNKNOWN"}
 }
 function execute(command){
  if(!enabled())return {status:"DISABLED"};
  if(inWrite)return {status:"BLOCKED",reason:"FW_FLEET_REENTRANT"};
  if(!command||!valid(command.eventID)||
   !["ASSIGN","RELEASE","DEMOBILIZE"].includes(command.type))
   return {status:"BLOCKED",reason:"INVALID_COMMAND"};
  inWrite=true;
  try{
   return transact(tx=>{
    const s=validate(tx.get(TABLE,KEY)||empty());
    const signature=JSON.stringify(command),prior=own(s.processed,command.eventID)?
     s.processed[command.eventID]:null;
    if(prior)return prior.signature===signature?{status:"DUPLICATE",receipt:prior.receipt}:
     {status:"BLOCKED",reason:"EVENT_REPLAY_CONFLICT"};
    if(Object.keys(s.processed).length>=2048)return {status:"BLOCKED",reason:"FLEET_EVENT_CAP"};
    const id=String(command.entityID),priorShip=s.ships[id];
    let receipt;
    if(command.type==="ASSIGN"){
     const {entityID,systemID,pilotID,corporationID,factionID,fleetID,warID,campaignID,proofID}=command;
     if(!pos(entityID)||!pos(systemID)||!pilot(pilotID)||!pos(corporationID)||
      !pos(factionID)||!valid(fleetID)||!valid(warID)||!valid(campaignID)||
      !valid(proofID)||priorShip||
      Object.values(s.ships).some(v=>v.pilotID===pilotID)||
      Object.keys(s.ships).length>=256)return {status:"BLOCKED",reason:"FLEET_IDENTITY_OR_CAP_CONFLICT"};
     const details={entityID,systemID,pilotID,corporationID,factionID,fleetID,warID,campaignID,proofID};
     let ok=false;try{ok=verifyNativeShip(details)===true&&verifyCampaign(details,tx)===true}catch{}
     if(!ok)return {status:"BLOCKED",reason:"NATIVE_SHIP_OR_CAMPAIGN_UNVERIFIED"};
     s.ships[id]={...details,assignedAt:clock()};
     receipt={type:"ASSIGN",entityID,pilotID,systemID,fleetID,warID,campaignID};
    }else if(command.type==="DEMOBILIZE"){
     // Terminal campaign and physical ship must be proved against the
     // SAME SQLite snapshot in which exclusive fleet custody is released.
     // A caller cannot force this with a chat-supplied proofID or a stale
     // read of ACTIVE/PREPARING/ASSAULT.
     if(env.EVEJS_COOP_FACTION_WAR_DEMOBILIZE!=="1")
      return {status:"DISABLED"};
     if(!priorShip||!pos(command.entityID)||
      command.entityID!==priorShip.entityID||
      command.pilotID!==priorShip.pilotID||
      command.fleetID!==priorShip.fleetID||
      command.campaignID!==priorShip.campaignID||
      command.warID!==priorShip.warID||
      command.systemID!==priorShip.systemID||
      !pos(command.campaignRevision)||!valid(command.proofID)||
      command.proofID!=="native-demob:"+command.campaignID+":"+command.entityID)
      return {status:"BLOCKED",reason:"WAR_DEMOB_IDENTITY_OR_PROOF_INVALID"};
     if(s.transfers?.[id])
      return {status:"BLOCKED",reason:"WAR_DEMOB_TRANSFER_NOT_RETIRED"};
     const warRecord=tx.get(TABLE,"coop-faction-war\u001fstate-v1");
     const campaign=warRecord?.campaigns?.[command.campaignID],
      war=warRecord?.wars?.[command.warID];
     if(warRecord?.version!==1||!campaign||!war||
      campaign.warID!==command.warID||
      campaign.revision!==command.campaignRevision||
      !["OCCUPIED","CANCELLED"].includes(campaign.state)||
      !["ACTIVE","ENDED"].includes(war.state)||
      (campaign.state==="CANCELLED"&&war.state!=="ENDED")||
      ![war.attackerFactionID,war.defenderFactionID].includes(priorShip.factionID))
      return {status:"BLOCKED",reason:"WAR_CAMPAIGN_NOT_TERMINAL"};
     let nativeOK=false;
     try{
      nativeOK=verifyNativeShip({...priorShip,proofID:command.proofID})===true&&
       verifyRelease({...priorShip,proofID:command.proofID})===true&&
       verifyDemobOrderIdle({...priorShip,proofID:command.proofID})===true;
     }catch{}
     if(!nativeOK)return {status:"BLOCKED",reason:"WAR_DEMOB_NATIVE_HULL_BUSY_OR_UNVERIFIED"};
     delete s.ships[id];
     receipt={type:"DEMOBILIZE",entityID:priorShip.entityID,
      pilotID:priorShip.pilotID,systemID:priorShip.systemID,
      fleetID:priorShip.fleetID,campaignID:priorShip.campaignID,
      campaignRevision:campaign.revision,warID:priorShip.warID,
      nativeShipPreserved:true};
    }else{
     // Even a COMPLETE transfer remains forensic evidence. The native
     // transfer ledger must first retire it after verifying journal
     // cleanup, both physical scenes and the exact pilot/cargo signature.
     if(s.transfers?.[id])
      return {status:"BLOCKED",reason:"WAR_HULL_TRANSFER_REQUIRES_VERIFIED_RETIREMENT"};
     if(!priorShip||!valid(command.proofID)||command.pilotID!==priorShip.pilotID||
      command.fleetID!==priorShip.fleetID)return {status:"BLOCKED",reason:"SHIP_NOT_IN_FLEET"};
     let ok=false;try{ok=verifyRelease({...priorShip,proofID:command.proofID})===true}catch{}
     // FW-110: a hull the pilot provably no longer flies may leave custody even though it is
     // neither present nor destroyed - the pilot has exactly one other REAL ship, which is
     // stronger evidence than absence. The proof string is exact, so a caller cannot ask for
     // a replacement it did not name.
     let replaced=false;
     if(!ok&&typeof verifyReplacement==="function"&&pos(command.currentEntityID)){
      const want="native-replaced:"+priorShip.campaignID+":"+priorShip.entityID+":"+
       Number(command.currentEntityID);
      if(command.proofID===want){
       try{
        replaced=verifyReplacement({...priorShip,currentEntityID:Number(command.currentEntityID),
         proofID:command.proofID})===true;
       }catch{replaced=false}
      }
     }
     if(!ok&&!replaced)return {status:"BLOCKED",reason:"NATIVE_RELEASE_UNVERIFIED"};
     delete s.ships[id];
     receipt={type:"RELEASE",entityID:priorShip.entityID,fleetID:priorShip.fleetID,
      ...(replaced?{custodyReplaced:true,currentEntityID:Number(command.currentEntityID)}:{})};
    }
    const at=clock();
    if(!pos(at))throw Error("FW_FLEET_CLOCK_INVALID");
    s.processed[command.eventID]={signature,receipt};
    s.history.push({eventID:command.eventID,at,...receipt});
    if(s.history.length>128)s.history.splice(0,s.history.length-128);
    validate(s);tx.put(TABLE,KEY,s);
    return {status:"APPLIED",receipt};
   });
  }finally{inWrite=false}
 }
 return Object.freeze({snapshot,claim,execute});
}
module.exports={TABLE,KEY,empty,validate,createWarFleetRegistry};
