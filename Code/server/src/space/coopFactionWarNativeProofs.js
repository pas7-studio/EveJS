"use strict";
// FW-002: read-only canonical SDE proof. No war, wallet or sovereignty writes.
const pos=x=>Number.isSafeInteger(x)&&x>0;
function createNativeFactionProofs({getFaction,getSystem,getGates,getGate,
 allowDeclaration=()=>false}={}){
 if([getFaction,getSystem,getGates,getGate,allowDeclaration].some(x=>typeof x!=="function"))
  throw Error("FW_NATIVE_REFERENCE_AUTHORITIES_REQUIRED");
 function faction(factionID){
  if(!pos(factionID))return false;
  try{const f=getFaction(factionID);return f?.factionID===factionID&&pos(f.militiaCorporationID)}
  catch{return false}
 }
 function territory({systemID,ownerFactionID}={}){
  if(!pos(systemID)||!faction(ownerFactionID))return false;
  try{const s=getSystem(systemID);
   return s?.solarSystemID===systemID&&s.factionID===ownerFactionID}
  catch{return false}
 }
 function declaration({warID,attackerFactionID,defenderFactionID}={}){
  if(!faction(attackerFactionID)||!faction(defenderFactionID)||
   attackerFactionID===defenderFactionID)return false;
  try{return allowDeclaration({warID,attackerFactionID,defenderFactionID})===true}
  catch{return false}
 }
 function adjacency({sourceSystemID,targetSystemID}={}){
  if(!pos(sourceSystemID)||!pos(targetSystemID)||sourceSystemID===targetSystemID)return false;
  try{
   if(getSystem(sourceSystemID)?.solarSystemID!==sourceSystemID||
      getSystem(targetSystemID)?.solarSystemID!==targetSystemID)return false;
   const gates=getGates(sourceSystemID);
   if(!Array.isArray(gates)||gates.length>100)return false;
   return gates.some(g=>{
    if(!pos(g?.itemID)||g.solarSystemID!==sourceSystemID)return false;
    const from=getGate(g.itemID);
    if(from?.itemID!==g.itemID||from.solarSystemID!==sourceSystemID||
       !pos(from.destinationID))return false;
    const to=getGate(from.destinationID);
    return to?.itemID===from.destinationID&&to.solarSystemID===targetSystemID&&
      to.destinationID===from.itemID;
   });
  }catch{return false}
 }
 return Object.freeze({territory,declaration,adjacency,
  // Native supply and objective witnesses are not installed yet.
  supply:()=>false,deployment:()=>false,objective:()=>false,capture:()=>false,
  ceasefire:()=>false});
}
module.exports={createNativeFactionProofs};
