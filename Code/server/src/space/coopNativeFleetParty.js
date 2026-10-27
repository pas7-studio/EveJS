"use strict";
// Authoritative native EveJS fleet membership for cooperative gameplay.
// Fleet invitations, leader/wing/squad roles, member opt-out and
// Warp Fleet remain owned by stock fleetRuntime, not this adapter.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
function membership({leaderSession,peerSession,fleetRuntime}={}){
 const leader=id(leaderSession?.characterID);
 const peer=id(peerSession?.characterID);
 if(!leader||!peer||leader===peer||
  leaderSession?.socket?.destroyed===true||
  peerSession?.socket?.destroyed===true)
  return {ok:false,reason:"UNAUTHENTICATED_OR_DISCONNECTED"};
 if(!fleetRuntime||typeof fleetRuntime.getFleetForCharacter!=="function"||
  typeof fleetRuntime.getMemberRecord!=="function")
  return {ok:false,reason:"NATIVE_FLEET_UNAVAILABLE"};
 const native=fleetRuntime.getFleetForCharacter(leader);
 if(!native||!id(native.fleetID)||
  fleetRuntime.getFleetForCharacter(peer)!==native)
  return {ok:false,reason:"NOT_SAME_NATIVE_FLEET"};
 const leaderMember=fleetRuntime.getMemberRecord(native,leader);
 const peerMember=fleetRuntime.getMemberRecord(native,peer);
 if(!leaderMember||!peerMember)
  return {ok:false,reason:"NOT_ACTIVE_NATIVE_FLEET_MEMBERS"};
 if(id(leaderMember.charID??leaderMember.characterID)!==leader||
    id(peerMember.charID??peerMember.characterID)!==peer)
  return {ok:false,reason:"NATIVE_FLEET_MEMBER_RECORD_MISMATCH"};
 return {ok:true,fleetID:id(native.fleetID),leaderCharacterID:leader,
  peerCharacterID:peer};
}
function inSpaceParty({leaderSession,peerSession,fleetRuntime,spaceRuntime,
 maxDistanceMeters=250000}={}){
 const member=membership({leaderSession,peerSession,fleetRuntime});
 if(!member.ok)return member;
 if(!spaceRuntime||typeof spaceRuntime.getSceneForSession!=="function"||
  !Number.isFinite(maxDistanceMeters)||maxDistanceMeters<1000)
  return {ok:false,reason:"NATIVE_SCENE_UNAVAILABLE"};
 const scene=spaceRuntime.getSceneForSession(leaderSession);
 if(!scene||scene!==spaceRuntime.getSceneForSession(peerSession)||
  id(scene.systemID)!==id(leaderSession?._space?.systemID)||
  id(scene.systemID)!==id(peerSession?._space?.systemID)||
  leaderSession?._space?.initialStateSent!==true||
  peerSession?._space?.initialStateSent!==true||
  typeof scene.sessions?.values!=="function")
  return {ok:false,reason:"NOT_SAME_READY_SCENE"};
 const sessions=[...scene.sessions.values()];
 if(!sessions.includes(leaderSession)||!sessions.includes(peerSession)||
  sessions.filter(s=>s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
   s?.characterID===member.leaderCharacterID).length!==1||
  sessions.filter(s=>s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
   s?.characterID===member.peerCharacterID).length!==1)
  return {ok:false,reason:"STALE_OR_DUPLICATE_SESSION"};
 // The selected characters can be unique while a third authenticated
 // pilot simultaneously claims one of their native physical ship IDs.
 if(!require("./coopFleetWarpSafety").uniqueOwners(
  scene,leaderSession,peerSession,id(scene.systemID)))
  return {ok:false,reason:"STALE_OR_DUPLICATE_NATIVE_OWNER"};
 const a=scene.getShipEntityForSession?.(leaderSession),
  b=scene.getShipEntityForSession?.(peerSession);
 if(!a||!b||a===b||a.kind!=="ship"||b.kind!=="ship"||
  id(a.itemID)!==id(leaderSession._space.shipID)||
  id(b.itemID)!==id(peerSession._space.shipID)||
  scene.getEntityByID?.(a.itemID)!==a||
  scene.getEntityByID?.(b.itemID)!==b||
  ![a,b].every(e=>e.position&&["x","y","z"].every(k=>Number.isFinite(e.position[k]))))
  return {ok:false,reason:"NATIVE_HULL_MISSING"};
 const distance=Math.hypot(a.position.x-b.position.x,a.position.y-b.position.y,a.position.z-b.position.z);
 if(distance>maxDistanceMeters)
  return {ok:false,reason:"TOO_FAR_FROM_TEAMMATE",distanceMeters:distance};
 return {...member,systemID:id(scene.systemID),leaderShipID:id(a.itemID),
  peerShipID:id(b.itemID),distanceMeters:distance};
}
module.exports={membership,inSpaceParty};
