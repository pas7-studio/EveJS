"use strict";
/**
 * Native EveJS player-facing Opportunity Board.
 * Only physical NPC observations can publish; no grants, NPC spawns, or ISK.
 * Default OFF. EVEmail sender uses existing pinned mailState (stock UI).
 */
const fs=require("node:fs"),path=require("node:path");
const POS=x=>Number.isSafeInteger(x)&&x>0;
const KEY=x=>typeof x==="string"&&/^(raid|convoy)-[0-9]+-[0-9]+-[0-9]+$/.test(x);
const MODES=new Set(["off","local","all"]);
const TYPES=new Set(["RAID","CONVOY"]);
const MAX_AGE=24*60*60*1000;
const COPY=x=>JSON.parse(JSON.stringify(x));
function createBoard({root,io=fs,clock=()=>Date.now(),getSessions=()=>[],
 sendNativeMail=null,authorizeInterest=null}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function"||
  typeof getSessions!=="function"||(sendNativeMail!==null&&typeof sendNativeMail!=="function")||
  (authorizeInterest!==null&&typeof authorizeInterest!=="function"))
  throw Error("OPPORTUNITY_NATIVE_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"coop-opportunities"),eventDir=path.join(dir,"events"),
  watchDir=path.join(dir,"watch"),claimsDir=path.join(dir,"mail-claims"),
  interestDir=path.join(dir,"interest");
 function safeDir(p){io.mkdirSync(p,{recursive:true});}
 function sync(p){let fd;try{fd=io.openSync(p,"r");io.fsyncSync(fd);return true}
  catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}}
 function durableNew(p,value){
  let fd;try{
   safeDir(path.dirname(p));
   const bytes=Buffer.from(JSON.stringify(value)+"\n");
   if(bytes.length>4096)return false;
   fd=io.openSync(p,"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)return false;
   io.fsyncSync(fd);
  }catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return sync(path.dirname(p));
 }
 function durableReplace(p,value){
  const tmp=p+".tmp";
  let fd;try{
   safeDir(path.dirname(p));
   const bytes=Buffer.from(JSON.stringify(value)+"\n");
   if(bytes.length>4096)return false;
   fd=io.openSync(tmp,"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)return false;
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   io.renameSync(tmp,p);
  }catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return sync(path.dirname(p));
 }
 function load(p){
  let text;try{text=io.readFileSync(p,"utf8")}catch(e){
   return e?.code==="ENOENT"?{status:"NOT_FOUND"}:{status:"STORAGE_UNAVAILABLE"};
  }
  if(typeof text!=="string"||Buffer.byteLength(text)>4096||!text.endsWith("\n"))
   return {status:"CORRUPT"};
  try{return {status:"READY",value:JSON.parse(text.trim())}}
  catch{return {status:"CORRUPT"}}
 }
 const eventFile=id=>path.join(eventDir,id+".json");
 const watchFile=id=>path.join(watchDir,id+".json");
 const claimFile=(id,char)=>path.join(claimsDir,String(char)+"-"+id+".lock");
 const interestFile=(id,char)=>path.join(interestDir,id+"-"+char+".json");
 const nowOK=()=>{const n=clock();return Number.isSafeInteger(n)&&n>0?n:null};
 function readEvent(id){
  if(!KEY(id))return {status:"BAD_EVENT_ID"};
  const d=load(eventFile(id));
  if(d.status!=="READY")return {status:d.status};
  const e=d.value;
  if(e?.v!==1||e.id!==id||!TYPES.has(e.type)||!POS(e.systemID)||
   !POS(e.entityID)||!POS(e.createdAt)||!POS(e.expiresAt)||
   e.expiresAt<=e.createdAt||e.expiresAt-e.createdAt>MAX_AGE||
   typeof e.title!=="string"||e.title.length>96||
   typeof e.summary!=="string"||e.summary.length>240||
   !["ACTIVE","RESOLVED"].includes(e.phase))
   return {status:"CORRUPT"};
  return {status:"READY",event:e};
 }
 function watch(characterID){
  if(!POS(characterID))return {status:"INVALID_CHARACTER"};
  const w=load(watchFile(characterID));
  if(w.status==="NOT_FOUND")return {status:"READY",mode:"local",at:0};
  if(w.status!=="READY"||w.value?.v!==1||w.value.characterID!==characterID||
    !MODES.has(w.value.mode)||!Number.isSafeInteger(w.value.at))
   return {status:"WATCH_CORRUPT"};
  return {status:"READY",mode:w.value.mode,at:w.value.at};
 }
 function setWatch(characterID,mode){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  if(!POS(characterID)||!MODES.has(mode))return {status:"WATCH_INVALID"};
  const prev=watch(characterID),n=nowOK();
  if(prev.status!=="READY"||!n)return {status:"WATCH_STORAGE_UNAVAILABLE"};
  if(!durableReplace(watchFile(characterID),{v:1,characterID,mode,at:n}))
   return {status:"WATCH_WRITE_UNCERTAIN"};
  return {status:"WATCH_UPDATED",mode};
 }
 function list({systemID=null,limit=12,all=false}={}){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED",events:[]};
  let names;try{names=io.readdirSync(eventDir)}catch(e){
   return {status:e?.code==="ENOENT"?"READY":"STORAGE_UNAVAILABLE",events:[]};
  }
  if(names.length>2000)return {status:"EVENT_DIRECTORY_TOO_LARGE",events:[]};
  const results=[],n=nowOK();
  if(!n)return {status:"CLOCK_INVALID",events:[]};
  for(const filename of names){
   if(!filename.endsWith(".json"))continue;
   const r=readEvent(filename.slice(0,-5));
   if(r.status!=="READY")return {status:"EVENT_STORAGE_UNTRUSTED",events:[]};
   const e=r.event;
   if(e.expiresAt<=n||e.phase!=="ACTIVE")continue;
   if(!all&&POS(systemID)&&e.systemID!==systemID)continue;
   results.push(e);
  }
  results.sort((a,b)=>b.createdAt-a.createdAt);
  return {status:"READY",events:results.slice(0,Math.min(20,Math.max(1,limit)))};
 }
 function watchAllows(id,systemID,sessionSystemID){
  const w=watch(id);
  return w.status==="READY"&&(w.mode==="all"||
   w.mode==="local"&&POS(sessionSystemID)&&sessionSystemID===systemID);
 }
 function alert(e){
  if(process.env.EVEJS_COOP_OPPORTUNITY_MAIL!=="1"||!sendNativeMail)
   return {status:"MAIL_DISABLED",sent:0};
  let sessions;try{sessions=getSessions()}catch{return {status:"SESSIONS_UNAVAILABLE",sent:0}}
  if(!Array.isArray(sessions))return {status:"SESSIONS_UNAVAILABLE",sent:0};
  let sent=0,blocked=0;
  const seen=new Set();
  for(const session of sessions){
   const characterID=Number(session?.characterID);
   const systemID=Number(session?._space?.systemID||session?.solarsystemid||session?.solarSystemID);
   if(!POS(characterID)||seen.has(characterID)||session?.socket?.destroyed===true||
    !watchAllows(characterID,e.systemID,systemID))continue;
   seen.add(characterID);
   const claim=claimFile(e.id,characterID);
   // Durable pre-send claim avoids duplicate EVEmail on crash/lost ACK. Unknown
   // mail outcome remains blocked for reconciliation; no blind retry.
   if(!durableNew(claim,{v:1,characterID,eventID:e.id,at:clock(),state:"PREPARED"})){
    blocked++;continue;
   }
   let receipt;try{receipt=sendNativeMail(characterID,{
    title:"New Eden: "+e.title,
    body:process.env.EVEJS_COOP_NATIVE_JOB_AGENT==="1"?
     e.summary+" | Native event in system "+e.systemID+
     (e.stage==="PREPARING"?
      " | An NPC convoy is preparing; this is NOT a paid offer. A separate "+
      "in-game corporate agent EVEmail may follow only after a genuine native quote.":
      " | Travel and respond using the actual EVE ship, overview and fleet controls."):
     e.summary+" | System "+e.systemID+" | /events info "+e.id+
     " | /events interest "+e.id+
     (e.stage==="PREPARING"?" | /events volunteer "+e.id+" | /events info "+e.id+" (priced accept only after NPC quote)":"")+
     " | /events watch off",
    eventID:e.id})}catch{blocked++;continue}
   if(receipt?.success!==true||!POS(Number(receipt.messageID))){blocked++;continue}
   sent++;
  }
  return {status:blocked?"MAIL_PARTIAL_OR_UNCERTAIN":"MAIL_DISPATCHED",sent,blocked};
 }
 function publish(event){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  const n=nowOK();
  if(!n||!event||!KEY(event.id)||!TYPES.has(event.type)||
   !POS(event.systemID)||!POS(event.entityID)||
   !POS(event.expiresAt)||event.expiresAt<=n||event.expiresAt-n>MAX_AGE||
   typeof event.title!=="string"||event.title.length>96||
   typeof event.summary!=="string"||event.summary.length>240)
   return {status:"INVALID_NATIVE_EVENT"};
  const entry={v:1,id:event.id,type:event.type,systemID:event.systemID,
   entityID:event.entityID,stationID:POS(event.stationID)?event.stationID:null,
   title:event.title,summary:event.summary,createdAt:n,
   expiresAt:event.expiresAt,phase:"ACTIVE",source:"NATIVE_VERIFIED",
   ...(event.type==="CONVOY"&&["PREPARING","EN_ROUTE"].includes(event.stage)?{stage:event.stage}:{})};
  if(!durableNew(eventFile(entry.id),entry))
   return {status:"EVENT_ALREADY_EXISTS_OR_WRITE_UNCERTAIN"};
  // Notification failures cannot retroactively change the authoritative event.
  const notices=alert(entry);
  return {status:"EVENT_PUBLISHED",id:entry.id,notices};
 }
 function nativeRaid({scene,action}={}){
  if(action?.action!=="attack"||!POS(scene?.systemID)||
   !POS(action.pirateID)||!POS(action.targetID)||action.pirateID===action.targetID||
   !["miner","hauler"].includes(action.targetRole))return {status:"NO_NATIVE_RAID"};
  const pirate=scene.getEntityByID?.(action.pirateID),
   target=scene.getEntityByID?.(action.targetID);
  if(pirate?.nativeNpc!==true||target?.nativeNpc!==true||
   pirate?.kind!=="ship"||target?.kind!=="ship"||
   pirate.itemID!==action.pirateID||target.itemID!==action.targetID||
   pirate.transient===true||target.transient===true)
   return {status:"NO_VERIFIED_NATIVE_SHIPS"};
  const n=nowOK();if(!n)return {status:"CLOCK_INVALID"};
  return publish({id:"raid-"+scene.systemID+"-"+action.pirateID+"-"+action.targetID,
   type:"RAID",systemID:scene.systemID,entityID:action.targetID,
   title:"Pirates attacking NPC "+action.targetRole,
   summary:"Native pirate ship "+action.pirateID+" is attacking NPC "+
    action.targetRole+" "+action.targetID+". You can intervene in the real system.",
   expiresAt:n+30*60*1000});
 }

 // Pre-warp event ID uses a real immutable cargoID, not a retry timer.
 // The same physical NPC cargo cannot get unlimited new paid offers on restart.
 function nativeConvoyPreparing({scene,fleet,stationID,cargoIDs}={}){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  if(!POS(scene?.systemID)||fleet?.systemID!==scene.systemID||
   !POS(fleet?.fleetID)||!POS(stationID)||
   !Array.isArray(fleet.haulerEntityIDs)||fleet.haulerEntityIDs.length!==1||
   !Array.isArray(cargoIDs)||!cargoIDs.length||
   cargoIDs.length>1000||cargoIDs.some(x=>!POS(x))||
   new Set(cargoIDs).size!==cargoIDs.length)
   return {status:"PREPARING_SOURCE_INVALID"};
  const haulerID=fleet.haulerEntityIDs[0],ship=scene.getEntityByID?.(haulerID);
  if(!POS(haulerID)||ship?.nativeNpc!==true||ship.kind!=="ship"||
   ship.itemID!==haulerID||ship.transient===true)
   return {status:"PREPARING_NATIVE_HAULER_NOT_PRESENT"};
  const sourceCargoID=Math.min(...cargoIDs);
  const eventID="convoy-"+scene.systemID+"-"+fleet.fleetID+"-"+sourceCargoID;
  const existing=readEvent(eventID),n=nowOK();
  if(!n)return {status:"CLOCK_INVALID"};
  if(existing.status==="READY"){
   const e=existing.event;
   if(e.type!=="CONVOY"||e.stage!=="PREPARING"||
    e.systemID!==scene.systemID||e.entityID!==haulerID||
    e.stationID!==stationID||e.expiresAt<=n||e.phase!=="ACTIVE")
    return {status:"PREPARING_EVENT_IDENTITY_OR_EXPIRY_CONFLICT"};
   return {status:"NATIVE_PREPARING_EVENT_READY",id:eventID};
  }
  if(existing.status!=="NOT_FOUND")
   return {status:"PREPARING_JOURNAL_UNTRUSTED"};
  return publish({id:eventID,type:"CONVOY",stage:"PREPARING",
   systemID:scene.systemID,entityID:haulerID,stationID,
   title:"NPC convoy preparing — escort volunteers needed",
   summary:"Real NPC hauler "+haulerID+" is preparing for station "+stationID+
    ". Volunteer only if you want to escort it. Two pilots must consent. No ISK promised.",
   expiresAt:n+2*60*60*1000});
 }
 function nativePreparingDeparted({scene,fleet,preparingEventID,trip}={}){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  const existing=readEvent(preparingEventID),n=nowOK();
  if(existing.status!=="READY"||!n)return {status:"PREPARING_EVENT_NOT_VERIFIED"};
  const e=existing.event;
  if(e.type!=="CONVOY"||e.stage!=="PREPARING"||
   !["ACTIVE","RESOLVED"].includes(e.phase)||e.systemID!==scene?.systemID||
   !trip?.haulers||Object.keys(trip.haulers).length!==1||
   e.entityID!==Number(Object.keys(trip.haulers)[0])||
   e.entityID!==fleet?.haulerEntityIDs?.[0]||
   e.stationID!==trip?.stationID||
   trip?.fleetID!==fleet?.fleetID||
   trip?.systemID!==scene?.systemID||
   !POS(trip?.startedAt)||!POS(trip?.stationID))
   return {status:"PREPARING_DEPARTURE_PROVENANCE_MISMATCH"};
  if(e.phase==="RESOLVED")
   return e.outcome==="DEPARTED"&&e.linkedTripID===trip.manifestID?
    {status:"NATIVE_PREPARING_EVENT_CLOSED",id:preparingEventID}:
    {status:"PREPARING_DEPARTURE_TERMINAL_CONFLICT"};
  // This flag comes only after the native warpToPoint accepted a real warp.
  const closed={...e,phase:"RESOLVED",outcome:"DEPARTED",
   endedAt:n,linkedTripID:trip.manifestID||null};
  if(!durableReplace(eventFile(preparingEventID),closed))
   return {status:"PREPARING_DEPARTURE_WRITE_UNCERTAIN"};
  return {status:"NATIVE_PREPARING_EVENT_CLOSED",id:preparingEventID};
 }
 function nativeConvoy({scene,fleet,route}={}){
  if(route?.status!=="EN_ROUTE"||!POS(scene?.systemID)||
   fleet?.systemID!==scene.systemID||!POS(fleet.fleetID)||
   !Array.isArray(fleet.haulerEntityIDs)||fleet.haulerEntityIDs.length!==1)
   return {status:"NO_NATIVE_CONVOY"};
  const id=fleet.haulerEntityIDs[0],ship=scene.getEntityByID?.(id),
   trip=fleet.coopStationArrival;
  if(!POS(id)||ship?.nativeNpc!==true||ship.kind!=="ship"||ship.itemID!==id||
   ship.transient===true||trip?.fleetID!==fleet.fleetID||
   trip.systemID!==scene.systemID||!POS(trip.startedAt)||!POS(trip.stationID))
   return {status:"NO_VERIFIED_NATIVE_CONVOY"};
  const n=nowOK();if(!n)return {status:"CLOCK_INVALID"};
  return publish({id:"convoy-"+scene.systemID+"-"+fleet.fleetID+"-"+trip.startedAt,
   type:"CONVOY",systemID:scene.systemID,entityID:id,stationID:trip.stationID,
   title:"NPC convoy departing",
   summary:"Native hauler "+id+" is moving to station "+trip.stationID+
    ". Fly to its system to escort or scout. Reward is NOT guaranteed.",
   expiresAt:n+30*60*1000});
 }
 function nativeConvoyOutcome({scene,trip,terminal}={}){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  if(!POS(scene?.systemID)||!POS(trip?.fleetID)||!POS(trip?.startedAt)||
   trip.systemID!==scene.systemID||terminal?.status!=="DELIVERED"||
   terminal.terminal!==true||!POS(trip.stationID))
   return {status:"NATIVE_DELIVERY_NOT_VERIFIED"};
  const key="convoy-"+scene.systemID+"-"+trip.fleetID+"-"+trip.startedAt;
  const r=readEvent(key);
  if(r.status==="NOT_FOUND")return {status:"NO_POSTED_CONVOY_EVENT"};
  if(r.status!=="READY"||r.event.type!=="CONVOY"||
   r.event.stationID!==trip.stationID)return {status:"EVENT_PROVENANCE_MISMATCH"};
  if(r.event.phase==="RESOLVED")return {status:"ALREADY_RESOLVED"};
  const n=nowOK();
  if(!n||n<r.event.createdAt)return {status:"CLOCK_INVALID"};
  const closed={...r.event,phase:"RESOLVED",outcome:"DELIVERED",endedAt:n};
  if(!durableReplace(eventFile(key),closed))return {status:"EVENT_OUTCOME_WRITE_UNCERTAIN"};
  return {status:"NATIVE_CONVOY_EVENT_RESOLVED",id:key};
 }
 function interest(characterID,eventID){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")return {status:"DISABLED"};
  if(!POS(characterID))return {status:"INVALID_CHARACTER"};
  const r=readEvent(eventID),n=nowOK();
  if(r.status!=="READY")return {status:"EVENT_NOT_AVAILABLE"};
  if(!n||r.event.phase!=="ACTIVE"||r.event.expiresAt<=n)
   return {status:"EVENT_EXPIRED"};
  if(authorizeInterest){
   let a;try{a=authorizeInterest(characterID,COPY(r.event))}catch{
    return {status:"INTEREST_AUTHORITY_UNAVAILABLE"}}
   if(a?.status!=="AUTHORIZED_NATIVE_CHARACTER"||a.characterID!==characterID)
    return {status:"INTEREST_NOT_AUTHORIZED"};
  }
  if(!durableNew(interestFile(eventID,characterID),
    {v:1,characterID,eventID,at:n,phase:"INTERESTED"})){
   const proof=readInterest(characterID,eventID);
   if(proof.status!=="INTEREST_RECORDED"||
    !sync(interestFile(eventID,characterID))||!sync(interestDir))
    return {status:"INTEREST_WRITE_UNCERTAIN_NEEDS_REPAIR"};
   return {status:"INTEREST_ALREADY_DURABLY_RECORDED",eventID,characterID};
  }
  // NOT a fleet join and never a reward promise.
  return {status:"INTEREST_RECORDED",eventID,systemID:r.event.systemID,
   note:"Interest only. Travel and join an actual EVE fleet manually."};
 }
 function readInterest(characterID,eventID){
  if(!POS(characterID)||!KEY(eventID))return {status:"INVALID_INTEREST_IDENTITY"};
  const d=load(interestFile(eventID,characterID));
  if(d.status!=="READY")return {status:d.status};
  const i=d.value;
  if(i?.v!==1||i.characterID!==characterID||i.eventID!==eventID||
   i.phase!=="INTERESTED"||!POS(i.at))
   return {status:"INTEREST_CORRUPT"};
  return {status:"INTEREST_RECORDED",eventID,characterID};
 }
 function handleChat({session,command,argumentText=""}={}){
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1")
   return {status:"DISABLED",message:"[Co-op Events] Board is disabled on this server."};
  const id=Number(session?.characterID);
  if(!POS(id))return {status:"NO_CHARACTER",message:"Select your EVE character."};
  const tokens=String(argumentText).trim().split(/\s+/).filter(Boolean);
  const op=command==="alerts"?"watch":(tokens.shift()||"list").toLowerCase();
  if(op==="watch"){
   const mode=(command==="alerts"?argumentText:tokens[0]||"").trim().toLowerCase();
   if(!mode){const w=watch(id);return {status:w.status,message:"Event alerts: "+(w.mode||"unavailable")+
    ". Use /events watch local|all|off."}}
   const r=setWatch(id,mode);return {status:r.status,message:"[Co-op Events] Alerts: "+
    (r.status==="WATCH_UPDATED"?r.mode:r.status)};
  }
  if(op==="list"||op==="all"){
   const local=Number(session?._space?.systemID||session?.solarsystemid||session?.solarSystemID);
   const r=list({systemID:local,all:op==="all",limit:8});
   if(r.status!=="READY")return {status:r.status,message:"[Co-op Events] "+r.status};
   // Show only source-verified rescue quotes, never virtual jobs or fake ISK.
   const rescueOffers=[];
   if(process.env.EVEJS_COOP_RESCUE_CONTRACTS==="1"){
    try{
     const files=io.readdirSync(eventDir);
     if(files.length<=2000){
      for(const filename of files.sort().slice(-100)){
       if(!filename.endsWith(".json"))continue;
       const loaded=readEvent(filename.slice(0,-5)),event=loaded?.event;
       if(loaded?.status!=="READY"||event?.type!=="CONVOY"||
          event.stage!=="PREPARING"||event.phase!=="RESOLVED"||
          event.outcome!=="DEPARTED"||
          (op!=="all"&&POS(local)&&event.systemID!==local))continue;
       const offer=require("./coopRescueNativeGame").runGame(session,"offer",event.id);
       if(offer?.status!=="READY"||!Array.isArray(offer.expected))continue;
       rescueOffers.push(event.id+" | [RESCUE] NPC corporation "+
        offer.contract.corporationID+" offers "+offer.contract.amountISK+
        " ISK for "+offer.expected.reduce((n,x)=>n+x.quantity,0)+
        " verified native cargo units | /events rescue offer "+event.id);
       if(rescueOffers.length>=5)break;
      }
     }
    }catch{/* Unverified event sources never produce offers. */}
   }
   if(!r.events.length&&!rescueOffers.length)
    return {status:"READY",message:"[Co-op Events] No verified active events or rescue jobs. /events all for whole universe; /events watch local|all|off."};
   return {status:"READY",message:"[Co-op Events] Verified active opportunities:\\n"+
    [...r.events.map(e=>e.id+" | "+(e.stage==="PREPARING"?"[PREPARING] ":"")+e.title+" | system "+e.systemID+
     " | /events info "+e.id),...rescueOffers].join("\\n")};
  }
  if(op==="info"){
   const r=readEvent(tokens[0]);const n=nowOK();
   if(r.status!=="READY"||!n||r.event.expiresAt<=n)return {status:"EVENT_NOT_AVAILABLE",message:"Event unavailable or expired."};
   const e=r.event;
   return {status:"READY",message:"[Co-op Events] "+e.title+" | "+e.id+
    "\n"+e.summary+"\nSystem: "+e.systemID+
    (e.stationID?" | station: "+e.stationID:"")+
    (e.stage==="PREPARING"?
      "\nTo volunteer: /events interest "+e.id+
      " then both real EVE fleet pilots use /events volunteer "+e.id+
      "\n"+(function(){const q=require("./coopEscortPricedOffers").readVisibleQuote(e.id);
       return q.status==="READY"?
        "NPC-funded quote: "+q.quote.amountISK+" ISK total ("+
        q.quote.amountISK/2+" per pilot). Both must explicitly accept: /events accept "+e.id:
        "No verified funded quote yet. /events accept is unavailable until server publishes one.";})():
      "\nTo participate voluntarily: /events interest "+e.id+
      " then fly to the actual location and use native EVE fleet/warp.")};
  }
  if(op==="tactic"){
   const eventID=tokens[0],mode=String(tokens[1]||"").toUpperCase();
   if(!["HOLD","CONTINUE","RETREAT"].includes(mode))
    return {status:"INVALID_TACTIC",
     message:"Use /events tactic <event-id> hold|continue|retreat."};
   const result=require("./coopEscortTacticalGame")
    .commandInGame(session,eventID,mode);
   return {status:result.status,message:result.status==="NATIVE_CONVOY_TACTIC_VERIFIED"?
    "[Co-op Escort] Native NPC controller accepted "+mode+
     " for real hauler "+result.entityID+". Movement is now controlled by stock EveJS. No ISK changes.":
    "[Co-op Escort] "+result.status+". No tactic was confirmed."};
  }
  if(op==="salvage"){
   const action=String(tokens[0]||"").toUpperCase();
   const eventID=tokens[1],cargoID=Number(tokens[2]);
   if(!["OFFER","ACCEPT","PICKUP","DELIVER","REFUND"].includes(action)||
    !/^convoy-\d+-\d+-\d+$/.test(String(eventID))||
    !Number.isSafeInteger(cargoID)||cargoID<=0)
    return {status:"SALVAGE_HELP",
     message:"[Co-op Salvage] /events salvage offer|accept|pickup|deliver|refund <event-id> <cargo-id>"};
   const result=require("./coopSalvageGameMount")
    .commandInGame(session,eventID,cargoID,action);
   return {status:result.status,message:
    "[Co-op Salvage] "+result.status+
    " | cargo "+cargoID+
    (result.amountISK?" | native NPC quote/escrow "+result.amountISK+" ISK":"")+
    (result.payoutStatus?" | wallet payout: "+result.payoutStatus:"")+
    " | stock and ISK are server-authoritative."};
  }
  if(op==="rescue"){
   // Paid rescue is a separate explicitly opt-in native-custody contract.
   // With the flag OFF, preserve normal stock-wreck navigation.
   if(process.env.EVEJS_COOP_RESCUE_CONTRACTS==="1"){
    const action=String(tokens[0]||"").toLowerCase();
    if(["offer","accept","claim","cancel","history"].includes(action)){
     const result=require("./coopRescueNativeGame").runGame(session,action,tokens[1]);
     const message=result?.status==="READY"&&result.contract&&result.expected?
      "[Co-op Rescue] Native corporation "+result.contract.corporationID+
      " offers "+result.contract.amountISK+" ISK for "+
      result.expected.reduce((n,x)=>n+x.quantity,0)+
      " original cargo units. Two pilots must each accept the offer.":
      result?.status==="RESCUE_NATIVE_FUNDED"?
      "[Co-op Rescue] Real corporate escrow reserved "+result.amountISK+
      " ISK. Deliver the original native cargo to the station before claiming.":
      result?.status==="RESCUE_NATIVE_PAID"?
      "[Co-op Rescue] Verified native payout: "+result.perPilotISK+" ISK per pilot.":
      ["RESCUE_NATIVE_RIVAL_REFUNDED","RESCUE_ALREADY_REFUNDED"].includes(result?.status)?
      "[Co-op Rescue] Source-verified NPC rival custody. Original corporation refund: "+
       result.amountISK+" ISK. No player payment.":
      "[Co-op Rescue] "+(result?.status||"NATIVE_RESCUE_AUTHORITY_UNAVAILABLE");
     return {status:result?.status||"BLOCKED",message};
    }
    if(action==="deliver"){
     const manifestKey=tokens[1],itemID=Number(tokens[2]);
     const stationID=Number(session?.stationID||session?.stationid);
     let corporationID=0;try{corporationID=Number(
      require("./worldData").getStationByID(stationID)?.corporationID)||0}catch{}
     const result=require("./coopRescueNativeWarehouse").deliverInGame(session,
      {manifestKey,stationID,corporationID,itemID});
     return {status:result.status,message:result.status===
      "NATIVE_RESCUE_WAREHOUSE_COMMITTED"?
      "[Co-op Rescue] Original native item "+result.itemID+
      " delivered ("+result.quantity+" units). Claim after independent verification.":
      "[Co-op Rescue] "+result.status+". No stock or funds granted."};
    }
   }
   const result=require("./coopEscortRescueNavigation")
    .rescueInGame(session,tokens[0]);
   return {status:result.status,message:["RESCUE_NATIVE_WARP_ACKNOWLEDGED","RESCUE_NATIVE_APPROACH_ACKNOWLEDGED"].includes(result.status)?
    "[Co-op Rescue] Stock EVE ship movement accepted toward real wreck "+
     result.wreckID+"; "+result.survivingQuantity+
     " units of source-matched cargo present. Open the native wreck inventory and loot manually. NO rescue stock/ISK granted by this command.":
    "[Co-op Rescue] "+result.status+". No cargo or money granted."};
  }
  if(op==="history"||op==="reputation"){
   const escorts=require("./coopEscortReputation").listNativeHistory(session);
   const salvages=require("./coopSalvageGameMount").historyInGame(session);
   if(salvages?.status!=="READY")return escorts;
   const h=salvages.history||[];
   const rep=salvages.reputation;
   const lines=h.map(x=>x.contractID+" / "+x.outcome+
    " / "+x.earnedISK+" ISK / +"+x.reputationPoints+" RESCUE rep");
   const extra="[Co-op Salvage] Authenticated native RESCUE history: paid "+
    rep.paidRescues+" | refunded "+rep.refundedRescues+
    " | earned "+rep.earnedISK+" ISK | score "+rep.score+
    (lines.length?"\\n"+lines.join("\\n"):"\\nNo verified rescue payments yet.");
   if(escorts?.status==="READY")
    return {...escorts,message:escorts.message+"\\n"+extra};
   return {status:"READY",message:extra};
  }
  if(op==="accept"){
   if(process.env.EVEJS_COOP_ESCORT_PAID_ACCEPT!=="1")
    return {status:"DISABLED",
     message:"[Co-op Escort] Paid contract acceptance is disabled."};
   const r=require("./coopEscortPricedOffers").acceptInGame(session,tokens[0]);
   const message=r.status==="DURABLE_TWO_PILOT_PAID_ACCEPTANCE"?
    "[Co-op Escort] Both pilots explicitly accepted the native quote: "+
    r.amountISK+" ISK total, "+(r.amountISK/2)+" ISK per pilot. This is NOT payment yet; the NPC corporation must actually reserve funds before warp.":
    r.status==="WAITING_FOR_OTHER_PAID_ACCEPTOR"?
    "[Co-op Escort] Accepted "+r.amountISK+" ISK total ("+
    (r.amountISK/2)+" ISK each). The second authenticated pilot must separately use /events accept "+tokens[0]+".":
    "[Co-op Escort] "+r.status+
    ". No ISK has been reserved by this command.";
   return {status:r.status,message};
  }
  if(op==="volunteer"){
   if(process.env.EVEJS_COOP_EVENT_VOLUNTEERS!=="1")
    return {status:"DISABLED",message:"[Co-op Events] Verified two-pilot volunteer mode is disabled."};
   const r=require("./coopEscortVolunteers").nativeVoluntaryOptIn(session,tokens[0],{
    readEvent,readInterest
   });
   const message=r.status==="VERIFIED_NATIVE_DUO_VOLUNTEER"?
    "[Co-op Events] Both real EVE fleet pilots volunteered for "+r.eventID+
    ". This is not a funded contract, warp command or reward.":
    r.status==="WAITING_FOR_OTHER_VOLUNTEER"?
    "[Co-op Events] Voluntary interest confirmed. The second pilot must run /events interest and /events volunteer for the same event.":
    "[Co-op Events] "+r.status;
   return {status:r.status,message};
  }
  if(op==="interest"){
   const r=interest(id,tokens[0]);return {status:r.status,
    message:r.status==="INTEREST_RECORDED"?
     "[Co-op Events] Interest saved. Navigate to system "+r.systemID+
     ", find the actual NPC via overview, join a real fleet manually. No automatic warp or ISK award.":
     "[Co-op Events] "+r.status};
  }
  return {status:"HELP",message:"/events list | /events all | /events info <id> | /events interest <id> | /events volunteer <id> | /events accept <id> | /events tactic <id> hold|continue|retreat | /events rescue <id> | /events salvage offer|accept|pickup|deliver <id> <cargo-id> | /events history | /events watch local|all|off"};
 }
 return {publish,nativeRaid,nativeConvoy,nativeConvoyPreparing,nativePreparingDeparted,nativeConvoyOutcome,readEvent,readInterest,list,watch,setWatch,interest,alert,handleChat};
}
let singleton;
function instance(){
 if(!singleton){
  const root=process.env.EVEJS_DATA_ROOT||"/var/lib/evejs";
  singleton=createBoard({root,getSessions:()=>require("../services/chat/sessionRegistry").getSessions(),
   sendNativeMail:(characterID,mail)=>{
    const state=require("../services/mail/mailState");
    return state.sendMail({senderID:state.resolveWelcomeSenderID(),
     toCharacterIDs:[characterID],saveSenderCopy:false,
     title:mail.title,body:mail.body});
   }});
 }
 return singleton;
}
function readNativeEvent(id){
 try{return instance().readEvent(id)}
 catch{return {status:"NATIVE_EVENT_SOURCE_UNAVAILABLE"}}
}
function listNativeEvents(filters){
 try{return instance().list(filters)}
 catch{return {status:"NATIVE_EVENT_SOURCE_UNAVAILABLE",events:[]}}
}
function readNativeWatch(characterID){
 try{return instance().watch(characterID)}
 catch{return {status:"NATIVE_WATCH_UNAVAILABLE"}}
}
function handleChat(x){return instance().handleChat(x)}
function noteNativeRaid(scene,action){try{return instance().nativeRaid({scene,action})}
 catch{return {status:"OPPORTUNITY_RAID_UNAVAILABLE"}}}
function noteNativeConvoy(scene,fleet,route){try{return instance().nativeConvoy({scene,fleet,route})}
 catch{return {status:"OPPORTUNITY_CONVOY_UNAVAILABLE"}}}
function noteNativeConvoyOutcome(scene,trip,terminal){
 try{return instance().nativeConvoyOutcome({scene,trip,terminal})}
 catch{return {status:"OPPORTUNITY_OUTCOME_UNAVAILABLE"}}
}
function noteNativeConvoyPreparing(scene,fleet,stationID,cargoIDs){
 try{return instance().nativeConvoyPreparing({scene,fleet,stationID,cargoIDs})}
 catch{return {status:"PREPARING_NATIVE_SOURCE_UNAVAILABLE"}}
}
function noteNativePreparingDeparted(scene,fleet,preparingEventID,trip){
 try{return instance().nativePreparingDeparted({scene,fleet,preparingEventID,trip})}
 catch{return {status:"PREPARING_DEPARTURE_WRITE_UNCERTAIN"}}
}
module.exports={createBoard,handleChat,readNativeEvent,listNativeEvents,readNativeWatch,noteNativeRaid,noteNativeConvoy,
 noteNativeConvoyPreparing,noteNativePreparingDeparted,noteNativeConvoyOutcome};
