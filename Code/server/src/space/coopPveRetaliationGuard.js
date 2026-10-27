"use strict";
// Pure PvE response authorization; native EveJS owns ships, damage and orders.
// This never initiates PvP: a real, recent attack on a physical NPC must exist.
const id=value=>Number.isSafeInteger(value)&&value>0?value:null;
const position=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const range=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function authorize({systemID,scene,victim,helper,attacker,session,
 verifiedCharacterID,aggression,witnessedAggression,now,maxRangeMeters=250000}={}){
 const system=id(systemID),character=id(verifiedCharacterID);
 if(!system||!character||!Number.isSafeInteger(now)||now<=0||
    !Number.isFinite(maxRangeMeters)||maxRangeMeters<1000||maxRangeMeters>300000||
    Number(scene?.systemID)!==system||typeof scene?.getEntityByID!=="function"||
    typeof scene?.sessions?.values!=="function")return false;
 const victimID=id(victim?.itemID),helperID=id(helper?.itemID),attackerID=id(attacker?.itemID);
 if(!victimID||!helperID||!attackerID||new Set([victimID,helperID,attackerID]).size!==3||
    victim.kind!=="ship"||victim.nativeNpc!==true||victim.session?.characterID||
    helper.kind!=="ship"||helper.nativeNpc!==true||helper.session?.characterID||
    attacker.kind!=="ship"||attacker.nativeNpc===true||
    scene.getEntityByID(victimID)!==victim||
    scene.getEntityByID(helperID)!==helper||scene.getEntityByID(attackerID)!==attacker||
    !position(victim.position)||!position(helper.position)||!position(attacker.position)||
    range(victim.position,attacker.position)>maxRangeMeters)return false;
 const nativeAggression=id(aggression?.lastAggressorID)===attackerID&&
    Number.isSafeInteger(aggression?.lastAggressedAtMs)&&
    aggression.lastAggressedAtMs<=now&&now-aggression.lastAggressedAtMs<=120000;
 // A native controller does not always record a player aggressor, so the damage
 // witness receipt is the second admissible proof. It is not a client claim: it
 // comes from the killmail tracker with a unique live session, and it must match
 // this exact system, victim, attacker ship and verified character.
 const witnessed=witnessedAggression;
 const witnessedAggressionOK=Boolean(witnessed)&&
    id(witnessed.systemID)===system&&id(witnessed.victimEntityID)===victimID&&
    id(witnessed.attackerShipID)===attackerID&&id(witnessed.characterID)===character&&
    Number.isSafeInteger(witnessed.atMs)&&witnessed.atMs<=now&&now-witnessed.atMs<=120000;
 if(!nativeAggression&&!witnessedAggressionOK)return false;
 if(!session||id(session.characterID)!==character||
    id(session?._space?.shipID)!==attackerID||
    id(session?._space?.systemID)!==system||
    session._space.initialStateSent!==true||
    !session.socket||session.socket.destroyed===true)return false;
 const live=[...scene.sessions.values()].filter(s=>s?.socket&&
    s.socket.destroyed!==true&&s?._space?.initialStateSent===true);
 return live.includes(session)&&
    live.filter(s=>id(s.characterID)===character).length===1&&
    live.filter(s=>id(s?._space?.shipID)===attackerID).length===1;
}
module.exports={authorize};
