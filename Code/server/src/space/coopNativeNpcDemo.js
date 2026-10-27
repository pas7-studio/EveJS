"use strict";
// Optional native EveJS NPC encounter. This is NOT X-Eve Living Universe.
// Uses the authoritative existing npcRuntime and never creates fake players.
const seenSystems = new Set();
const retryAfter=new Map();
const liveEncounterIDs=new Map();
let persistentDirector=null;
function positive(v) { const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null; }
function maybeSpawn(session,ship) {
  const persistent=process.env.EVEJS_COOP_PERSISTENT_ENCOUNTERS==="1";
  if(!persistent&&process.env.EVEJS_COOP_NATIVE_NPC_DEMO!=="1")return;
  const systemID=positive(ship?.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid);
  const allowedSystem=positive(process.env.EVEJS_COOP_NATIVE_NPC_SYSTEM_ID);
  if(!systemID||!allowedSystem||systemID!==allowedSystem)return;
  if(!ship||!positive(ship.itemID))return;
  if(!persistent&&(seenSystems.has(systemID)||Date.now()<(retryAfter.get(systemID)||0)))return;
  setImmediate(()=>{
    try {
      // Defer until after the ship's login transition. A failed spawn remains
      // suppressed for this process, preventing an unbounded retry loop.
      const npcRuntime=require("./npc/npcRuntime");
      const amount=Number(process.env.EVEJS_COOP_NATIVE_NPC_COUNT||1);
      if(!Number.isInteger(amount)||amount<1||amount>3)throw Error("NPC_COUNT must be 1..3");
      const scene=require("./runtime").ensureScene(systemID,{refreshStargates:false});
      // Never stack a new encounter on top of an existing live co-op target.
      const priorIDs=liveEncounterIDs.get(systemID)||[];
      if(priorIDs.some(id=>Boolean(scene.getEntityByID(id))))return;
      if(priorIDs.length)liveEncounterIDs.delete(systemID);
      let anchor=require("./coopNpcTopology").anchorOptions(scene);
      const partyMode=process.env.EVEJS_COOP_REQUIRE_TWO_PILOTS==="1";
      if(partyMode){
        const pilots=Array.from(scene?.sessions?.values?.()||[])
          .filter(x=>x?.characterID&&x?._space?.shipID&&x._space.initialStateSent===true)
          .map(x=>({characterID:positive(x.characterID),entity:scene.getEntityByID(positive(x._space.shipID))}))
          .filter(x=>x.characterID&&x.entity?.position);
        const unique=[...new Map(pilots.map(x=>[x.characterID,x])).values()];
        const maxDistance=Number(process.env.EVEJS_COOP_PARTY_RANGE_METERS||250000);
        let pair=null;
        for(let i=0;i<unique.length&&!pair;i++){
          for(let j=i+1;j<unique.length;j++){
            const a=unique[i].entity.position,b=unique[j].entity.position;
            const distance=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
            if(Number.isFinite(distance)&&distance<=maxDistance){pair=[unique[i],unique[j]];break;}
          }
        }
        if(!pair){
          require("./coopRuntimeProbe").observe("coop-encounter-waiting",session,ship,{
            reason:"NEED_TWO_PILOTS_SAME_GRID",observerCount:unique.length
          });
          return;
        }
        // A real ship entity anchors the NPC in the same local combat area.
        anchor={anchorEntity:pair[0].entity};
      }
      if(!anchor){console.warn("[CoopNpcDemo] no native scene anchor in",systemID);return;}
      if(!persistent){
        if(seenSystems.has(systemID)||Date.now()<(retryAfter.get(systemID)||0))return;
        // Failed attempts can retry after one minute; never flood the scene.
        retryAfter.set(systemID,Date.now()+60000);
      }
      const spawnNative=id=>npcRuntime.spawnBatchInSystem(id,{
        ...anchor,
        amount,entityType:"npc",transient:true,broadcast:true,
        defaultPoolID:"npc_hostiles",fallbackProfileID:"generic_hostile"
      });
      let result;
      if(persistent){
        if(!persistentDirector){
          const {createDirector}=require("./coopEncounterDirector");
          persistentDirector=createDirector({
            filename:process.env.EVEJS_COOP_ENCOUNTER_STATE_FILE||"/var/lib/evejs/coop-encounters.json",
            allowedSystems:[allowedSystem],
            cooldownMs:Number(process.env.EVEJS_COOP_ENCOUNTER_COOLDOWN_MS||3600000),
            maxSpawns:Number(process.env.EVEJS_COOP_ENCOUNTER_MAX_SPAWNS||24),
            spawn:spawnNative
          });
        }
        const outcome=persistentDirector.onPilotArrived(systemID);
        if(outcome.status!=="SPAWNED"){
          require("./coopRuntimeProbe").observe("native-npc-director",session,ship,{status:outcome.status,nextAt:outcome.nextAt||null});
          return;
        }
        result=outcome.result;
      } else { result=spawnNative(systemID); }
      const spawned=Array.isArray(result?.data?.spawned)?result.data.spawned:[];
      if(result?.success===true&&spawned.length){
        const liveIDs=spawned.map(x=>positive(x?.entity?.itemID)).filter(Boolean);
        if(liveIDs.length)liveEncounterIDs.set(systemID,liveIDs);
        if(!persistent)seenSystems.add(systemID);
      }
      const recipients=Array.from(scene?.sessions?.values?.()||[]).filter(x=>x?.socket?.destroyed!==true&&x?._space?.initialStateSent===true);
      const probe=require("./coopRuntimeProbe");
      probe.observe("native-npc-spawn",session,ship,{
        success:result?.success===true,
        spawnedCount:spawned.length,
        spawnedEntityIDs:spawned.map(x=>positive(x?.entity?.itemID)).filter(Boolean),
        activeObservers:recipients.length,
        observerCharacterIDs:recipients.map(x=>positive(x?.characterID)).filter(Boolean),
        error:result?.success===true?undefined:String(result?.errorMsg||"NPC_SPAWN_FAILED"),
      });
      if(result?.success===true && spawned.length){
        const npcIDs=spawned.map(x=>positive(x?.entity?.itemID)).filter(Boolean);
        const pilotShipIDs=recipients.map(x=>positive(x?._space?.shipID)).filter(Boolean);
        require("./coopCombatProbe").launch({
          scene,shipIDs:pilotShipIDs,npcIDs,probe,session,ship,
          intervalMs:1000,maxSamples:60,
          onConfirmedWreck:wreck=>{
            if(process.env.EVEJS_COOP_VIRTUAL_ECONOMY==="1"){
              require("./coopVirtualWorldRuntime").confirmedWreck(session,ship,wreck.sourceNpcID,wreck.wreckID);
            }
          }
        });
        // Give the normal EveJS visibility tick time to deliver entities.
        // Observe only; never force AddBalls or bypass watcher relevance.
        const timer=setTimeout(()=>{
          try {
            const ids=spawned.map(x=>positive(x?.entity?.itemID)).filter(Boolean);
            const observers=Array.from(scene?.sessions?.values?.()||[]).filter(x=>x?.socket?.destroyed!==true&&x?._space?.initialStateSent===true);
            probe.observe("native-npc-visibility",session,ship,{
              npcIDs:ids,
              observers:observers.map(x=>({
                characterID:positive(x.characterID),
                visibleNPCIDs:ids.filter(id=>x._space?.visibleDynamicEntityIDs?.has(id)),
              })),
            });
          }catch(err){try{console.warn("[CoopNpcDemo] visibility probe:",err.message);}catch{}}
        },2500);
        timer.unref?.();
      }
    }catch(error){
      try {console.warn("[CoopNpcDemo] spawn failed:",error.message);}catch{}
    }
  });
}
function confirmedWreck(systemID,npcID,wreckID){
  const ids=liveEncounterIDs.get(positive(systemID));
  if(!ids||!ids.includes(positive(npcID)))return false;
  const remaining=ids.filter(id=>id!==positive(npcID));
  if(remaining.length)liveEncounterIDs.set(positive(systemID),remaining);
  else liveEncounterIDs.delete(positive(systemID));
  require("./coopRuntimeProbe").observe("coop-encounter-kill",null,{
    itemID:npcID,spaceState:{systemID}
  },{npcID,wreckID});
  return true;
}
module.exports={maybeSpawn,confirmedWreck};
