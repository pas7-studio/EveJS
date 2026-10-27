"use strict";
// Real EveJS stargate approach for autonomous, persistent NPC ships.
// No virtual system jumps, synthetic gate coordinates or fake transfers.
// Native cross-system transfer is a separate verified capability.
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const vector=p=>!!p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
// Pinned EveJS requires <=2500m SURFACE separation for player gate jumps.
const surfaceGap=(ship,gate)=>Math.max(0,distance(ship.position,gate.position)-
 Math.max(0,Number(ship.radius)||0)-Math.max(0,Number(gate.radius)||0));
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function connectedGates({sourceSystemID,targetSystemID,sourceScene,getGate}={}){
 const source=pos(sourceSystemID),target=pos(targetSystemID);
 if(!source||!target||source===target||!Array.isArray(sourceScene?.staticEntities)||
  typeof getGate!=="function")return [];
 const result=[];
 for(const entry of sourceScene.staticEntities){
  const id=pos(entry?.itemID);
  if(entry?.kind!=="stargate"||!id||!vector(entry.position))continue;
  const gate=getGate(id);
  if(!gate||Number(gate.itemID)!==id||Number(gate.solarSystemID)!==source)continue;
  const destID=pos(gate.destinationID);
  if(!destID)continue;
  const arrival=getGate(destID);
  if(!arrival||Number(arrival.itemID)!==destID||
   Number(arrival.solarSystemID)!==target||
   Number(gate.destinationSolarSystemID||target)!==target||
   Number(arrival.destinationID)!==id)continue;
  result.push({sourceGateID:id,destinationGateID:destID,
   sourceSystemID:source,destinationSystemID:target,
   position:{...entry.position},radius:Math.max(0,Number(entry.radius)||0)});
 }
 return result.sort((a,b)=>a.sourceGateID-b.sourceGateID);
}
function createGateTravel({warp,getGate,clock=()=>Date.now(),dwellMs=180000,
 approachMeters=2500,maxShipsPerTick=2,transfer=null,followEntity=null,
 orderFollow=null}={}){
 if(typeof warp!=="function"||typeof getGate!=="function"||typeof clock!=="function"||
  !Number.isSafeInteger(dwellMs)||dwellMs<30000||
  !Number.isFinite(approachMeters)||approachMeters<500||approachMeters>2500||
  !Number.isSafeInteger(maxShipsPerTick)||maxShipsPerTick<1||maxShipsPerTick>5||
  (transfer!==null&&typeof transfer!=="function"))throw Error("invalid native gate travel options");
 const pending=new Map();
 function tick({systemID,scene,assignments=[],route=[],roles={},
  getController=()=>null,blockedIDs=new Set()}={}){
  const system=pos(systemID);
  if(!system||!scene||typeof scene.getEntityByID!=="function"||!Array.isArray(route)||
   !Array.isArray(assignments)||typeof getController!=="function")
   return {status:"NO_NATIVE_SCENE",orders:[],observations:[]};
  const hop=route.indexOf(system);
  if(hop<0||route.length<2)return {status:"NO_ROUTE",orders:[],observations:[]};
  const destination=pos(route[(hop+1)%route.length]);
  if(!destination||destination===system)return {status:"NO_ROUTE",orders:[],observations:[]};
  const gates=connectedGates({sourceSystemID:system,targetSystemID:destination,sourceScene:scene,getGate});
  if(!gates.length)return {status:"NO_RECIPROCAL_NATIVE_GATE",orders:[],observations:[]};
  const now=clock(),orders=[],observations=[],candidates=[],rejections=[];
  // The native warp refuses a target that is already close (measured
  // WARP_DISTANCE_TOO_CLOSE) and a ONE-SHOT subwarp follow loses to the NPC's own
  // behaviour loop, which flies the hull back home. The durable, loop-respecting
  // form is a native manual movement order (type follow) on the gate, so the
  // hull closes the last kilometres itself. Nothing is ever moved by hand.
  const followShip=(ship,gateID)=>{
   try{
    if(typeof orderFollow==="function"&&
     orderFollow(ship.itemID,gateID,{rangeMeters:1000})===true)return "MANUAL_FOLLOW_ORDER";
    if(typeof followEntity==="function"&&
     followEntity(ship,gateID,1000,{queueHistorySafeContract:true,
      suppressFreshAcquireReplay:true})===true)return "SUBWARP_FOLLOW";
    if(scene?.followShipEntity?.(ship,gateID,1000,
     {queueHistorySafeContract:true,suppressFreshAcquireReplay:true})===true)
     return "SUBWARP_FOLLOW";
   }catch{return null}
   return null;
  };
  const reject=(a,id,reason)=>rejections.push({entityID:id,pilotID:a?.pilotID,reason});
  for(const a of assignments){
   const id=pos(a?.entityID);
   if(!id)continue;
   if(!named(a.pilotID)){reject(a,id,"PILOT_NOT_NAMED");continue}
   if(Number(a.systemID)!==system){reject(a,id,"ASSIGNMENT_SYSTEM_MISMATCH");continue}
   if(blockedIDs.has(id)){reject(a,id,"BLOCKED_BY_OWNER");continue}
   const role=String(roles[a.pilotID]?.role||a.role||"");
   if(role!=="trader"&&role!=="patrol"){reject(a,id,"ROLE_NOT_TRAVELING");continue}
   const ship=scene.getEntityByID(id);
   if(!ship){reject(a,id,"SHIP_NOT_IN_SCENE");continue}
   if(ship.kind!=="ship"){reject(a,id,"NOT_A_SHIP");continue}
   if(ship.nativeNpc!==true){reject(a,id,"NOT_A_NATIVE_NPC");continue}
   if(!vector(ship.position)){reject(a,id,"NO_REAL_POSITION");continue}
   if(ship.session?.characterID){reject(a,id,"PLAYER_SESSION");continue}
   const c=getController(id);
   if(!c){reject(a,id,"NO_NATIVE_CONTROLLER");continue}
   if(Number(c.entityID)!==id){reject(a,id,"CONTROLLER_ENTITY_MISMATCH");continue}
   if(Number(c.systemID)!==system){reject(a,id,"CONTROLLER_SYSTEM_MISMATCH");continue}
   // A hull already flying our own follow order to this gate is NOT engaged: it
   // is closing on the gate we asked it to reach.
   const followingGate=c.manualOrder?.type==="follow"&&
    Number(c.manualOrder.targetID)===Number(c.currentTargetID);
   if(Number(c.currentTargetID)>0&&!followingGate){
    reject(a,id,"CONTROLLER_ENGAGED");continue}
   if(Number(c.lastAggressorID)>0&&
      now-Number(c.lastAggressedAtMs)<120000){reject(a,id,"RECENTLY_AGGRESSED");continue}
   if(c.manualOrder?.type==="attack"){reject(a,id,"MANUAL_ATTACK_ORDER");continue}
   if(String(ship.mode||"").toUpperCase().includes("WARP")&&!followingGate){
    reject(a,id,"SHIP_WARPING:"+String(ship.mode));continue}
   if(ship.pendingWarp&&!followingGate){reject(a,id,"PENDING_WARP");continue}
   if(ship.warpState&&!followingGate){
    reject(a,id,"WARP_STATE_SET:"+String(ship.warpState));continue}
   candidates.push({id,pilotID:a.pilotID,role,ship});
  }
  let issued=0;
  for(const pilot of candidates.sort((a,b)=>a.pilotID.localeCompare(b.pilotID))){
   if(issued>=maxShipsPerTick)break;
   const key=system+":"+pilot.id;
   const old=pending.get(key);
   const gate=gates.reduce((best,g)=>!best||distance(pilot.ship.position,g.position)<
    distance(pilot.ship.position,best.position)?g:best,null);
   if(!gate)continue;
   const meters=surfaceGap(pilot.ship,gate);
   // ARRIVAL IS MEASURED BEFORE ANY RETRY WINDOW. A warp lands the hull on the
   // gate, and the native warp of the NEXT tick is refused as too close, so a
   // pending window that skipped the arrival check would hide the only moment the
   // hull really is at the gate (measured: the hull drifted 15 km per tick after
   // a successful warp and was never evaluated).
   if(meters>approachMeters&&old&&now<old.nextAt){
    reject(pilot,pilot.id,"PENDING:"+String(old.phase)+"@"+old.nextAt);
    continue;
   }
   if(meters>approachMeters){
    const result=warp(pilot.id,gate.sourceGateID,{forceImmediateStart:true,
     broadcastWarpStartToVisibleSessions:true});
    pending.set(key,{pilotID:pilot.pilotID,sourceSystemID:system,
     targetSystemID:destination,gateID:gate.sourceGateID,
     nextAt:now+(result?.success===true?dwellMs:60000),
     phase:result?.success===true?"NATIVE_GATE_WARP":"WARP_FAILED"});
    if(result?.success===true){
     issued++;orders.push({pilotID:pilot.pilotID,entityID:pilot.id,
      sourceGateID:gate.sourceGateID,targetSystemID:destination,
      action:"NATIVE_WARP_TO_REAL_GATE"});
    }else{
     const reason=String(result?.errorMsg||"NATIVE_WARP_NOT_ACCEPTED");
     // A real follow order replaces a warp the native runtime refuses because the
     // hull is already at the gate: same gate entity, real movement, and the
     // arrival is still only claimed by a measured surface gap.
     const followed=reason.includes("WARP_DISTANCE_TOO_CLOSE")?
      followShip(pilot.ship,gate.sourceGateID):null;
     if(followed){
      pending.set(key,{pilotID:pilot.pilotID,sourceSystemID:system,
       targetSystemID:destination,gateID:gate.sourceGateID,
       nextAt:now+30000,phase:"SUBWARP_APPROACH"});
      issued++;
      orders.push({pilotID:pilot.pilotID,entityID:pilot.id,
       sourceGateID:gate.sourceGateID,targetSystemID:destination,
       action:"NATIVE_SUBWARP_TO_REAL_GATE",order:followed});
      continue;
     }
     observations.push({pilotID:pilot.pilotID,entityID:pilot.id,
      sourceGateID:gate.sourceGateID,destinationGateID:gate.destinationGateID,
      destinationSystemID:destination,status:"WARP_REFUSED",reason});
    }
    continue;
   }
   // Being within actual stargate range only proves physical arrival,
   // not a system transition. Never alter virtual pilot location here.
   observations.push({pilotID:pilot.pilotID,entityID:pilot.id,
    sourceGateID:gate.sourceGateID,destinationGateID:gate.destinationGateID,
    destinationSystemID:destination,status:"AT_REAL_GATE"});
   if(!transfer){
    pending.set(key,{pilotID:pilot.pilotID,sourceSystemID:system,
     targetSystemID:destination,gateID:gate.sourceGateID,
     nextAt:now+dwellMs,phase:"AWAITING_NATIVE_TRANSFER"});
    continue;
   }
   const result=transfer({pilotID:pilot.pilotID,entityID:pilot.id,gate,
    sourceScene:scene,ship:pilot.ship,controller:getController(pilot.id)});
   if(result?.success===true&&result.verifiedSourceAbsent===true&&
    result.verifiedDestinationPresent===true&&
    Number(result.entityID)===pilot.id&&Number(result.systemID)===destination){
    pending.delete(key);issued++;
    orders.push({pilotID:pilot.pilotID,entityID:pilot.id,
     sourceGateID:gate.sourceGateID,targetSystemID:destination,
     action:"VERIFIED_NATIVE_GATE_TRANSFER"});
   }else{
    pending.set(key,{pilotID:pilot.pilotID,sourceSystemID:system,
     targetSystemID:destination,gateID:gate.sourceGateID,
     nextAt:now+60000,phase:"TRANSFER_NOT_VERIFIED"});
    // A refused crossing must name itself: the exact adapter verdict is the only
    // thing that can tell an operator which native precondition is missing.
    observations.push({pilotID:pilot.pilotID,entityID:pilot.id,
     sourceGateID:gate.sourceGateID,destinationGateID:gate.destinationGateID,
     destinationSystemID:destination,status:"TRANSFER_REFUSED",
     reason:String(result?.errorMsg||"TRANSFER_NOT_VERIFIED")});
   }
  }
  if(pending.size>500)for(const [key,p] of pending)if(p.nextAt<now-3600000)pending.delete(key);
  return {status:"OK",gateCount:gates.length,orders,observations,rejections};
 }
 function activeIDs(){
  const now=clock(),ids=new Set();
  for(const [key,p] of pending){
   if(p.nextAt<=now){
    if(now-p.nextAt>60000)pending.delete(key);
    continue;
   }
   const id=pos(key.split(":")[1]);
   if(id&&["NATIVE_GATE_WARP","AWAITING_NATIVE_TRANSFER"].includes(p.phase))
    ids.add(id);
  }
  return ids;
 }
 return {tick,activeIDs,snapshot:()=>[...pending].map(([key,p])=>({key,...p}))};
}
module.exports={connectedGates,createGateTravel};
