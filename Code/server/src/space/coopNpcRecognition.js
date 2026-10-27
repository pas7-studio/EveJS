"use strict";
// A named NPC can recognize a real nearby player through an existing native
// EveJS private system message. This does NOT impersonate player chat,
// fabricate dialogue, spawn NPCs, or change native standing/combat.
const validID=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;
const position=x=>x&&["x","y","z"].every(k=>Number.isFinite(Number(x[k])));
const distance=(a,b)=>Math.hypot(
 Number(a.x)-Number(b.x),Number(a.y)-Number(b.y),Number(a.z)-Number(b.z));
function createRecognition({lookup,send,clock=()=>Date.now(),
 radiusMeters=80000,cooldownMs=1800000,maxTracked=2000}={}){
 if(typeof lookup!=="function"||typeof send!=="function"||
    typeof clock!=="function"||!Number.isFinite(radiusMeters)||
    radiusMeters<1000||radiusMeters>250000||
    !Number.isSafeInteger(cooldownMs)||cooldownMs<60000||
    !Number.isSafeInteger(maxTracked)||maxTracked<1)throw Error("invalid NPC recognition options");
 const notices=new Map(),lastPlayerNotice=new Map();
 function tick({session,scene,links=[]}={}){
  const characterID=validID(session?.characterID)&&Number(session.characterID);
  const systemID=validID(session?._space?.systemID)&&Number(session._space.systemID);
  const shipID=validID(session?._space?.shipID)&&Number(session._space.shipID);
  if(!characterID||!systemID||!shipID||session?._space?.initialStateSent!==true||
     typeof scene?.getEntityByID!=="function")return {status:"PLAYER_NOT_READY"};
  const playerShip=scene.getEntityByID(shipID);
  if(!playerShip||!position(playerShip.position)||playerShip.kind!=="ship")
   return {status:"NO_PHYSICAL_SHIP"};
  const now=clock();
  const playerKey=systemID+":"+characterID;
  if(lastPlayerNotice.has(playerKey)&&now-lastPlayerNotice.get(playerKey)<180000)
   return {status:"PLAYER_COOLDOWN"};
  const candidates=[];
  for(const link of links){
   if(!link||Number(link.systemID)!==systemID||
      !/^coop-pilot-[0-9]{3,}$/.test(String(link.pilotID||""))||
      !validID(link.entityID)||Number(link.entityID)===shipID)continue;
   const npc=scene.getEntityByID(Number(link.entityID));
   if(!npc||npc.kind!=="ship"||!position(npc.position)||
      distance(npc.position,playerShip.position)>radiusMeters)continue;
   let remembered;
   try{remembered=lookup({pilotID:link.pilotID,characterID});}
   catch(error){console.warn("[CoopNpcRecognition] memory unavailable",error.message);continue;}
   if(remembered?.status!=="KNOWN"||!Number.isFinite(remembered.score))continue;
   const key=systemID+":"+link.pilotID+":"+characterID;
   if(notices.has(key)&&now-notices.get(key)<cooldownMs)continue;
   candidates.push({key,link,npc,remembered,range:distance(npc.position,playerShip.position)});
  }
  candidates.sort((a,b)=>a.range-b.range||a.link.pilotID.localeCompare(b.link.pilotID));
  if(!candidates.length)return {status:"NO_NEW_RECOGNITION"};
  const {key,link,npc,remembered}=candidates[0];
  const name=String(npc.itemName||npc.name||link.pilotID)
   .replace(/[\r\n\t]+/g," ").trim().slice(0,72);
  const qualifier=remembered.score<=-30?
   "remembers your hostile actions and may request stronger protection":
   remembered.score<=-10?"remembers your earlier attack and remains wary":
   remembered.score>=10?"remembers your help to its allies":"remembers a previous encounter";
  try{send(session,"[Living Universe] "+name+" recognizes you nearby and "+qualifier+".");}
  catch(error){return {status:"DELIVERY_FAILED",error:String(error.message).slice(0,120)};}
  notices.set(key,now);
  lastPlayerNotice.set(playerKey,now);
  if(lastPlayerNotice.size>maxTracked){
   for(const [id,at] of lastPlayerNotice)if(now-at>=180000)lastPlayerNotice.delete(id);
   while(lastPlayerNotice.size>maxTracked)lastPlayerNotice.delete(lastPlayerNotice.keys().next().value);
  }
  if(notices.size>maxTracked){
   for(const [id,at] of notices)if(now-at>=cooldownMs)notices.delete(id);
   while(notices.size>maxTracked)notices.delete(notices.keys().next().value);
  }
  return {status:"DELIVERED",pilotID:link.pilotID,characterID,systemID,attitude:remembered.attitude};
 }
 return {tick};
}
module.exports={createRecognition};
