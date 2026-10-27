"use strict";
// Native Ballpark membership is necessary, but by itself cannot authorize an
// account or its current ship. All checks are read-only and fail closed.
const scheduled=new WeakMap();
const positive=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null;};
const live=session=>Boolean(session?.socket&&session.socket.destroyed!==true);
function admission(session,ship,getSceneForSession,authority=null){
 const characterID=positive(session?.characterID),shipID=positive(ship?.itemID),
  systemID=positive(session?._space?.systemID);
 if(!characterID||!shipID||!systemID||!live(session))return {status:"STALE_SESSION"};
 if(session._space.initialStateSent!==true)return {status:"PENDING_BALLPARK"};
 if(positive(session._space.shipID)!==shipID||
  positive(ship?.spaceState?.systemID||systemID)!==systemID||
  (positive(session.shipID??session.shipid)&&positive(session.shipID??session.shipid)!==shipID))
  return {status:"REPLACED_OR_WRONG_SYSTEM_SHIP"};
 let scene;
 try{scene=getSceneForSession(session);}catch{return {status:"SCENE_UNAVAILABLE"};}
 if(!scene||positive(scene.systemID)!==systemID||
  typeof scene.getEntityByID!=="function"||
  typeof scene.sessions?.values!=="function")return {status:"SCENE_UNAVAILABLE"};
 const sessions=[...scene.sessions.values()];
 if(!sessions.includes(session))return {status:"SESSION_NOT_IN_NATIVE_SCENE"};
 const active=sessions.filter(s=>positive(s?.characterID)===characterID&&
  s?._space?.initialStateSent===true&&live(s));
 if(active.length!==1)return {status:"AMBIGUOUS_NATIVE_CHARACTER_SESSION"};
 if(sessions.some(s=>s!==session&&positive(s?._space?.shipID)===shipID&&
  s?._space?.initialStateSent===true&&live(s)))
  return {status:"AMBIGUOUS_NATIVE_SHIP_OWNER"};
 const physical=scene.getEntityByID(shipID);
 if(!physical||physical.kind!=="ship"||positive(physical.itemID)!==shipID)
  return {status:"NATIVE_HULL_NOT_READY"};
 const owner=positive(physical.pilotCharacterID??physical.characterID);
 if(owner&&owner!==characterID)return {status:"WRONG_PHYSICAL_PILOT"};
 if(physical.session&&physical.session!==session)
  return {status:"WRONG_PHYSICAL_SESSION"};
 // The live native caller supplies these native lookups; never use a shadow
 // account, ship or session store. Pure scene tests can omit authority.
 if(authority!==null){
  if(typeof authority.getSessions!=="function"||
   typeof authority.getCharacterRecord!=="function"||
   typeof authority.getActiveShipRecord!=="function")
   return {status:"AUTHORITY_UNAVAILABLE"};
  let registered,record,activeShip;
  try{
   registered=authority.getSessions();
   record=authority.getCharacterRecord(characterID);
   activeShip=authority.getActiveShipRecord(characterID);
  }catch{return {status:"AUTHORITY_UNAVAILABLE"};}
  if(!Array.isArray(registered))return {status:"AUTHORITY_UNAVAILABLE"};
  if(!registered.includes(session))return {status:"SESSION_NOT_IN_NATIVE_REGISTRY"};
  if(registered.some(s=>s!==session&&live(s)&&positive(s.characterID)===characterID))
   return {status:"AMBIGUOUS_GLOBAL_CHARACTER_SESSION"};
  if(registered.some(s=>s!==session&&live(s)&&
   positive(s?._space?.shipID)===shipID))
   return {status:"AMBIGUOUS_GLOBAL_SHIP_OWNER"};
  const accountID=positive(session.userid);
  if(!accountID||!record||positive(record.accountId)!==accountID)
   return {status:"WRONG_ACCOUNT_OWNER"};
  if(!activeShip||positive(activeShip.itemID)!==shipID||
   positive(activeShip.ownerID)!==characterID)
   return {status:"WRONG_ACTIVE_SHIP_OWNER"};
 }
 return {status:"ADMITTED_NATIVE_SESSION",scene,physical};
}
function nativeAuthority(){
 const registry=require("../services/chat/sessionRegistry");
 const characters=require("../services/character/characterState");
 return {getSessions:()=>registry.getSessions(),
  getCharacterRecord:id=>characters.getCharacterRecord(id),
  getActiveShipRecord:id=>characters.getActiveShipRecord(id)};
}
function schedule(session,ship,reason="transition"){
 if(!session||typeof session!=="object"||!positive(ship?.itemID))return false;
 const previous=scheduled.get(session);
 if(previous)clearTimeout(previous.timer);
 const expectedID=positive(ship.itemID);
 const expectedSystem=positive(ship.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid);
 const job={expectedID,expectedSystem,reason,attempts:0,timer:null};
 scheduled.set(session,job);
 function poll(){
  if(scheduled.get(session)!==job)return;
  try{
   const space=session._space;
   if(!space||!live(session)){scheduled.delete(session);return;}
   if(positive(space.shipID)!==expectedID||positive(space.systemID)!==expectedSystem){
    scheduled.delete(session);return;
   }
   if(space.initialStateSent!==true){
    if(++job.attempts>=30){
     scheduled.delete(session);
     require("./coopRuntimeProbe").observe("coop-client-not-ready",session,ship,{reason});
     return;
    }
    job.timer=setTimeout(poll,1000);
    job.timer.unref?.();
    return;
   }
   const verified=admission(session,ship,s=>require("./runtime").getSceneForSession(s),nativeAuthority());
   if(verified.status!=="ADMITTED_NATIVE_SESSION"){
    if(++job.attempts>=30||[
     "AMBIGUOUS_NATIVE_CHARACTER_SESSION","AMBIGUOUS_NATIVE_SHIP_OWNER",
     "AMBIGUOUS_GLOBAL_CHARACTER_SESSION","AMBIGUOUS_GLOBAL_SHIP_OWNER",
     "WRONG_PHYSICAL_PILOT","WRONG_PHYSICAL_SESSION",
     "WRONG_ACTIVE_SHIP_OWNER","WRONG_ACCOUNT_OWNER",
     "REPLACED_OR_WRONG_SYSTEM_SHIP","STALE_SESSION"].includes(verified.status)){
     scheduled.delete(session);
     require("./coopRuntimeProbe").observe("coop-session-admission-blocked",
      session,ship,{reason,status:verified.status});
     return;
    }
    job.timer=setTimeout(poll,1000);
    job.timer.unref?.();
    return;
   }
   scheduled.delete(session);
   require("./coopRuntimeProbe").observe("space-arrival",session,ship,
    {reason,ballparkReady:true,authoritativeScene:true});
   require("./coopDuoPresence").observe(session,ship,reason);
   require("./coopDuoCoordinator").register(session,ship);
   require("./coopVirtualWorldRuntime").observeSession(session,ship);
   require("./coopNativeNpcDemo").maybeSpawn(session,ship);
  }catch(error){
   scheduled.delete(session);
   console.warn("[CoopSessionPresence]",reason,error.message);
  }
 }
 job.timer=setTimeout(poll,2500);
 job.timer.unref?.();
 return true;
}
module.exports={schedule,admission,nativeAuthority};
