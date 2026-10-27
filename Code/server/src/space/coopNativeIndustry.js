"use strict";
// Reuse EveJS's real mining fleet controller, rock depletion, cargo and response.
// This adapter never simulates asteroid yields or spawns substitute miners.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function observe({systemID,scene,pilots=[],registry,getFleets,getCargo,present,getController}){
 if(!positive(systemID)||!scene||typeof getFleets!=="function"||typeof getCargo!=="function")
  return {status:"UNAVAILABLE",fleets:[],assignments:[]};
 const fleets=(getFleets(systemID)||[]).filter(f=>Number(f?.systemID)===Number(systemID));
 const assigned=[],occupied=new Set();
 const targets={miner:[],hauler:[]};
 for(const fleet of fleets){
  for(const [role,key] of [["miner","minerEntityIDs"],["hauler","haulerEntityIDs"]]){
   for(const rawID of fleet[key]||[]){
    const id=positive(rawID);
    const ship=id?scene.getEntityByID?.(id):null;
    if(id&&ship?.kind==="ship"&&ship.nativeNpc===true&&
     !targets[role].includes(id))targets[role].push(id);
   }
  }
 }
 for(const pilot of pilots.filter(p=>p?.role==="miner"||p?.role==="hauler")){
  const old=registry?.get(pilot.id);
  let id=null;
  if(old?.systemID===Number(systemID)&&targets[pilot.role].includes(Number(old.entityID))){
   id=Number(old.entityID);
  }else{
   id=targets[pilot.role].find(candidate=>!occupied.has(candidate) &&
    !pilots.some(other=>other.id!==pilot.id&&registry?.get(other.id)?.entityID===candidate))||null;
  }
  if(!id||occupied.has(id))continue;
  const link=registry?.link(pilot,systemID,id);
  if(link&&Number(link.entityID)!==id)continue;
  occupied.add(id);
  const outcome=typeof present==="function"?present(scene,id,pilot):null;
  assigned.push({pilotID:pilot.id,entityID:id,role:pilot.role,presented:outcome?.status||"NO_DISPLAY"});
 }
 // ALIFE-1 PERCEIVE assertion: a fleet that says "mining" while producing
 // nothing is the same silent-blocker class one stage earlier. Opt-in only.
 const trace=process.env.EVEJS_COOP_ALIFE_TRACE==="1";
 const belts=trace?(scene.staticEntities||[]).filter(x=>
  x?.kind==="asteroidBelt"&&["x","y","z"].every(k=>Number.isFinite(x?.position?.[k]))):[];
 const minerEvidence=id=>{
  const ship=scene.getEntityByID?.(id);
  const controller=typeof getController==="function"?getController(id):null;
  let nearest=null;
  for(const belt of belts){
   const dx=ship?.position?.x-belt.position.x,dy=ship?.position?.y-belt.position.y,
    dz=ship?.position?.z-belt.position.z;
   if(![dx,dy,dz].every(Number.isFinite))continue;
   const meters=Math.round(Math.hypot(dx,dy,dz));
   if(nearest===null||meters<nearest)nearest=meters;
  }
  return {entityID:id,mode:String(ship?.mode||""),
   controllerTarget:Number(controller?.currentTargetID)||0,
   shipTarget:Number(ship?.targetID)||0,
   sceneCargoStacks:(ship?.nativeCargoItems||[]).length,
   nearestBeltMeters:nearest,belts:belts.length};
 };
 const details=fleets.map(f=>{
  const live=(ids)=>[...(ids||[])].filter(id=>{
   const ship=scene.getEntityByID?.(Number(id));
   return ship?.kind==="ship"&&ship.nativeNpc===true;
  }).map(Number);
  const miners=live(f.minerEntityIDs),haulers=live(f.haulerEntityIDs),response=live(f.responseEntityIDs);
  const cargo=miners.map(id=>({
   entityID:id,
   items:(getCargo(id)||[]).filter(x=>Number(x?.moduleID||0)===0).map(x=>({
    typeID:positive(x.typeID),quantity:Math.max(0,Number(x.quantity)||0)
   })).filter(x=>x.typeID&&x.quantity>0)
  }));
  const haulerCargo=haulers.map(id=>({
   entityID:id,oreQuantity:(getCargo(id)||[]).filter(x=>Number(x?.moduleID||0)===0)
    .reduce((n,x)=>n+Math.max(0,Number(x.quantity)||0),0)
  }));
  return {fleetID:positive(f.fleetID),state:String(f.state||"unknown"),
   minerIDs:miners,haulerIDs:haulers,responseIDs:response,
   cargo,haulerCargo,loadedHaulerOreQuantity:haulerCargo.reduce((n,x)=>n+x.oreQuantity,0),
   oreStacks:cargo.reduce((n,x)=>n+x.items.length,0),
   oreQuantity:cargo.reduce((n,x)=>n+x.items.reduce((sum,y)=>sum+y.quantity,0),0),
   lastHauledVolumeM3:Number(f.lastHauledVolumeM3)||0,lastHauledAtMs:Number(f.lastHauledAtMs)||0,
   ...(trace?{mining:miners.map(minerEvidence)}:{})
  };
 });
 return {status:fleets.length?"ACTIVE":"NO_NATIVE_FLEET",fleets:details,assignments:assigned};
}
module.exports={observe};
