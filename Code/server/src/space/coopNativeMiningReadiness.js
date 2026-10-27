"use strict";
// Check actual pinned EveJS startup fleet slots before suppressing
// further native mining startup retries. A GM fleet or one surviving
// ship from a partial seed does NOT mean every slot was installed.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function inspect({scene,systemID,fleets=[],expectedCount=1}={}){
 const system=positive(systemID);
 if(!system||Number(scene?.systemID)!==system||
  typeof scene?.getEntityByID!=="function"||!Array.isArray(fleets)||
  !Number.isSafeInteger(expectedCount)||expectedCount<0||expectedCount>20)
  return {status:"INVALID_STARTUP_SCENE",ready:false,missingSlots:[]};
 if(expectedCount===0)
  return {status:"STARTUP_DISABLED",ready:true,missingSlots:[]};
 const liveSlots=new Set();
 for(const fleet of fleets){
  if(Number(fleet?.systemID)!==system||fleet?.source!=="startup")continue;
  const ids=[...(fleet.minerEntityIDs||[]),...(fleet.haulerEntityIDs||[])];
  const live=ids.some(raw=>{
   const id=positive(raw),ship=id&&scene.getEntityByID(id);
   return ship?.kind==="ship"&&ship.nativeNpc===true&&
    Number(ship.itemID)===id;
  });
  if(live&&typeof fleet.startupKey==="string")
   liveSlots.add(fleet.startupKey);
 }
 const missingSlots=[];
 for(let slot=1;slot<=expectedCount;slot++){
  if(!liveSlots.has(system+":"+slot))missingSlots.push(slot);
 }
 return {status:missingSlots.length?"MISSING_NATIVE_MINING_STARTUP_SLOTS":"READY",
  ready:missingSlots.length===0,systemID:system,
  presentSlots:expectedCount-missingSlots.length,expectedCount,missingSlots};
}
module.exports={inspect};
