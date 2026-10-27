"use strict";
// Actual pinned EVE services mounted only by authenticated chat action.
// Never creates offers, pays ISK, or writes to a live world when feature OFF.
let singleton,historyReader;
const deny=status=>({status});
function commandInGame(session,eventID,cargoID,action){
 if(process.env.EVEJS_COOP_SALVAGE_GAME!=="1")return deny("DISABLED");
 try{
  if(!singleton){
   const root=process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
    "/var/lib/evejs/coop-native-warehouse";
   const store=require("./npc/nativeNpcStore");
   const items=require("../services/inventory/itemStore");
   const manifest=require("./coopNativeHaulManifest").createManifest({
    root,store,items,getNativeEntity:store.getNativeEntity});
   const ledger=require("./coopSalvageProvenance").createSalvageLedger({
    root,readManifest:manifest.read,
    getWreck:store.getNativeWreck,
    getWreckItems:store.listNativeWreckItemsForWreck,
    readOriginalCargo:id=>store.listNativeEntities().some(e=>
     store.listNativeCargoForEntity(e.entityID).some(x=>x.cargoID===id)),
    readWarehouseItem:id=>Object.values(items.getAllItems()).some(x=>
     x.customInfo==="coop-warehouse:v1:cargo:"+id||
     typeof x.customInfo==="string"&&
      x.customInfo.startsWith("coop-salvage:v1:")&&
      x.customInfo.split(":").at(-2)===String(id))
   });
   const atomic=require("../gameStore").coopAtomicNativeRows;
   const offers=require("./coopSalvageNativeOffers").createSalvageOffers({
    readManifest:manifest.read,readWitness:ledger.read,
    getWreckItems:store.listNativeWreckItemsForWreck,
    readEvent:id=>require("./coopWorldOpportunityBoard").readNativeEvent(id),
    readVolunteers:id=>require("./coopEscortVolunteers").readVerifiedNativePair(id),
    readOutcomes:()=>require("./coopConvoyOutcomeProof").createOutcomes().snapshot(),
    isNpcCorporation:require("../services/corporation/corporationState")
     .isNpcCorporationID
   });
   const consent=require("./coopSalvageNativeConsent").createSalvageConsent({
    root,readQuote:offers.readOffer,
    verifyPilot:(session,manifestKey,offer)=>{
     const pair=require("./coopEscortVolunteers")
      .readVerifiedNativePair(offer.eventID);
     const sessions=require("../services/chat/sessionRegistry").getSessions();
     const fleets=require("../services/fleets/fleetRuntime");
     const fleet=fleets.getFleetForCharacter(session.characterID);
     if(pair?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
      pair.eventID!==offer.eventID||fleet?.fleetID!==pair.fleetID||
      !Array.isArray(sessions)||!Array.isArray(pair.pilots)||
      pair.pilots.length!==2||!Array.isArray(offer.characters)||
      !pair.pilots.some(p=>p.characterID===session.characterID&&
       p.shipID===session._space?.shipID)||
      !session._space?.initialStateSent||
      sessions.filter(x=>x.characterID===session.characterID&&
       x.socket?.destroyed!==true).length!==1)
      return {status:"SALVAGE_PLAYER_FLEET_NOT_VERIFIED"};
     return {status:"SALVAGE_AUTHENTIC_PILOT",
      characterID:session.characterID};
    }
   });
   const rewards=require("./coopSalvageNativeRewards")
    .createSalvageNativeRewards({
     atomic,
     isNpcCorporation:require("../services/corporation/corporationState")
      .isNpcCorporationID,
     readWitness:ledger.read,readManifest:manifest.read,
     readAcceptedDuo:consent.readDuo
    });

   historyReader=id=>rewards.history(id);
   singleton=require("./coopSalvageGameAuthority").createSalvageGameAuthority({
    readEvent:id=>require("./coopWorldOpportunityBoard").readNativeEvent(id),
    readFlight:id=>require("./coopEscortNativeBinding").routeGate().readFlight(id),
    readManifest:manifest.read,
    readVolunteers:id=>require("./coopEscortVolunteers").readVerifiedNativePair(id),
    readOutcomes:()=>require("./coopConvoyOutcomeProof").createOutcomes().snapshot(),
    ledger,
    readSalvageOffer:offers.readOffer,
    acceptSalvage:(s,id)=>consent.accept(s,id),
    reserveSalvage:id=>rewards.reserve(id),
    verifyEscrow:id=>rewards.verify(id),
    settleSalvage:id=>rewards.settle(id),
    refundSalvage:id=>rewards.refundUnstarted(id),
    readScene:s=>require("./runtime").getSceneForSession(s),
    readPlayerShip:s=>{
     const target=s?._space?.shipID||
      items.getActiveShipItem(s.characterID)?.itemID;
     return items.findItemById(target);
    },
    readDockedStation:s=>require("../services/structure/structureLocation")
     .getSessionStationID(s),
    getSessions:()=>require("../services/chat/sessionRegistry").getSessions(),
    createTransfer:({verifyPickupPresence,verifyDocking})=>
     require("./coopSalvageNativeTransfer").createNativeSalvageTransfer({
      atomic,readWitness:ledger.read,readManifest:manifest.read,
      readOriginalWreckItem:store.getNativeWreckItem,
      listNativeItems:()=>Object.values(items.getAllItems()),
      readMoveJournal:()=>{
       const r=require("../gameStore").read("corporationRuntime",
        "/coopSalvageMoves");
       return r?.success===true?r.data:null;
      },
      buildInventoryItem:items.buildInventoryItem,
      verifyPickupPresence,verifyDocking
     })
   });
  }
  return singleton.command({session,eventID,cargoID:Number(cargoID),action});
 }catch{return deny("SALVAGE_PINNED_NATIVE_MOUNT_UNAVAILABLE")}
}
// Invalid dummy event only initialises native read authorities, never writes
// to a wallet, wreck, consent or shipment. Real history reads wallet source.
function historyInGame(session){
 if(process.env.EVEJS_COOP_SALVAGE_GAME!=="1"||
  process.env.EVEJS_COOP_SALVAGE_REWARDS!=="1")
  return {status:"DISABLED",history:[]};
 if(!Number.isSafeInteger(session?.characterID)||session.characterID<=0||
  session.socket?.destroyed===true)
  return {status:"SALVAGE_HISTORY_NOT_AUTHENTICATED",history:[]};
 try{
  if(!singleton)commandInGame(session,"invalid-event",1,"OFFER");
  if(typeof historyReader!=="function")
   return {status:"SALVAGE_HISTORY_NATIVE_MOUNT_UNAVAILABLE",history:[]};
  return historyReader(session.characterID);
 }catch{return {status:"SALVAGE_HISTORY_NATIVE_MOUNT_UNAVAILABLE",history:[]}}
}
module.exports={commandInGame,historyInGame};
