"use strict";
// Real, bounded NPC trades against EXISTING EveJS seed market orders.
// Never place unbacked player orders, forge a session, or touch player escrow.
// All external market calls are journaled; ambiguous RPC failures halt the pilot.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
// FW-057: the earned ledger is the one real ISK store, and a war bounty can be
// owed to a real player (coop-player-<characterID>) as well as to an NPC pilot.
// The market itself still only ever names NPC pilots; this only widens the KEY,
// never a trade path.
const {isWarPilotID}=require("./coopWarPilotID" + (typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs"));
const pilotName=x=>isWarPilotID(x);
const amount=x=>Number.isFinite(Number(x))&&Number(x)>=0?Math.round(Number(x)*100)/100:null;
const vec=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const copy=x=>JSON.parse(JSON.stringify(x));
const total=(price,qty)=>Math.round(price*qty*100)/100;
const status=e=>({status:e});
function createNpcMarketTrader({call,store,registry,getStation,resolveType,sceneForSystem,getController,
 root="/var/lib/evejs/coop-native-market",clock=()=>Date.now(),
 maxQuantity=10,maxSellQuantity=100000,maxPrice=1000000,cooldownMs=300000,priceFloorFor=null}={}){
 if(typeof call!=="function"||typeof sceneForSystem!=="function"||typeof getController!=="function"||
  !store||typeof registry?.snapshot!=="function"||
  typeof getStation!=="function"||typeof resolveType!=="function"||
  !["getNativeEntity","listNativeCargoForEntity","upsertNativeCargo",
   "removeNativeCargo","allocateCargoID","buildNativeCargoItems"].every(k=>typeof store[k]==="function")||
  !Number.isSafeInteger(maxQuantity)||maxQuantity<1||maxQuantity>100||
  !Number.isSafeInteger(maxSellQuantity)||maxSellQuantity<1||maxSellQuantity>1000000||
  !Number.isFinite(maxPrice)||maxPrice<=0||
  !Number.isSafeInteger(cooldownMs)||cooldownMs<30000||
  (priceFloorFor!==null&&typeof priceFloorFor!=="function"))
  throw Error("invalid native NPC market dependencies or safety caps");
 const ledgerFile=path.join(root,"ledger.json"),active=new Set();
 let ledger;
 try{ledger=JSON.parse(fs.readFileSync(ledgerFile,"utf8"));}
 catch(e){if(e.code!=="ENOENT")throw e;ledger={version:1,pilots:{}};}
 if(ledger?.version!==1||!ledger.pilots||typeof ledger.pilots!=="object")
  throw Error("NPC_MARKET_LEDGER_INVALID");
 const txPath=id=>path.join(root,"tx",id+".json");
 const purchasePath=id=>path.join(root,"purchases",String(id)+".json");
 function atomic(file,obj){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+".tmp-"+process.pid;
  fs.writeFileSync(temp,JSON.stringify(obj));
  fs.renameSync(temp,file);
 }
 function unlink(file){try{fs.unlinkSync(file);}catch(e){if(e.code!=="ENOENT")throw e;}}
 const account=id=>{
  const a=ledger.pilots[id];
  if(!a)return {balance:0,lastTradeAt:0,tradeCount:0};
  if(amount(a.balance)===null||!Number.isFinite(a.lastTradeAt)||
   !Number.isSafeInteger(a.tradeCount)||a.tradeCount<0)throw Error("NPC_MARKET_ACCOUNT_INVALID");
  return a;
 };
 // FW-005B: the earned-ISK ledger is the only real ISK an NPC owns. A faction
 // levy (negative) and a war bounty (positive) are transfers of that same
 // value, never new ISK, so they must be exactly-once and must never be lost to
 // the in-memory copy a trade would otherwise write back.
 const adjustmentsFile=path.join(root,"adjustments.json");
 function readAdjustments(){
  try{
   const state=JSON.parse(fs.readFileSync(adjustmentsFile,"utf8"));
   if(state?.version!==1||!state.applied||typeof state.applied!=="object"||
    Array.isArray(state.applied))throw Error("NPC_MARKET_ADJUSTMENTS_INVALID");
   return state;
  }catch(e){
   if(e.code==="ENOENT")return {version:1,applied:{}};
   throw e;
  }
 }
 function reloadLedger(){
  let next;
  try{next=JSON.parse(fs.readFileSync(ledgerFile,"utf8"));}
  catch(e){
   if(e.code!=="ENOENT")throw e;
   next={version:1,pilots:{}};
  }
  if(next?.version!==1||!next.pilots||typeof next.pilots!=="object")
   throw Error("NPC_MARKET_LEDGER_INVALID");
  ledger=next;
 }
 function adjustEarned({pilotID,cents:delta,eventID,reason=""}={}){
  if(!pilotName(pilotID)||!Number.isSafeInteger(delta)||delta===0||
   !Number.isSafeInteger(clock()))return {status:"INVALID_ADJUSTMENT"};
  const id=typeof eventID==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(eventID)?
   eventID:"";
  if(!id)return {status:"INVALID_ADJUSTMENT"};
  if(!fs.existsSync(path.dirname(adjustmentsFile)))
   fs.mkdirSync(path.dirname(adjustmentsFile),{recursive:true});
  const applied=readAdjustments(),prior=applied.applied[id];
  if(prior)return prior.pilotID===pilotID&&prior.cents===delta?
   {status:"DUPLICATE",receipt:prior}:
   {status:"ADJUSTMENT_CONFLICT",eventID:id};
  // Re-read before every change: a market trade writes the whole ledger from
  // memory, so a stale copy must never overwrite a real levy or bounty.
  reloadLedger();
  const before=account(pilotID).balance;
  const afterCents=Math.round(before*100)+delta;
  if(afterCents<0)return {status:"INSUFFICIENT_EARNED_ISK",pilotID,
   balanceCents:Math.round(before*100)};
  const after=afterCents/100;
  const current=ledger.pilots[pilotID]||{balance:0,lastTradeAt:0,tradeCount:0};
  ledger.pilots[pilotID]={...current,balance:after,
   lastTradeAt:Number.isFinite(current.lastTradeAt)?current.lastTradeAt:0,
   tradeCount:Number.isSafeInteger(current.tradeCount)?current.tradeCount:0};
  atomic(ledgerFile,ledger);
  const receipt={pilotID,cents:delta,before,after,at:clock(),
   reason:String(reason||"").slice(0,80)};
  applied.applied[id]=receipt;
  atomic(adjustmentsFile,applied);
  return {status:"APPLIED",receipt};
 }
 function sameCargo(now,before,after){
  if(now===null)return after===0;
  return Number(now.quantity)===before||Number(now.quantity)===after;
 }
 function applyAck(tx){
  const entry=store.getNativeEntity(tx.entityID);
  if(!entry||Number(entry.systemID)!==Number(tx.systemID)||
   !pilotName(tx.pilotID)||!pos(tx.entityID)||
   !Number.isSafeInteger(tx.quantity)||tx.quantity<1||
   amount(tx.beforeBalance)===null||amount(tx.afterBalance)===null||
   !tx.ack||Number(tx.ack.station_id||tx.ack.stationID)!==tx.stationID)
   throw Error("NPC_MARKET_ACK_INVALID");
  const acc=account(tx.pilotID);
  if(acc.balance!==tx.beforeBalance&&acc.balance!==tx.afterBalance)
   throw Error("NPC_MARKET_BALANCE_CONFLICT");
  if(tx.side==="sell"){
   const cargo=(store.listNativeCargoForEntity(tx.entityID)||[])
    .find(c=>Number(c.cargoID)===tx.cargoID)||null;
   if(cargo&&(Number(cargo.entityID)!==tx.entityID||Number(cargo.typeID)!==tx.typeID))
    throw Error("NPC_MARKET_CARGO_IDENTITY_CHANGED");
   if(!sameCargo(cargo,tx.beforeQuantity,tx.afterQuantity))
    throw Error("NPC_MARKET_CARGO_CONFLICT");
   if(tx.afterQuantity===0&&cargo){
    const r=store.removeNativeCargo(tx.cargoID);
    if(r?.success!==true)throw Error("NPC_MARKET_CARGO_REMOVE_FAILED");
   }else if(tx.afterQuantity>0&&cargo&&Number(cargo.quantity)===tx.beforeQuantity){
    const r=store.upsertNativeCargo({...cargo,quantity:tx.afterQuantity},{transient:cargo.transient===true});
    if(r?.success!==true)throw Error("NPC_MARKET_CARGO_WRITE_FAILED");
   }else if(tx.afterQuantity>0&&!cargo)throw Error("NPC_MARKET_CARGO_MISSING");
  }else if(tx.side==="buy"){
   const cargo=(store.listNativeCargoForEntity(tx.entityID)||[])
    .find(c=>Number(c.cargoID)===tx.cargoID)||null;
   if(cargo&&(Number(cargo.entityID)!==tx.entityID||
     Number(cargo.typeID)!==tx.typeID||Number(cargo.quantity)!==tx.quantity))
    throw Error("NPC_MARKET_PURCHASE_CARGO_CONFLICT");
   if(!cargo){
    const r=store.upsertNativeCargo(copy(tx.newCargo),{transient:false});
    if(r?.success!==true)throw Error("NPC_MARKET_PURCHASE_CARGO_WRITE_FAILED");
   }
  }else throw Error("NPC_MARKET_SIDE_INVALID");
  // Source-of-truth cargo is the native store; active EveJS ships also
  // cache nativeCargoItems and mining code reads that cache directly.
  // Refresh it from authoritative store before declaring the sale settled.
  const scene=sceneForSystem(tx.systemID);
  const live=scene?.getEntityByID?.(tx.entityID);
  if(!live||live.kind!=="ship"||live.nativeNpc!==true)
   throw Error("NPC_MARKET_PHYSICAL_SHIP_MISSING");
  const items=store.buildNativeCargoItems(tx.entityID);
  if(!Array.isArray(items))throw Error("NPC_MARKET_NATIVE_CARGO_SNAPSHOT_INVALID");
  live.nativeCargoItems=items.map(item=>{
   const type=resolveType(item.typeID);
   return {...item,volume:type?.volume===null||type?.volume===undefined?
    0:Math.max(0,Number(type.volume)||0)};
  });
  // Persist verified inventory before wallet update; recovery recognizes
  // either old or final wallet balance and never applies both twice.
  if(acc.balance===tx.beforeBalance){
   ledger.pilots[tx.pilotID]={balance:tx.afterBalance,lastTradeAt:tx.at,
    tradeCount:acc.tradeCount+1};
   atomic(ledgerFile,ledger);
  }
  if(tx.side==="buy"){
   // Durable source witness for the exact cargo ID, not a new asset grant.
   // Kept after the market RPC journal is removed. If writing it fails,
   // leave RPC_ACK for recovery and do not claim resupply complete.
   const receipt={version:1,phase:"SETTLED",source:"EVEJS_SEED_MARKET",
    pilotID:tx.pilotID,entityID:tx.entityID,systemID:tx.systemID,
    cargoID:tx.cargoID,typeID:tx.typeID,quantity:tx.quantity,
    stationID:tx.stationID,marketOrderID:tx.marketOrderID,
    price:tx.price,at:tx.at};
   let earlier=null;
   try{earlier=JSON.parse(fs.readFileSync(purchasePath(tx.cargoID),"utf8"));}
   catch(e){if(e.code!=="ENOENT")throw e;}
   if(earlier&&JSON.stringify(earlier)!==JSON.stringify(receipt))
    throw Error("NPC_MARKET_PURCHASE_RECEIPT_CONFLICT");
   if(!earlier)atomic(purchasePath(tx.cargoID),receipt);
  }
  return {status:"TRADE_SETTLED",side:tx.side,pilotID:tx.pilotID,
   entityID:tx.entityID,systemID:tx.systemID,
   stationID:tx.stationID,typeID:tx.typeID,
   quantity:tx.quantity,price:tx.price,balance:tx.afterBalance,
   marketOrderID:tx.marketOrderID,
   marketOrderSource:"EVEJS_SEED",
   cargoID:tx.cargoID,
   buyReceipt:tx.side==="buy"?{
    cargoID:tx.cargoID,stationID:tx.stationID,typeID:tx.typeID,
    quantity:tx.quantity,marketOrderID:tx.marketOrderID
   }:null,
   lootSource:tx.lootSource||null,
   npcLedgerOnly:true,
   nativeCargoVerified:true,marketRPCAcknowledged:true,
   marketRPC:tx.side==="sell"?"FillOrder":"AdjustSeedStock"};
 }
 function recover(){
  let files;
  try{files=fs.readdirSync(path.join(root,"tx")).filter(x=>/^coop-pilot-[0-9]{3,}\.json$/.test(x));}
  catch(e){if(e.code==="ENOENT")return {status:"CLEAN",recovered:0};throw e;}
  const pending=[];let recovered=0;
  for(const f of files){
   const file=path.join(root,"tx",f);
   let tx;
   try{tx=JSON.parse(fs.readFileSync(file,"utf8"));}
   catch(_){pending.push({file:f,reason:"CORRUPT_JOURNAL"});continue;}
   if(tx.phase==="PREPARED"){unlink(file);recovered++;continue;}
   if(tx.phase!=="RPC_ACK"){
    pending.push({file:f,reason:"RPC_OUTCOME_UNKNOWN"});continue;
   }
   try{applyAck(tx);unlink(file);recovered++;}
   catch(e){pending.push({file:f,reason:String(e.message).slice(0,100)});}
  }
  return {status:pending.length?"NEEDS_OPERATOR_REPAIR":files.length?"RECOVERED":"CLEAN",recovered,pending};
 }
 function offer({scene,entityID,pilotID,stationID,side,typeID,
  buyTypes=[],sellTypes=[],cargoID=null,verifyCargo=null}={}){
  const id=pos(entityID),station=pos(stationID),type=pos(typeID);
  if(!id||!pilotName(pilotID)||!station||!type||
   !["buy","sell"].includes(side))return status("INVALID_TRADE");
  const link=registry.snapshot().links?.[pilotID];
  const ship=scene?.getEntityByID?.(id);
  const st=getStation(station);
  // Static station rows use stationID, not necessarily itemID or a
  // physical position. Require the matching actual EveJS scene station.
  const physicalStation=scene?.staticEntities?.find(x=>
   x?.kind==="station"&&Number(x.itemID)===station);
  if(!ship||ship.nativeNpc!==true||ship.kind!=="ship"||
   Number(link?.entityID)!==id||Number(link?.systemID)!==Number(scene.systemID)||
   !st||Number(st.stationID||st.itemID)!==station||
   Number(st.solarSystemID)!==Number(scene.systemID)||
   !physicalStation||!vec(physicalStation.position)||
   !vec(ship.position)||ship.session?.characterID||
   dist(ship.position,physicalStation.position)-
    Math.max(0,Number(physicalStation.radius)||0)-
    Math.max(0,Number(ship.radius)||0)>10000)
   return status("NOT_AT_NATIVE_STATION");
  const players=new Set(Array.from(scene?.sessions?.values?.()||[])
   .map(x=>pos(x?._space?.shipID)).filter(Boolean));
  if(players.has(id))return status("PLAYER_SHIP_EXCLUDED");
  const controller=getController(id);
  const aggressionAge=clock()-Number(controller?.lastAggressedAtMs);
  if(!controller||Number(controller.entityID)!==id||
   Number(controller.systemID)!==Number(scene.systemID)||
   Number(controller.currentTargetID)>0||controller.manualOrder?.type==="attack"||
   Number(controller.lastAggressorID)>0&&
    Number.isFinite(aggressionAge)&&aggressionAge>=0&&aggressionAge<=120000||
   String(ship.mode||"").toUpperCase().includes("WARP")||
   ship.pendingWarp||ship.warpState)return status("NATIVE_NPC_BUSY");
  if(side==="buy"&&!buyTypes.includes(type)||side==="sell"&&!sellTypes.includes(type))
   return status("TYPE_NOT_ALLOWLISTED");
  const native=store.getNativeEntity(id);
  if(!native||Number(native.systemID)!==Number(scene.systemID))return status("NATIVE_SHIP_NOT_PERSISTED");
  const stock=(store.listNativeCargoForEntity(id)||[]).filter(c=>
   Number(c.typeID)===type&&Number(c.entityID)===id&&
   Number(c.moduleID||0)===0&&c.singleton!==true&&Number(c.quantity)>0);
  // An exact cargo ID prevents a pirate from accidentally selling a different
  // native stack of the same type. Its separate durable provenance proof must
  // survive both quote and pre-RPC revalidation.
  let chosen=stock;
  if(cargoID!==null){
   const focus=pos(cargoID);
   if(side!=="sell"||!focus||typeof verifyCargo!=="function")
    return status("NATIVE_LOOT_CARGO_NOT_VERIFIED");
   chosen=stock.filter(c=>Number(c.cargoID)===focus);
   if(chosen.length!==1)return status("NATIVE_LOOT_CARGO_NOT_VERIFIED");
   let verified=false;
   try{verified=verifyCargo(chosen[0])===true;}catch(_){}
   if(!verified)return status("NATIVE_LOOT_CARGO_NOT_VERIFIED");
  }
  const balance=account(pilotID).balance;
  return {status:"ELIGIBLE",pilotID,entityID:id,stationID:station,
   systemID:Number(scene.systemID),side,typeID:type,
   native,stock:chosen,balance};
 }
 async function execute(params={},options={}){
  const pre=offer(params);
  if(pre.status!=="ELIGIBLE")return pre;
  if(active.has(pre.pilotID))return status("TRADE_BUSY");
  if(fs.existsSync(txPath(pre.pilotID)))return status("UNRESOLVED_MARKET_JOURNAL");
  const acc=account(pre.pilotID),now=clock();
  // One arrival is ONE merchant action. Liquidating several ore stacks of the
  // same real haul is not a second discretionary trade, so a continuing SELL
  // inside an explicit batch may skip the cooldown. A purchase never can.
  const withinBatch=options?.withinBatch===true&&pre.side==="sell";
  if(!withinBatch&&now<acc.lastTradeAt+cooldownMs)return status("COOLDOWN");
  active.add(pre.pilotID);
  try{
   const station=getStation(pre.stationID);
   const regionID=pos(station?.regionID);
   if(!regionID)return status("STATION_REGION_UNAVAILABLE");
   let book;
   try{book=await call("GetOrders",{region_id:regionID,type_id:pre.typeID});}
   catch(error){return {status:"MARKET_UNAVAILABLE",
    reason:String(error?.message||error).slice(0,90)};}
   // Physical ship and cargo may change while awaiting market book.
   const current=offer(params);
   if(current.status!=="ELIGIBLE"||current.balance!==pre.balance)
    return status("MARKET_PREFLIGHT_STALE");
   pre.stock=current.stock;pre.native=current.native;
   const rows=pre.side==="sell"?book?.buys:book?.sells;
   // A seller takes the BEST price on the station, not whatever row the
   // daemon happened to return first. Deepest volume breaks a tie.
   // `maxPrice` is a SPENDING cap: it must never refuse a higher bid when the
   // NPC is the seller, or a rich buyer would look like "no counterparty".
   const candidates=(Array.isArray(rows)?rows:[]).filter(x=>
    x.source==="seed"&&Number(x.station_id)===pre.stationID&&
    Number(x.type_id)===pre.typeID&&
    Number(x.vol_remaining)>=1&&Number(x.price)>0&&
    (pre.side==="sell"||Number(x.price)<=maxPrice)&&
    /^[0-9]+$/.test(String(x.order_id||"")))
    .sort((left,right)=>Number(right.price)-Number(left.price)||
     Number(right.vol_remaining)-Number(left.vol_remaining));
   const row=candidates[0];
   if(!row)return status("NO_SEEDED_COUNTERPARTY");
   // The merchant's own asking price: while a stack stays unsold the floor
   // steps down, but a bid below it is never accepted just to make a sale.
   if(pre.side==="sell"&&typeof priceFloorFor==="function"){
    let floor=0;
    try{floor=Number(priceFloorFor(pre.typeID,Number(row.price),pre.stationID));}
    catch(_error){floor=0;}
    if(Number.isFinite(floor)&&floor>0&&Number(row.price)<floor)
     return {status:"PRICE_BELOW_FLOOR",typeID:pre.typeID,stationID:pre.stationID,
      pilotID:pre.pilotID,bestBid:Number(row.price),floor:Math.round(floor*100)/100};
   }
   // Selling real ore into a real seeded bid is limited by that bid's own
   // remaining volume, exactly like a player. `maxQuantity` stays the small
   // BUY cap; a haul is liquidated against the market's actual demand.
   const cap=pre.side==="sell"?maxSellQuantity:maxQuantity;
   const price=amount(row.price),maxOrder=Math.min(cap,Number(row.vol_remaining));
   if(price===null||price<=0||maxOrder<1)return status("INVALID_SEEDED_ORDER");
   let quantity,cargo=null,newCargo=null,allocated=null;
   if(pre.side==="sell"){
    cargo=pre.stock.sort((a,b)=>Number(a.cargoID)-Number(b.cargoID))[0];
    if(!cargo)return status("NO_REAL_NATIVE_CARGO");
    quantity=Math.min(maxOrder,Number(cargo.quantity));
   }else{
    const type=resolveType(pre.typeID);
    if(!type||Number(type.typeID)!==pre.typeID||!pos(type.groupID)||!pos(type.categoryID)||
     type.volume===null||type.volume===undefined||!Number.isFinite(Number(type.volume))||Number(type.volume)<0)return status("UNKNOWN_NATIVE_ITEM_TYPE");
    const hull=resolveType(pre.native.typeID);
    const capacity=Number(hull?.capacity);
    if(!Number.isFinite(capacity)||capacity<=0)
     return status("NATIVE_CARGO_CAPACITY_UNKNOWN");
    let occupied=0;
    for(const cargoRow of store.listNativeCargoForEntity(pre.entityID)||[]){
     if(Number(cargoRow.moduleID||0)!==0)continue;
     const item=resolveType(cargoRow.typeID);
     if(item?.volume===null||item?.volume===undefined||
      !Number.isFinite(Number(item.volume))||Number(item.volume)<0||
      !Number.isSafeInteger(Number(cargoRow.quantity))||Number(cargoRow.quantity)<0)
      return status("NATIVE_CARGO_VOLUME_UNVERIFIED");
     occupied+=Number(cargoRow.quantity)*Number(item.volume);
    }
    const itemVolume=Number(type.volume);
    const free=Math.max(0,capacity-occupied);
    const allowedByVolume=itemVolume>0?Math.max(0,Math.floor((free+1e-8)/itemVolume)):maxOrder;
    quantity=Math.min(maxOrder,Math.floor(pre.balance/price),allowedByVolume);
    if(quantity<1)return status(free<itemVolume?"NATIVE_CARGO_FULL":"INSUFFICIENT_EARNED_ISK");
    allocated=store.allocateCargoID({transient:false});
    if(allocated?.success!==true||!pos(allocated.data))return status("CARGO_ID_ALLOCATION_FAILED");
    newCargo={cargoID:Number(allocated.data),entityID:pre.entityID,
     ownerID:Number(pre.native.ownerID),moduleID:0,typeID:pre.typeID,
     groupID:Number(type.groupID),categoryID:Number(type.categoryID),
     itemName:String(type.name||""),quantity,singleton:false,flagID:5,
     moduleState:null,transient:false};
   }
   const tx={version:1,phase:"PREPARED",at:now,pilotID:pre.pilotID,
    entityID:pre.entityID,systemID:pre.systemID,stationID:pre.stationID,typeID:pre.typeID,
    marketOrderID:String(row.order_id),
    side:pre.side,quantity,price,cargoID:pre.side==="sell"?Number(cargo.cargoID):Number(allocated.data),
    beforeQuantity:pre.side==="sell"?Number(cargo.quantity):0,
    afterQuantity:pre.side==="sell"?Number(cargo.quantity)-quantity:quantity,
    newCargo,beforeBalance:pre.balance,
    lootSource:params.cargoID!==null&&params.cargoID!==undefined&&
     pre.side==="sell"?{
      sourceWreckItemID:Number(cargo.sourceWreckItemID),
      sourceWreckID:Number(cargo.sourceWreckID)
     }:null,
    afterBalance:amount(pre.balance+(pre.side==="sell"?1:-1)*total(price,quantity))};
   if(tx.afterBalance===null||tx.afterBalance<0)return status("BALANCE_OVERFLOW");
   atomic(txPath(pre.pilotID),tx);
   tx.phase="RPC_CALLING";atomic(txPath(pre.pilotID),tx);
   let ack;
   try{
    ack=pre.side==="sell"?
     await call("FillOrder",{order_id:row.order_id,fill_quantity:quantity}):
     await call("AdjustSeedStock",{station_id:pre.stationID,
      type_id:pre.typeID,delta_quantity:-quantity,reason:"coop_native_npc_purchase"});
   }catch(error){
    // The daemon may have committed despite an RPC timeout. Do not retry.
    return {status:"RPC_OUTCOME_UNKNOWN",pilotID:pre.pilotID,
     error:String(error?.message||error).slice(0,120)};
   }
   // A seeded market price can move while the RPC is in flight. Never
   // settle an NPC wallet using a stale quote or a different order book row.
   const priceMatches=amount(ack?.price)===price;
   const fill=pre.side==="sell"?Number(ack?.filled_quantity)===quantity&&
    String(ack?.order_id)===String(row.order_id)&&
    ack.bid===true&&Number(ack?.station_id)===pre.stationID&&
    Number(ack?.type_id)===pre.typeID&&priceMatches:
    Number(ack?.station_id)===pre.stationID&&
    Number(ack?.type_id)===pre.typeID&&
    Number.isSafeInteger(Number(ack?.quantity))&&Number(ack.quantity)>=0&&priceMatches;
   if(!fill)return {status:"RPC_ACK_NOT_VERIFIABLE",pilotID:pre.pilotID};
   tx.ack=ack;tx.phase="RPC_ACK";atomic(txPath(pre.pilotID),tx);
   const settled=applyAck(tx);unlink(txPath(pre.pilotID));
   // Price-history updates are not necessary for inventory/wallet settlement;
   // a failed history write must never repeat a trade.
   try{await call("RecordTrade",{type_id:pre.typeID,price,quantity});}
   catch(_){}
   return settled;
  }catch(error){
   return {status:"NEEDS_MARKET_REPAIR",pilotID:pre.pilotID,
    reason:String(error?.message||error).slice(0,120)};
  }finally{active.delete(pre.pilotID);}
 }
 return {offer,execute,recover,adjustEarned,snapshot:()=>copy(ledger)};
}
module.exports={createNpcMarketTrader};
