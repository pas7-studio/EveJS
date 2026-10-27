"use strict";
// FW-003C: automatically mobilize EXISTING idle native patrol ships only.
// The original 30s A-Life tick owns scheduling. No hull/ISK/ammo production,
// artificial travel, faction tag, scripted damage or invented military supply.
//
// FW-028: mobilisation is per campaign, not per world. Every live campaign is
// planned and reported on its own, and the tick budget is spent on the most
// starved campaign first, so one un-winnable border can never hide (or starve)
// another border whose two sides really are mustered.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const identifier=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(x);
const warp=s=>String(s?.mode||"").toUpperCase().includes("WARP")||
 !!(s?.pendingWarp||s?.warpState||s?.isWarping);
const enabled=env=>env.EVEJS_COOP_FACTION_WAR==="1"&&
 env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
 env.EVEJS_COOP_FACTION_WAR_MOBILIZE==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 env.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
 env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE==="1"&&
 env.EVEJS_COOP_NPC_BANK_ATOMIC==="1"&&
 (env.EVEJS_COOP_ALIFE==="1"||env.EVEJS_COOP_NPC_ORDER_ARBITER==="1");
// A dry run reports every campaign, so its own bound is much larger than the
// write budget. It never writes, so the only risk of a bigger bound is output.
const DRY_RUN_REPORT_LIMIT=64;
const SIDE_REJECT_LIMIT=6;
function createWarMobilizer({registry,readWarState,readLinks,sceneForSystem,
 getNativeEntity,getController,getFactionForCorporation,
 inspectReadiness,getOrderLeases,isTactical=()=>false,
 commandCap=null,
 clock=()=>Date.now(),env=process.env,maxPerTick=2,maxPerSide=2}={}){
 if(!registry?.snapshot||!registry?.execute||
  [readWarState,readLinks,sceneForSystem,getNativeEntity,getController,
   getFactionForCorporation,inspectReadiness,getOrderLeases,isTactical,clock]
   .some(x=>typeof x!=="function")||
  (commandCap!==null&&typeof commandCap!=="function")||
  !Number.isSafeInteger(maxPerTick)||maxPerTick<1||maxPerTick>4||
  !Number.isSafeInteger(maxPerSide)||maxPerSide<1||maxPerSide>4)
  throw Error("WAR_MOBILIZATION_NATIVE_AUTHORITIES_REQUIRED");
 let busy=false;
 function tick({systemIDs=[],dryRun=false}={}){
  if(!enabled(env))return {status:"DISABLED",mobilized:[],campaigns:[]};
  if(busy)return {status:"BUSY",mobilized:[],campaigns:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>20||systemIDs.some(x=>!pos(x)))
   return {status:"INVALID_SYSTEMS",mobilized:[],campaigns:[]};
  busy=true;
  try{
   const now=clock();
   if(!pos(now))return {status:"CLOCK_UNSAFE",mobilized:[],campaigns:[]};
   let state,assigned,links,leases;
   try{
    state=readWarState();
    assigned=registry.snapshot();
    links=readLinks();
    leases=getOrderLeases();
   }catch{return {status:"NATIVE_AUTHORITIES_UNAVAILABLE",mobilized:[],campaigns:[]}}
   if(state?.version!==1||!state.wars||!state.campaigns||
    assigned?.version!==1||!assigned.ships||
    !Array.isArray(links)||links.length>10000||
    !Array.isArray(leases)||leases.length>10000)
    return {status:"INVALID_MOBILIZATION_STATE",mobilized:[],campaigns:[]};
   const reachable=new Set(systemIDs);
   // One pass per tick instead of scanning the full identity registry
   // for every NPC candidate of every active campaign.
   const pilotCounts=new Map(),entityCounts=new Map();
   for(const l of links){
    if(named(l?.pilotID))
     pilotCounts.set(l.pilotID,(pilotCounts.get(l.pilotID)||0)+1);
    if(pos(l?.entityID))
     entityCounts.set(l.entityID,(entityCounts.get(l.entityID)||0)+1);
   }
   const candidateLinks=links.filter(l=>reachable.has(l?.systemID)&&named(l?.pilotID)&&
    pilotCounts.get(l.pilotID)===1&&pos(l.entityID)&&
    entityCounts.get(l.entityID)===1&&l.role==="patrol")
    .sort((a,b)=>a.entityID-b.entityID).slice(0,512);
   const existing=new Set(Object.keys(assigned.ships).map(Number));
   const usedPilots=new Set(Object.values(assigned.ships).map(x=>x?.pilotID));
   const mobilized=[];
   const blocked=[];
   // A hull that was released from a campaign may legitimately be mobilized into
   // it again (e.g. after it was relieved while dry and later re-armed). The
   // registry refuses a reused event ID, so the ID must identify the real
   // assignment attempt: the count of proven ASSIGN receipts already on record.
   const assignmentCounts=new Map();
   for(const receipt of Array.isArray(assigned.history)?assigned.history:[]){
    if(receipt?.type!=="ASSIGN"||!pos(receipt.entityID)||!receipt.campaignID)continue;
    const key=String(receipt.campaignID)+":"+Number(receipt.entityID);
    assignmentCounts.set(key,(assignmentCounts.get(key)||0)+1);
   }
   // Campaign IDs are user-independent server-generated records, never chat
   // input. Sort deterministically to prevent tick-order oscillations.
   const campaigns=Object.values(state.campaigns)
    .filter(c=>c&&identifier(c.campaignID)&&identifier(c.warID)&&
     ["PREPARING","ASSAULT"].includes(c.state)&&
     state.wars[c.warID]?.state==="ACTIVE")
    .sort((a,b)=>(a.startedAt||0)-(b.startedAt||0)||
     a.campaignID.localeCompare(b.campaignID)).slice(0,16);
   // Plan EVERY live campaign before any write: the number of ships its own
   // commander may still field on each side, in the system that side must hold.
   // A side is never filled by a hull that is not physically in its system, so an
   // assault attacker left behind in the source system cannot hold the slot.
   const inSide=(campaignID,factionID,systemID)=>s=>s?.campaignID===campaignID&&
    Number(s.factionID)===Number(factionID)&&Number(s.systemID)===Number(systemID);
   const plans=[];
   for(const c of campaigns){
    const w=state.wars[c.warID];
    if(!pos(w?.attackerFactionID)||!pos(w.defenderFactionID)||
     w.attackerFactionID===w.defenderFactionID||
     !pos(c.sourceSystemID)||!pos(c.targetSystemID))continue;
    const sides=[
     {factionID:w.defenderFactionID,systemID:c.targetSystemID,role:"DEFENDER"},
     {factionID:w.attackerFactionID,systemID:c.state==="PREPARING"?
      c.sourceSystemID:c.targetSystemID,role:"ATTACKER"}
    ];
    const entries=sides.map(side=>{
     const onSide=inSide(c.campaignID,side.factionID,side.systemID);
     let existingSide=Object.values(assigned.ships).filter(onSide).length;
     existingSide+=mobilized.filter(onSide).length;
     // A side may only field as many ships as its commander's rank allows
     // (recruit 1 ... admiral 25), and never more than the global hard cap.
     let sideLimit=maxPerSide;
     if(typeof commandCap==="function"){
      const commanded=[...Object.values(assigned.ships),...mobilized]
       .filter(onSide).map(s=>s.pilotID);
      let cap=0;
      try{
       cap=Number(commandCap({campaignID:c.campaignID,factionID:side.factionID,
        systemID:side.systemID,assignedPilotIDs:commanded}));
      }catch{cap=0}
      if(!Number.isSafeInteger(cap)||cap<1)cap=1;
      sideLimit=Math.max(1,Math.min(maxPerSide,cap));
     }
     return {side,sideLimit,existingSide};
    });
    const deficit=entries.reduce((sum,e)=>sum+Math.max(0,e.sideLimit-e.existingSide),0);
    plans.push({campaign:c,war:w,entries,deficit});
   }
   // Fair scheduling: a campaign that still has empty slots is served before one
   // whose sides are already full, so the per-tick write budget can never starve
   // a second live campaign forever. Ties keep the deterministic old order.
   plans.sort((a,b)=>b.deficit-a.deficit||
    (a.campaign.startedAt||0)-(b.campaign.startedAt||0)||
    a.campaign.campaignID.localeCompare(b.campaign.campaignID));
   const rejected=[];
   const report=[];
   for(const plan of plans){
    const c=plan.campaign;
    const campaignReport={campaignID:c.campaignID,warID:c.warID,state:c.state,
     sourceSystemID:c.sourceSystemID,targetSystemID:c.targetSystemID,sides:[]};
    report.push(campaignReport);
    for(const entry of plan.entries){
     const side=entry.side;
     const sideReport={role:side.role,factionID:side.factionID,
      systemID:side.systemID,limit:entry.sideLimit,assigned:entry.existingSide,
      mobilizable:[],rejected:[],status:""};
     campaignReport.sides.push(sideReport);
     const note=(entityID,pilotID,reason)=>{
      if(sideReport.rejected.length>=SIDE_REJECT_LIMIT)return;
      sideReport.rejected.push({entityID,pilotID,reason});
      if(rejected.length<DRY_RUN_REPORT_LIMIT)
       rejected.push({entityID,pilotID,side:side.role,reason});
     };
     if(!reachable.has(side.systemID)){sideReport.status="SYSTEM_NOT_TRACKED";continue}
     let scene;
     try{scene=sceneForSystem(side.systemID)}catch{scene=null}
     if(scene?.systemID!==side.systemID||
      typeof scene.getEntityByID!=="function"){sideReport.status="NO_NATIVE_SCENE";continue}
     // A dry run reports the full truth per side; a real tick spends at most
     // maxPerTick assignments for the whole world.
     let filled=entry.existingSide;
     const playerIDs=new Set([...(scene.sessions?.values?.()||[])]
      .map(x=>Number(x?._space?.shipID)).filter(pos));
     for(const link of candidateLinks){
      if(filled>=entry.sideLimit)break;
      if(dryRun?mobilized.length>=DRY_RUN_REPORT_LIMIT:mobilized.length>=maxPerTick)break;
      const id=link?.entityID;
      const cheap=!pos(id)?"INVALID_ENTITY":!named(link.pilotID)?"INVALID_PILOT":
       link.role!=="patrol"?"NOT_PATROL_ROLE":link.systemID!==side.systemID?"WRONG_SYSTEM":
       existing.has(id)?"ALREADY_ASSIGNED":usedPilots.has(link.pilotID)?"PILOT_IN_USE":
       playerIDs.has(id)?"PLAYER_SHIP":isTactical(id)?"TACTICAL_BUSY":"";
      if(cheap){
       // WRONG_SYSTEM is per-side noise, not a blocker: report only candidates
       // that are really in this side's system.
       if(cheap!=="WRONG_SYSTEM")note(id,String(link?.pilotID||""),cheap);
       continue;
      }
      // Uniqueness already proven using the bounded registry index above.
      if(leases.some(x=>x.entityID===id&&x.systemID===side.systemID&&
       (["ISSUING","OUTCOME_UNKNOWN"].includes(x.phase)||
        (x.phase==="ACTIVE"&&Number(x.expiresAt)>now)))){
       note(id,link.pilotID,"ORDER_LEASE_ACTIVE");
       continue;
      }
      let ship,native,ctrl,ready,faction;
      try{
       ship=scene.getEntityByID(id);native=getNativeEntity(id);
       ctrl=getController(id);
       faction=getFactionForCorporation(native?.corporationID);
       ready=inspectReadiness({entityID:id,ship,
        systemID:side.systemID,corporationID:native?.corporationID});
      }catch{
       note(id,link.pilotID,"NATIVE_LOOKUP_THREW");
       continue;
      }
      let fail="";
      if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true||
       ship.itemID!==id||ship.session?.characterID||warp(ship))fail="SHIP_NOT_IDLE_NATIVE";
      else if(!native||native.entityID!==id||native.systemID!==side.systemID||
       !pos(native.corporationID)||ship.corporationID!==native.corporationID)fail="NATIVE_RECORD_DRIFT";
      else if(faction!==side.factionID)fail="WRONG_FACTION";
      else if(ctrl?.entityID!==id||ctrl.systemID!==side.systemID)fail="NO_CONTROLLER";
      else if(ctrl.currentTargetID||ctrl.manualOrder)fail="CONTROLLER_BUSY";
      else if(ready?.ready!==true)fail="NOT_READY:"+String((ready&&ready.reason)||"UNKNOWN");
      if(fail){
       note(id,link.pilotID,fail);
       continue;
      }
      if(dryRun){
       // Read-only: report what a real tick would mobilize, never write.
       mobilized.push({status:"DRY_RUN_MOBILIZABLE",entityID:id,
        pilotID:link.pilotID,systemID:side.systemID,
        factionID:side.factionID,campaignID:c.campaignID,role:side.role});
       sideReport.mobilizable.push(id);
       filled+=1;
       continue;
      }
      const command={
       type:"ASSIGN",
       eventID:"wm:"+c.campaignID+":"+id+":"+
        (assignmentCounts.get(String(c.campaignID)+":"+id)||0),
       entityID:id,systemID:side.systemID,pilotID:link.pilotID,
       corporationID:native.corporationID,factionID:side.factionID,
       fleetID:"fw-"+c.campaignID+"-"+side.factionID,
       warID:c.warID,campaignID:c.campaignID,
       proofID:"native-muster:"+id
      };
      let result;
      try{result=registry.execute(command)}catch{
       // The SQLite commit may be ambiguous. Never issue another mutation
       // in this tick after an exception from the authoritative writer.
       return {status:"NATIVE_COMMIT_UNCERTAIN",mobilized,rejected,
        blocked,campaigns:report};
      }
      if(result?.status!=="APPLIED"){
       // A refused ASSIGN must never be a silent boolean: the native registry's
       // own reason is published so the operator sees why a side stays empty.
       const reason=String(result?.reason||result?.status||"BLOCKED");
       blocked.push({entityID:id,pilotID:link.pilotID,campaignID:c.campaignID,
        role:side.role,reason});
       note(id,link.pilotID,"REGISTRY_"+reason);
       continue;
      }
      existing.add(id);usedPilots.add(link.pilotID);filled+=1;
      mobilized.push({status:"NATIVE_PATROL_MOBILIZED",
       entityID:id,pilotID:link.pilotID,systemID:side.systemID,
       factionID:side.factionID,campaignID:c.campaignID,
       fleetID:command.fleetID,role:side.role});
      sideReport.mobilizable.push(id);
     }
     sideReport.assigned=filled;
     sideReport.status=filled>=entry.sideLimit?"SIDE_MUSTERED":
      sideReport.mobilizable.length?"MOBILIZABLE":
      sideReport.rejected.length?"NO_ELIGIBLE_PATROL":"NO_PATROL_CANDIDATE";
    }
   }
   return {status:dryRun?"DRY_RUN":"OBSERVED",mobilized,rejected,blocked,
    campaigns:report,activeCampaignCount:campaigns.length};
  }finally{busy=false}
 }
 return Object.freeze({tick});
}
module.exports={createWarMobilizer,enabled};
