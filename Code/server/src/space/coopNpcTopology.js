"use strict";
// Use EveJS's authoritative static scene (same list used by npcAnchors).
// Never invent space coordinates or substitute a player's ship as a patrol POI.
const KINDS=["stargate","station","asteroidBelt","planet","moon"];
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function validPosition(p){return !!p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));}
function waypoints(scene){
 if(!Array.isArray(scene?.staticEntities))return [];
 const byID=new Map();
 for(const e of scene.staticEntities){
  const id=positive(e?.itemID);
  if(!id||!KINDS.includes(e?.kind)||!validPosition(e.position))continue;
  if(!byID.has(id))byID.set(id,{id,kind:e.kind,name:String(e.itemName||e.slimName||e.kind),position:{x:e.position.x,y:e.position.y,z:e.position.z}});
 }
 return [...byID.values()].sort((a,b)=>KINDS.indexOf(a.kind)-KINDS.indexOf(b.kind)||a.id-b.id);
}
function anchorOptions(scene){
 const entry=waypoints(scene)[0];
 if(!entry)return null;
 return {anchorDescriptor:{kind:entry.kind,itemID:entry.id},anchorName:entry.name};
}
// Use only actual EveJS scene POIs: pirates and patrols can encounter
// real Perimeter miners, while beltless Jita falls back to genuine gates.
function anchorOptionsForRole(scene,role){
 const points=waypoints(scene);
 const order=role==="trader"?["station","stargate","asteroidBelt"]:
  ["pirate","patrol","miner","hauler"].includes(role)?
   ["asteroidBelt","stargate","station"]:["stargate","station","asteroidBelt"];
 const entry=order.map(kind=>points.find(p=>p.kind===kind)).find(Boolean)||points[0];
 if(!entry)return null;
 return {anchorDescriptor:{kind:entry.kind,itemID:entry.id},anchorName:entry.name};
}
module.exports={waypoints,anchorOptions,anchorOptionsForRole,validPosition};
