"use strict";
/**
 * LW-04D: READ-ONLY original native ore -> refinery -> manufacturing input
 * -> Rust sale -> wallet audit. No timer, wallet, SQL write or fake session.
 *
 * This is a PROOF CONTRACT, not an installed live source adapter or a
 * successful two-client integration test. In particular, a station ore grant
 * to a WAREHOUSE corporation is not an input owned by a different factory
 * corporation: no free cross-corporation minerals are assumed.
 */
const OP=/^npc-manufacture:[0-9a-f]{32}$/;
const REF=/^coop-refine:v1:[0-9]+:[0-9]+$/;
const POS=x=>Number.isSafeInteger(x)&&x>0;
const NN=x=>Number.isSafeInteger(x)&&x>=0;
const BLOCK=(reason,operationID)=>Object.freeze({status:"BLOCKED",reason,
 operationID,nativeMutation:false,readOnly:true,realNativeE2E:false});
const immutable=x=>JSON.stringify(x);
function createLivingWorldNativeChainProof({
 readMiningCommit,readHaulReceipt,readStationReceipt,readRefineryReceipt,
 readOriginalIndustryJob,readIndustryDebit,readDirectorJournal,
 readOriginalTitleTransfer=null,readOriginalCorporation=null,
 saleAudit,clock=()=>Date.now()
}={}){
 if([readMiningCommit,readHaulReceipt,readStationReceipt,readRefineryReceipt,
      readOriginalIndustryJob,readIndustryDebit,readDirectorJournal,clock]
     .some(x=>typeof x!=="function")||
    typeof saleAudit?.audit!=="function"||
    (readOriginalTitleTransfer!==null&&typeof readOriginalTitleTransfer!=="function")||
    (readOriginalCorporation!==null&&typeof readOriginalCorporation!=="function")||
    ((readOriginalTitleTransfer===null)!==(readOriginalCorporation===null)))
  throw Error("LW04D_ORIGINAL_READ_AUTHORITIES_REQUIRED");
 async function audit({operationID,ownerID,stationID,systemID,
  miningOperationKey,cargoID,oreItemID,refineOperationID,oreTypeID,
  mineralTypeID,orderID}={}){
  if(!OP.test(operationID||"")||!POS(ownerID)||!POS(stationID)||
     !POS(systemID)||!POS(cargoID)||!POS(oreItemID)||
     !POS(oreTypeID)||!POS(mineralTypeID)||!POS(orderID)||
     typeof miningOperationKey!=="string"||
     !/^coopMiningCycle:[0-9a-f]{64}$/.test(miningOperationKey)||
     !REF.test(refineOperationID||""))
   return BLOCK("LW04D_SOURCE_SCOPE_INVALID",operationID);
  try{
   const reader=(fn,...args)=>{
    const out=fn(...args);
    if(out&&typeof out.then==="function")
     throw Error("LW04D_SOURCE_READER_ASYNC_UNSUPPORTED");
    return out;
   };
   const now=clock();
   if(!POS(now))throw Error("LW04D_CLOCK_UNVERIFIED");
   // ALIFE-07: the physical rock and native miner cargoID are written in
   // the same original GameStore two-table SQLite COMMIT.
   const mine=reader(readMiningCommit,miningOperationKey);
   if(mine?.version!==1||mine.status!=="COMMITTED"||
      !POS(mine.shipID)||!POS(mine.rockID)||!POS(mine.ownerID)||
      mine.systemID!==systemID||mine.cargoID!==cargoID||
      mine.oreTypeID!==oreTypeID||!POS(mine.quantity)||
      !NN(mine.beforeCargo)||mine.beforeCargo!==0||
      mine.nextCargo!==mine.quantity||
      mine.beforeRock-mine.afterRock!==mine.quantity+mine.wasted||
      !NN(mine.afterRock)||!NN(mine.wasted))
    throw Error("LW04D_NATIVE_ASTEROID_TO_MINER_UNVERIFIED");
   // ALIFE-10: custody of the SAME original cargoID migrates from the
   // miner to the hauler atomically, with its native receipt.
   const haul=reader(readHaulReceipt,cargoID);
   if(haul?.version!==1||haul.status!=="COMMITTED"||
      haul.cargoID!==cargoID||haul.systemID!==systemID||
      haul.minerID!==mine.shipID||!POS(haul.haulerID)||
      !POS(haul.fleetID)||haul.quantity!==mine.quantity||
      haul.typeID!==oreTypeID||haul.sourceOwnerID!==mine.ownerID||
      !POS(haul.haulerOwnerID)||
      !/^[0-9a-f]{64}$/.test(String(haul.beforeHash||""))||
      !/^[0-9a-f]{64}$/.test(String(haul.afterHash||"")))
    throw Error("LW04D_MINER_HAULER_NATIVE_CUSTODY_UNVERIFIED");
   // ALIFE-09: this journal is a warehouse stock grant and may have a
   // DIFFERENT owner from the NPC manufacturer. Nothing may silently
   // transfer that warehouse stock to another corporation.
   const ore=reader(readStationReceipt,cargoID);
   if(ore?.phase!=="COMPLETED"||ore.cargoID!==cargoID||
      ore.stationID!==stationID||ore.systemID!==systemID||
      ore.haulerID!==haul.haulerID||ore.fleetID!==haul.fleetID||
      ore.typeID!==oreTypeID||ore.quantity!==mine.quantity||
      ore.after-ore.before!==ore.quantity||
      !NN(ore.before)||!POS(ore.after)||!POS(ore.ownerID))
    throw Error("LW04D_NATIVE_STATION_ORE_GRANT_UNVERIFIED");
   if(haul.haulerOwnerID!==ore.ownerID)
    return BLOCK("LW04E_HAULER_AND_WAREHOUSE_OWNER_DISAGREE",operationID);
   // The ALIFE-09 native station receipt credits the station WAREHOUSE,
   // not automatically the factory corporation. Cross-owner source must
   // provide the ORIGINAL two-wallet + exact itemID transfer COMMIT.
   let title=null,originalSeller=null,originalBuyer=null;
   if(ore.ownerID!==ownerID){
    if(readOriginalTitleTransfer===null)
     return BLOCK("LW04D_WAREHOUSE_TO_MANUFACTURER_TITLE_TRANSFER_NOT_PROVEN",
      operationID);
    title=reader(readOriginalTitleTransfer,cargoID);
    if(title?.version!==1||title.phase!=="COMMITTED"||
       title.operationID!=="coop-warehouse-title:v1:"+cargoID+":"+ownerID||
       title.cargoID!==cargoID||title.sourceOwnerID!==ore.ownerID||
       title.buyerOwnerID!==ownerID||title.stationID!==stationID||
       title.typeID!==oreTypeID||title.quantity!==ore.quantity||
       title.itemID!==oreItemID||
       ore.oreItemID!==oreItemID||
       ore.sourceCustomInfo!=="coop-warehouse:v1:cargo:"+cargoID||
       title.sourceCustomInfo!=="coop-warehouse:v1:cargo:"+cargoID||
       !POS(title.priceCents)||title.sellerAfterCents-title.sellerBeforeCents!==title.priceCents||
       title.buyerBeforeCents-title.buyerAfterCents!==title.priceCents||
       !NN(title.buyerAfterCents)||!NN(title.sellerBeforeCents)||
       !POS(title.committedAt)||title.committedAt>now)
     return BLOCK("LW04E_ORIGINAL_WAREHOUSE_TITLE_NOT_ATTESTED",operationID);
    const ledger=(corporation,corporationID,other,amount,after)=>{
     const division=corporation?.wallet?.divisions?.["1000"];
     if(corporation?.corporationID!==corporationID||
        !Array.isArray(division?.transactions)||!Array.isArray(division?.journal))
      return false;
     const one=rows=>rows.filter(x=>x?.transactionID===title.operationID);
     const tx=one(division.transactions),journal=one(division.journal);
     return tx.length===1&&journal.length===1&&
      [tx[0],journal[0]].every(x=>x.referenceID===title.operationID&&
       x.ownerID1===corporationID&&x.ownerID2===other&&
       x.accountKey===1000&&Number.isFinite(x.amount)&&
       Number.isFinite(x.balance)&&
       Math.abs(x.amount*100-amount)<1e-7&&
       Math.abs(x.balance*100-after)<1e-7);
    };
    originalSeller=reader(readOriginalCorporation,ore.ownerID);
    originalBuyer=reader(readOriginalCorporation,ownerID);
    if(!ledger(originalSeller,ore.ownerID,ownerID,
        title.priceCents,title.sellerAfterCents)||
       !ledger(originalBuyer,ownerID,ore.ownerID,
        -title.priceCents,title.buyerAfterCents))
     return BLOCK("LW04E_ORIGINAL_TRANSFER_WALLET_NOT_ATTESTED",operationID);
   }
   // COOP-031: original refinery journal proves the warehouse ore marker
   // was converted to actual owned mineral itemIDs. No virtual inputs.
   const refine=reader(readRefineryReceipt,refineOperationID);
   if(refine?.version!==1||refine.phase!=="COMMITTED"||
      refine.operationID!==refineOperationID||
      refine.ownerID!==ownerID||refine.stationID!==stationID||
      refine.oreItemID!==oreItemID||refine.oreTypeID!==oreTypeID||
      refine.originalQuantity!==ore.quantity||
      refine.sourceCustomInfo!=="coop-warehouse:v1:cargo:"+cargoID||
      !Array.isArray(refine.outputs)||!Array.isArray(refine.nativeItemIDs)||
      refine.nativeItemIDs.length!==refine.outputs.length||
      !POS(refine.completedAt)||refine.completedAt>now)
    throw Error("LW04D_NATIVE_REFINERY_RECEIPT_UNVERIFIED");
   const products=refine.outputs.filter(x=>x.typeID===mineralTypeID);
   if(products.length!==1||!POS(products[0].quantity))
    throw Error("LW04D_MATERIAL_NOT_FROM_ORIGINAL_REFINERY");
   const job=reader(readOriginalIndustryJob,operationID);
   if(!job||!POS(job.jobID)||job.coopOperationID!==operationID||
      job.ownerID!==ownerID||job.stationID!==stationID||
      job.facilityID!==stationID||job.solarSystemID!==systemID||
      job.activityID!==1||job.status!==4||
      !POS(job.blueprintID)||!POS(job.productTypeID)||
      !Array.isArray(job.coopMaterialDebits)||
      !POS(job.coopDelivery?.itemID)||!POS(job.coopDelivery?.quantity)||
      job.coopDelivery.operationID!==operationID)
    throw Error("LW04D_ORIGINAL_MANUFACTURING_JOB_UNVERIFIED");
   const materials=job.coopMaterialDebits;
   if(!materials.length||materials.length>1000)
    throw Error("LW04D_ORIGINAL_INPUT_DEBIT_LEDGER_MISSING");
   const seenItems=new Set(),counts=new Map();
   for(const m of materials){
    if(!POS(m.itemID)||seenItems.has(m.itemID)||
       !POS(m.typeID)||m.ownerID!==ownerID||
       m.stationID!==stationID||!POS(m.beforeQuantity)||
       !POS(m.consumedQuantity)||!NN(m.afterQuantity)||
       m.beforeQuantity-m.consumedQuantity!==m.afterQuantity)
     throw Error("LW04D_ORIGINAL_MATERIAL_SOURCE_INVALID");
    seenItems.add(m.itemID);
    counts.set(m.typeID,(counts.get(m.typeID)||0)+m.consumedQuantity);
   }
   for(const [type,amount]of Object.entries(job.materials||{})){
    if(!POS(Number(type))||!POS(amount)||counts.get(Number(type))!==amount)
     throw Error("LW04D_INDUSTRY_BILL_AND_SOURCE_DEBITS_DIVERGED");
   }
   if([...counts].some(([type,amount])=>job.materials?.[String(type)]!==amount))
    throw Error("LW04D_UNQUOTED_MATERIAL_DEBIT");
   const material=materials.filter(m=>m.typeID===mineralTypeID&&
      m.sourceCustomInfo===refineOperationID+":mineral:"+mineralTypeID&&
      refine.nativeItemIDs.includes(m.itemID));
   if(material.length!==1||
      material[0].beforeQuantity!==products[0].quantity||
      material[0].consumedQuantity>products[0].quantity)
    throw Error("LW04D_REFINED_ITEM_NOT_NATIVE_FACTORY_INPUT");
   const debit=reader(readIndustryDebit,job.jobID);
   if(debit?.verifiedNative!==true||debit.jobID!==job.jobID||
      debit.ownerID!==ownerID||!POS(debit.transactionID)||
      !NN(debit.amountCents)||debit.amountCents!==Math.round(job.totalCost*100))
    throw Error("LW04D_ORIGINAL_MANUFACTURING_ISK_NOT_DEBITED");
   const journal=reader(readDirectorJournal);
   const entry=journal?.entries?.[operationID];
   if(journal?.version!==1||entry?.phase!=="SOLD"||
      entry.ownerID!==ownerID||entry.stationID!==stationID||
      entry.orderID!==orderID||entry.jobID!==job.jobID||
      entry.itemID!==job.coopDelivery.itemID||
      entry.quantity!==job.coopDelivery.quantity||
      entry.typeID!==job.productTypeID||
      entry.settlementProof!=="RUST_FINALIZED_GAMESTORE_BUYER_ITEM_AND_CORP_WALLET")
    throw Error("LW04D_DURABLE_PRODUCER_SOLD_NOT_ATTESTED");
   const sales=await saleAudit.audit({ownerID,stationID,operationID,orderID});
   if(sales?.status!=="ORIGINAL_FULL_SALE_ATTESTED"||
      sales.readOnly!==true||sales.nativeMutation!==false||
      sales.proof!=="RUST_FINALIZED_GAMESTORE_BUYER_ITEM_AND_CORP_WALLET"||
      sales.soldQuantity!==entry.quantity||sales.remainingQuantity!==0||
      sales.revenueCents!==entry.revenueCents||
      immutable(sales.fillIDs)!==immutable(entry.settlementFillIDs))
    throw Error("LW04D_ORIGINAL_RUST_SALE_NOT_ATTESTED");
   // Every original source was read from a single explicitly injected
   // authority. Re-read for drift; no source mutation or replay occurs.
   const after=reader(readDirectorJournal);
   const again=[
    [mine,reader(readMiningCommit,miningOperationKey)],
    [haul,reader(readHaulReceipt,cargoID)],
    [ore,reader(readStationReceipt,cargoID)],
    [refine,reader(readRefineryReceipt,refineOperationID)],
    [job,reader(readOriginalIndustryJob,operationID)],
    [debit,reader(readIndustryDebit,job.jobID)]
   ];
   if(title){
    again.push(
     [title,reader(readOriginalTitleTransfer,cargoID)],
     [originalSeller,reader(readOriginalCorporation,ore.ownerID)],
     [originalBuyer,reader(readOriginalCorporation,ownerID)]
    );
   }
   if(immutable(journal)!==immutable(after)||
      again.some(([before,current])=>immutable(before)!==immutable(current)))
    throw Error("LW04D_ORIGINAL_SOURCE_CHANGED_DURING_GATE");
   return Object.freeze({status:"SOURCE_CHAIN_ATTESTED",operationID,ownerID,
    systemID,stationID,cargoID,oreItemID,originalMinerID:mine.shipID,
    originalHaulerID:haul.haulerID,originalJobID:job.jobID,
    originalProductItemID:entry.itemID,originalRustOrderID:orderID,
    soldQuantity:entry.quantity,oreQuantity:mine.quantity,
    consumedMineralQuantity:material[0].consumedQuantity,
    titleTransferOperationID:title?.operationID??null,
    warehouseProcurementPriceCents:title?.priceCents??0,
    manufacturingCostCents:debit.amountCents,revenueCents:sales.revenueCents,
    originalFillIDs:[...sales.fillIDs],nativeMutation:false,readOnly:true,
    // This is a read-only source-contract assertion, not proof the
    // captured adapters actually ran against a native SQLite/Rust server.
    realNativeE2E:false,requiresPinnedTwoClientGate:true});
  }catch(error){
   return BLOCK("LW04D_ORIGINAL_CUSTODY_CHAIN_NOT_ATTESTED:"+
    String(error?.message||error).slice(0,110),operationID);
  }
 }
 return Object.freeze({audit,mode:"ORIGINAL_NATIVE_CHAIN_READ_ONLY",
  supportsNativeMutation:false,supportsLiveRuntime:false});
}
module.exports={createLivingWorldNativeChainProof};
