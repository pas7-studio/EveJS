"use strict";
// COOP-043: one trusted read-side station authority. NO item/wallet/market writes.
// Every reported number is native GameStore/ItemStore/SDE/Rust evidence, tied to
// the EXACT same NPC corp, system, station, product and fresh observation.
const ESCROW_BASE=9200000000;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const count=x=>Number.isSafeInteger(x)&&x>=0;
const money=x=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&
 Number.isSafeInteger(Math.round(x*100))?Math.round(x*100):null;
const clone=x=>JSON.parse(JSON.stringify(x));
// SQL-native item moves may bypass itemStore mutation-version bumps. Compare
// canonical owned item rows too, so post-buy direct SQLite commits are visible.
const itemProof=items=>JSON.stringify(items.map(i=>[
 i.itemID,i.typeID,i.ownerID,i.locationID,i.flagID,i.quantity??null,
 i.stacksize??null,i.singleton??null,i.customInfo??null
 ]).sort((a,b)=>a[0]-b[0]));
const reason=(error,extra={})=>({authoritativeNative:false,reason:error,...extra});
const NATIVE_OP=/^npc-manufacture:[0-9a-f]{32}$/;
function createStationAuthority({getCorporation,getCorporationRuntime,getStation,getFacility,
 listOwnedItems,listJobs,listEscrow,getEscrowItem,getDefinition,getBlueprintState,
 getMaterials,getOrders,getItemVersion,clock=()=>Date.now(),
 products,maxItems=10000,maxJobs=1000,maxEscrow=1000}={}){
 const required=[getCorporation,getCorporationRuntime,getStation,getFacility,
  listOwnedItems,listJobs,listEscrow,getEscrowItem,getDefinition,getBlueprintState,
  getMaterials,getOrders,getItemVersion,clock];
 if(required.some(f=>typeof f!=="function")||!Array.isArray(products)||
  products.length<1||products.length>8||!count(maxItems)||maxItems<1||maxItems>30000||
  !count(maxJobs)||maxJobs<1||maxJobs>5000||!count(maxEscrow)||maxEscrow<1||maxEscrow>5000)
  throw Error("ALIFE_NATIVE_AUTHORITY_DEPENDENCIES");
 const seen=new Set();
 const targets=products.map(p=>{
  if(!pos(p?.typeID)||!count(p.targetStock)||p.targetStock>50000||seen.has(p.typeID))
    throw Error("ALIFE_NATIVE_TARGET_POLICY_INVALID");
  seen.add(p.typeID);return Object.freeze({typeID:p.typeID,targetStock:p.targetStock});
 }).sort((a,b)=>a.typeID-b.typeID);
 const inFlight=new Set();
 function sample(ownerID,stationID,systemID){
  const corp=getCorporation(ownerID),nativeStation=getStation(stationID),
   wallet=getCorporationRuntime(ownerID),facility=getFacility(stationID);
  if(corp?.corporationID!==ownerID||corp.isNPC!==true||
    nativeStation?.stationID!==stationID||
    nativeStation?.solarSystemID!==systemID||!pos(nativeStation.regionID)||
    wallet?.corporationID!==ownerID)
   throw Error("NPC_CORPORATION_STATION_IDENTITY_UNVERIFIED");
  const walletCents=money(wallet?.wallet?.divisions?.["1000"]?.balance);
  if(walletCents===null)throw Error("NPC_CORPORATION_WALLET_UNVERIFIED");
  const online=facility?.facilityID===stationID&&
   facility?.solarSystemID===systemID&&facility?.activities?.[1]!=null&&
   facility?.online===true;
  const items=listOwnedItems(ownerID),jobs=listJobs(ownerID),escrows=listEscrow();
  if(!Array.isArray(items)||!Array.isArray(jobs)||!Array.isArray(escrows)||
   items.length>maxItems||jobs.length>maxJobs||escrows.length>maxEscrow)
   throw Error("NATIVE_INVENTORY_JOBS_ESCROW_UNAVAILABLE");
  const itemIds=new Set(),stock=new Map();
  for(const item of items){
   if(!pos(item?.itemID)||!pos(item?.typeID)||item.ownerID!==ownerID||
      !count(item.quantity??item.stacksize)||itemIds.has(item.itemID))
    throw Error("NATIVE_STATION_ITEM_PROVENANCE_CONFLICT");
   itemIds.add(item.itemID);
   if(item.locationID===stationID&&[4,115].includes(item.flagID)){
    const type=item.typeID,quantity=Number(item.quantity??item.stacksize);
    stock.set(type,(stock.get(type)||0)+quantity);
    if(!count(stock.get(type)))throw Error("NATIVE_STATION_ITEM_QUANTITY_OVERFLOW");
   }
  }
  const jobsForStation=jobs.filter(j=>j?.ownerID===ownerID&&j?.stationID===stationID&&
    NATIVE_OP.test(String(j.coopOperationID||""))&&[1,2,3].includes(j.status));
  const uniqueJobs=new Set();
  for(const j of jobsForStation){
   if(!pos(j.jobID)||uniqueJobs.has(j.jobID)||!pos(j.productTypeID)||
      !count(j.productQuantity)||!pos(j.blueprintID)||j.activityID!==1)
    throw Error("NATIVE_STATION_JOB_PROOF_CONFLICT");
   uniqueJobs.add(j.jobID);
  }
  const ownedEscrow=escrows.filter(e=>e?.ownerId===ownerID&&
   e.stationId===stationID&&e.coopSource==="NATIVE_INDUSTRY");
  const ids=new Set();
  for(const e of ownedEscrow){
   const orderId=Number(e.orderId);
   if(!pos(orderId)||ids.has(orderId)||!pos(e.sourceItemID)||!pos(e.typeId)||
      !count(e.remainingQuantity)||e.remainingQuantity===0||
      e.isCorp!==true||e.escrowType!=="sell"||!NATIVE_OP.test(e.coopOperationID)||
      e.escrowLocationID!==ESCROW_BASE+orderId)
    throw Error("NATIVE_STATION_ESCROW_PROOF_CONFLICT");
   ids.add(orderId);
   const item=getEscrowItem(e.sourceItemID);
   if(!item||item.itemID!==e.sourceItemID||item.ownerID!==ownerID||
     item.typeID!==e.typeId||item.locationID!==e.escrowLocationID||
     item.quantity!==e.remainingQuantity||item.stacksize!==e.remainingQuantity||
     item.flagID!==4||!/^coop-industry:v1:[0-9]+$/.test(String(item.customInfo||"")))
    throw Error("NATIVE_STATION_ESCROW_CUSTODY_INVALID");
  }
  const version=getItemVersion();
  if(!count(version))throw Error("NATIVE_STATION_MUTATION_VERSION_UNAVAILABLE");
  return {ownerID,stationID,systemID,regionID:nativeStation.regionID,walletCents,
   online,items,stock,jobsForStation,ownedEscrow,version};
 }
 async function read({ownerID,stationID,systemID}={}){
  if(![ownerID,stationID,systemID].every(pos))
   return reason("NATIVE_STATION_AUTHORITY_INVALID_CONTEXT");
  const key=ownerID+":"+stationID;
  if(inFlight.has(key))return reason("NATIVE_STATION_AUTHORITY_REFRESH_BUSY");
  inFlight.add(key);
  try{
   const start=clock();if(!count(start))return reason("NATIVE_AUTHORITY_CLOCK_INVALID");
   const before=sample(ownerID,stationID,systemID);
   // Read-only Rust calls can run concurrently; one slow item type must not
   // delay the other product books or spawn an extra A-Life scheduler.
   const books=new Map(await Promise.all(targets.map(async p=>[
    p.typeID,await getOrders(before.regionID,p.typeID)])));
   const rows=[];
   for(const p of targets){
    const def=getDefinition(p.typeID);
    if(!def||def.productTypeID!==p.typeID||!pos(def.blueprintTypeID))
     throw Error("NATIVE_SDE_PRODUCT_BLUEPRINT_MISSING");
    const blueprints=before.items.filter(i=>i.locationID===stationID&&i.flagID===4&&
      i.typeID===def.blueprintTypeID&&i.singleton===1).sort((a,b)=>a.itemID-b.itemID);
    let quote=null;
    for(const bp of blueprints){
     const state=getBlueprintState(bp.itemID,bp);
     if(state?.original!==true||state.typeID!==def.blueprintTypeID||
       state.jobID||!count(state.materialEfficiency)||state.materialEfficiency>10)continue;
     const materials=getMaterials(def,1,1,{materialEfficiency:state.materialEfficiency,
      facility:getFacility(stationID),productTypeID:p.typeID});
     if(!Array.isArray(materials)||!materials.length||materials.some(m=>!pos(m.typeID)||
        !pos(m.quantity)))throw Error("NATIVE_SDE_MATERIAL_QUOTE_INVALID");
     quote=materials;break;
    }
    // No free station BPO is normal while the real BPO is installed at 2003.
    // READY delivery and listing produced goods must remain observable.
    const book=books.get(p.typeID);
    if(!book||!Array.isArray(book.sells))
     throw Error("NATIVE_RUST_MARKET_BOOK_UNAVAILABLE");
    let listed=0;const matched=new Set();
    const rowsOfType=before.ownedEscrow.filter(e=>e.typeId===p.typeID);
    for(const row of book.sells){
     if(row?.source!=="coop-npc"||row.is_corp!==true||
       Number(row.owner_id)!==ownerID||Number(row.station_id)!==stationID)continue;
     const orderID=Number(row.order_id);
     const escrow=rowsOfType.find(e=>Number(e.orderId)===orderID);
     if(!escrow||matched.has(orderID)||row.bid!==false||row.state!=="open"||
       Number(row.vol_remaining)!==escrow.remainingQuantity)
      throw Error("NATIVE_RUST_MARKET_ESCROW_MISMATCH");
     matched.add(orderID);
     listed+=row.vol_remaining;
     if(!count(listed))throw Error("NATIVE_RUST_MARKET_STOCK_OVERFLOW");
    }
    if(matched.size!==rowsOfType.length)
     throw Error("NATIVE_RUST_ESCROW_ORDER_NOT_VISIBLE");
    const inHangar=before.stock.get(p.typeID)||0;
    const unlisted=before.items.filter(i=>i.locationID===stationID&&
      [4,115].includes(i.flagID)&&i.typeID===p.typeID&&
      /^coop-industry:v1:[0-9]+$/.test(String(i.customInfo||"")))
      .reduce((sum,i)=>sum+Number(i.quantity??i.stacksize),0);
    const active=before.jobsForStation.filter(j=>j.productTypeID===p.typeID);
    // A real industry job reserves its original blueprint in installed
    // location 2003 (stock INDUSTRY_INSTALLED_LOCATION_ID). Never accept a
    // fabricated READY job without that exact corporate item custody.
    for(const j of active){
     const bp=before.items.find(i=>i.itemID===j.blueprintID);
     if(!bp||bp.ownerID!==ownerID||bp.locationID!==2003||
       bp.typeID!==def.blueprintTypeID||bp.categoryID!==9||
       bp.singleton!==1)
      throw Error("NATIVE_ACTIVE_JOB_BLUEPRINT_CUSTODY_MISSING");
    }
    // Only new installs need a free BPO. Already-paid output may still be
    // delivered/listed when the only blueprint is installed or unavailable.
    if(!quote&&active.length===0&&unlisted===0)
     throw Error("NATIVE_ORIGINAL_BLUEPRINT_QUOTE_UNAVAILABLE");
    const pending=active.reduce((s,j)=>s+j.productQuantity,0);
    const materialShortage=(quote||[]).reduce((sum,m)=>
      sum+Math.max(0,m.quantity-(before.stock.get(m.typeID)||0)),0);
    const mineralStock=(quote||[]).reduce((sum,m)=>sum+(before.stock.get(m.typeID)||0),0);
    if(![pending,materialShortage,mineralStock,unlisted].every(count))
     throw Error("NATIVE_AUTHORITY_QUANTITY_OVERFLOW");
    rows.push({typeID:p.typeID,targetStock:p.targetStock,listed,inHangar,pending,
     productShortage:Math.max(0,p.targetStock-inHangar-listed-pending),
     materialShortage,mineralStock,nativeOutputQty:unlisted,
     nativeReadyJobs:active.filter(j=>j.status===3).length,
     nativeActiveJobs:active.length,manufacturingEligible:!!quote,requirements:quote});
   }
   const after=sample(ownerID,stationID,systemID),end=clock();
   if(!count(end)||end<start||end-start>10000||
     before.version!==after.version||before.walletCents!==after.walletCents||
     itemProof(before.items)!==itemProof(after.items)||
     JSON.stringify(before.jobsForStation)!==JSON.stringify(after.jobsForStation)||
     JSON.stringify(before.ownedEscrow)!==JSON.stringify(after.ownedEscrow))
    throw Error("NATIVE_STATION_AUTHORITY_CHANGED_DURING_READ");
   // Only one product may drive one station action at a time; avoid merging
   // material quotes for unrelated blueprints and hiding a station conflict.
   rows.sort((a,b)=>b.nativeOutputQty-a.nativeOutputQty||
     b.nativeReadyJobs-a.nativeReadyJobs||
     b.productShortage-a.productShortage||a.typeID-b.typeID);
   const selected=rows[0];
   const oreAtStation=before.items.filter(i=>i.locationID===stationID&&
     [4,115].includes(i.flagID)&&i.categoryID===25)
     .reduce((sum,i)=>sum+Number(i.quantity??i.stacksize),0);
   if(!count(oreAtStation))throw Error("NATIVE_ORE_STOCK_OVERFLOW");
   return {authoritativeNative:true,source:"GAMESTORE_ITEMSTORE_SDE_RUST",
    ownerID,stationID,systemID,observedAt:end,walletCents:after.walletCents,
    productTypeID:selected.typeID,productShortage:selected.productShortage,
    oreAtStation,mineralStock:selected.mineralStock,materialShortage:selected.materialShortage,
    nativeOreToRefine:oreAtStation,nativeOutputQty:selected.nativeOutputQty,
    nativeReadyJobs:selected.nativeReadyJobs,nativeActiveJobs:selected.nativeActiveJobs,
    factoryOnline:before.online&&selected.manufacturingEligible,marketOnline:true,
    products:rows.map(({requirements,...x})=>x)};
  }catch(e){return reason(String(e?.message||"NATIVE_AUTHORITY_UNKNOWN_FAILURE").slice(0,110));}
  finally{inFlight.delete(key);}
 }
 return Object.freeze({read,mode:"NATIVE_READ_ONLY_AUTHORITY",supportsNativeMutation:false});
}
module.exports={createStationAuthority};
