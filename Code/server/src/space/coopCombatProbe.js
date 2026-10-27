"use strict";
// Read-only live combat sampling for ships/NPCs in the same authoritative scene.
// No damage application, target acquisition, fake Destiny packets or inventories.
function num(x){const v=Number(x);return Number.isFinite(v)?v:null;}
function entitySample(entity){
 if(!entity)return null;
 const c=entity.conditionState||{};
 return {
   itemID:num(entity.itemID),kind:String(entity.kind||""),
   mode:String(entity.mode||""),
   shieldCharge:num(c.shieldCharge),
   armorDamage:num(c.armorDamage),
   structureDamage:num(c.damage),
   destroyed:Boolean(entity.destroyed||entity.isDestroyed),
 };
}
function wreckSamples(scene,npcIDs){
 const entities=scene?.dynamicEntities;
 if(!(entities instanceof Map))return [];
 return Array.from(entities.values()).filter(entity=>
   entity?.nativeNpcWreck===true &&
   npcIDs.some(id=>Number(entity.launcherID)===Number(id))
 ).map(entity=>({
   wreckID:num(entity.itemID),sourceNpcID:num(entity.launcherID),
   kind:String(entity.kind||""),isEmpty:Boolean(entity.isEmpty),
   position:entity.position&&['x','y','z'].every(k=>Number.isFinite(Number(entity.position[k])))
     ? {x:num(entity.position.x),y:num(entity.position.y),z:num(entity.position.z)}:null
 }));
}
function launch({scene,shipIDs,npcIDs,probe,session,ship,intervalMs=1000,maxSamples=60,onConfirmedWreck=null}){
 const allIDs=[...new Set([...shipIDs,...npcIDs].map(num).filter(x=>x>0))];
 if(!scene||typeof scene.getEntityByID!=="function"||typeof probe?.observe!=="function")return;
 let count=0;
 const timer=setInterval(()=>{
   try {
     count++;
     const entities=allIDs.map(id=>({id,sample:entitySample(scene.getEntityByID(id))}));
     const wrecks=wreckSamples(scene,npcIDs);
     if(typeof onConfirmedWreck==="function")for(const wreck of wrecks){
       try{onConfirmedWreck(wreck);}catch(err){console.warn("[CoopCombatProbe] wreck callback",err.message);}
     }
     const observers=Array.from(scene.sessions?.values?.()||[])
       .filter(x=>x?.socket?.destroyed!==true)
       .map(x=>({characterID:num(x.characterID),shipID:num(x?._space?.shipID),
         visibleEntityIDs:allIDs.filter(id=>x?._space?.visibleDynamicEntityIDs?.has(id)),
         visibleWreckIDs:wrecks.map(w=>w.wreckID).filter(id=>x?._space?.visibleDynamicEntityIDs?.has(id))}));
     probe.observe("native-npc-combat-sample",session,ship,{sample:count,entities,wrecks,observers});
     if(count>=maxSamples)clearInterval(timer);
   }catch(error){
     clearInterval(timer);
     try{console.warn("[CoopCombatProbe] sample failed:",error.message);}catch{}
   }
 },intervalMs);
 timer.unref?.();
 return ()=>clearInterval(timer);
}
module.exports={launch,entitySample,wreckSamples};
