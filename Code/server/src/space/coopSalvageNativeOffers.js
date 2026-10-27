"use strict";
// Read-only NPC-generated rescue quote based entirely on one real original
// hauler-loss witness and two verified EVE volunteers (no synthetic rewards).
const pos=x=>Number.isSafeInteger(x)&&x>0;
const deny=status=>({status});
function createSalvageOffers({readManifest,readWitness,readEvent,
 readVolunteers,readOutcomes,isNpcCorporation,getWreckItems,ratePerUnitISK=5,
 maxRewardISK=1000000}={}){
 if([readManifest,readWitness,readEvent,readVolunteers,
  readOutcomes,isNpcCorporation,getWreckItems].some(f=>typeof f!=="function")||
  !pos(ratePerUnitISK)||!pos(maxRewardISK)||maxRewardISK>1000000000)
  throw Error("SALVAGE_NATIVE_OFFER_SOURCES_REQUIRED");
 // The live wreck is required when publishing or accepting a NEW offer.
 // Already funded contracts must use the durable original manifest/quote
 // after stock moves out of the wreck into an authentic player cargo hold.
 function readOffer(manifestKey,{allowStarted=false}={}){
  if(!/^\d+-\d+-\d+$/.test(String(manifestKey)))
   return deny("SALVAGE_OFFER_INVALID_KEY");
  let manifest,witness;
  try{manifest=readManifest(manifestKey);witness=readWitness(manifestKey)}
  catch{return deny("SALVAGE_OFFER_SOURCE_UNAVAILABLE")}
  const m=manifest?.record,r=witness?.record;
  if(manifest?.status!=="READY"||m?.key!==manifestKey||
   witness?.status!=="READY"||r?.manifestKey!==manifestKey||
   m.systemID!==r.systemID||m.stationID!==r.stationID||
   m.corporationID!==r.corporationID||!isNpcCorporation(m.corporationID)||
   !Array.isArray(m.cargo)||!m.cargo.length||
   !Array.isArray(r.rows)||!r.rows.length)
   return deny("SALVAGE_OFFER_WRECK_UNVERIFIED");
  // An NPC rival or an already-completed player pickup makes the original
  // wreck source no longer available. Never reserve corporate ISK for it.
  if(!allowStarted){
   // A NEW offer must prove the original stock is actually still available.
   let nativeWreckItems;try{nativeWreckItems=getWreckItems(r.wreckID)}
   catch{return deny("SALVAGE_OFFER_NATIVE_WRECK_UNAVAILABLE")}
   if(!Array.isArray(nativeWreckItems)||
    r.rows.some(x=>nativeWreckItems.filter(w=>
     w.wreckItemID===x.wreckItemID&&w.wreckID===r.wreckID&&
     w.sourceCargoID===x.cargoID&&w.sourceKind==="cargo"&&
     w.typeID===x.typeID&&w.quantity===x.quantity).length!==1))
    return deny("SALVAGE_OFFER_SOURCE_ALREADY_RECOVERED");
  }
  // A signed STARTED contract no longer depends on the physical wreck
  // being present or queryable: the authoritative transfer and final
  // payout must validate the immutable receipt and real destination items.
  const eventID="convoy-"+m.systemID+"-"+m.fleetID+"-"+
   Math.min(...m.cargo.map(x=>x.cargoID));
  let e,v,o;try{e=readEvent(eventID);v=readVolunteers(eventID);
   o=readOutcomes()}
  catch{return deny("SALVAGE_OFFER_PLAYER_OR_LOSS_SOURCE_UNAVAILABLE")}
  if(e?.status!=="READY"||e.event?.type!=="CONVOY"||
   e.event.linkedTripID!==manifestKey||
   e.event.outcome!=="DEPARTED"||
   v?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
   v.eventID!==eventID||
   !Array.isArray(v.pilots)||v.pilots.length!==2||
   v.pilots.some(p=>!pos(p.characterID))||
   o?.status!=="READY"||
   !o.outcomes?.some(x=>x.systemID===m.systemID&&
    x.targetID===r.haulerID&&x.haulerNativeWreckID===r.wreckID&&
    ["HAULER_NATIVE_LOSS_VERIFIED",
     "PARTIAL_STOCK_DELIVERED_THEN_HAULER_LOST"].includes(x.status)))
   return deny("SALVAGE_OFFER_NATIVE_LOSS_OR_DUO_UNVERIFIED");
  const characters=v.pilots.map(p=>p.characterID).sort((a,b)=>a-b);
  if(characters[0]===characters[1])return deny("SALVAGE_OFFER_DUPLICATE_PILOTS");
  const count=r.rows.reduce((n,x)=>n+x.quantity,0);
  const amountISK=Math.min(maxRewardISK,Math.floor(count*ratePerUnitISK/2)*2);
  if(!pos(count)||!pos(amountISK)||
   !Number.isSafeInteger(count)||!Number.isSafeInteger(amountISK))
   return deny("SALVAGE_OFFER_INVALID_PAYMENT");
  return {status:"SALVAGE_NATIVE_OFFER_READY",eventID,
   manifestKey,contractID:"salvage-"+manifestKey,
   corporationID:m.corporationID,stationID:m.stationID,
   wreckID:r.wreckID,characters,amountISK,quantity:count,
   originalStacks:r.rows.length};
 }
 return {readOffer};
}
module.exports={createSalvageOffers};
