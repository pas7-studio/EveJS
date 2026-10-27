"use strict";
// Source-first, write-ahead native NPC wreck->cargo transfer. This is NOT an
// atomic two-table transaction. A crash before durable debit confirmation
// is fenced for operator repair, never interpreted as free goods.
const fs=require("node:fs"),path=require("node:path");
const validID=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const vec=x=>!!x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const copy=x=>JSON.parse(JSON.stringify(x));
const STATES=new Set(["PREPARED","DEBIT_CONFIRMED","SETTLED"]);
// On POSIX the directory entry of a renamed journal is only durable after a
// directory fsync. Windows cannot open a directory for fsync at all, so there
// the file-level fsync of the journal itself is the whole guarantee the
// platform offers; this is the real capability of the filesystem, not a
// weakened fence.
function syncDirectory(dir){
 if(process.platform==="win32")return;
 const fd=fs.openSync(dir,"r");
 try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function createWreckCustody({store,sceneForSystem,resolveType,root,
 clock=()=>Date.now(),maxTransactions=10000,maxDistance=2500}={}){
 if(!store||!["getNativeEntity","getNativeWreck","getNativeWreckItem",
 "listNativeCargoForEntity","allocateCargoID","removeNativeWreckItem",
 "upsertNativeWreckItem","allocateWreckItemID",
 "upsertNativeCargo","buildNativeCargoItems"].every(k=>typeof store[k]==="function")||
 typeof sceneForSystem!=="function"||typeof resolveType!=="function"||
 typeof root!=="string"||!path.isAbsolute(root)||
 typeof clock!=="function"||!Number.isSafeInteger(maxTransactions)||
 maxTransactions<1||maxTransactions>100000||
 !Number.isFinite(maxDistance)||maxDistance<250||maxDistance>5000)
  throw Error("INVALID_NATIVE_WRECK_CUSTODY_DEPENDENCIES");
 const dir=path.join(root,"tx");
 const busy=new Set();
 const writerLock=path.join(root,"native-wreck-custody.writer.lock");
 let lockUnsafe=false;
 const filename=itemID=>path.join(dir,String(itemID)+".json");
 function read(txID){
  const file=filename(txID);
  let value;
  try{value=JSON.parse(fs.readFileSync(file,"utf8"));}
  catch(e){if(e.code==="ENOENT")return null;throw e;}
  if(value?.version!==1||!STATES.has(value.phase)||
   validID(value.itemID)!==validID(txID)||!validID(value.wreckID)||
   !validID(value.systemID)||!validID(value.entityID)||
   !validID(value.cargoID)||!named(value.pilotID)||
   !validID(value.typeID)||!validID(value.quantity)||
   !validID(value.ownerID)||!validID(value.groupID)||
   !validID(value.categoryID)||!Number.isSafeInteger(value.at)||
   value.at<0||!value.newCargo||
   Number(value.newCargo.cargoID)!==Number(value.cargoID)||
   Number(value.newCargo.entityID)!==Number(value.entityID)||
   Number(value.newCargo.typeID)!==Number(value.typeID)||
   Number(value.newCargo.ownerID)!==Number(value.ownerID)||
   Number(value.newCargo.quantity)!==Number(value.quantity)||
   (value.newCargo.sourceWreckItemID!==undefined&&
    Number(value.newCargo.sourceWreckItemID)!==Number(value.itemID))||
   (value.newCargo.sourceWreckID!==undefined&&
    Number(value.newCargo.sourceWreckID)!==Number(value.wreckID))||
   // A hold smaller than the stack moves what really fits and leaves the rest
   // as a real remainder wreck item; both quantities must agree exactly.
   (value.partial===true&&(!validID(value.sourceBeforeQuantity)||
    Number(value.sourceBeforeQuantity)<=Number(value.quantity)||
    !validID(value.remainder&&value.remainder.itemID)||
    Number(value.remainder.itemID)===Number(value.itemID)||
    Number(value.remainder.quantity)!==
     Number(value.sourceBeforeQuantity)-Number(value.quantity))))
   throw Error("INVALID_NATIVE_WRECK_CUSTODY_JOURNAL");
  return value;
 }
 function persist(tx){
  const file=filename(tx.itemID);
  fs.mkdirSync(dir,{recursive:true});
  const temp=file+".tmp-"+process.pid;
  const fd=fs.openSync(temp,"wx",0o600);
  try{fs.writeFileSync(fd,JSON.stringify(tx));fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  try{
   fs.renameSync(temp,file);
   // Durable name switch is also part of the write-ahead fence on Linux:
   // fsync() of the file alone does not persist its directory entry.
   syncDirectory(dir);
  }catch(error){
   try{fs.unlinkSync(temp);}catch(_){}
   throw error;
  }
 }
 function sameCargo(row,tx){
  return row&&Number(row.cargoID)===tx.cargoID&&
   Number(row.entityID)===tx.entityID&&
   Number(row.ownerID)===tx.ownerID&&
   Number(row.typeID)===tx.typeID&&
   Number(row.quantity)===tx.quantity&&
   row.singleton===tx.newCargo.singleton&&
   Number(row.groupID)===tx.newCargo.groupID&&
   Number(row.categoryID)===tx.newCargo.categoryID&&
   Number(row.flagID)===5&&Number(row.moduleID||0)===0&&
   (tx.newCargo.sourceWreckItemID===undefined||
    Number(row.sourceWreckItemID)===Number(tx.newCargo.sourceWreckItemID))&&
   (tx.newCargo.sourceWreckID===undefined||
    Number(row.sourceWreckID)===Number(tx.newCargo.sourceWreckID));
 }
 function cargoFor(tx){
  const rows=store.listNativeCargoForEntity(tx.entityID);
  if(!Array.isArray(rows))throw Error("CARGO_STORE_UNAVAILABLE");
  return rows.filter(c=>Number(c.cargoID)===tx.cargoID);
 }
 function refresh(tx){
  const scene=sceneForSystem(tx.systemID);
  const live=scene?.getEntityByID?.(tx.entityID);
  if(!live||live.kind!=="ship"||live.nativeNpc!==true||
     Number(live.itemID)!==tx.entityID)
   return false;
  const items=store.buildNativeCargoItems(tx.entityID);
  if(!Array.isArray(items))return false;
  const checked=items.map(item=>{
   const type=resolveType(item.typeID);
   if(!type||!Number.isFinite(Number(type.volume))||Number(type.volume)<0)
    throw Error("CARGO_TYPE_METADATA_UNAVAILABLE");
   return {...item,volume:Number(type.volume)};
  });
  live.nativeCargoItems=checked;
  return true;
 }
 function settle(tx){
  const ship=store.getNativeEntity(tx.entityID);
  if(!ship||Number(ship.entityID)!==tx.entityID||
   Number(ship.systemID)!==tx.systemID||
   Number(ship.ownerID)!==tx.ownerID)
   return {status:"REPAIR_NATIVE_SHIP_IDENTITY"};
  if(store.getNativeWreckItem(tx.itemID))
   return {status:"REPAIR_SOURCE_STILL_PRESENT"};
  // A partial move left a real remainder stack in the same wreck; it must exist
  // with exactly the quantity that was not moved.
  if(tx.partial===true){
   const rest=store.getNativeWreckItem(tx.remainder.itemID);
   if(!rest||Number(rest.wreckID)!==tx.wreckID||
    Number(rest.typeID)!==tx.typeID||
    Number(rest.quantity)!==tx.remainder.quantity||
    (rest.singleton===true)!==(tx.newCargo.singleton===true))
    return {status:"REPAIR_SOURCE_QUANTITY_CONFLICT"};
  }
  const already=cargoFor(tx);
  if(already.length>1||already.length===1&&!sameCargo(already[0],tx))
   return {status:"REPAIR_DESTINATION_CONFLICT"};
  if(!already.length){
   const added=store.upsertNativeCargo(tx.newCargo,{transient:false});
   if(added?.success!==true)return {status:"DEBIT_CONFIRMED_DESTINATION_PENDING"};
   const final=cargoFor(tx);
   if(final.length!==1||!sameCargo(final[0],tx))
    return {status:"REPAIR_DESTINATION_NOT_DURABLE"};
  }
  if(!refresh(tx))return {status:"DESTINATION_COMMITTED_CACHE_PENDING"};
  persist({...tx,phase:"SETTLED"});
  return {status:"NATIVE_WRECK_CARGO_SETTLED",itemID:tx.itemID,
   cargoID:tx.cargoID,entityID:tx.entityID,
   wreckID:tx.wreckID,typeID:tx.typeID,quantity:tx.quantity,
   partial:tx.partial===true,sourceBeforeQuantity:Number(tx.sourceBeforeQuantity||
    tx.quantity),remainder:tx.remainder?{...tx.remainder}:null,
   nativeSourceDebited:true,nativeCargoCredited:true,iskCredited:false};
 }
 function inspectExisting(itemID){
  const tx=read(itemID);
  if(!tx)return null;
  if(tx.phase==="SETTLED")return {status:"ALREADY_SETTLED"};
  if(tx.phase==="PREPARED")return {status:"PREPARED_REQUIRES_REPAIR"};
  try{return settle(tx);}
  catch(_){return {status:"CUSTODY_REPAIR_REQUIRED"};}
 }
 function transferUnlocked({claim,scene,entityID,wreckItemID,assignments=[],
  getController=()=>null,canLoot=()=>false,verifyClaim=()=>false}={}){
  const itemID=validID(wreckItemID),shipID=validID(entityID),
   systemID=validID(scene?.systemID),wreckID=validID(claim?.wreckID);
  if(!itemID||!shipID||!systemID||!wreckID||
   typeof scene?.getEntityByID!=="function"||
   !Array.isArray(assignments)||typeof getController!=="function"||
   typeof canLoot!=="function"||typeof verifyClaim!=="function"||
   !named(claim?.attackerPilotID)||
   claim.attackerEntityID!==shipID||claim.systemID!==systemID||
   !Number.isSafeInteger(claim.at)||!Number.isSafeInteger(claim.expiresAt)||
   clock()<claim.at||clock()>claim.expiresAt)
   return {status:"INVALID_NATIVE_CUSTODY_PROOF"};
  // Re-check against the *durable* native kill journal, not only a caller-
  // supplied object. Without proof, do not even consult an old tx for credit.
  let attested=false;
  try{attested=verifyClaim({claim,scene,entityID:shipID})===true;}
  catch(_){attested=false;}
  if(!attested)return {status:"NATIVE_KILL_RECEIPT_NOT_VERIFIED"};
  if(busy.has(itemID))return {status:"ITEM_TRANSFER_BUSY"};
  busy.add(itemID);
  try{
   const previous=inspectExisting(itemID);
   if(previous)return previous;
   // No new custody action with any unresolved transaction. A PREPARED
   // crash can mean a native source was debited with no journal ACK.
   const files=fs.existsSync(dir)?fs.readdirSync(dir):[];
   if(files.some(name=>!/^\d+\.json$/.test(name)))
    return {status:"UNEXPECTED_CUSTODY_JOURNAL_FILES"};
   if(files.length>=maxTransactions)return {status:"CUSTODY_JOURNAL_CAP"};
   for(const name of files){
    const tx=read(Number(name.slice(0,-5)));
    if(tx?.phase!=="SETTLED")return {status:"OTHER_CUSTODY_UNRESOLVED"};
   }
   const links=assignments.filter(a=>a?.pilotID===claim.attackerPilotID&&
    Number(a.entityID)===shipID&&Number(a.systemID)===systemID);
   if(links.length!==1||assignments.some(a=>
     Number(a?.entityID)===shipID&&a?.pilotID!==claim.attackerPilotID))
    return {status:"NATIVE_PILOT_NOT_UNIQUE"};
   const native=store.getNativeEntity(shipID);
   const live=scene.getEntityByID(shipID),physical=scene.getEntityByID(wreckID);
   const wreck=store.getNativeWreck(wreckID),source=store.getNativeWreckItem(itemID);
   if(!native||Number(native.entityID)!==shipID||
     Number(native.systemID)!==systemID||
     !validID(native.ownerID)||!validID(native.typeID)||
     live?.nativeNpc!==true||live.kind!=="ship"||
     Number(live.itemID)!==shipID||live.session?.characterID||
     !vec(live.position)||String(live.mode||"").includes("WARP")||
     live.pendingWarp||live.warpState||
     physical?.nativeNpcWreck!==true||
     Number(physical.itemID)!==wreckID||!vec(physical.position)||
     distance(live.position,physical.position)>maxDistance||
     !wreck||wreck.transient===true||
     Number(wreck.systemID)!==systemID||
     Number(wreck.sourceEntityID)!==Number(claim.sourceEntityID)||
     Number(wreck.launcherID)!==Number(claim.sourceEntityID)||
     !source||source.transient===true||Number(source.wreckID)!==wreckID)
    return {status:"NATIVE_WRECK_OR_SHIP_UNVERIFIED"};
   if([...scene.sessions?.values?.()||[]].some(s=>
    Number(s?._space?.shipID)===shipID))
    return {status:"PLAYER_SHIP_EXCLUDED"};
   const controller=getController(shipID);
   if(Number(controller?.entityID)!==shipID||
    Number(controller?.systemID)!==systemID||
    Number(controller?.currentTargetID)>0||
    controller?.manualOrder?.type==="attack")
    return {status:"NATIVE_COMBAT_ORDER_ACTIVE"};
   // Only an existing source-verified owner/corporate loot entitlement
   // is supported. Suspect/theft/Crimewatch adjudication is not forged.
   const rights=Number(wreck.ownerID)>0&&Number(wreck.ownerID)===Number(native.ownerID)||
    Number(wreck.lootRightCorpID)>0&&
    Number(wreck.lootRightCorpID)===Number(native.corporationID)&&
    Number(native.corporationID)>0;
   if(!rights||canLoot({scene,wreck,ship:live,native,claim})!==true)
    return {status:"NATIVE_LOOT_RIGHTS_NOT_VERIFIED"};
   const type=resolveType(source.typeID),hull=resolveType(native.typeID);
   const quantity=source.singleton===true?1:Number(source.quantity);
   const unitVolume=Number(type?.volume),capacity=Number(hull?.capacity);
   if(!validID(source.typeID)||!validID(source.groupID)||
    !validID(source.categoryID)||!Number.isSafeInteger(quantity)||
    quantity<1||quantity>100000||!Number.isFinite(unitVolume)||
    unitVolume<0||!Number.isFinite(capacity)||capacity<=0)
    return {status:"NATIVE_ITEM_METADATA_UNVERIFIED"};
   const current=store.listNativeCargoForEntity(shipID);
   if(!Array.isArray(current))return {status:"NATIVE_CARGO_UNAVAILABLE"};
   let occupied=0;
   for(const cargo of current){
    if(Number(cargo.moduleID||0)!==0)continue;
    const typeRow=resolveType(cargo.typeID),vol=Number(typeRow?.volume);
    if(!Number.isFinite(vol)||vol<0||
     !Number.isSafeInteger(Number(cargo.quantity))||Number(cargo.quantity)<1)
     return {status:"NATIVE_CARGO_CAPACITY_UNVERIFIED"};
    occupied+=vol*Number(cargo.quantity);
   }
   if(!Number.isFinite(occupied)||occupied>capacity+1e-8)
    return {status:"NATIVE_CARGO_CAPACITY_UNVERIFIED"};
   // A real hold only takes what physically fits. The remainder stays in the
   // same wreck as a real native wreck item (never duplicated, never invented).
   const freeM3=capacity-occupied;
   const fits=unitVolume>0?Math.floor((freeM3+1e-8)/unitVolume):quantity;
   const moved=Math.min(quantity,Math.max(0,fits));
   if(moved<1)return {status:"NATIVE_CARGO_FULL"};
   const partial=moved<quantity;
   const allocated=store.allocateCargoID({transient:false});
   if(allocated?.success!==true||!validID(allocated.data))
    return {status:"NATIVE_CARGO_ID_ALLOCATION_FAILED"};
   let remainder=null;
   if(partial){
    const remainderID=store.allocateWreckItemID({transient:source.transient===true});
    if(remainderID?.success!==true||!validID(remainderID.data))
     return {status:"NATIVE_WRECK_ITEM_ID_ALLOCATION_FAILED"};
    remainder={itemID:Number(remainderID.data),quantity:quantity-moved};
   }
   const cargoID=Number(allocated.data),now=clock();
   const newCargo={cargoID,entityID:shipID,ownerID:Number(native.ownerID),
    moduleID:0,typeID:Number(source.typeID),
    groupID:Number(source.groupID),categoryID:Number(source.categoryID),
    itemName:String(source.itemName||type.name||""),
    quantity:moved,singleton:source.singleton===true,
    flagID:5,moduleState:copy(source.moduleState||null),transient:false,
    sourceWreckID:wreckID,sourceWreckItemID:itemID};
   const tx={version:1,phase:"PREPARED",itemID,wreckID,systemID,
    entityID:shipID,pilotID:claim.attackerPilotID,cargoID,
    ownerID:Number(native.ownerID),typeID:Number(source.typeID),
    quantity:moved,groupID:Number(source.groupID),
    categoryID:Number(source.categoryID),
    newCargo,at:now,partial,sourceBeforeQuantity:quantity,
    ...(remainder?{remainder}:{})};
   persist(tx);
   if(remainder){
    const written=store.upsertNativeWreckItem({...source,
     wreckItemID:remainder.itemID,quantity:remainder.quantity,
     transient:source.transient===true},
     {transient:source.transient===true});
    if(written?.success!==true)
     return {status:"DEBIT_OUTCOME_UNCERTAIN_REPAIR_REQUIRED"};
   }
   const debited=store.removeNativeWreckItem(itemID);
   if(debited?.success!==true||store.getNativeWreckItem(itemID))
    return {status:"DEBIT_OUTCOME_UNCERTAIN_REPAIR_REQUIRED"};
   persist({...tx,phase:"DEBIT_CONFIRMED"});
   return settle({...tx,phase:"DEBIT_CONFIRMED"});
  }catch(error){
   return {status:"NATIVE_CUSTODY_REPAIR_REQUIRED",
    reason:String(error?.message||error).slice(0,110)};
  }finally{busy.delete(itemID);}
 }
 function recoverUnlocked(){
  let files;
  try{files=fs.readdirSync(dir);}catch(e){if(e.code==="ENOENT")return {status:"CLEAN",recovered:0};throw e;}
  if(files.some(x=>!/^\d+\.json$/.test(x))||files.length>maxTransactions)
   return {status:"REPAIR_UNEXPECTED_CUSTODY_FILES",recovered:0};
  let recovered=0;const pending=[];
  for(const name of files){
   let tx;
   try{tx=read(Number(name.slice(0,-5)));}
   catch(e){pending.push({file:name,reason:"CORRUPT_JOURNAL"});continue;}
   if(tx.phase==="SETTLED")continue;
   if(tx.phase==="PREPARED"){
    pending.push({file:name,reason:"PREPARED_OUTCOME_UNCERTAIN"});continue;
   }
   let status;
   try{status=settle(tx).status;}catch(e){status="REPAIR_REQUIRED";}
   if(status==="NATIVE_WRECK_CARGO_SETTLED")recovered++;
   else pending.push({file:name,reason:status});
  }
  return {status:pending.length?"NEEDS_OPERATOR_REPAIR":"CLEAN",
   recovered,pending};
 }
 // The lock file is an interprocess fence, not a TTL lease. A stale file
 // after a crash must be inspected and cleared by the operator, never stolen.
 function withWriter(action,blocked){
  if(lockUnsafe)return blocked;
  let fd;
  try{
   fs.mkdirSync(root,{recursive:true});
   fd=fs.openSync(writerLock,"wx",0o600);
   fs.writeFileSync(fd,JSON.stringify({version:1,pid:process.pid,
    at:clock(),purpose:"NATIVE_WRECK_ITEM_CUSTODY"}));
   fs.fsyncSync(fd);
   syncDirectory(root);
  }catch(_){
   if(fd!==undefined){
    try{fs.closeSync(fd);}catch(_){}
    // Never auto-clear uncertain lock acquisition/durability state.
    lockUnsafe=true;
   }
   return blocked;
  }
  let result;
  try{result=action();}
  finally{
   try{fs.closeSync(fd);}catch(_){lockUnsafe=true;}
   try{
    fs.unlinkSync(writerLock);
    syncDirectory(root);
   }catch(_){lockUnsafe=true;}
  }
  if(lockUnsafe)return blocked;
  return result;
 }
 function transfer(args){
  return withWriter(()=>transferUnlocked(args),
   {status:"NATIVE_CUSTODY_WRITER_LOCK_UNSAFE"});
 }
 function recover(){
  return withWriter(recoverUnlocked,
   {status:"NEEDS_OPERATOR_REPAIR",recovered:0,
    pending:[{reason:"NATIVE_CUSTODY_WRITER_LOCK_UNSAFE"}]});
 }
 return {transfer,recover};
}
module.exports={createWreckCustody};
