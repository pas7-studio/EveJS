"use strict";
// Native read-back verification of character, jump clones, ship custody,
// consumables, boosters and dogma.  No replacement game-state backend.
const {validateUniqueImplants}=require("./coopCloneNativeGuard" + (__filename.endsWith(".cjs") ? ".cjs" : ".js"));
const pos=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const equals=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const indices=xs=>xs.map(pos).sort((a,b)=>a-b);
const implanted=x=>Array.isArray(x)?x:[];
function itemConsumedOne(before,after){
 if(!before||!pos(before.itemID))return false;
 const old=Number(before.singleton)===1?1:Number(before.stacksize??before.quantity??1);
 if(!Number.isSafeInteger(old)||old<=0)return false;
 if(old===1)return after===null;
 if(!after||pos(after.itemID)!==pos(before.itemID)||
  pos(after.ownerID)!==pos(before.ownerID))return false;
 const next=Number(after.singleton)===1?1:Number(after.stacksize??after.quantity??1);
 return old-next===1;
}
function hasNativeYearCooldown(record,nowFiletime){
 try{
  const time=BigInt(String(record.nextRemoteHomeStationChangeTime||"0"));
  const now=BigInt(nowFiletime());
  const days365=365n*24n*3600n*10000000n;
  return time>=now+days365-120n*10000000n &&
   time<=now+days365+120n*10000000n;
 }catch{return false}
}
function createCloneReceipts({
 getCharacterRecord,getActiveShip,getInventoryItem,getWalletBalance,
 getNativeDogmaImplants,getNativeActiveBoosters,getOwnedShipsAtLocation,
 isCapsuleShip,nowFiletime
}={}){
 const callbacks=[getCharacterRecord,getActiveShip,getInventoryItem,getWalletBalance,
  getNativeDogmaImplants,getNativeActiveBoosters,getOwnedShipsAtLocation,isCapsuleShip,nowFiletime];
 if(callbacks.some(x=>typeof x!=="function"))
  throw Error("NATIVE_CLONE_RECEIPT_BINDINGS_REQUIRED");
 function capture(proof){
  if(!proof?.ok||!pos(proof.characterID)||!proof.kind)
   throw Error("INVALID_NATIVE_CLONE_PROOF");
  const characterID=pos(proof.characterID);
  const record=getCharacterRecord(characterID),ship=getActiveShip(characterID);
  if(!record||!ship||pos(record.characterID)!==characterID||
   pos(ship.ownerID)!==characterID)
   throw Error("NATIVE_CHARACTER_READBACK_MISSING");
  const implants=getNativeDogmaImplants(characterID);
  const boosters=getNativeActiveBoosters(characterID);
  if(!Array.isArray(implants)||!Array.isArray(boosters))
   throw Error("NATIVE_DOGMA_READBACK_MISSING");
  const copies=obj=>JSON.parse(JSON.stringify(obj));
  return {record:copies(record),ship:copies(ship),
   implantDogma:copies(implants),boosters:copies(boosters),
   wallet:Number(getWalletBalance(characterID)),
   item:pos(proof.itemID)?copies(getInventoryItem(proof.itemID)):null};
 }
 function check({proof,before,nativeResult,nativeThrew=false}={}){
  if(!proof?.ok||!before?.record||nativeThrew||nativeResult?.success===false)
   return {ok:false,reason:"NATIVE_CLONE_RECEIPT_UNAVAILABLE"};
  const characterID=pos(proof.characterID);
  let after;
  try{after=capture(proof)}catch{return {ok:false,reason:"NATIVE_CLONE_READBACK_FAILED"}}
  const a=after.record,b=before.record;
  if(pos(a.characterID)!==characterID)return {ok:false,reason:"FOREIGN_CLONE_CHARACTER"};
  const unique=validateUniqueImplants(a);
  if(!unique.ok)return {ok:false,reason:unique.reason};
  if(proof.kind==="INSTALL_CLONE"){
   const old=new Set((b.jumpClones||[]).map(x=>pos(x.jumpCloneID)));
   const created=(a.jumpClones||[]).filter(x=>!old.has(pos(x.jumpCloneID)));
   if(created.length!==1||pos(created[0].ownerID)!==characterID||
    pos(created[0].locationID)!==pos(proof.locationID)||
    (a.jumpClones||[]).length!==(b.jumpClones||[]).length+1||
    Math.abs(before.wallet-after.wallet-Number(proof.cost))>0.000001)
    return {ok:false,reason:"NATIVE_CLONE_INSTALL_RECEIPT_MISMATCH"};
  }else if(proof.kind==="CLONE_JUMP"){
   const target=(b.jumpClones||[]).find(x=>pos(x.jumpCloneID)===pos(proof.cloneID));
   if(!target||(proof.remote&&(a.jumpClones||[]).some(x=>pos(x.jumpCloneID)===pos(proof.cloneID)))||
    (!proof.remote&&!(a.jumpClones||[]).some(x=>pos(x.jumpCloneID)===pos(proof.cloneID)))||
    pos(a.stationID||a.structureID)!==pos(proof.destinationLocationID)||
    !isCapsuleShip(after.ship)||pos(after.ship.ownerID)!==characterID||
    pos(after.ship.locationID)!==pos(proof.destinationLocationID))
    return {ok:false,reason:"NATIVE_CLONE_JUMP_ARRIVAL_MISMATCH"};
   if(!Number.isFinite(before.wallet)||!Number.isFinite(after.wallet)||
    Math.abs((before.wallet-after.wallet)-Number(proof.activationFee||0))>0.000001)
    return {ok:false,reason:"NATIVE_CLONE_ACTIVATION_FEE_MISMATCH"};
   if(proof.remote){
    let previous,now;try{previous=BigInt(proof.previousLastJump);now=BigInt(a.timeLastCloneJump)}
    catch{return {ok:false,reason:"NATIVE_CLONE_TIMER_INVALID"}}
    if(now<=previous||now>BigInt(nowFiletime())+10000000n)
     return {ok:false,reason:"NATIVE_CLONE_TIMER_NOT_UPDATED"};
   }
   const oldShipID=pos(proof.originalShipID);
   if(!oldShipID||pos(after.ship.itemID)!==oldShipID)
    return {ok:false,reason:"NATIVE_CAPSULE_IDENTITY_LOST"};
   const parked=getOwnedShipsAtLocation(characterID,proof.sourceLocationID);
   if(!Array.isArray(parked))return {ok:false,reason:"NATIVE_SHIP_CUSTODY_MISSING"};
   const found=new Map(parked.map(x=>[pos(x.itemID),x]));
   for(const previousShip of proof.sourceParkedShips||[]){
    if(pos(previousShip.itemID)===oldShipID)continue;
    const nowShip=found.get(pos(previousShip.itemID));
    if(!nowShip||pos(nowShip.ownerID)!==characterID||
     pos(nowShip.locationID)!==pos(proof.sourceLocationID)||
     Number(nowShip.flagID)!==Number(previousShip.flagID))
     return {ok:false,reason:"SOURCE_SHIP_MOVED_WITH_CLONE"};
   }
   const active=implanted(a.implants).map(x=>pos(x.itemID)).sort((x,y)=>x-y);
   const dst=implanted(target.implants).map(x=>pos(x.itemID)).sort((x,y)=>x-y);
   const original=implanted(b.implants).filter(x=>x.followsJumpClones===true)
    .map(x=>pos(x.itemID));
   if(!dst.every(x=>active.includes(x))||!original.every(x=>active.includes(x)))
    return {ok:false,reason:"NATIVE_CLONE_IMPLANTS_NOT_RESTORED"};
   if(!dst.every(itemID=>after.implantDogma.some(entry=>
    pos(entry.itemID??entry.implantID)===itemID||
    pos(entry.typeID)===pos(target.implants.find(x=>pos(x.itemID)===itemID)?.typeID))))
    return {ok:false,reason:"NATIVE_IMPLANT_DOGMA_NOT_SYNCED"};
  }else if(proof.kind==="IMPLANT"){
   const installed=implanted(a.implants).filter(x=>pos(x.itemID)===pos(proof.itemID));
   if(installed.length!==1||pos(installed[0].typeID)!==pos(proof.typeID)||
    pos(installed[0].slot)!==pos(proof.slot)||
    (a.implants||[]).length!==(b.implants||[]).length+1||
    !itemConsumedOne(before.item,after.item)||
    !after.implantDogma.some(x=>pos(x.itemID??x.implantID)===pos(proof.itemID)||
     pos(x.typeID)===pos(proof.typeID)))
    return {ok:false,reason:"NATIVE_IMPLANT_INSTALL_RECEIPT_MISMATCH"};
  }else if(proof.kind==="BOOSTER"){
   const newer=(a.boosters||[]).filter(x=>pos(x.itemID)===pos(proof.itemID));
   if(newer.length!==1||pos(newer[0].typeID??newer[0].boosterTypeID)!==pos(proof.typeID)||
    !itemConsumedOne(before.item,after.item)||!after.boosters.some(x=>pos(x.itemID)===pos(proof.itemID)))
    return {ok:false,reason:"NATIVE_BOOSTER_RECEIPT_MISMATCH"};
  }else if(proof.kind==="HOME_STATION"){
   if(pos(a.homeStationID)!==pos(proof.homeStationID)||
    pos(a.cloneStationID)!==pos(proof.homeStationID)||
    (proof.remote&&!hasNativeYearCooldown(a,nowFiletime)))
    return {ok:false,reason:"NATIVE_MEDICAL_HOME_NOT_PERSISTED"};
  }else if(proof.kind==="POD_DEATH"){
   const old=new Set((b.jumpClones||[]).map(x=>pos(x.jumpCloneID))),
    fresh=new Set((a.jumpClones||[]).map(x=>pos(x.jumpCloneID)));
   if(!equals(indices([...old]),indices([...fresh])))
    return {ok:false,reason:"POD_DEATH_DESTROYED_STORED_CLONE"};
   const lost=new Set((proof.activeImplants||[]).map(x=>pos(x.itemID)));
   if((a.implants||[]).some(x=>lost.has(pos(x.itemID))&&x.nonDestructible!==true))
    return {ok:false,reason:"DESTRUCTIBLE_IMPLANT_SURVIVED_POD_DEATH"};
   if(pos(a.stationID)!==pos(proof.homeStationID))
    return {ok:false,reason:"POD_RESPAWN_NOT_AT_HOME_STATION"};
  }else return {ok:false,reason:"INVALID_NATIVE_CLONE_RECEIPT_ACTION"};
  return {ok:true,kind:proof.kind,characterID,readback:after};
 }
 return {capture,check};
}
module.exports={createCloneReceipts};
