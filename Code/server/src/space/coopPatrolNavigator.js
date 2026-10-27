"use strict";
// Executable patrol routes through *real* EveJS scene points of interest.
// Only native warp/orbit APIs move ships; no fake system jumps or Destiny packets.
const {waypoints}=require("./coopNpcTopology");
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createPatrolNavigator({sceneForSystem,warp,orbit,clock=()=>Date.now(),dwellMs=120000,minimumWarpMeters=250000}){
 if(typeof sceneForSystem!=="function"||typeof warp!=="function"||typeof orbit!=="function")throw Error("native patrol dependencies required");
 if(!Number.isSafeInteger(dwellMs)||dwellMs<30000)throw Error("dwellMs must be >= 30000");
 const progress=new Map();
 function tick(systemID,entityIDs,{blockedIDs=new Set()}={}){
  const system=positive(systemID),scene=system&&sceneForSystem(system);
  if(!scene||typeof scene.getEntityByID!=="function")return {status:"SCENE_NOT_FOUND",orders:[]};
  const route=waypoints(scene).slice(0,8);
  if(!route.length)return {status:"NO_REAL_WAYPOINTS",orders:[]};
  const now=clock(),ordered=[],waiting=[];
  for(const entityID of new Set(entityIDs||[])){
   const id=positive(entityID),key=system+":"+id;
   if(!id||blockedIDs.has(id))continue;
   const ship=scene.getEntityByID(id);
   if(!ship){progress.delete(key);continue;}
   const p=progress.get(key)||{nextAt:0,nextIndex:0,lastWaypoint:null};
   if(now<p.nextAt||String(ship.mode||"").toUpperCase().includes("WARP")){waiting.push(id);continue;}
   if(!validShipPosition(ship.position)){p.nextAt=now+60000;progress.set(key,p);continue;}
   // Pick a distinct real waypoint far enough for actual EveJS warp.
   let target=null,selectedIndex=p.nextIndex%route.length;
   for(let attempt=0;attempt<route.length;attempt++){
    const index=(p.nextIndex+attempt)%route.length;
    const w=route[index];
    if(distance(ship.position,w.position)>=minimumWarpMeters){
      target=w;selectedIndex=index;break;
    }
   }
   let result,action;
   if(target){
     result=warp(id,{...target.position},{targetEntityID:target.id});
     action="warp";
   }else{
     const anchor=route[p.nextIndex%route.length];
     if(anchor.id===id){p.nextAt=now+dwellMs;progress.set(key,p);continue;}
     result=orbit(id,anchor.id,15000);
     target=anchor;action="orbit";
   }
   // Even on failures, backoff: never re-issue broken warp each tick.
   p.nextAt=now+(result?.success===true?dwellMs:60000);
   if(result?.success===true){
     p.nextIndex=(selectedIndex+1)%route.length;
     p.lastWaypoint=target.id;
     ordered.push({entityID:id,action,waypointID:target.id,waypointKind:target.kind});
   }else waiting.push(id);
   progress.set(key,p);
  }
  return {status:"OK",waypointCount:route.length,orders:ordered,waiting};
 }
 return {tick,snapshot:()=>Array.from(progress,([id,p])=>({id,...p}))};
}
function validShipPosition(p){return !!p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));}
module.exports={createPatrolNavigator};
