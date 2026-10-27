"use strict";
// COOP-048: one native actor decision -> durable claim key -> source-backed
// Rust player order -> existing GameStore/Rust NPC corporate buyer writer.
// Not registered on the live timer; does not impersonate player sessions.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {planNpcNativePurchase}=require("./coopNpcMarketPolicy"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
const cents=x=>typeof x==="number"&&Number.isFinite(x)&&x>0&&
 Number.isSafeInteger(Math.round(x*100))?Math.round(x*100):null;
function createNpcBuyerCoordinator({file,resolveActor,readProof,getOrder,buyer,
 auditRecovery=null,authorizeRecoveryOperator=null,
 clock=()=>Date.now(),env=process.env}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||
  [resolveActor,readProof,getOrder,clock].some(f=>typeof f!=="function")||
  typeof buyer?.purchaseOnce!=="function"||buyer.mode!=="RUST_CLAIM_PLAYER_FULL_ESCROW")
  throw Error("NPC_BUY_COORDINATOR_NATIVE_DEPENDENCIES_REQUIRED");
 const lock=file+".lock";
 function load(){
  try{
   const state=JSON.parse(fs.readFileSync(file,"utf8"));
   if(state.version!==1||!state.entries||typeof state.entries!=="object"||
      Array.isArray(state.entries))throw Error("NPC_BUY_JOURNAL_CORRUPT");
   for(const [key,row] of Object.entries(state.entries)){
    if(!/^\d+:\d+$/.test(key)||!row||!["PREPARED","SETTLED"].includes(row.phase)||
       !/^npc-corpbuy:[0-9a-f]{32}$/.test(row.claimKey)||!pos(row.buyerCorpID)||
       !pos(row.orderID)||!pos(row.stationID)||!pos(row.typeID)||
       !pos(row.sellerID)||!pos(row.quantity)||!pos(row.unitPriceCents))
     throw Error("NPC_BUY_JOURNAL_CORRUPT");
   }
   return state;
  }catch(e){if(e.code==="ENOENT")return {version:1,entries:{}};throw e;}
 }
 function save(state){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+".tmp-"+process.pid+"-"+crypto.randomUUID();
  let fd;
  try{
   fd=fs.openSync(tmp,"wx",0o600);fs.writeFileSync(fd,JSON.stringify(state));
   fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file);
   try{const dir=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}}
   catch(e){if(process.platform!=="win32"||
      !["EPERM","EINVAL","ENOTSUP","EBADF","EISDIR"].includes(e.code))throw e;}
  }finally{
   if(fd!==null&&fd!==undefined)fs.closeSync(fd);
   try{fs.unlinkSync(tmp)}catch(e){if(e.code!=="ENOENT")throw e;}
  }
 }
 const denied=reason=>({status:"BLOCKED",reason});
 function validActor(a,corp,station){
  return a?.nativeVerified===true&&a.isNpc===true&&a.role==="trader"&&
   a.corporationID===corp&&a.stationID===station&&a.playerControlled!==true&&
   a.inWarp!==true&&a.underAttack!==true&&a.activeNativeOrder!==true;
 }
 async function tick({actorID,buyerCorpID,stationID,typeID,
  maxUnitPriceCents,maxSpendCents,minReserveCents=0}={}){
  if(env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"||
     env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
     env.EVEJS_COOP_NPC_BUY_PLAYER_ASK!=="1")
   return {status:"DISABLED",nativeMutation:false};
  if(![actorID,buyerCorpID,stationID,typeID,
    maxUnitPriceCents,maxSpendCents].every(pos)||
    !Number.isSafeInteger(minReserveCents)||minReserveCents<0)
   return denied("NPC_BUY_COORDINATOR_CONTEXT_INVALID");
  let fd;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fd=fs.openSync(lock,"wx",0o600)}
  catch(e){if(e.code==="EEXIST")return denied("NPC_BUY_COORDINATOR_LOCKED");throw e;}
  try{
   const actor=await resolveActor(actorID);
   if(!validActor(actor,buyerCorpID,stationID))
    return denied("NPC_BUY_ACTOR_UNVERIFIED");
   const state=load(),prefix=buyerCorpID+":";
   const existing=Object.entries(state.entries).filter(([k,v])=>
    k.startsWith(prefix)&&v.phase==="PREPARED"&&
    v.stationID===stationID);
   if(existing.length>1)return denied("NPC_BUY_MULTIPLE_UNRESOLVED_CLAIMS");
   let entry=existing[0]?.[1]||null;
   // COOP-054: normal A-Life never replays a crash-left PREPARED claim.
   // Only the separate operator-approved recovery path may resume it.
   if(entry)return denied("NPC_BUY_PENDING_OPERATOR_RECOVERY");
   if(!entry){
    const proof=await readProof(buyerCorpID,stationID,typeID);
    if(proof?.authoritativeNative!==true||proof.ownerID!==buyerCorpID||
       proof.stationID!==stationID||proof.typeID!==typeID)
     return denied("NPC_BUY_NATIVE_PROOF_MISSING");
    const planned=planNpcNativePurchase({proof,ownerID:buyerCorpID,
     stationID,typeID,maxUnitPriceCents,maxSpendCents,
     minCashReserveCents:minReserveCents});
    if(planned.status!=="NATIVE_BUY_INTENT_ONLY")
     return {status:planned.status,reason:planned.reason||null,nativeMutation:false};
    entry={phase:"PREPARED",claimKey:"npc-corpbuy:"+
      crypto.randomUUID().replace(/-/g,""),
     buyerCorpID,orderID:planned.orderID,sellerID:planned.sellerOwnerID,
     stationID,typeID,quantity:planned.quantity,
     unitPriceCents:planned.totalCents/planned.quantity,
     minReserveCents,createdAt:clock()};
    if(!pos(entry.orderID)||!pos(entry.sellerID)||!pos(entry.quantity)||
       !pos(entry.unitPriceCents)||entry.sellerID===buyerCorpID||
       !Number.isSafeInteger(entry.unitPriceCents))
     return denied("NPC_BUY_CANDIDATE_NOT_CANONICAL");
    const id=buyerCorpID+":"+entry.orderID;
    if(Object.keys(state.entries).length>=5000)return denied("NPC_BUY_JOURNAL_CAP");
    if(state.entries[id])return denied("NPC_BUY_ORDER_ALREADY_HANDLED");
    state.entries[id]=entry;save(state); // write-ahead BEFORE first native claim
   }
   const live=await getOrder(entry.orderID);
   if(live?.source!=="player"||live.is_corp!==false||live.bid!==false||
      !["open","settling","filled"].includes(live.state)||
      Number(live.order_id)!==entry.orderID||
      Number(live.owner_id)!==entry.sellerID||
      Number(live.station_id)!==stationID||
      Number(live.type_id)!==typeID||
      cents(Number(live.price))!==entry.unitPriceCents||
      (live.state==="open"&&Number(live.vol_remaining)!==entry.quantity))
    return denied("NPC_BUY_FRESH_RUST_ORDER_CHANGED");
   if(!validActor(await resolveActor(actorID),buyerCorpID,stationID))
    return denied("NPC_BUY_ACTOR_CHANGED_BEFORE_CLAIM");
   const result=await buyer.purchaseOnce({
    claimKey:entry.claimKey,buyerCorpID,sellerID:entry.sellerID,
    stationID,typeID,orderID:entry.orderID,
    quantity:entry.quantity,maxUnitPriceCents:entry.unitPriceCents,
    minReserveCents:entry.minReserveCents});
   if(result?.status!=="NPC_PURCHASED_PLAYER_GOODS")
    return denied("NPC_BUY_NATIVE_SETTLEMENT_NOT_CONFIRMED");
   entry.phase="SETTLED";entry.fillID=result.fillID;entry.itemID=result.itemID;
   entry.committedAt=clock();save(state);
   return {status:"NPC_PLAYER_PURCHASE_SETTLED",operation:entry.claimKey,
    fillID:result.fillID,itemID:result.itemID,quantity:entry.quantity};
  }finally{fs.closeSync(fd);try{fs.unlinkSync(lock)}catch(e){if(e.code!=="ENOENT")throw e}}
 }
 // Explicit recovery is deliberately NOT called by A-Life.
 // A genuine operator authenticator must be injected from a trusted server
 // control surface; a gameplay client token cannot authorize this method.
 async function recoverApproved({approval,actorID}={}){
  if(env.EVEJS_COOP_NPC_BUY_RECOVERY_OPERATOR!=="1"||
     env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
     env.EVEJS_COOP_NPC_BUY_PLAYER_ASK!=="1")
   return denied("NPC_BUY_RECOVERY_DISABLED");
  if(typeof auditRecovery!=="function"||
     typeof authorizeRecoveryOperator!=="function"||
     !approval||typeof approval!=="object"||
     !/^npc-corpbuy:[0-9a-f]{32}$/.test(approval.claimKey||"")||
     !["RETRY_SAME_CLAIM","RESUME_GAMESTORE_SAME_CLAIM",
       "FINALIZE_RUST_SAME_CLAIM","ACK_JOURNAL_SAME_CLAIM"].includes(approval.action)||
     typeof approval.reason!=="string"||approval.reason.trim().length<12||
     approval.reason.length>500||
     typeof approval.approvalID!=="string"||
     !/^[a-zA-Z0-9_-]{12,120}$/.test(approval.approvalID)||
     !pos(actorID))
   return denied("NPC_BUY_RECOVERY_APPROVAL_INVALID");
  let fd;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fd=fs.openSync(lock,"wx",0o600)}
  catch(e){if(e.code==="EEXIST")return denied("NPC_BUY_RECOVERY_LOCK_PRESENT");throw e}
  try{
   const journal=load();
   const pending=Object.entries(journal.entries).filter(([k,e])=>
     e.phase==="PREPARED"&&e.claimKey===approval.claimKey);
   if(pending.length!==1)return denied("NPC_BUY_RECOVERY_CLAIM_NOT_SINGLE_PENDING");
   const [id,entry]=pending[0];
   if(id!==entry.buyerCorpID+":"+entry.orderID||
      !Number.isSafeInteger(entry.minReserveCents)||entry.minReserveCents<0||
      !pos(entry.unitPriceCents)||!pos(entry.quantity))
    return denied("NPC_BUY_RECOVERY_JOURNAL_IDENTITY_INVALID");
   if(Object.values(journal.entries).some(e=>e!==entry&&
       e.phase==="PREPARED"&&e.buyerCorpID===entry.buyerCorpID&&
       e.stationID===entry.stationID))
    return denied("NPC_BUY_RECOVERY_OTHER_PENDING_CLAIM");
   const accepted=await authorizeRecoveryOperator({
    approvalID:approval.approvalID,claimKey:approval.claimKey,
    action:approval.action,reason:approval.reason.trim(),
    actorID,orderID:entry.orderID,buyerCorpID:entry.buyerCorpID,
    stationID:entry.stationID,typeID:entry.typeID});
   if(accepted!==true)return denied("NPC_BUY_RECOVERY_OPERATOR_DENIED");
   const actor=await resolveActor(actorID);
   if(!validActor(actor,entry.buyerCorpID,entry.stationID))
    return denied("NPC_BUY_RECOVERY_ACTOR_UNVERIFIED");
   const first=await auditRecovery();
   const checks=first?.entries?.filter(x=>x.id===id&&
      x.claimKey===entry.claimKey);
   if(checks?.length!==1||checks[0].status!==approval.action||
      first.status==="HOLD_MANUAL")
    return denied("NPC_BUY_RECOVERY_AUDIT_DIVERGED");
   const proof=checks[0];
   // Check journal identity once more under the lock; prohibit touching any
   // other claim or advancing a journal that has been externally replaced.
   const fresh=load().entries[id];
   if(!fresh||fresh.phase!=="PREPARED"||
      JSON.stringify(fresh)!==JSON.stringify(entry))
    return denied("NPC_BUY_RECOVERY_JOURNAL_CHANGED");
   let result;
   if(approval.action==="ACK_JOURNAL_SAME_CLAIM"){
    if(!pos(proof.fillID)||!pos(proof.itemID)||
       proof.quantity!==entry.quantity)
     return denied("NPC_BUY_RECOVERY_ACK_RECEIPT_INVALID");
    result={status:"NPC_PURCHASED_PLAYER_GOODS",
     fillID:proof.fillID,itemID:proof.itemID};
   }else{
    const live=await getOrder(entry.orderID);
    const stateExpected=approval.action==="RETRY_SAME_CLAIM"?"open":"settling";
    if(live?.state!==stateExpected||live.source!=="player"||
       live.is_corp!==false||live.bid!==false||
       Number(live.order_id)!==entry.orderID||
       Number(live.owner_id)!==entry.sellerID||
       Number(live.station_id)!==entry.stationID||
       Number(live.type_id)!==entry.typeID||
       Number(live.vol_remaining)!==entry.quantity||
       cents(Number(live.price))!==entry.unitPriceCents)
     return denied("NPC_BUY_RECOVERY_FRESH_ORDER_CHANGED");
    if(!validActor(await resolveActor(actorID),entry.buyerCorpID,entry.stationID))
     return denied("NPC_BUY_RECOVERY_ACTOR_CHANGED");
    // Preserve original durable key exactly. GameStore receipt and Rust
    // claim/finalize are independently idempotent on this key/fillID.
    result=await buyer.purchaseOnce({
     claimKey:entry.claimKey,buyerCorpID:entry.buyerCorpID,
     sellerID:entry.sellerID,stationID:entry.stationID,
     typeID:entry.typeID,orderID:entry.orderID,
     quantity:entry.quantity,maxUnitPriceCents:entry.unitPriceCents,
     minReserveCents:entry.minReserveCents
    });
    if(result?.status!=="NPC_PURCHASED_PLAYER_GOODS"||
       !pos(result.fillID)||!pos(result.itemID))
     return denied("NPC_BUY_RECOVERY_NATIVE_SETTLEMENT_UNCONFIRMED");
   }
   // Never ACK the journal from a stale pre-write audit. Re-audit all
   // authorities under the same owned lock after the native operation.
   const second=await auditRecovery();
   const verified=second?.entries?.filter(x=>x.id===id&&
      x.claimKey===entry.claimKey);
   if(second.status==="HOLD_MANUAL"||verified?.length!==1||
      verified[0].status!=="ACK_JOURNAL_SAME_CLAIM"||
      verified[0].fillID!==result.fillID||
      verified[0].itemID!==result.itemID)
    return denied("NPC_BUY_RECOVERY_POST_WRITE_AUDIT_FAILED");
   const current=load();
   if(JSON.stringify(current.entries[id])!==JSON.stringify(entry))
    return denied("NPC_BUY_RECOVERY_JOURNAL_CHANGED");
   current.entries[id]={...entry,phase:"SETTLED",fillID:result.fillID,
    itemID:result.itemID,committedAt:clock()};
   save(current);
   return {status:"NPC_BUY_OPERATOR_RECOVERED",action:approval.action,
    operation:entry.claimKey,fillID:result.fillID,itemID:result.itemID,
    approvalID:approval.approvalID};
  }finally{
   fs.closeSync(fd);
   try{fs.unlinkSync(lock)}catch(e){if(e.code!=="ENOENT")throw e}
  }
 }
 return Object.freeze({tick,recoverApproved,inspect:load,
  mode:"MANUAL_NATIVE_CORP_BUY_COORDINATOR",supportsLiveRuntime:false});
}
module.exports={createNpcBuyerCoordinator};
