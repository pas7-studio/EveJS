"use strict";
// Bridges persistent virtual identities to native NPC entities in an observed
// scene. A mapping is process-local: native EveJS remains authoritative.

function ids(entries){return (Array.isArray(entries)?entries:[]).map(x=>Number(x?.entity?.itemID)).filter(x=>Number.isSafeInteger(x)&&x>0);}
function createBridge({spawn,exists,limit=3,registry=null,exemptRoles=[]}){
 if(typeof spawn!=="function"||typeof exists!=="function")throw Error("native spawn and exists required");
 if(!Number.isInteger(limit)||limit<1||limit>10)throw Error("materialization limit 1..10");
 if(!Array.isArray(exemptRoles)||exemptRoles.some(x=>!["miner","hauler"].includes(x)))throw Error("unsupported exempt native role");
 const exemptions=new Set(exemptRoles);
 const assignments=new Map();
 function reconcile(systemID,pilots,{exemptEntityIDs=[]}={}){
  const current=new Set((pilots||[]).map(p=>p.id));
  // Do not delete native NPCs when virtual travel changes: they may be in
  // combat or observed. Merely release dead mappings.
  registry?.prune();
  for(const [id,entry] of assignments){
    if(!exists(entry.systemID,entry.entityID))assignments.delete(id);
  }
  const results=[];
  const stored=registry?Object.values(registry.snapshot().links).filter(x=>x.systemID===systemID&&exists(x.systemID,x.entityID)):[];
  // Roles in saved links are not proof of provenance: an old co-op-spawned
  // miner can remain linked after a configuration change. An exemption
  // needs BOTH a miner/hauler role and membership in an authoritative live
  // EveJS mining fleet; fallback co-op ships must still consume capacity.
  const nativeFleetIDs=new Set((Array.isArray(exemptEntityIDs)?exemptEntityIDs:[])
   .map(Number).filter(id=>Number.isSafeInteger(id)&&id>0));
  const isExempt=entry=>exemptions.has(entry.role)&&nativeFleetIDs.has(Number(entry.entityID));
  const occupiedEntities=new Set([
   ...Array.from(assignments.values()).filter(x=>Number(x.systemID)===Number(systemID)).map(x=>x.entityID),
   ...stored.filter(x=>!isExempt(x)).map(x=>Number(x.entityID))
  ]);
  let occupied=occupiedEntities.size;
  for(const pilot of pilots||[]){
    if(!pilot?.id||!current.has(pilot.id))continue;
    const prior=assignments.get(pilot.id)||registry?.get(pilot.id);
    if(prior&&exists(prior.systemID,prior.entityID)){
      assignments.set(pilot.id,{systemID:prior.systemID,entityID:prior.entityID});
      // A physical spawn can succeed before a durable registry write
      // fails. Retrying the link is safer than spawning another ship.
      const durable=registry?.get(pilot.id);
      if(durable&&(Number(durable.entityID)!==Number(prior.entityID)||
         Number(durable.systemID)!==Number(prior.systemID))){
        results.push({pilotID:pilot.id,error:"IDENTITY_CONFLICT",
         provisionalEntityID:prior.entityID});
        continue;
      }
      if(registry&&!durable){
        try{
          const linked=registry.link(pilot,prior.systemID,prior.entityID);
          if(Number(linked?.entityID)!==Number(prior.entityID))
           throw Error("DURABLE_IDENTITY_MISMATCH");
        }catch(error){
          results.push({pilotID:pilot.id,error:"IDENTITY_LINK_FAILED",
           nativeReason:String(error.message).slice(0,100),
           provisionalEntityID:prior.entityID});
          continue;
        }
      }
      if(Number(prior.systemID)!==Number(systemID)){
        results.push({pilotID:pilot.id,pendingTransit:true,existingSystemID:prior.systemID});
      }else results.push({pilotID:pilot.id,entityID:prior.entityID,reused:true});
      continue;
    }
    if(occupied>=limit){
      results.push({pilotID:pilot.id,error:"SPAWN_LIMIT_REACHED",
       occupied,limit});
      continue;
    }
    let result;
    try{result=spawn(systemID,pilot);}
    catch(error){
      results.push({pilotID:pilot.id,error:"NATIVE_SPAWN_THROW",
       nativeReason:String(error?.message||error).slice(0,100)});
      continue;
    }
    const entityID=ids(result?.data?.spawned)[0];
    if(result?.success!==true||!entityID){
      results.push({pilotID:pilot.id,error:String(result?.errorMsg||"SPAWN_FAILED").slice(0,120)});
      continue;
    }
    // Track the real ship immediately; never generate a second physical
    // spawn when the following identity registry persistence fails.
    assignments.set(pilot.id,{systemID,entityID});
    occupied++;
    if(registry){
      try{
        const linked=registry.link(pilot,systemID,entityID);
        if(Number(linked?.entityID)!==entityID)throw Error("DURABLE_IDENTITY_MISMATCH");
      }catch(error){
        results.push({pilotID:pilot.id,error:"IDENTITY_LINK_FAILED",
         nativeReason:String(error.message).slice(0,100),
         provisionalEntityID:entityID});
        continue;
      }
    }
    results.push({pilotID:pilot.id,entityID,reused:false});
  }
  return results;
 }
 function snapshot(){
  for(const [pilotID,value] of assignments)if(!exists(value.systemID,value.entityID))assignments.delete(pilotID);
  return Array.from(assignments,([pilotID,value])=>({pilotID,...value}));
 }
 return {reconcile,snapshot};
}
module.exports={createBridge};
