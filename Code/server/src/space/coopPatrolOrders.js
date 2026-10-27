"use strict";
// Direct native NPC patrol orders. No fake damage, teleport or ownership changes.
function createPatrolOrders({orbit,exists,clock=()=>Date.now(),cooldownMs=120000}){
 if(typeof orbit!=="function"||typeof exists!=="function")throw Error("native orbit and exists required");
 const issued=new Map();
 function assign(systemID,patrolIDs,anchorID){
  if(!Number.isSafeInteger(Number(anchorID))||Number(anchorID)<=0)return {status:"NO_ANCHOR",issued:[]};
  const results=[];
  for(const npcID of patrolIDs||[]){
   if(!exists(systemID,npcID))continue;
   const key=String(systemID)+":"+npcID;
   if(clock()-(issued.get(key)||-Infinity)<cooldownMs)continue;
   const result=orbit(npcID,anchorID,10000);
   if(result?.success===true){issued.set(key,clock());results.push(npcID);}
  }
  return {status:results.length?"ORDERED":"UNCHANGED",issued:results};
 }
 return {assign};
}
module.exports={createPatrolOrders};
