"use strict";
// Match two independently controlled, Ballpark-ready ships in one native scene.
const registered=new Map();
let timer=null;
const lastSceneObservation=new Map();
let notices=null;
function pos(x){const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:null;}
const presence=require("./coopSessionPresence");
function readyPilots(scene,systemID,authority=null){
 if(!scene?.sessions||typeof scene.sessions.values!=="function"||
  Number(scene.systemID)!==systemID||typeof scene.getEntityByID!=="function")return [];
 const pilots=[];
 for(const session of scene.sessions.values()){
  const charID=pos(session?.characterID),shipID=pos(session?._space?.shipID);
  if(!charID||!shipID||session?._space?.initialStateSent!==true||
   !session.socket||session.socket.destroyed===true||
   pos(session._space.systemID)!==systemID)continue;
  const ship=scene.getEntityByID(shipID);
  // Scene presence alone cannot prove ownership; duplicates of either a
  // character or a physical hull must not be eligible for party side effects.
  if(presence.admission(session,ship,()=>scene,authority).status!=="ADMITTED_NATIVE_SESSION")continue;
  if(!ship.position||["x","y","z"].some(k=>!Number.isFinite(ship.position[k])))continue;
  if(String(ship.mode||"").toUpperCase().includes("WARP"))continue;
  pilots.push({session,ship,characterID:charID,shipID});
 }
 return pilots;
}
function findParty(scene,systemID,maxDistance=250000,authority=null){
 const pilots=readyPilots(scene,systemID,authority);
 for(let i=0;i<pilots.length;i++)for(let j=i+1;j<pilots.length;j++){
  const a=pilots[i].ship.position,b=pilots[j].ship.position;
  const separation=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  if(Number.isFinite(separation)&&separation<=maxDistance)
   return {pilots:[pilots[i],pilots[j]],separation};
 }
 return null;
}
function tick(){
 const runtime=require("./runtime");
 let current=0;
 // Drop registrations whose native identities, hull ownership, sockets, or
 // scene memberships no longer agree. Never mutate the peer's native session.
 for(const [id,item] of registered){
  let valid=false;
  try{
   valid=pos(item.session?.characterID)===id&&
    pos(item.session?._space?.systemID)===item.systemID&&
    pos(item.session?._space?.shipID)===item.shipID&&
    presence.admission(item.session,item.ship,
     s=>runtime.getSceneForSession(s),presence.nativeAuthority()).status===
     "ADMITTED_NATIVE_SESSION";
  }catch{/* Missing native authority is not a reason to grant access. */}
  if(!valid)registered.delete(id);else current++;
 }
 if(!current){if(timer)clearInterval(timer);timer=null;return;}
 const systemIDs=new Set([...registered.values()].map(x=>x.systemID));
 for(const systemID of systemIDs){
  try{
   const owner=[...registered.values()].find(x=>x.systemID===systemID);
   const scene=runtime.getSceneForSession(owner.session);
   if(!scene)continue;
   const party=findParty(scene,systemID,Number(process.env.EVEJS_COOP_PARTY_RANGE_METERS||250000),presence.nativeAuthority());
   let nativeFleet=null;
   if(party)try{
    nativeFleet=require("./coopNativeFleetParty").membership({
     leaderSession:party.pilots[0].session,
     peerSession:party.pilots[1].session,
     fleetRuntime:require("../services/fleets/fleetRuntime")
    });
   }catch(_){/* optional evidence cannot stop native scene activity */}
   const signature=party
    ?party.pilots.map(p=>p.characterID).sort((a,b)=>a-b).join(":")+
     (nativeFleet?.ok?":fleet-"+nativeFleet.fleetID:":not-in-fleet")
    :"waiting";
   const changed=owner.lastParty!==signature;
   const time=Date.now();
   if(changed){
    for(const item of registered.values())if(item.systemID===systemID)item.lastParty=signature;
    require("./coopRuntimeProbe").observe("coop-party-proximity",owner.session,owner.ship,{
     ready:Boolean(party),characterIDs:party?.pilots.map(p=>p.characterID)||[],separationMeters:party?.separation||null,
     nativeFleetID:nativeFleet?.ok?nativeFleet.fleetID:null,nativeFleetVerified:nativeFleet?.ok===true
    });
    if(party&&process.env.EVEJS_COOP_PARTY_NOTICES==="1"){
     try{
      if(!notices)notices=require("./coopPartyNotices").createNotices();
      notices.rendezvous({scene,party,systemID,fleetID:nativeFleet?.ok?nativeFleet.fleetID:null});
     }catch(error){console.warn("[CoopDuoCoordinator] party notice",error.message);}
    }
   }
   if(changed||(party&&time-(lastSceneObservation.get(systemID)||0)>=15000)){
    lastSceneObservation.set(systemID,time);
    require("./coopDuoPresence").observe(owner.session,owner.ship,signature==="waiting"?"party-waiting":"party-grid-refresh");
   }
   if(party&&nativeFleet?.ok&&process.env.EVEJS_COOP_FLEET_BRIEF==="1"){
    try{
     if(!notices)notices=require("./coopPartyNotices").createNotices();
     notices.brief({scene,party,systemID,fleetID:nativeFleet.fleetID});
    }catch(error){console.warn("[CoopDuoCoordinator] fleet brief",error.message);}
   }
   if(party){
    const chosen=party.pilots[0];
    const record=registered.get(chosen.characterID)?.ship||
     {itemID:chosen.shipID,spaceState:{systemID}};
    require("./coopNativeNpcDemo").maybeSpawn(chosen.session,record);
   }
  }catch(error){console.warn("[CoopDuoCoordinator] tick",error.message);}
 }
}
function register(session,ship){
 if(process.env.EVEJS_COOP_REQUIRE_TWO_PILOTS!=="1")return false;
 const characterID=pos(session?.characterID);
 const shipID=pos(session?._space?.shipID);
 const systemID=pos(session?._space?.systemID);
 if(!characterID||!shipID||!systemID||session._space.initialStateSent!==true)return false;
 try{
  if(presence.admission(session,ship,
   s=>require("./runtime").getSceneForSession(s),presence.nativeAuthority()).status!==
   "ADMITTED_NATIVE_SESSION")return false;
 }catch{return false;}
 registered.set(characterID,{session,ship,systemID,shipID,lastParty:null});
 if(!timer){timer=setInterval(tick,4000);timer.unref?.();}
 tick();
 return true;
}
module.exports={register,findParty,readyPilots,tick};
