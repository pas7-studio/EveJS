"use strict";
// Trusted native wiring for rescue offers and real ISK escrow.
// In-game commands can request accept/claim; they cannot define price,
// beneficiaries, wreck or station and never write a wallet directly.
const {createRescueContracts}=require("./coopRescueContracts");
function makeNativeGame(){
 const store=require("../gameStore");
 const npc=require("./npc/nativeNpcStore");
 const items=require("../services/inventory/itemStore");
 const corps=require("../services/corporation/corporationState");
 const board=require("./coopWorldOpportunityBoard");
 let game;
 const wallet=require("./coopEscortNativeFunds").createEscortNativeFunds({
  atomicRows:store.coopAtomicNativeRows,
  isNpcCorporation:corps.isNpcCorporationID,
  verifyRescueFailure:c=>game?.verifyRivalLoss(c)});
 const root=process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
  "/var/lib/evejs/coop-native-warehouse";
 const manifest=require("./coopNativeHaulManifest").createManifest({
  root,store:npc,items,getNativeEntity:npc.getNativeEntity});
 game=createRescueContracts({
  root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
  readEvent:board.readNativeEvent,
  readFlight:key=>require("./coopEscortNativeBinding").routeGate()
   .readFlight(key),
  readManifest:manifest.read,
  readOutcomes:()=>require("./coopConvoyOutcomeProof").createOutcomes().snapshot(),
  getWreck:npc.getNativeWreck,
  getWreckItems:npc.listNativeWreckItemsForWreck,
  readWarehouseItems:()=>Object.values(items.getAllItems()),
  isNpcCorporation:corps.isNpcCorporationID,
  readVolunteer:require("./coopEscortVolunteers").readVerifiedNativePair,
  nativeFunds:wallet,
  readNativeNpcCargo:()=>{
   const result=store.read("npcCargo","/cargo");
   if(!result?.success||!result.data||
    typeof result.data!=="object")throw Error("NPC_CARGO_UNAVAILABLE");
   return Object.values(result.data);
  },
  amountISK:Number(process.env.EVEJS_COOP_RESCUE_REWARD_ISK)});
 return game;
}
let instance;
function runGame(session,operation,eventID){
 if(process.env.EVEJS_COOP_RESCUE_CONTRACTS!=="1")
  return {status:"DISABLED"};
 try{
  if(!instance)instance=makeNativeGame();
  if(operation==="offer")return instance.offer(eventID);
  if(operation==="accept")return instance.accept({session,eventID});
  if(operation==="claim")return instance.claim({session,eventID});
  if(operation==="history")return instance.history({characterID:session?.characterID,limit:8});
  if(operation==="cancel")return instance.cancel({session,eventID});
  return {status:"INVALID_RESCUE_OPERATION"};
 }catch{return {status:"RESCUE_CONTRACT_RUNTIME_UNAVAILABLE"}}
}
module.exports={makeNativeGame,runGame};
