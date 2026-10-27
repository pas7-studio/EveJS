"use strict";
// Project a virtual NPC's stable identity into the real EveJS slim item.
// The native ship/entity ID and combat stats remain owned by EveJS.
// A failed client broadcast must be retried even if the in-memory name has
// already been modified (and must not cause a new physical NPC to spawn).
const announced=new WeakMap();
function presentVirtualPilot(scene,entityID,pilot){
 if(!scene||typeof scene.getEntityByID!=="function"||!pilot?.id)return {status:"INVALID"};
 const ship=scene.getEntityByID(Number(entityID));
 if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true)return {status:"NOT_NATIVE_NPC_SHIP"};
 const roleLabels={miner:"Miner",hauler:"Hauler",trader:"Trader",patrol:"Patrol",pirate:"Pirate"};
 const role=roleLabels[pilot.role]||"";
 const base=String(pilot.name||pilot.id).trim();
 const name=(base+(role?" ["+role+"]":"")).slice(0,90);
 if(!name)return {status:"NO_NAME"};
 if(ship.coopVirtualPilotID&&ship.coopVirtualPilotID!==pilot.id)return {status:"IDENTITY_CONFLICT"};
 const key=pilot.id+"\u0000"+name;
 const changed=ship.coopVirtualPilotID!==pilot.id||ship.itemName!==name||ship.slimName!==name;
 if(!changed&&announced.get(ship)===key)return {status:"UNCHANGED",entityID:Number(entityID),name};
 ship.coopVirtualPilotID=pilot.id;
 ship.itemName=name;
 ship.slimName=name;
 // Pinned EveJS SolarSystemScene broadcasts slim-item changes using this
 // method, NOT the nonexistent sendSlimItemChangesToAllSessions API.
 if(typeof scene.broadcastSlimItemChanges!=="function")
  return {status:"BROADCAST_UNAVAILABLE",entityID:Number(entityID),name};
 try{
  scene.broadcastSlimItemChanges([ship]);
  announced.set(ship,key);
 }catch(error){
  return {status:"BROADCAST_FAILED",entityID:Number(entityID),name,
   error:String(error?.message||error).slice(0,120)};
 }
 return {status:"UPDATED",entityID:Number(entityID),name};
}
module.exports={presentVirtualPilot};
