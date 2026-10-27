"use strict";
// Physical NPC ammunition exhaustion and recovery to a REAL station.
// Never authors a shot/damage event, spawns charges or changes inventory.
const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const vec=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const pilot=x=>/^coop-pilot-[0-9]{3,}$/.test(String(x||""));
function createAmmoSupply({store,getWeaponModules,resolveFamily,isOptional,compatible,
 getController,getStation,warp,orbit,isScrambled,clock=()=>Date.now(),
 cooldownMs=60000,maxOrders=3}={}){
 if(!store||typeof store.getNativeEntity!=="function"||
 ["listNativeModulesForEntity","listNativeCargoForEntity"].some(k=>typeof store[k]!=="function")||
 [getWeaponModules,resolveFamily,isOptional,compatible,getController,getStation,
  warp,orbit,isScrambled,clock].some(k=>typeof k!=="function")||
 !Number.isSafeInteger(cooldownMs)||cooldownMs<30000||
 !Number.isSafeInteger(maxOrders)||maxOrders<1||maxOrders>12)
  throw Error("INVALID_NATIVE_AMMO_SUPPLY_DEPENDENCIES");
 const leases=new Map(),lastOrder=new Map();
 function inspect({scene,entityID,pilotID,assignments=[]}={}){
  const system=id(scene?.systemID),shipID=id(entityID);
  const out=(status,detail={})=>({status,...detail});
  if(!system||!shipID||!pilot(pilotID)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments))return out("INVALID_NATIVE_CONTEXT");
  const linked=assignments.filter(a=>Number(a.entityID)===shipID||
   a.pilotID===pilotID);
  if(linked.length!==1||linked[0]?.pilotID!==pilotID||
   Number(linked[0]?.entityID)!==shipID||
   Number(linked[0]?.systemID)!==system)
   return out("PILOT_NOT_UNIQUE");
  const ship=scene.getEntityByID(shipID),native=store.getNativeEntity(shipID);
  if(ship?.kind!=="ship"||ship.nativeNpc!==true||ship.session?.characterID||
   Number(ship.itemID)!==shipID||!native||
   Number(native.entityID)!==shipID||Number(native.systemID)!==system||
   !id(native.ownerID)||[...scene.sessions?.values?.()||[]].some(s=>
    Number(s?._space?.shipID)===shipID))
   return out("NATIVE_SHIP_NOT_VERIFIED");
  const installed=store.listNativeModulesForEntity(shipID),
   cargo=store.listNativeCargoForEntity(shipID),weapons=getWeaponModules(ship);
  if(!Array.isArray(installed)||!Array.isArray(cargo)||!Array.isArray(weapons))
   return out("NATIVE_FITTING_UNAVAILABLE");
  const modulesByID=new Map();
  for(const m of installed){
   if(!id(m?.moduleID)||Number(m.entityID)!==shipID||
    Number(m.ownerID)!==Number(native.ownerID)||Number(m.categoryID)!==7)continue;
   if(modulesByID.has(Number(m.moduleID)))return out("DUPLICATED_MODULE");
   modulesByID.set(Number(m.moduleID),m);
  }
  let mandatory=0,loaded=0,loose=0,other=0;
  for(const weapon of weapons){
   // Hull-synthetic and charge-optional weapons stay usable without cargo.
   const moduleID=id(weapon?.itemID);
   const actual=moduleID&&modulesByID.get(moduleID);
   if(weapon?.npcSyntheticHullWeapon===true){other++;continue;}
   if(!actual)return out("NATIVE_FITTING_NOT_VERIFIED");
   const family=resolveFamily(weapon);
   if(!["missileLauncher","projectileTurret","hybridTurret","precursorTurret",
    "laserTurret"].includes(family)){other++;continue;}
   if(isOptional(weapon)===true){other++;continue;}
   mandatory++;
   const charges=cargo.filter(c=>Number(c?.entityID)===shipID&&
    Number(c?.ownerID)===Number(native.ownerID)&&
    Number(c?.categoryID)===8&&id(c.typeID)&&
    Number.isSafeInteger(Number(c.quantity))&&Number(c.quantity)>0&&
    c.transient!==true&&compatible(weapon,Number(c.typeID))===true);
   if(charges.some(c=>Number(c.moduleID)===moduleID))loaded++;
   else if(charges.some(c=>Number(c.moduleID||0)===0))loose++;
  }
  if(other>0||mandatory===0)return out("NOT_APPLICABLE",{mandatory,other});
  if(loaded>0||loose>0)return out("AMMO_AVAILABLE",
   {mandatory,loaded,loose});
  return out("AMMO_EXHAUSTED",{mandatory,loaded,loose});
 }
 function tick({scene,assignments=[],blockedIDs=new Set(),observeOnly=false}={}){
  const system=id(scene?.systemID),orders=[],events=[],now=clock();
  if(!system||!Array.isArray(assignments)||
   !Number.isSafeInteger(now)||now<0||!(blockedIDs instanceof Set)||
   typeof observeOnly!=="boolean")
   return {status:"INVALID",orders,events};
  const seen=new Set();let used=0;
  for(const a of assignments){
   if(Number(a?.systemID)!==system||!id(a?.entityID)||!pilot(a?.pilotID)||
    seen.has(Number(a.entityID)))continue;
   const entityID=Number(a.entityID),key=system+":"+entityID;
   seen.add(entityID);
   const readiness=inspect({scene,entityID,pilotID:a.pilotID,assignments});
   const lease=leases.get(key);
   if(readiness.status!=="AMMO_EXHAUSTED"){
    // A temporarily unreadable native fitting is NOT evidence that cargo
    // was restored; keep the depleted ship fenced until positive readiness.
    if(lease&&["AMMO_AVAILABLE","NOT_APPLICABLE"].includes(readiness.status)){
     leases.delete(key);lastOrder.delete(key);
     if(readiness.status==="AMMO_AVAILABLE")
      events.push({kind:"npc-ammo-resupplied",entityID,systemID:system,
       pilotID:a.pilotID,source:"REAL_NATIVE_CARGO"});
    }
    continue;
   }
   if(!lease)events.push({kind:"npc-ammo-exhausted",entityID,systemID:system,
    pilotID:a.pilotID,source:"REAL_NATIVE_CARGO"});
   leases.set(key,{systemID:system,entityID,pilotID:a.pilotID,
    expiresAt:now+180000});
   // ALIFE-02: no order, route, item, ISK or wallet mutation here.
   // Keep the physical depletion fence live so raids cannot ignore ammo.
   if(observeOnly)continue;
   const ship=scene.getEntityByID(entityID);
   if(!vec(ship?.position)||ship.pendingWarp||ship.warpState||
    String(ship.mode||"").toUpperCase().includes("WARP")||
    blockedIDs.has(entityID)||used>=maxOrders)continue;
   const controller=getController(entityID);
   if(Number(controller?.entityID)!==entityID||
    Number(controller?.systemID)!==system||
    isScrambled(ship)!==false)continue;
   const aggressor=id(controller?.lastAggressorID),
    recentAggression=aggressor&&
     Number(controller?.lastAggressedAtMs)>0&&
     now-Number(controller.lastAggressedAtMs)>=0&&
     now-Number(controller.lastAggressedAtMs)<120000;
   const danger=recentAggression?scene.getEntityByID(aggressor):null;
   const target=id(controller?.currentTargetID);
   const inCombat=Boolean(target||recentAggression||
    controller?.manualOrder?.type==="attack");
   const stations=(scene.staticEntities||[]).filter(e=>
    e?.kind==="station"&&id(e.itemID)&&vec(e.position)&&
    Number(getStation(e.itemID)?.solarSystemID)===system&&
    Number(getStation(e.itemID)?.stationID||
     getStation(e.itemID)?.itemID)===Number(e.itemID)&&
    (!danger||!vec(danger.position)||
     dist(e.position,danger.position)>500000))
    .sort((x,y)=>dist(ship.position,x.position)-
     dist(ship.position,y.position)||Number(x.itemID)-Number(y.itemID));
   if(!stations.length)continue;
   const at=stations[0],distance=dist(ship.position,at.position);
   if(distance<=5000){
    events.push({kind:"npc-ammo-awaiting-supply",entityID,
     systemID:system,stationID:Number(at.itemID),pilotID:a.pilotID,
     nativeStationReached:true,noAmmoSpawned:true});
    continue;
   }
   if((lastOrder.get(key)||0)>now)continue;
   // An active fight is allowed to yield only to genuine native warp,
   // never to a 2km orbit command that would cancel combat while close.
   if(inCombat&&distance<=250000)continue;
   let result;
   try{result=distance>250000?
    warp(entityID,Number(at.itemID),{forceImmediateStart:true}):
    orbit(entityID,Number(at.itemID),2000);}
   catch(_){result={success:false};}
   lastOrder.set(key,now+(result?.success===true?cooldownMs:30000));
   if(result?.success===true){
    used++;
    orders.push({action:distance>250000?
      "NATIVE_AMMO_RESUPPLY_WARP":"NATIVE_AMMO_RESUPPLY_ORBIT",
     entityID,systemID:system,pilotID:a.pilotID,stationID:Number(at.itemID),
     reason:"NATIVE_AMMO_EXHAUSTED",cargoCredited:false});
   }
  }
  for(const [key,v] of leases)if(v.expiresAt<now)leases.delete(key);
  if(lastOrder.size>5000)for(const [key,v] of lastOrder)if(v<now)lastOrder.delete(key);
  return {status:"OK",orders,events};
 }
 function activeIDs(systemID){
  const s=id(systemID),set=new Set(),now=clock();
  for(const lease of leases.values())if(lease.systemID===s&&
   lease.expiresAt>=now)set.add(lease.entityID);
  return set;
 }
 return {inspect,tick,activeIDs};
}
module.exports={createAmmoSupply};
