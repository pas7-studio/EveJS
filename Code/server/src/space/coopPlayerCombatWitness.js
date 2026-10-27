"use strict";
// Passive proof of applied player damage from the pinned native EveJS
// killmailTracker.noteDamage call. Never changes combat, rewards or standings.
const positive = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
function observeAppliedDamage({attackerEntity, targetEntity, appliedDamage, sessions, sceneForSession, emit} = {}) {
  const amount = Number(appliedDamage);
  const attackerID = positive(attackerEntity?.itemID);
  const targetID = positive(targetEntity?.itemID);
  if (!attackerID || !targetID || attackerID === targetID ||
    attackerEntity?.kind !== "ship" || attackerEntity.nativeNpc === true ||
    targetEntity?.kind !== "ship" || targetEntity.nativeNpc !== true ||
    !Number.isFinite(amount) || amount <= 0 || !Array.isArray(sessions) ||
    typeof sceneForSession !== "function" || typeof emit !== "function")
    return {status: "NOT_VERIFIED_NATIVE_PLAYER_DAMAGE"};
  // Pinned EveJS applies damage, destroys a lethal native NPC and spawns
  // its physical wreck BEFORE calling killmailTracker.noteDamage. A strict
  // live-target-only check loses authentic one-shot/final-blow contributions.
  // Accept an already removed target ONLY with terminal native condition and
  // the matching physical native wreck still resident in the same scene.
  // A stale/replaced target, empty scene, spoofed ship or missing wreck fails.
  function witnessedVictim(scene) {
    const current = scene.getEntityByID?.(targetID);
    if (current === targetEntity) return "LIVE_NATIVE_SHIP";
    if (current != null ||
        targetEntity?.conditionState?.damage !== 1 ||
        !(scene.dynamicEntities instanceof Map)) return null;
    for (const wreck of scene.dynamicEntities.values()) {
      if (wreck?.nativeNpcWreck === true &&
          positive(wreck.itemID) &&
          positive(wreck.launcherID) === targetID &&
          scene.getEntityByID?.(positive(wreck.itemID)) === wreck)
        return "TERMINAL_NATIVE_WRECK";
    }
    return null;
  }
  // Derive identity from one real current native ship/session, never from a
  // client claim or the killmail-attacker record alone.
  const matches = sessions.flatMap(session => {
    if (!positive(session?.characterID) ||
        positive(session?._space?.shipID) !== attackerID ||
        !positive(session?._space?.systemID) ||
        session._space.initialStateSent !== true ||
        session?.socket?.destroyed === true) return [];
    const scene = sceneForSession(session);
    if (!scene || positive(scene.systemID) !== positive(session._space.systemID) ||
        scene.getEntityByID?.(attackerID) !== attackerEntity) return [];
    const victimProof = witnessedVictim(scene);
    return victimProof ? [{session, victimProof}] : [];
  });
  if(matches.length !== 1)return {status:"NO_UNIQUE_NATIVE_SHIP_OWNER"};
  const {session, victimProof} = matches[0];
  const claimedPilot=positive(attackerEntity.pilotCharacterID ?? attackerEntity.characterID);
  if(claimedPilot && claimedPilot !== positive(session.characterID))
    return {status:"PLAYER_IDENTITY_MISMATCH"};
  const receipt = {
    status:"APPLIED_NATIVE_PLAYER_DAMAGE", systemID:positive(session._space.systemID),
    characterID:positive(session.characterID),shipID:attackerID,
    victimEntityID:targetID,appliedDamage:amount,victimProof,
    source:"NATIVE_KILLMAIL_TRACKER_NOTE_DAMAGE"
  };
  try {emit(receipt);}catch(error){
    console.warn("[CoopPlayerCombatWitness] telemetry",String(error?.message||error));
    return {status:"TELEMETRY_NOT_RECORDED"};
  }
  return receipt;
}
function note(attackerEntity,targetEntity,appliedDamage){
  if(process.env.EVEJS_COOP_PLAYER_DAMAGE_EVIDENCE!=="1")return {status:"DISABLED"};
  try {
    const registry=require("../services/chat/sessionRegistry");
    const runtime=require("./runtime");
    const sessions=registry.getSessions();
    const receipt=observeAppliedDamage({attackerEntity,targetEntity,appliedDamage,
      sessions,sceneForSession:s=>runtime.getSceneForSession(s),
      emit:receipt=>{
        const written=require("./coopRuntimeProbe").observe("coop-native-player-damage",null,
          {spaceState:{systemID:receipt.systemID}},receipt);
        if(written!==true)throw Error("TELEMETRY_NOT_RECORDED");
      }});
    if(receipt?.status==="APPLIED_NATIVE_PLAYER_DAMAGE"){
      // The verified receipt is the only source of "who attacked this NPC". The
      // tactics director reads it for real self-defence and ally help when the
      // native controller did not record an aggressor.
      try{
        require("./coopNpcAggressionLedger").getSharedLedger().note({
          systemID:receipt.systemID,victimEntityID:receipt.victimEntityID,
          attackerShipID:receipt.shipID,characterID:receipt.characterID,atMs:Date.now()});
      }catch(_ledgerError){/* self-defence ledger is best effort */}
    }
    if(receipt?.status==="APPLIED_NATIVE_PLAYER_DAMAGE"&&
       process.env.EVEJS_COOP_CONVOY_OPERATIONS==="1"){
      try{
       const owners=sessions.filter(s=>Number(s?.characterID)===receipt.characterID);
       if(owners.length===1){
        const scene=runtime.getSceneForSession(owners[0]);
        const fleets=require("../services/fleets/fleetRuntime");
        const incident=require("./coopConvoyOperations").noteDamage(scene,receipt,fleets);
        if(incident.newlyConfirmedDuo||incident.newlyConfirmedWreck){
         // An authentic native receipt authorizes this ONE informational
         // message; no wallet, faction, cargo or NPC command is touched.
         const message=incident.newlyConfirmedDuo
          ?"[Living Universe] Підтверджено участь двох пілотів вашого флоту в бою з піратом біля конвою. Це ще НЕ доказ порятунку вантажу і НЕ виплата нагороди."
          :"[Living Universe] Підтверджено знищення пірата та появу реального уламка. Стан конвою й вантажу перевіряється окремо; додаткових нагород немає.";
         const chat=require("../services/chat/chatHub");
         for(const other of sessions){
          if(other?.socket?.destroyed===true||
             !incident.duoFleetID||Number(fleets.getFleetForCharacter(other?.characterID)?.fleetID)!==incident.duoFleetID||
             runtime.getSceneForSession(other)!==scene)continue;
          try{chat.sendSystemMessage(other,message)}catch(_error){}
         }
        }
       }
      }catch(error){console.warn("[CoopConvoyOperations] damage",String(error?.message||error))}
    }
    return receipt;
  }catch(error){
    console.warn("[CoopPlayerCombatWitness] native hook",String(error?.message||error));
    return {status:"UNAVAILABLE"};
  }
}
module.exports={observeAppliedDamage,note};
