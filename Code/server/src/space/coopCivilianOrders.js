"use strict";
// Real native ship movement for materialized virtual workers; economic ledger
// remains virtual until an authorized EveJS inventory/market bridge exists.
const {waypoints}=require("./coopNpcTopology");
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const valid=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));

// Real player ships currently on grid. A scheduled civilian route must never
// warp an NPC out from under a player who just flew up to it: the client sees
// the ship simply vanish. Sessions are the only honest source of "a human is
// here", so ghost/disconnected sessions are ignored.
function playerShipPositions(scene){
 const out=[];
 try{
  for(const session of scene?.sessions?.values?.()||[]){
   const shipID=positive(session?._space?.shipID);
   if(!shipID||session?.socket?.destroyed===true)continue;
   const ship=scene.getEntityByID?.(shipID);
   if(ship&&ship.kind==="ship"&&valid(ship.position))out.push(ship.position);
  }
 }catch{}
 return out;
}

function routeForRole(scene,role){
 const all=waypoints(scene);
 const select=kinds=>all.filter(w=>kinds.includes(w.kind));
 const prefer=kinds=>kinds.flatMap(kind=>all.filter(w=>w.kind===kind));
 switch(role){
  case "scout":return prefer(["stargate","asteroidBelt","station"]).slice(0,6);
  case "watch":return prefer(["asteroidBelt","stargate"]).slice(0,6);
  case "lay-low":return select(["station"]).slice(0,4);
  case "miner":return select(["asteroidBelt"]).concat(select(["station"])).slice(0,4);
  case "hauler":return [select(["asteroidBelt"])[0],select(["station"])[0],select(["stargate"])[0]].filter(Boolean);
  case "trader":return select(["station","stargate"]).slice(0,6);
  case "patrol":return select(["stargate","station"]).slice(0,6);
  case "pirate":return select(["asteroidBelt","stargate"]).slice(0,6);
  default:return select(["station","stargate","asteroidBelt"]).slice(0,4);
 }
}
function createCivilianOrders({sceneForSystem,warp,orbit,clock=()=>Date.now(),dwellMs=120000,playerHoldMeters=0,playerHoldRetryMs=15000,playerHoldRoles=["pirate"]}){
 if(typeof sceneForSystem!=="function"||typeof warp!=="function"||typeof orbit!=="function")throw Error("native scene and movement required");
 const holdRoles=new Set(Array.isArray(playerHoldRoles)?playerHoldRoles:["pirate"]);
 const history=new Map();
 function tick(assignments,roles={},options={}){
  const result=[];
  const playersBySystem=new Map();
  const playersFor=system=>{
   if(!(playerHoldMeters>0))return [];
   if(!playersBySystem.has(system))
    playersBySystem.set(system,playerShipPositions(sceneForSystem(system)));
   return playersBySystem.get(system);
  };
  for(const assignment of assignments||[]){
   const system=positive(assignment.systemID),id=positive(assignment.entityID);
   if(!system||!id||options.blockedIDs?.has(id))continue;
   const scene=sceneForSystem(system),ship=scene?.getEntityByID?.(id);
   if(!ship||ship.kind!=="ship")continue;
   // Never interrupt a live EveJS NPC combat controller to force a
   // scheduled trade/patrol/raid waypoint. Native combat takes priority.
   try{
     const controller=require("./npc/npcRegistry").getControllerByEntityID(id);
     if(Number(controller?.currentTargetID)>0)continue;
   }catch{} 

   // Only native movement intentions override navigation routing.
   // Never overwrite the pilot's economic role or native fleet membership.
   const requested=options.routeOverrides?.[assignment.pilotID];
   const role=["scout","watch","lay-low"].includes(requested)?requested:
     String(roles[assignment.pilotID]?.role||"patrol");
   const route=routeForRole(scene,role);
   if(!route.length)continue;
   const key=system+":"+id,previous=history.get(key)||{index:0,nextAt:0};
   if(previous.routeRole!==role){
    previous.index=0;
    if(previous.routeRole!==undefined)previous.nextAt=Math.min(previous.nextAt,clock());
    previous.routeRole=role;
   }
   if(clock()<previous.nextAt||String(ship.mode||"").toUpperCase().includes("WARP")||!valid(ship.position))continue;
   const target=route[previous.index%route.length];
   if(!target)continue;
   let order=null,action="";
   if(distance(ship.position,target.position)>250000){
    // A player on grid means an enemy stays: no scheduled warp out, so a fight
    // cannot be cancelled by a timer. Civilians keep their own routes.
    if(holdRoles.has(role)&&playersFor(system).some(p=>distance(ship.position,p)<=playerHoldMeters)){
     previous.nextAt=clock()+playerHoldRetryMs;
     history.set(key,previous);
     continue;
    }
    action="warp";order=warp(id,{...target.position},{targetEntityID:target.id});
   }else if(id!==target.id){
    action="orbit";order=orbit(id,target.id,role==="miner"?12000:15000);
   }
   previous.nextAt=clock()+(order?.success===true?dwellMs:60000);
   if(order?.success===true){
    previous.index=(previous.index+1)%route.length;
    result.push({pilotID:assignment.pilotID,entityID:id,role,action,targetID:target.id,targetKind:target.kind});
   }
   history.set(key,previous);
  }
  return result;
 }
 return {tick,snapshot:()=>[...history].map(([id,state])=>({id,...state}))};
}
module.exports={createCivilianOrders,routeForRole};
