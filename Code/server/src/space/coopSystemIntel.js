"use strict";
// Read-only intel from native EveJS scene objects. Never synthesize ships,
// quests, money, loot or evidence of player-visible actions.
const {waypoints}=(()=>{
 try { return require("./coopNpcTopology"); } // deployed .js overlay
 catch (error) {
  if(error.code!=="MODULE_NOT_FOUND"||!String(error.message).includes("coopNpcTopology"))throw error;
  return require("./coopNpcTopology"); // standalone repository tests
 }
})();
const positive=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null;};
const point=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const meters=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const clean=v=>String(v||"").replace(/[<>\x00-\x1f\x7f]/g," ").replace(/\s+/g," ").trim().slice(0,64);
const ship=e=>e?.kind==="ship"&&point(e.position);
function nearest(scene,entity,kinds=["asteroidBelt","station","stargate"]){
 if(!point(entity?.position))return null;
 const found=waypoints(scene).filter(p=>kinds.includes(p.kind))
  .map(p=>({...p,distance:meters(entity.position,p.position)}))
  .sort((a,b)=>a.distance-b.distance)[0];
 if(!found||found.distance>300000)return null;
 return {id:found.id,name:clean(found.name),kind:found.kind,km:Math.round(found.distance/1000)};
}
function build(scene,{fleets=[],pirateIDs=[]}={}){
 if(typeof scene?.getEntityByID!=="function")return {status:"NO_SCENE",messages:[],activity:[]};
 const playerShips=new Set(Array.from(scene.sessions?.values?.()||[])
  .map(s=>positive(s?._space?.shipID)).filter(Boolean));
 const findShip=id=>{
  const key=positive(id);
  if(!key||playerShips.has(key))return null;
  const entity=scene.getEntityByID(key);
  return ship(entity)?entity:null;
 };
 const activity=[];
 for(const fleet of Array.isArray(fleets)?fleets:[]){
  if(!fleet||typeof fleet!=="object")continue;
  const miners=[...new Set(fleet.minerIDs||fleet.minerEntityIDs||[])]
   .map(findShip).filter(Boolean);
  const haulers=[...new Set(fleet.haulerIDs||fleet.haulerEntityIDs||[])]
   .map(findShip).filter(Boolean);
  if(!miners.length&&!haulers.length)continue;
  const at=nearest(scene,miners[0]||haulers[0]);
  const responders=[...new Set(fleet.responseIDs||fleet.responseEntityIDs||[])]
   .map(findShip).filter(Boolean);
  activity.push({type:"mining",fleetID:positive(fleet.fleetID),
   location:at?.name||"unknown position",waypointID:at?.id||null,
   miners:miners.length,haulers:haulers.length,
   oreOnHaulers:haulers.length?Math.max(0,Number(fleet.loadedHaulerOreQuantity)||0):0,
   defenders:responders.length});
 }
 const pirates=[...new Set(Array.isArray(pirateIDs)?pirateIDs:[])]
  .map(findShip).filter(Boolean);
 if(pirates.length){
  const at=nearest(scene,pirates[0]);
  activity.push({type:"pirates",count:pirates.length,location:at?.name||"unknown position",waypointID:at?.id||null});
 }
 const messages=[];
 for(const x of activity.slice(0,4)){
  const location=x.location!=="unknown position"?" біля "+x.location:" у цій системі";
  if(x.type==="mining"){
   messages.push("[Living Universe] Флот шахтарів: "+x.miners+" видобувачів, "+x.haulers+
    " рудовозів"+location+
    (x.oreOnHaulers>0?"; вантаж: "+x.oreOnHaulers+" од. руди":"")+
    (x.defenders>0?"; ескорт: "+x.defenders:"" )+
    ". Удвох можна розвідати район і допомогти ескорту або зайнятися власним видобутком поруч.");
  }else{
   messages.push("[Living Universe] Виявлено "+x.count+" фізичних піратських кораблів"+location+
    ". Спільна розвідка можлива; напад чи нагорода не гарантовані.");
  }
 }
 return {status:messages.length?"ACTIVE":"QUIET",messages,activity};
}
function signature(data){
 return data.activity.map(x=>x.type==="mining"
  ?[x.type,x.fleetID,x.waypointID,x.miners,x.haulers,x.defenders,
    x.oreOnHaulers>=500?3:x.oreOnHaulers>=100?2:x.oreOnHaulers>0?1:0].join(":")
  :[x.type,x.waypointID,x.count].join(":")).join("|");
}
function createAnnouncer({send,clock=()=>Date.now(),cooldownMs=90000,refreshMs=900000}={}){
 if(typeof send!=="function"||typeof clock!=="function"||
  !Number.isSafeInteger(cooldownMs)||cooldownMs<1000||
  !Number.isSafeInteger(refreshMs)||refreshMs<cooldownMs)throw Error("invalid intel options");
 const last=new Map();
 function announce(session,scene,options={}){
  const charID=positive(session?.characterID),systemID=positive(session?._space?.systemID);
  const actualShip=scene?.getEntityByID?.(positive(session?._space?.shipID));
  const sceneSystem=positive(scene?.systemID||scene?.solarSystemID);
  if(!charID||!systemID||(sceneSystem&&sceneSystem!==systemID)||
   session?.socket?.destroyed===true||session?._space?.initialStateSent!==true||!ship(actualShip))
   return {status:"CLIENT_NOT_READY"};
  const now=clock();
  if(!Number.isFinite(now)||now<0)return {status:"INVALID_CLOCK"};
  const data=build(scene,options),key=charID+":"+systemID;
  if(data.status!=="ACTIVE")return {status:"QUIET",activity:data.activity};
  const digest=signature(data),previous=last.get(key);
  if(previous&&now>=previous.at&&now-previous.at<cooldownMs)return {status:"COOLDOWN",activity:data.activity};
  if(previous&&previous.digest===digest&&now>=previous.at&&now-previous.at<refreshMs)
   return {status:"UNCHANGED",activity:data.activity};
  let delivered=0;
  for(const message of data.messages.slice(0,3)){
   try{send(session,message);delivered++;}catch(e){console.warn("[CoopIntel] chat",e.message);break;}
  }
  if(delivered){
   last.delete(key);last.set(key,{at:now,digest});
   while(last.size>256)last.delete(last.keys().next().value);
  }
  return {status:delivered?"DELIVERED":"FAILED",messages:delivered,activity:data.activity};
 }
 return {announce};
}
module.exports={build,nearest,createAnnouncer};
