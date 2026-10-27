"use strict";
// Small, in-game rendezvous acknowledgement for two authenticated pilots.
// Actual ships/sessions are verified by coopDuoCoordinator before this call;
// the notice does not create ships, fleets, chat users or warp orders.
const pos=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function createNotices({clock=()=>Date.now(),cooldownMs=300000,
 send=(session,message)=>require("../services/chat/chatHub").sendSystemMessage(session,message)}={}){
 if(typeof clock!=="function"||typeof send!=="function"||
  !Number.isSafeInteger(cooldownMs)||cooldownMs<30000)
  throw Error("invalid duo notice options");
 const last=new Map();
 function rendezvous({scene,party,systemID,fleetID=null}={}){
  const pilots=party?.pilots;
  if(!Array.isArray(pilots)||pilots.length!==2||
   !scene||Number(scene.systemID)!==Number(systemID)||
   !Number.isFinite(party.separation)||party.separation<0||
   party.separation>250000)return {status:"NOT_TWO_READY_NATIVE_PILOTS",sent:0};
  const ids=pilots.map(p=>pos(p?.characterID));
  if(ids.some(id=>!id)||ids[0]===ids[1])
   return {status:"INVALID_PARTY",sent:0};
  if(pilots.some(p=>!pos(p?.shipID)||p.session?._space?.initialStateSent!==true||
   Number(p.session?._space?.systemID)!==Number(systemID)||
   scene.getEntityByID?.(p.shipID)!==p.ship||
   ![...scene.sessions?.values?.()||[]].includes(p.session)))
   return {status:"NOT_NATIVE_SCENE_MEMBERS",sent:0};
  const actualFleetID=pos(fleetID);
  const key=systemID+":"+ids.sort((a,b)=>a-b).join(":")+
   (actualFleetID?":fleet-"+actualFleetID:":rendezvous");
  const now=clock();
  if(!Number.isFinite(now))return {status:"CLOCK_INVALID",sent:0};
  if(last.has(key)&&now-last.get(key)<cooldownMs)
   return {status:"COOLDOWN",sent:0};
  const distance=Math.round(party.separation/1000);
  const msg=actualFleetID
   ?"[Co-op] Native EVE fleet #"+actualFleetID+
    " confirmed: both physical ships are nearby ("+distance+
    " km). Your fleet commander can use Warp Fleet. Try escorting a real mining convoy together."
   :"[Co-op] Rendezvous: both ships are nearby ("+distance+
    " km apart). Form an EVE fleet to warp together; check Perimeter belts for real mining convoys and pirate activity.";
  let sent=0;
  for(const p of pilots){
   if(p.session?.socket?.destroyed===true)continue;
   try{send(p.session,msg);sent++;}catch(error){
    console.warn("[CoopPartyNotices] chat",String(error?.message||error).slice(0,90));
   }
  }
  if(sent)last.set(key,now);
  if(last.size>500)for(const [id,time] of last)if(now-time>cooldownMs)last.delete(id);
  return {status:sent===2?"SENT":"PARTIAL",sent,systemID,
   characterIDs:ids,separationMeters:party.separation,
   nativeFleetID:actualFleetID};
 }

 const briefs=new Map();
 function brief({scene,party,systemID,fleetID}={}){
  const pilots=party?.pilots,system=pos(systemID),fleet=pos(fleetID);
  if(!system||!fleet||!scene||Number(scene.systemID)!==system||
   !Array.isArray(pilots)||pilots.length!==2||
   !(scene.dynamicEntities instanceof Map)||
   typeof scene.getEntityByID!=="function"||
   typeof scene.sessions?.values!=="function")
   return {status:"NO_VERIFIED_NATIVE_FLEET_BRIEF",sent:0};
  const members=[...scene.sessions.values()];
  const characterIDs=pilots.map(p=>pos(p?.characterID));
  if(characterIDs.some(x=>!x)||characterIDs[0]===characterIDs[1]||
   pilots.some(p=>!members.includes(p.session)||
    p.session?.socket?.destroyed===true||
    p.session?._space?.initialStateSent!==true||
    pos(p.session?._space?.systemID)!==system||
    pos(p.session?._space?.shipID)!==pos(p.shipID)||
    scene.getEntityByID(p.shipID)!==p.ship||
    p.ship?.kind!=="ship"))return {status:"STALE_NATIVE_FLEET_MEMBERS",sent:0};
  const point=e=>e?.position&&["x","y","z"].every(k=>Number.isFinite(e.position[k]));
  if(pilots.some(p=>!point(p.ship)))return {status:"NO_PHYSICAL_PLAYER_POSITIONS",sent:0};
  const playerShips=new Set(pilots.map(p=>pos(p.shipID)));
  const options=[...scene.dynamicEntities.values()].filter(n=>
   n?.nativeNpc===true&&n.kind==="ship"&&pos(n.itemID)&&
   !playerShips.has(pos(n.itemID))&&
   scene.getEntityByID(n.itemID)===n&&point(n)).map(n=>({
    npc:n,distance:Math.min(...pilots.map(p=>
     Math.hypot(...["x","y","z"].map(k=>p.ship.position[k]-n.position[k]))))
   })).filter(x=>x.distance<=250000).sort((a,b)=>a.distance-b.distance);
  if(!options.length)return {status:"NO_ACTIONABLE_NATIVE_SHIP",sent:0};
  const chosen=options[0],npcID=pos(chosen.npc.itemID),now=clock();
  if(!Number.isFinite(now)||now<0)return {status:"CLOCK_INVALID",sent:0};
  const key=[fleet,system,...characterIDs.slice().sort((a,b)=>a-b)].join(":");
  const previous=briefs.get(key);
  if(previous!==undefined&&now>=previous&&now-previous<120000)
   return {status:"COOLDOWN",sent:0};
  const distanceKM=Math.round(chosen.distance/1000);
  const msg="[Co-op Fleet] У поточній системі підтверджено фізичний NPC-корабель #"+
   npcID+" ("+distanceKM+" км від найближчого учасника). "+
   "Оберіть його в overview; за потреби використайте native Approach / Lock / Warp Fleet. "+
   "Це орієнтир для розвідки, НЕ наказ атакувати і НЕ підтверджена місія.";
  let sent=0;
  for(const p of pilots){
   try{send(p.session,msg);sent++;}catch(error){
    console.warn("[CoopPartyNotices] fleet brief",String(error?.message||error).slice(0,90));
   }
  }
  if(sent)briefs.set(key,now);
  for(const [k,at] of briefs)if(now-at>=120000||now<at)briefs.delete(k);
  while(briefs.size>300)briefs.delete(briefs.keys().next().value);
  return {status:sent===2?"FLEET_BRIEF_DELIVERED":sent?"PARTIAL":"FAILED",
   sent,systemID:system,fleetID:fleet,targetEntityID:npcID,distanceKM};
 }
 return {rendezvous,brief};
}
module.exports={createNotices};
