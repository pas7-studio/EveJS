"use strict";
// Real /events salvage server adapter. No client-provided wallet authority:
// exact original duo, actual hauler loss, original manifest, physical player
// ship at wreck for pickup and real docked ship for transfer.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const deny=status=>({status});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const vector=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
function createSalvageGameAuthority({readEvent,readFlight,readManifest,
 readVolunteers,readOutcomes,ledger,createTransfer,readScene,
 readPlayerShip,readDockedStation,getSessions,readSalvageOffer,
 acceptSalvage,reserveSalvage,verifyEscrow,settleSalvage,refundSalvage}={}){
 if([readEvent,readFlight,readManifest,readVolunteers,readOutcomes,
  createTransfer,readScene,readPlayerShip,readDockedStation,
  getSessions,readSalvageOffer,acceptSalvage,reserveSalvage,
  verifyEscrow,settleSalvage,refundSalvage].some(x=>typeof x!=="function")||
  !ledger||typeof ledger.witness!=="function"||
  typeof ledger.read!=="function")
  throw Error("SALVAGE_GAME_NATIVE_AUTHORITIES_REQUIRED");
 function command({session,eventID,cargoID,action}={}){
  if(process.env.EVEJS_COOP_SALVAGE_GAME!=="1")
   return deny("DISABLED");
  if(!["OFFER","ACCEPT","PICKUP","DELIVER","REFUND"].includes(action)||
   !/^convoy-\d+-\d+-\d+$/.test(String(eventID))||
   !pos(cargoID)||!pos(session?.characterID)||session.socket?.destroyed===true)
   return deny("SALVAGE_GAME_INVALID_REQUEST");
  let event,vol,flight,manifest,loss,peers;
  try{
   event=readEvent(eventID);
   vol=readVolunteers(eventID);
   const trip=event?.event?.linkedTripID;
   flight=readFlight(trip);manifest=readManifest(trip);
   loss=readOutcomes();peers=getSessions();
  }catch{return deny("SALVAGE_GAME_AUTHORITIES_UNAVAILABLE")}
  const e=event?.event,b=flight?.booking,m=manifest?.record;
  if(event?.status!=="READY"||e?.type!=="CONVOY"||
   e.stage!=="PREPARING"||e.outcome!=="DEPARTED"||
   flight?.status!=="READY"||
   !["FUNDED","REFUNDED"].includes(flight.phase)||
   manifest?.status!=="READY"||
   e.linkedTripID!==m?.key||b?.manifestKey!==m.key||
   e.systemID!==m.systemID||e.entityID!==b.haulerID||
   m.fleetID!==b.fleetID||m.corporationID!==b.corporationID||
   m.stationID!==b.stationID||
   !b.characters?.includes(session.characterID)||
   vol?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
   vol.eventID!==eventID||vol.fleetID!==b.playerFleetID||
   !vol.pilots?.some(p=>p.characterID===session.characterID)||
   !Array.isArray(peers)||peers.filter(p=>
    p?.characterID===session.characterID&&p.socket?.destroyed!==true).length!==1||
   loss?.status!=="READY"||!Array.isArray(loss.outcomes))
   return deny("SALVAGE_GAME_ORIGINAL_CONTRACT_UNVERIFIED");
  const wrecks=loss.outcomes.filter(x=>x.systemID===m.systemID&&
   x.targetID===b.haulerID&&
   ["HAULER_NATIVE_LOSS_VERIFIED","PARTIAL_STOCK_DELIVERED_THEN_HAULER_LOST"]
    .includes(x.status)&&pos(x.haulerNativeWreckID));
  if(wrecks.length!==1)return deny("SALVAGE_NATIVE_HAULER_LOSS_NOT_UNIQUE");
  const wreckID=wrecks[0].haulerNativeWreckID;
  let witness;
  try{witness=ledger.read(m.key)}
  catch{return deny("SALVAGE_ORIGINAL_WITNESS_UNAVAILABLE")}
  if(witness.status==="NOT_FOUND"){
   if(!["PICKUP","OFFER","ACCEPT"].includes(action))
    return deny("SALVAGE_ORIGINAL_WITNESS_NOT_PREPARED");
   witness=ledger.witness({manifestKey:m.key,wreckID,
    haulerID:b.haulerID,systemID:m.systemID});
   if(witness.status!=="SALVAGE_ORIGIN_DURABLE")
    return deny(witness.status);
   witness=ledger.read(m.key);
  }
  if(witness?.status!=="READY"||witness.record.wreckID!==wreckID)
   return deny("SALVAGE_ORIGINAL_WITNESS_INVALID");
  const row=witness.record.rows.find(r=>r.cargoID===cargoID);
  if(!row)return deny("SALVAGE_CARGO_NOT_IN_ORIGINAL_WRECK");
  // Do not insist that the wreck still contains physically PICKED UP
  // goods for commands on a previously escrow-funded rescue.
  // OFFER/ACCEPT always require original cargo to remain at the wreck.
  const offer=readSalvageOffer(m.key,{
   allowStarted:action==="PICKUP"||action==="DELIVER"||action==="REFUND"
  });
  if(offer?.status!=="SALVAGE_NATIVE_OFFER_READY"||
   offer.eventID!==eventID||offer.wreckID!==wreckID||
   !offer.characters.includes(session.characterID))
   return deny("SALVAGE_NATIVE_OFFER_NOT_VERIFIED");
  if(action==="OFFER")return offer;
  if(action==="REFUND")return refundSalvage(m.key);
  if(action==="ACCEPT"){
   const accepted=acceptSalvage(session,m.key);
   if(accepted?.status!=="VERIFIED_DUO_SALVAGE_ACCEPT")
    return accepted;
   return reserveSalvage(m.key);
  }
  const escrow=verifyEscrow(m.key);
  if(!["RESERVED","SETTLED"].includes(escrow?.status)||
   escrow.nativeDurable!==true)
   return deny("SALVAGE_CORPORATION_ESCROW_NOT_RESERVED");
  const ship=readPlayerShip(session);
  if(!pos(ship?.itemID)||ship.ownerID!==session.characterID)
   return deny("SALVAGE_PLAYER_SHIP_UNVERIFIED");
  const args={manifestKey:m.key,cargoID,wreckItemID:row.wreckItemID,
   quantity:row.quantity,expectedWreckID:wreckID,stationID:m.stationID,
   corporationID:m.corporationID,characterID:session.characterID,
   shipID:ship.itemID};
  let transfer;
  try{
   transfer=createTransfer({
    verifyPickupPresence:requested=>{
     const scene=readScene(session);
     const player=scene?.getEntityByID?.(requested.shipID);
     const wreck=scene?.getEntityByID?.(requested.expectedWreckID);
     if(scene?.systemID!==m.systemID||
      session._space?.systemID!==m.systemID||
      session._space?.shipID!==requested.shipID||
      session._space?.initialStateSent!==true||
      pos(readDockedStation(session))||
      player?.itemID!==requested.shipID||player.kind!=="ship"||
      player.nativeNpc===true||
      wreck?.itemID!==requested.expectedWreckID||
      wreck.nativeNpcWreck!==true||
      !vector(player.position)||!vector(wreck.position))
      return deny("NOT_AT_NATIVE_WRECK");
     const dist=distance(player.position,wreck.position);
     return {status:"LIVE_NATIVE_WRECK_PICKUP_VERIFIED",
      characterID:session.characterID,shipID:ship.itemID,
      wreckID,haulerID:b.haulerID,systemID:m.systemID,
      distanceMeters:dist};
    },
    verifyDocking:requested=>{
     const location=readDockedStation(session);
     const docked=readPlayerShip(session);
     if(location!==requested.stationID||docked?.itemID!==requested.shipID||
      docked.ownerID!==session.characterID||
      docked.locationID!==requested.stationID)
      return deny("NOT_DOCKED_WITH_ORIGINAL_SHIP");
     return {status:"LIVE_NATIVE_DOCKED_DELIVERY_VERIFIED",
      characterID:session.characterID,shipID:ship.itemID,
      stationID:requested.stationID};
    }
   });
  }catch{return deny("SALVAGE_NATIVE_TRANSFER_PROVIDER_UNAVAILABLE")}
  const result=action==="PICKUP"?transfer.pickup(args):transfer.deliver(args);
  if(action==="DELIVER"&&result?.status==="ATOMIC_NATIVE_ITEM_MOVED"&&
   escrow.status!=="SETTLED"){
   const payout=settleSalvage(m.key);
   if(["SALVAGE_NATIVE_DUO_PAID","SALVAGE_ALREADY_PAID"].includes(payout?.status))
    return {...result,payoutStatus:payout.status,
     nativePaidContractID:payout.contractID,
     nativePaidAmountISK:payout.amountISK||escrow.amountISK};
  }
  return {...result,manifestKey:m.key,cargoID,
   contractID:offer.contractID,
   playerCharacterID:session.characterID,
   escrowPaid:escrow.status==="SETTLED"};
 }
 return {command};
}
module.exports={createSalvageGameAuthority};
