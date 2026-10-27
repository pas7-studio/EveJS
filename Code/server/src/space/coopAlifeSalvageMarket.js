"use strict";
// Stage J: source-first A-Life corporate salvage seller. Runs at most ONE
// recovered or new source per existing 30s tick; never creates a scheduler,
// wallet, inventory stack, market order without original native authorities.
const positive=n=>Number.isSafeInteger(n)&&n>0;
const strict=n=>Number.isSafeInteger(n)&&n>=0;
const hold=(reason,extra={})=>({status:"ALIFE_SALVAGE_MARKET_HOLD",reason,...extra});
function quoteNativeSalvage({book,stationID,typeID,ownerID,
 maxPriceCents=100000000,minPriceCents=100}={}){
 if(!positive(stationID)||!positive(typeID)||!positive(ownerID)||
  !positive(maxPriceCents)||!positive(minPriceCents)||
  minPriceCents>maxPriceCents||
  !book||!Array.isArray(book.buys)||!Array.isArray(book.sells)||
  book.buys.length+book.sells.length>2000)
  return hold("NATIVE_RUST_ORDERBOOK_INVALID");
 function eligible(row,bid){
  if(!row||row.source==="seed"||row.source==="synthetic"||
   row.source==="virtual"||row.state!=="open"||row.bid!==bid||
   Number(row.station_id)!==stationID||
   Number(row.type_id)!==typeID||
   !positive(Number(row.owner_id))||
   Number(row.owner_id)===ownerID||
   !positive(Number(row.order_id))||
   !positive(Number(row.vol_remaining))||
   typeof row.price!=="number"||!Number.isFinite(row.price)||
   row.price<=0||row.price>1000000)return null;
  const cents=Math.round(row.price*100);
  if(!positive(cents)||cents>maxPriceCents||
   Math.abs(row.price*100-cents)>0.000001)return null;
  return {...row,priceCents:cents};
 }
 const buys=book.buys.map(x=>eligible(x,true)).filter(Boolean)
  .sort((a,b)=>b.priceCents-a.priceCents||
   Number(a.order_id)-Number(b.order_id));
 if(buys.length&&buys[0].priceCents>=minPriceCents)
  return {status:"NATIVE_MARKET_PRICE_QUOTED",
   priceCents:buys[0].priceCents,anchorOrderID:Number(buys[0].order_id),
   anchor:"REAL_NATIVE_BUY",source:"RUST_GET_ORDERS"};
 const sells=book.sells.map(x=>eligible(x,false)).filter(Boolean)
  .sort((a,b)=>a.priceCents-b.priceCents||
   Number(a.order_id)-Number(b.order_id));
 if(sells.length){
  // Compete by at most 1% against an actual offer, not an invented ticker.
  const priceCents=Math.max(minPriceCents,
   sells[0].priceCents-Math.max(1,Math.floor(sells[0].priceCents/100)));
  if(strict(priceCents)&&priceCents<=maxPriceCents&&
   priceCents<=sells[0].priceCents)
   return {status:"NATIVE_MARKET_PRICE_QUOTED",priceCents,
    anchorOrderID:Number(sells[0].order_id),
    anchor:"REAL_NATIVE_ASK",source:"RUST_GET_ORDERS"};
 }
 return hold("NO_REAL_NATIVE_MARKET_PRICE");
}
function createAlifeSalvageMarket({readJournal,readOps,getStation,
 getOrders,marketFactory,systems,clock=()=>Date.now(),
 maxPerTick=1,maxPriceCents=100000000,minPriceCents=100}={}){
 if([readJournal,readOps,getStation,getOrders,marketFactory,systems,clock]
   .some(f=>typeof f!=="function")||
   maxPerTick!==1||!positive(maxPriceCents)||!positive(minPriceCents)||
   minPriceCents>maxPriceCents)
  throw Error("ALIFE_SALVAGE_NATIVE_MARKET_AUTHORITIES_REQUIRED");
 let busy=false,last=null,completedAt=0,scanOffset=0;
 async function tick(){
  if(process.env.EVEJS_COOP_ALIFE!=="1"||
   process.env.EVEJS_COOP_ALIFE_SALVAGE_MARKET!=="1"||
   process.env.EVEJS_COOP_ALIFE_SALVAGE_RIVALS!=="1"||
   process.env.EVEJS_COOP_SALVAGE_NATIVE_MARKET!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
   process.env.EVEJS_COOP_NATIVE_NPC_MARKET_PENDING!=="1"||
   process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT_PROOF!=="1"||
   process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT!=="1")
   return {status:"ALIFE_SALVAGE_MARKET_DISABLED"};
  if(busy)return hold("PREVIOUS_NATIVE_MARKET_TICK_RUNNING");
  busy=true;
  try{
   const now=clock(),visited=systems();
   if(!positive(now)||!(visited instanceof Set)||visited.size>1000)
    return hold("NATIVE_ALIFE_SYSTEM_SOURCE_INVALID");
   let journal,ops;
   try{journal=readJournal();ops=readOps()}
   catch{return hold("NATIVE_ALIFE_CUSTODY_JOURNALS_UNAVAILABLE")}
   if(journal?.version!==1||!journal.moves||
    typeof journal.moves!=="object"||Array.isArray(journal.moves)||
    Object.keys(journal.moves).length>10000||
    ops?.version!==1||!ops.bySource||typeof ops.bySource!=="object"||
    Array.isArray(ops.bySource)||Object.keys(ops.bySource).length>10000)
    return hold("NATIVE_ALIFE_CUSTODY_JOURNALS_INVALID");
   // Recovery always wins over new business. Even an unresolved PREPARED
   // Rust ACK may mean a market-side reservation exists; don't race it.
   const unresolved=Object.entries(ops.bySource).filter(([,e])=>
    e&&e.phase!=="SOLD").sort((a,b)=>
    Number(a[1].at||0)-Number(b[1].at||0)||
    Number(a[0])-Number(b[0]));
   if(unresolved.length){
    const [key,e]=unresolved[0],id=Number(key);
    if(!positive(id)||!/^npc-salvage:[0-9a-f]{32}$/.test(e?.operationID||""))
     return hold("NATIVE_ALIFE_UNRESOLVED_SOURCE_CORRUPT");
    const station=getStation(e.stationID);
    if(!station||station.stationID!==e.stationID||
     !visited.has(station.solarSystemID))
     return hold("NATIVE_ALIFE_RECOVERY_SYSTEM_NOT_VISITED",{wreckItemID:id});
    const market=marketFactory(100);
    const result=await market.reconcile(id);
    return {status:"ALIFE_SALVAGE_MARKET_RECOVERY",wreckItemID:id,
     result,at:now};
   }
   const moves=Object.entries(journal.moves).filter(([,p])=>
    p?.state==="NPC_STOCK_DELIVERED").sort((a,b)=>
    Number(a[0])-Number(b[0]));
   // Rotate the bounded scan across ticks. Otherwise a stale/unpriced
   // 128-source prefix can permanently starve later original native stock.
   const scanCount=Math.min(128,moves.length);
   const start=moves.length?scanOffset%moves.length:0;
   if(moves.length)scanOffset=(start+scanCount)%moves.length;
   for(let i=0;i<scanCount;i++){
    const [key,p]=moves[(start+i)%moves.length];
    const id=Number(key);
    if(!positive(id)||!positive(p?.stationID)||
     p.wreckItemID!==id||!positive(p.typeID??1))continue;
    const station=getStation(p.stationID);
    if(!station||station.stationID!==p.stationID||
     !positive(station.regionID)||!positive(station.solarSystemID)||
     !visited.has(station.solarSystemID))continue;
    const inspection=marketFactory(100).inspect(id);
    if(inspection?.status!=="NATIVE_SALVAGE_STOCK_ELIGIBLE")continue;
    let book;try{
     book=await getOrders({region_id:station.regionID,
      type_id:inspection.typeID});
    }catch{return hold("NATIVE_RUST_MARKET_BOOK_UNAVAILABLE",{wreckItemID:id})}
    const priced=quoteNativeSalvage({book,stationID:p.stationID,
     typeID:inspection.typeID,ownerID:inspection.corporationID,
     maxPriceCents,minPriceCents});
    if(priced.status!=="NATIVE_MARKET_PRICE_QUOTED")continue;
    const market=marketFactory(priced.priceCents);
    const result=await market.listOnce(id);
    completedAt=now;last={id,at:now,result};
    return {status:"ALIFE_SALVAGE_MARKET_ATTEMPT",
     wreckItemID:id,priceCents:priced.priceCents,
     anchor:priced.anchor,anchorOrderID:priced.anchorOrderID,
     result,at:now};
   }
   return hold("NO_ORIGINAL_SALVAGE_WITH_REAL_MARKET_PRICE");
  }catch(error){
   return hold("ALIFE_SALVAGE_MARKET_UNEXPECTED_ERROR",{
    detail:String(error?.message||error).slice(0,100)});
  }finally{busy=false}
 }
 return Object.freeze({tick,inspect:()=>({busy,completedAt,last}),
  mode:"ONE_ACTION_PER_NATIVE_ALIFE_TICK"});
}
module.exports={createAlifeSalvageMarket,quoteNativeSalvage};
