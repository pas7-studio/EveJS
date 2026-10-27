"use strict";
// A-Life NPC salvage competitor: stock native movement followed by ONE
// atomic wreck debit -> REAL NPC cargo credit. No virtual items, no ISK.
// Legal native loot-right corporation required; no illegal theft bypass.
const id=x=>Number.isSafeInteger(x)&&x>0;
const vec=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function createSalvageRivals({atomic,readCases,readEscrow,getController,
 getNativeEntity,getNativeWreck,getNativeWreckItems,readCargo,
 warp,orbit,getUnitVolume,clock=()=>Date.now()}={}){
 if(typeof atomic?.transact!=="function"||
  [readCases,readEscrow,getController,getNativeEntity,getNativeWreck,
   getNativeWreckItems,readCargo,warp,orbit,getUnitVolume,clock]
   .some(x=>typeof x!=="function"))
  throw Error("SALVAGE_ALIFE_NATIVE_AUTHORITIES_REQUIRED");
 const cooldown=new Map();
 function tick({scene,assignments=[],roles=[],blockedIDs=new Set()}={}){
  if(process.env.EVEJS_COOP_ALIFE_SALVAGE_RIVALS!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
   process.env.EVEJS_COOP_SALVAGE_NATIVE_DEATH!=="1")
   return {status:"DISABLED",orders:[],pickups:[]};
  const systemID=scene?.systemID,now=clock();
  if(!id(systemID)||!id(now)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments)||!Array.isArray(roles)||
   !(blockedIDs instanceof Set))
   return {status:"ALIFE_SALVAGE_INVALID_SCENE",orders:[],pickups:[]};
  let cases;try{cases=readCases(systemID)}
  catch{return {status:"ALIFE_SALVAGE_CASE_SOURCE_UNAVAILABLE",orders:[],pickups:[]}}
  if(!Array.isArray(cases)||cases.length>256)
   return {status:"ALIFE_SALVAGE_CASES_UNTRUSTED",orders:[],pickups:[]};
  const roleOf=new Map(roles.filter(x=>named(x?.pilotID)).map(x=>[x.pilotID,x.role]));
  const legal=assignments.filter(x=>named(x?.pilotID)&&id(x.entityID)&&
   x.systemID===systemID&&!blockedIDs.has(x.entityID)&&
   ["hauler","trader"].includes(roleOf.get(x.pilotID))&&
   assignments.filter(y=>y.entityID===x.entityID&&
    y.systemID===systemID).length===1&&
   assignments.filter(y=>y.pilotID===x.pilotID).length===1)
   .sort((a,b)=>a.entityID-b.entityID);
  const orders=[],pickups=[];
  for(const c of cases){
   if(orders.length||pickups.length)break;
   if(!/^\d+-\d+-\d+$/.test(String(c.manifestKey))||
    !id(c.wreckID)||!id(c.haulerID)||
    !Array.isArray(c.rows)||!c.rows.length)continue;
   let escrow,wreck,contents;try{
    escrow=readEscrow(c.manifestKey);
    wreck=getNativeWreck(c.wreckID);
    contents=getNativeWreckItems(c.wreckID);
   }catch{continue}
   // Existing escrow (including terminal/refunded) excludes rival action:
   // no active player contract can be made impossible by this director.
   if(escrow?.status!=="NOT_FOUND"||
    wreck?.wreckID!==c.wreckID||wreck.systemID!==systemID||
    wreck.sourceEntityID!==c.haulerID||
    !Array.isArray(contents))continue;
   const physical=scene.getEntityByID(c.wreckID);
   if(physical?.nativeNpcWreck!==true||
    physical.itemID!==c.wreckID||!vec(physical.position))continue;
   const available=c.rows.map(r=>contents.find(x=>
    x.wreckItemID===r.wreckItemID&&
    x.sourceCargoID===r.cargoID&&x.wreckID===c.wreckID&&
    x.sourceKind==="cargo"&&x.typeID===r.typeID&&
    x.quantity===r.quantity)).filter(Boolean);
   if(!available.length)continue;
   for(const link of legal){
    let npc,controller,stock;
    try{npc=getNativeEntity(link.entityID);
     controller=getController(link.entityID);
     stock=readCargo(link.entityID)}catch{continue}
    const live=scene.getEntityByID(link.entityID);
    const corp=npc?.corporationID;
    if(!id(corp)||!id(npc.ownerID)||npc.entityID!==link.entityID||
     npc.systemID!==systemID||
     controller?.entityID!==link.entityID||
     controller.systemID!==systemID||
     controller.currentTargetID>0||
     controller.manualOrder?.type==="attack"||
     live?.kind!=="ship"||live.nativeNpc!==true||
     live.itemID!==link.entityID||!vec(live.position)||
     !Array.isArray(stock)||
     // No unimplemented crime/standing shortcut: a rival can act only with
     // real stock loot rights (e.g. allied salvage/corporate contractors).
     wreck.lootRightCorpID!==corp&&wreck.corporationID!==corp)
     continue;
    const lease=systemID+":"+link.entityID+":"+c.wreckID;
    if(cooldown.get(lease)>now)continue;
    const d=dist(live.position,physical.position);
    if(d>2500){
     let ack;
     try{ack=d>150000?warp(link.entityID,c.wreckID):
      orbit(link.entityID,c.wreckID,1500)}
     catch{ack={success:false}}
     cooldown.set(lease,now+(ack?.success===true?60000:30000));
     if(ack?.success===true)orders.push({pilotID:link.pilotID,
      entityID:link.entityID,wreckID:c.wreckID,
      action:d>150000?"NATIVE_WARP_TO_SALVAGE":"NATIVE_APPROACH_SALVAGE"});
     if(orders.length)break;
     continue;
    }
    const entry=available[0],unit=getUnitVolume(entry.typeID);
    const capacity=Number(live.capacity);
    const used=stock.reduce((n,x)=>n+
     Number(x.quantity||0)*Number(getUnitVolume(x.typeID)||0),0);
    if(!Number.isFinite(capacity)||capacity<=0||
     !Number.isFinite(unit)||unit<=0||
     !Number.isFinite(used)||used<0||
     used+unit*entry.quantity>capacity)continue;
    try{
     const receipt=atomic.transact(["npcWreckItems","npcCargo","corporationRuntime"],tx=>{
      const w=tx.get("npcWreckItems","items"),
       cargo=tx.get("npcCargo","cargo"),
       next=tx.get("npcCargo","nextCargoID"),
       journal=tx.get("corporationRuntime","coopSalvageRivalMoves")||
        {version:1,moves:{}};
      // The preflight escrow read happens before this transaction; a
      // real duo may reserve corporate ISK before the rival moves.
      // Serialize the final eligibility check with that same escrow row.
      const escrows=tx.get("corporationRuntime","coopSalvageEscrows");
      if(escrows!==null&&
       (escrows?.version!==1||!escrows.byContract||
        typeof escrows.byContract!=="object"||
        Array.isArray(escrows.byContract)))
       throw Error("ALIFE_SALVAGE_ESCROW_LEDGER_UNTRUSTED");
      if(escrows?.byContract?.["salvage-"+c.manifestKey])
       throw Error("ALIFE_SALVAGE_FUNDED_CONTRACT_OWNS_SOURCE");
      const real=w?.[String(entry.wreckItemID)];
      if(!real||real.wreckID!==c.wreckID||
       real.wreckItemID!==entry.wreckItemID||
       real.sourceKind!=="cargo"||real.singleton===true||
       real.sourceCargoID!==entry.sourceCargoID||
       real.typeID!==entry.typeID||real.quantity!==entry.quantity||
       !cargo||!id(next)||journal.version!==1||!journal.moves||
       Object.values(cargo).some(x=>x.sourceWreckItemID===entry.wreckItemID)||
       journal.moves[String(entry.wreckItemID)])
       throw Error("ALIFE_SALVAGE_NATIVE_SOURCE_CHANGED");
      const newID=Math.max(next,Object.keys(cargo).reduce((n,x)=>
       Math.max(n,Number(x)+1),next));
      if(!id(newID)||!Number.isSafeInteger(newID+1))
       throw Error("ALIFE_SALVAGE_CARGO_ID_OVERFLOW");
      const nextW={...w},nextC={...cargo};
      delete nextW[String(entry.wreckItemID)];
      nextC[String(newID)]={cargoID:newID,entityID:link.entityID,
       ownerID:npc.ownerID,moduleID:0,flagID:5,typeID:entry.typeID,
       groupID:entry.groupID,categoryID:entry.categoryID,
       itemName:entry.itemName,quantity:entry.quantity,singleton:false,
       sourceCargoID:entry.sourceCargoID,
       sourceWreckID:c.wreckID,sourceWreckItemID:entry.wreckItemID,
       salvageManifestKey:c.manifestKey};
      tx.put("npcWreckItems","items",nextW);
      tx.put("npcCargo","cargo",nextC);
      tx.put("npcCargo","nextCargoID",newID+1);
      journal.moves[String(entry.wreckItemID)]={v:1,state:"NPC_CARGO",
       wreckID:c.wreckID,manifestKey:c.manifestKey,
       sourceCargoID:entry.sourceCargoID,wreckItemID:entry.wreckItemID,
       npcCargoID:newID,entityID:link.entityID,corporationID:corp};
      tx.put("corporationRuntime","coopSalvageRivalMoves",journal);
      return {status:"ALIFE_NATIVE_SALVAGE_PICKED",npcCargoID:newID};
     });
     if(receipt?.status==="ALIFE_NATIVE_SALVAGE_PICKED"){
      pickups.push({...receipt,entityID:link.entityID,wreckID:c.wreckID,
       pilotID:link.pilotID,originalCargoID:entry.sourceCargoID});
      cooldown.set(lease,now+60000);
      break;
     }
    }catch{cooldown.set(lease,now+60000)}
   }
  }
  if(cooldown.size>1024)for(const [k,t] of cooldown)if(now>t+3600000)cooldown.delete(k);
  return {status:"READY",orders,pickups};
 }
 return {tick};
}
module.exports={createSalvageRivals};
