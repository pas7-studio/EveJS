"use strict";
// FW-005A: bind the war budget to actual NPC corp SDE identity.
// Does not publish an RPC, job, agent payment or AI spending authority.
const pos=x=>Number.isSafeInteger(x)&&x>0;
function createNativeWarTreasury({gameStore,corporationState,factionState,
 authorizeRefund=()=>false,authorizePayout=()=>false,clock=()=>Date.now(),env=process.env}={}){
 if(typeof corporationState?.getCorporationRecord!=="function"||
  typeof factionState?.getFactionIDForCorporation!=="function"||
  typeof factionState?.getFactionRecord!=="function"||
  typeof authorizeRefund!=="function"||typeof authorizePayout!=="function")
  throw Error("WAR_NATIVE_TREASURY_BINDINGS_REQUIRED");
 const {createWarTreasury}=require("./coopWarTreasury"+
  (__filename.endsWith(".js")?"":".cjs"));
 return createWarTreasury({gameStore,clock,env,authorizeRefund,authorizePayout,
  verifyCorporation({corporationID,factionID},stored){
   if(!pos(corporationID)||!pos(factionID)||
    (stored?.corporationID!==undefined&&stored.corporationID!==corporationID))return false;
   try{
    const corporation=corporationState.getCorporationRecord(corporationID),
     faction=factionState.getFactionRecord(factionID);
    // Only real NPC corporation wallets are eligible for war escrow.
    // Player corporation funds can never be selected by an AI director.
    // The wallet does not have to be the SDF militia corporation: a faction
    // that really fields ships through its own NPC corporation (ORE flies corp
    // 1000129 and has no militia corporation at all) funds from that one.
    return corporation?.corporationID===corporationID&&
     corporation.isNPC===true&&faction?.factionID===factionID&&
     factionState.getFactionIDForCorporation(corporationID)===factionID;
   }catch{return false}
  }
 });
}
module.exports={createNativeWarTreasury};
