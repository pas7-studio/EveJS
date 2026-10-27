"use strict";
// COOP-045: derived demand only; never writes inventory, wallets, or market orders.
// Purchases and sales are ownership transfers, NOT physical consumption.
const whole=x=>Number.isSafeInteger(x)&&x>=0;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const SOURCES=new Set(["NATIVE_MARKET_FILL","NATIVE_WEAPON_CONSUMPTION","NATIVE_NPC_PURCHASE"]);
function calculateNativeDemand({receipts,ownerID,stationID,typeID,base,maxStock,now,windowMs=86400000}={}){
 if(!positive(ownerID)||!positive(stationID)||!positive(typeID)||
    !whole(base)||!positive(maxStock)||base>maxStock||!whole(now)||
    !positive(windowMs)||!Array.isArray(receipts)||receipts.length>2000)
  throw Error("NATIVE_DEMAND_CONTEXT_UNVERIFIED");
 const receiptIDs=new Set(),consumptionIDs=new Set();
 let consumed=0,marketFill=0,npcPurchased=0;
 for(const r of receipts){
  if(!r||r.authoritativeNative!==true||!positive(r.ownerID)||r.ownerID!==ownerID||
     !positive(r.stationID)||r.stationID!==stationID||!positive(r.typeID)||
     !positive(r.quantity)||!whole(r.at)||r.at>now||!SOURCES.has(r.source)||
     typeof r.receiptID!=="string"||r.receiptID.length===0||r.receiptID.length>160||
     receiptIDs.has(r.receiptID))
   throw Error("NATIVE_DEMAND_RECEIPT_UNVERIFIED_OR_REPLAYED");
  receiptIDs.add(r.receiptID);
  // A native physical ammo debit may have multiple telemetry paths. Only its
  // canonical consumption identity is allowed to raise the demand forecast.
  if(r.source==="NATIVE_WEAPON_CONSUMPTION"){
   const id=r.consumptionID??r.receiptID;
   if(typeof id!=="string"||id.length===0||id.length>160||consumptionIDs.has(id))
    throw Error("NATIVE_DEMAND_CONSUMPTION_REPLAYED");
   consumptionIDs.add(id);
  }
  if(r.typeID!==typeID||now-r.at>windowMs)continue;
  if(r.source==="NATIVE_WEAPON_CONSUMPTION")consumed+=r.quantity;
  else if(r.source==="NATIVE_MARKET_FILL")marketFill+=r.quantity;
  else npcPurchased+=r.quantity;
  if(!whole(consumed)||!whole(marketFill)||!whole(npcPurchased))
   throw Error("NATIVE_DEMAND_QUANTITY_OVERFLOW");
 }
 // A sale depletes the seller's real inventory; it is already reflected in
 // station stock / escrow remaining. Do NOT add it to the target a second time.
 const physicalBoost=Math.min(base*2,consumed);
 return Object.freeze({target:Math.min(maxStock,base+physicalBoost),
  physicalConsumed:consumed,marketFill,npcPurchased,
  verifiedReceipts:receiptIDs.size,mode:"NATIVE_CONSUMPTION_ONLY"});
}
module.exports={calculateNativeDemand};
