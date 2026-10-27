"use strict";
// Stage J custody: require an atomic native move + independently replayable
// debit/credit receipt. No fallback to grantItemToCharacterLocation.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const block=status=>({status});
function createSalvageCustody({readSalvageProof,readManifest,inspectAtomicReceipt,
 atomicallyMoveOriginalItem,readNativeWreckItem,readWarehouseItem}={}){
 if([readSalvageProof,readManifest,inspectAtomicReceipt,
  atomicallyMoveOriginalItem,readNativeWreckItem,readWarehouseItem]
  .some(x=>typeof x!=="function"))
  throw Error("SALVAGE_ATOMIC_NATIVE_AUTHORITY_REQUIRED");
 function verify({manifestKey,cargoID,wreckItemID,stationID,
  corporationID,quantity}={}){
  if(!/^\d+-\d+-\d+$/.test(String(manifestKey))||
   ![cargoID,wreckItemID,stationID,corporationID,quantity].every(pos))
   return block("SALVAGE_CUSTODY_IDENTITY_INVALID");
  let witness,manifest,receipt,source,destination;
  try{
   witness=readSalvageProof(manifestKey);
   manifest=readManifest(manifestKey);
   receipt=inspectAtomicReceipt({manifestKey,cargoID,wreckItemID});
   source=readNativeWreckItem(wreckItemID);
   destination=readWarehouseItem({manifestKey,cargoID,wreckItemID});
  }catch{return block("SALVAGE_CUSTODY_EVIDENCE_UNAVAILABLE")}
  if(witness?.status!=="SALVAGE_ORIGIN_VERIFIED"||
   manifest?.status!=="READY"||manifest.record?.key!==manifestKey||
   manifest.record.stationID!==stationID||
   manifest.record.corporationID!==corporationID||
   (!pos(witness.wreckID)||receipt?.status==="ATOMIC_NATIVE_ITEM_MOVED"&&
    witness.wreckID!==receipt.wreckID)||
   !Array.isArray(witness.rows)||
   !witness.rows.some(x=>x.cargoID===cargoID&&
    x.wreckItemID===wreckItemID&&x.quantity===quantity))
   return block("SALVAGE_CUSTODY_ORIGIN_UNVERIFIED");
  if(receipt?.status!=="ATOMIC_NATIVE_ITEM_MOVED"||
   receipt.nativeDurable!==true||receipt.sourceDebited!==true||
   receipt.destinationCredited!==true||
   receipt.manifestKey!==manifestKey||
   receipt.cargoID!==cargoID||receipt.wreckItemID!==wreckItemID||
   receipt.stationID!==stationID||
   receipt.corporationID!==corporationID||
   receipt.quantity!==quantity||pos(source?.quantity)||
   destination?.nativeWarehouseItemID!==receipt.nativeWarehouseItemID||
   destination.quantity!==quantity||
   destination.sourceCargoID!==cargoID||
   destination.sourceWreckItemID!==wreckItemID)
   return block("SALVAGE_ATOMIC_NATIVE_TRANSFER_NOT_VERIFIED");
  return {status:"SALVAGE_NATIVE_CUSTODY_VERIFIED",
   manifestKey,cargoID,quantity,nativeWarehouseItemID:receipt.nativeWarehouseItemID,
   rewardISK:0};
 }
 function deliver(args){
  if(process.env.EVEJS_COOP_SALVAGE_ATOMIC_TRANSFER!=="1")
   return block("DISABLED");
  const prior=verify(args);
  if(prior.status==="SALVAGE_NATIVE_CUSTODY_VERIFIED")
   return {...prior,replayed:true};
  if(prior.status!=="SALVAGE_ATOMIC_NATIVE_TRANSFER_NOT_VERIFIED")
   return prior;
  const p=readSalvageProof(args?.manifestKey);
  if(p?.status!=="SALVAGE_ORIGIN_VERIFIED"||
   !p.rows?.some(x=>x.cargoID===args.cargoID&&
    x.wreckItemID===args.wreckItemID&&x.quantity===args.quantity))
   return block("SALVAGE_SOURCE_WITNESS_MISSING");
  let move;try{move=atomicallyMoveOriginalItem({
   manifestKey:args.manifestKey,cargoID:args.cargoID,
   wreckItemID:args.wreckItemID,stationID:args.stationID,
   corporationID:args.corporationID,quantity:args.quantity,
   expectedWreckID:p.wreckID})}
  catch{return block("SALVAGE_NATIVE_ATOMIC_MOVE_UNCERTAIN")}
  // ACK from native move is NOT sufficient. Require a replayable transaction
  // receipt and independent full original custody read-back.
  if(move?.status!=="ATOMIC_NATIVE_ITEM_MOVED")
   return block(move?.status||"SALVAGE_NATIVE_ATOMIC_MOVE_UNAVAILABLE");
  return verify(args);
 }
 return {deliver,verify};
}
module.exports={createSalvageCustody};
