"use strict";
// P1: stock EveJS NPC movement/behavior only. No fake ship control or ISK.
const {createTactics}=require("./coopEscortNativeTactics");
const pos=x=>Number.isSafeInteger(x)&&x>0;
function createNativeTacticalGame({readEvent,readVolunteer,readFlight,readManifest,
 getScene,getSessions,fleetRuntime,npcRuntime,npcService,clock=()=>Date.now()}={}){
 if([readEvent,readVolunteer,readFlight,readManifest,getScene,getSessions,clock]
   .some(f=>typeof f!=="function")||
   !fleetRuntime||typeof fleetRuntime.getFleetForCharacter!=="function"||
   typeof fleetRuntime.getMemberRecord!=="function"||
   !npcRuntime||["stop","resumeBehavior","issueOrder","resolveNpcContext"]
    .some(k=>typeof npcRuntime[k]!=="function")||
   !npcService||typeof npcService.getControllerByEntityID!=="function")
  throw Error("ESCORT_NATIVE_CONTROLLER_SOURCES_REQUIRED");
 function readRoute(eventID){
  const e=readEvent(eventID);
  if(e?.status!=="READY"||e.event?.type!=="CONVOY"||
   e.event.stage!=="PREPARING"||
   e.event.phase!=="RESOLVED"||e.event.outcome!=="DEPARTED"||
   typeof e.event.linkedTripID!=="string")
   return {status:"NATIVE_CONVOY_ROUTE_NOT_DEPARTED"};
  const id=e.event.linkedTripID;
  const f=readFlight(id),b=f?.booking,m=readManifest(id);
  if(f?.status!=="READY"||f.phase!=="FUNDED"||!b||
   m?.status!=="READY"||m.record?.key!==id||
   !Array.isArray(m.record?.cargo)||!m.record.cargo.length||
   m.record.cargo.some(x=>!pos(x.cargoID))||
   b.manifestKey!==id||e.event.entityID!==b.haulerID||
   e.event.systemID!==b.systemID||
   e.event.stationID!==b.stationID||
   eventID!=="convoy-"+b.systemID+"-"+b.fleetID+"-"+
    Math.min(...m.record.cargo.map(x=>x.cargoID))||
   !pos(b.playerFleetID)||!pos(b.haulerID))
   return {status:"NATIVE_CONVOY_ROUTE_NOT_FUNDED"};
  return {status:"NATIVE_CONVOY_EN_ROUTE",eventID,
   fleetID:b.fleetID,playerFleetID:b.playerFleetID,
   systemID:b.systemID,entityID:b.haulerID,
   stationID:b.stationID,contractID:b.contractID};
 }
 function authorized({session,volunteers,route}){
  const chars=volunteers?.pilots?.map(x=>x.characterID);
  // The first of two authenticated voluntary participants commands this NPC;
  // another player cannot impersonate a commander through /events.
  if(!Array.isArray(chars)||chars.length!==2||
   chars[0]>=chars[1]||session?.characterID!==chars[0]||
   volunteers.fleetID!==route.playerFleetID)
   return {status:"NOT_AUTHORIZED"};
  let online,fleet;
  try{online=getSessions();fleet=fleetRuntime.getFleetForCharacter(chars[0])}
  catch{return {status:"NATIVE_FLEET_UNAVAILABLE"}}
  if(!Array.isArray(online)||fleet?.fleetID!==route.playerFleetID||
   !fleet.members||fleet.members.size!==2||
   chars.some(c=>!fleet.members.has(c)||
    !fleetRuntime.getMemberRecord(fleet,c)||
    online.filter(s=>s?.characterID===c&&
     s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
     s._space.systemID===route.systemID&&
     s._space.shipID===volunteers.pilots.find(p=>p.characterID===c).shipID
    ).length!==1))
   return {status:"NATIVE_FLEET_NOT_LIVE"};
  return {status:"AUTHORIZED_NATIVE_CONVOY_COMMANDER",
   characterID:session.characterID,fleetID:fleet.fleetID};
 }
 const tactics=createTactics({
  readVolunteers:readVolunteer,
  readRoute,
  getScene,
  authorizeCommander:authorized,
  clock,
  issueNativeCommand:({shipID,systemID,mode})=>{
   const ctx=npcRuntime.resolveNpcContext(shipID);
   const controller=npcService.getControllerByEntityID(shipID);
   if(ctx?.success!==true||ctx.data?.systemID!==systemID||
    controller?.entityID!==shipID||controller.systemID!==systemID)
    return {status:"NATIVE_CONTROLLER_MISSING"};
   let native;
   if(mode==="HOLD")native=npcRuntime.stop(shipID,{
    reason:"escortPlayerHold",allowSessionlessWarpAbort:true});
   else if(mode==="CONTINUE")native=npcRuntime.resumeBehavior(shipID);
   else native=npcRuntime.issueOrder(shipID,{type:"returnHome"});
   if(native?.success!==true)return {status:"NATIVE_MOVEMENT_ORDER_FAILED"};
   return {status:"NATIVE_COMMAND_ACCEPTED",entityID:shipID};
  },
  observeNativeCommand:({scene,shipID,mode})=>{
   const ship=scene.getEntityByID(shipID);
   const ctrl=npcService.getControllerByEntityID(shipID);
   if(!ship||ctrl?.entityID!==shipID||ctrl.systemID!==scene.systemID)
    return {status:"CONTROLLER_NOT_OBSERVED"};
   const order=ctrl.manualOrder?.type||null;
   const verified=mode==="HOLD"?order==="stop"&&ship.mode==="STOP":
    mode==="CONTINUE"?order===null:order==="returnHome";
   return {status:verified?"NATIVE_COMMAND_APPLIED":"NATIVE_COMMAND_NOT_OBSERVED",
    entityID:shipID,mode};
  }
 });
 return {command:tactics.command,readRoute};
}
let instance=null;
function commandInGame(session,eventID,mode){
 if(process.env.EVEJS_COOP_ESCORT_TACTICS!=="1")
  return {status:"DISABLED"};
 try{
  if(!instance){
   const board=require("./coopWorldOpportunityBoard");
   const binding=require("./coopEscortNativeBinding").routeGate();
   const runtime=require("./runtime");
   instance=createNativeTacticalGame({
    readEvent:id=>board.readNativeEvent(id),
    readVolunteer:id=>require("./coopEscortVolunteers").readVerifiedNativePair(id),
    readFlight:key=>binding.readFlight?.(key)||
      {status:"NATIVE_FLIGHT_AUTHORITY_UNAVAILABLE"},
    readManifest:key=>require("./coopNativeHaulManifest").createManifest({
     root:process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
      "/var/lib/evejs/coop-native-warehouse",
     store:require("./npc/nativeNpcStore"),
     items:require("../services/inventory/itemStore"),
     getNativeEntity:require("./npc/nativeNpcStore").getNativeEntity
    }).read(key),
    getScene:session=>runtime.getSceneForSession(session),
    getSessions:()=>require("../services/chat/sessionRegistry").getSessions(),
    fleetRuntime:require("../services/fleets/fleetRuntime"),
    npcRuntime:require("./npc/npcRuntime"),
    npcService:require("./npc/npcService")
   });
  }
  return instance.command({session,eventID,mode});
 }catch{return {status:"NATIVE_TACTICAL_DISPATCH_UNAVAILABLE"}}
}
module.exports={createNativeTacticalGame,commandInGame};
