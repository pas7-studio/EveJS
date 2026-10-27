"use strict";
// Native order guard: exact named pilot+physical hull+controller proof.
// Deliberately no hardcoded EveJS access or global singleton in this module.
const pos = x => Number.isSafeInteger(Number(x)) && Number(x)>0 ? Number(x) : null;
const named = x => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);
const PEACEFUL = new Set(["PATROL","CIVILIAN","GATE","EXPEDITION"]);
function createOrderBridge({arbiter, assignments, sceneForSystem, getController,
 warShipClaim=null}={}) {
 if(warShipClaim!==null&&typeof warShipClaim!=="function")throw Error("WAR_SHIP_CLAIM_AUTHORITY_INVALID");
 if(!arbiter?.issue || !arbiter?.blocksForSystem || !arbiter?.blocked ||
    !arbiter?.retainWithNativeProof || !arbiter?.snapshot ||
    [assignments,sceneForSystem,getController].some(x=>typeof x!=="function"))
   throw Error("NATIVE_ORDER_BRIDGE_DEPENDENCIES");
 function uniqueAssignment(entityID,requestedSystemID=null) {
  if(!pos(entityID))return null;
  let raw;
  try{raw=assignments();}catch(_error){return null;}
  if(!Array.isArray(raw))return null;
  const all=raw.filter(x=>named(x?.pilotID)&&pos(x?.entityID)&&pos(x?.systemID));
  // Disagreeing registry and bridge links, or a single pilot linked to two
  // native ships, are ambiguous: do not issue an order.
  const matching=all.filter(x=>Number(x.entityID)===Number(entityID));
  if(!matching.length)return null;
  const signatures=new Set(matching.map(x=>x.pilotID+":"+x.systemID+":"+x.entityID));
  if(signatures.size!==1)return null;
  const link=matching[0];
  if(requestedSystemID!=null && Number(requestedSystemID)!==Number(link.systemID))return null;
  if(all.some(x=>x.pilotID===link.pilotID&&
    (Number(x.entityID)!==Number(link.entityID)||Number(x.systemID)!==Number(link.systemID))))return null;
  return {pilotID:link.pilotID,entityID:Number(link.entityID),systemID:Number(link.systemID)};
 }
 function nativeState(link) {
  try {
   const scene=sceneForSystem(link.systemID);
   if(Number(scene?.systemID)!==link.systemID)return null;
   const entity=scene?.getEntityByID?.(link.entityID);
   if(entity?.kind!=="ship"||entity.nativeNpc!==true||
      Number(entity.itemID)!==link.entityID||entity.session?.characterID)return null;
   const controller=getController(link.entityID);
   if(Number(controller?.entityID)!==link.entityID||
      Number(controller?.systemID)!==link.systemID||
      uniqueAssignment(link.entityID,link.systemID)?.pilotID!==link.pilotID)return null;
   const mode=String(entity.mode||"").toUpperCase();
   const warp=mode==="WARP"||Boolean(entity.pendingWarp)||
      Boolean(entity.warpState)||entity.isWarping===true;
   // npcRuntime.orbit/follow use scene movement APIs without manualOrder.
   const movementBusy=["ORBIT","FOLLOW","GOTO","ALIGN","APPROACH"].includes(mode);
   const manual=controller.manualOrder;
   const manualType=typeof manual?.type==="string"?manual.type.toLowerCase():"";
   const manualBusy=manual!=null&&manualType!=="resumebehavior";
   // Native orbit/follow manual orders can set currentTargetID without attack.
   const combat=manualType==="attack"||manualType==="holdfire"||
      (!manualType&&Number(controller.currentTargetID)>0);
   return {warp,movementBusy,manualBusy,combat};
  }catch(_error){return null;}
 }
 function retain(link,state){
  if(!state)return;
  const record=arbiter.snapshot().leases.find(x=>x.systemID===link.systemID&&
   x.entityID===link.entityID&&x.pilotID===link.pilotID);
  if(record)arbiter.retainWithNativeProof({...link,owner:record.owner,
   nativeBusy:state.warp||state.movementBusy||state.manualBusy});
 }
 function nativePermits(link,owner,action) {
  const state=nativeState(link);
  if(!state)return {success:false,errorMsg:"COOP_NPC_ORDER_NATIVE_PROOF_MISSING"};
  retain(link,state);
  // WAR can only command an exclusively registered real native ship.
  // Existing directors cannot retask a reserved warship after a lease TTL.
  // Unknown durable registry state fails closed until operator repairs it.
  let warClaim="UNASSIGNED";
  if(warShipClaim)try{warClaim=warShipClaim(link)}catch{warClaim="UNKNOWN"}
  if(owner==="WAR"&&(!warShipClaim||warClaim!=="ASSIGNED"))
   return {success:false,errorMsg:"COOP_NPC_ORDER_WAR_SHIP_UNVERIFIED"};
  if(warShipClaim&&owner!=="WAR"&&owner!=="TACTICS"&&
     (warClaim==="ASSIGNED"||warClaim==="UNKNOWN"))
   return {success:false,errorMsg:"COOP_NPC_ORDER_WAR_SHIP_RESERVED"};
  if(warShipClaim&&!["UNASSIGNED","ASSIGNED","UNKNOWN"].includes(warClaim))
   return {success:false,errorMsg:"COOP_NPC_ORDER_WAR_REGISTRY_INVALID"};
  // Even emergency tactics cannot override an in-flight native Destiny warp.
  if(state.warp)return {success:false,errorMsg:"COOP_NPC_ORDER_NATIVE_WARP_ACTIVE"};
  if(state.combat&&PEACEFUL.has(owner))
   return {success:false,errorMsg:"COOP_NPC_ORDER_NATIVE_COMBAT_ACTIVE"};
  const lease=arbiter.snapshot().leases.find(x=>x.systemID===link.systemID&&
   x.entityID===link.entityID&&x.pilotID===link.pilotID);
  // A registered war hull is exclusively reserved for WAR. Its own patrol
  // movement (GOTO/ORBIT/FOLLOW with no manual order) is not another owner's
  // command: refusing it left the defender unable to receive an attack order
  // because the lease is only created by a successful issue. A manual combat
  // order from an unknown owner is still never hijacked.
  const warOwnsItsPatrol=owner==="WAR"&&warClaim==="ASSIGNED"&&!state.manualBusy;
  // A persisted/stock manual command without a live matching arbiter owner
  // cannot be silently claimed by a new route, gate or raiding planner.
  if((state.manualBusy||state.movementBusy)&&owner!=="TACTICS"&&
   (!lease||lease.owner!==owner)&&!warOwnsItsPatrol)
   return {success:false,errorMsg:"COOP_NPC_ORDER_NATIVE_COMMAND_ACTIVE"};
  if(state.combat&&(owner==="RAID"||owner==="WAR")&&
   (!lease||lease.owner!==owner)&&!warOwnsItsPatrol)
   return {success:false,errorMsg:"COOP_NPC_ORDER_NATIVE_COMBAT_ACTIVE"};
  return {success:true};
 }
 function issue({entityID,systemID,owner,action,execute,holdMs}={}){
  const link=uniqueAssignment(entityID,systemID);
  if(!link)return {success:false,errorMsg:"COOP_NPC_ORDER_IDENTITY_UNVERIFIED"};
  const permission=nativePermits(link,owner,action);
  if(!permission.success)return permission;
  return arbiter.issue({...link,owner,action,execute,holdMs,
   verify:()=>nativePermits(link,owner,action).success});
 }
 function blocked({entityID,systemID,owner}={}){
  const link=uniqueAssignment(entityID,systemID);
  if(!link)return true;
  return !nativePermits(link,owner).success||arbiter.blocked({...link,owner});
 }
 // Read-only: why an order would be refused, with the exact first blocker.
 // Never issues, never retains a lease - the caller only observes.
 function diagnose({entityID,systemID,owner="RAID"}={}){
  const link=uniqueAssignment(entityID,systemID);
  if(!link)return {status:"BLOCKED",reason:"COOP_NPC_ORDER_IDENTITY_UNVERIFIED"};
  const state=nativeState(link);
  if(!state)return {status:"BLOCKED",reason:"COOP_NPC_ORDER_NATIVE_PROOF_MISSING"};
  let warClaim="UNASSIGNED";
  if(warShipClaim)try{warClaim=warShipClaim(link)}catch{warClaim="UNKNOWN"}
  const lease=arbiter.snapshot().leases.find(x=>x.systemID===link.systemID&&
   x.entityID===link.entityID&&x.pilotID===link.pilotID);
  const warOwnsItsPatrol=owner==="WAR"&&warClaim==="ASSIGNED"&&!state.manualBusy;
  const reason=state.warp?"COOP_NPC_ORDER_NATIVE_WARP_ACTIVE":
   (state.combat&&PEACEFUL.has(owner))?"COOP_NPC_ORDER_NATIVE_COMBAT_ACTIVE":
   ((state.manualBusy||state.movementBusy)&&owner!=="TACTICS"&&
    (!lease||lease.owner!==owner)&&!warOwnsItsPatrol)?"COOP_NPC_ORDER_NATIVE_COMMAND_ACTIVE":
   (owner==="WAR"&&(!warShipClaim||warClaim!=="ASSIGNED"))?"COOP_NPC_ORDER_WAR_SHIP_UNVERIFIED":
   (warShipClaim&&owner!=="WAR"&&owner!=="TACTICS"&&
    (warClaim==="ASSIGNED"||warClaim==="UNKNOWN"))?"COOP_NPC_ORDER_WAR_SHIP_RESERVED":
   (state.combat&&(owner==="RAID"||owner==="WAR")&&
    (!lease||lease.owner!==owner)&&!warOwnsItsPatrol)?
    "COOP_NPC_ORDER_NATIVE_COMBAT_ACTIVE":
   arbiter.blocked({...link,owner})?"COOP_NPC_ORDER_ARBITER_BLOCKED":"";
  return reason?{status:"BLOCKED",reason,warClaim,state,leaseOwner:String(lease?.owner||"")}:
   {status:"PERMITTED",warClaim,state,leaseOwner:String(lease?.owner||"")};
 }
 function blocksForSystem(systemID,owner){
  const ids=new Set();
  let links=[];
  try {links=assignments();}catch(_error){return ids;}
  if(!Array.isArray(links))return ids;
  for(const entry of links){
   if(Number(entry?.systemID)!==Number(systemID)||!pos(entry?.entityID))continue;
   const link=uniqueAssignment(entry.entityID,systemID);
   if(!link||!nativePermits(link,owner).success||arbiter.blocked({...link,owner}))
    ids.add(Number(entry.entityID));
  }
  for(const entityID of arbiter.blocksForSystem(systemID,owner))ids.add(entityID);
  return ids;
 }
 function snapshot(){return arbiter.snapshot();}
 return {issue,blocked,blocksForSystem,snapshot,diagnose};
}
module.exports={createOrderBridge};
