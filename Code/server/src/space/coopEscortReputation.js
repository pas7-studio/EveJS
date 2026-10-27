"use strict";
// P2: durable, read-only-for-player verified payout history.
// A client's chat/mission text never creates a paid reputation entry.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const cid=x=>typeof x==="string"&&/^escort-[a-zA-Z0-9-]{1,48}$/.test(x);
const copy=x=>JSON.parse(JSON.stringify(x));
function createReputation({root,io=fs,clock=()=>Date.now(),readContract,
 verifySettlement,verifyRefund,readProof}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  [clock,readContract,verifySettlement,verifyRefund,readProof].some(x=>typeof x!=="function"))
  throw Error("ESCORT_REPUTATION_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"escort-reputation");
 const file=id=>path.join(dir,id+".json");
 const deny=status=>({status});
 function load(id){
  let s;try{s=io.readFileSync(file(id),"utf8")}catch(e){
   return deny(e?.code==="ENOENT"?"NOT_FOUND":"LEDGER_READ_FAILED")}
  if(typeof s!=="string"||s.length>4096||!s.endsWith("\n"))
   return deny("LEDGER_CORRUPT");
  let record;try{record=JSON.parse(s.trim())}catch{return deny("LEDGER_CORRUPT")}
  if(record?.v!==1||record.contractID!==id||!cid(record.contractID)||
   !pos(record.corporationID)||!pos(record.amountISK)||
   !Array.isArray(record.characters)||record.characters.length!==2||
   !record.characters.every(pos)||record.characters[0]>=record.characters[1]||
   !pos(record.recordedAt)||!["PAID","REFUNDED"].includes(record.outcome)||
   (record.outcome==="PAID"?!pos(record.nativeWreckID):!pos(record.refundWitnessID)))
   return deny("LEDGER_CORRUPT");
  return {status:"READY",record};
 }
 function add(contractID){
  if(process.env.EVEJS_COOP_ESCORT_REPUTATION!=="1")return deny("DISABLED");
  if(!cid(contractID))return deny("INVALID_CONTRACT");
  let source;try{source=readContract(contractID)}catch{return deny("CONTRACT_SOURCE_UNAVAILABLE")}
  if(source?.status!=="READY"||
   !["SETTLED","REFUNDED"].includes(source.phase))return deny("NATIVE_TERMINAL_NOT_CONFIRMED");
  const c=source.contract;
  if(!c||c.contractID!==contractID||!pos(c.corporationID)||
   !pos(c.amountISK)||!Array.isArray(c.characters)||c.characters.length!==2||
   !c.characters.every(pos)||c.characters[0]>=c.characters[1])
   return deny("CONTRACT_IDENTITY_CORRUPT");
  const existed=load(contractID);
  if(existed.status==="READY")return {status:"ALREADY_RECORDED",outcome:existed.record.outcome};
  if(existed.status!=="NOT_FOUND")return existed;
  let receipt;try{receipt=source.phase==="SETTLED"?verifySettlement(c):verifyRefund(c)}
  catch{return deny("NATIVE_WALLET_UNAVAILABLE")}
  if(receipt?.status!==(source.phase==="SETTLED"?"SETTLED":"REFUNDED")||
   receipt.nativeDurable!==true||receipt.contractID!==contractID||
   receipt.corporationID!==c.corporationID||
   receipt.amountISK!==c.amountISK)
   return deny("NATIVE_WALLET_TERMINAL_NOT_VERIFIED");
  let wreck=0,refund=0;
  if(source.phase==="SETTLED"){
   if(!Array.isArray(receipt.credits)||receipt.credits.length!==2||
    receipt.credits[0]?.characterID!==c.characters[0]||
    receipt.credits[1]?.characterID!==c.characters[1]||
    receipt.credits.some(x=>x.amountISK!==c.amountISK/2))
    return deny("NATIVE_DUO_WALLET_CREDITS_MISMATCH");
   let proof;try{proof=readProof(c)}catch{return deny("NATIVE_COMBAT_PROOF_UNAVAILABLE")}
   if(proof?.status!=="NATIVE_ESCORT_EVIDENCE_VERIFIED"||
    proof.contractID!==contractID||!pos(proof.nativeWreckID))
    return deny("NATIVE_ESCORT_PROOF_UNVERIFIED");
   wreck=proof.nativeWreckID;
  }else{
   if(!pos(receipt.failureWitnessID)||
    !["NATIVE_HAULER_WRECK","NATIVE_PREWARP_CANCELLED"].includes(receipt.reason))
    return deny("NATIVE_REFUND_PROOF_UNVERIFIED");
   refund=receipt.failureWitnessID;
  }
  const at=clock();if(!pos(at))return deny("CLOCK_INVALID");
  const record={v:1,contractID,corporationID:c.corporationID,
   amountISK:c.amountISK,characters:c.characters.slice(),outcome:source.phase==="SETTLED"?"PAID":"REFUNDED",
   nativeWreckID:wreck||null,refundWitnessID:refund||null,recordedAt:at};
  let fd;try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(record)+"\n");
   fd=io.openSync(file(contractID),"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)return deny("HISTORY_WRITE_UNCERTAIN");
   io.fsyncSync(fd);
  }catch{return deny("HISTORY_ALREADY_EXISTS_OR_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  try{fd=io.openSync(dir,"r");io.fsyncSync(fd)}
  catch{return deny("HISTORY_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return {status:"VERIFIED_NATIVE_ESCORT_HISTORY_RECORDED",outcome:record.outcome};
 }
 function list({characterID=null,corporationID=null,limit=30}={}){
  if(process.env.EVEJS_COOP_ESCORT_REPUTATION!=="1")
   return {status:"DISABLED",history:[]};
  if(!pos(characterID)&&!pos(corporationID))return {status:"FILTER_REQUIRED",history:[]};
  let names;try{names=io.readdirSync(dir)}catch(e){
   return {status:e?.code==="ENOENT"?"READY":"HISTORY_READ_FAILED",history:[]}}
  if(names.length>2048)return {status:"HISTORY_CAP_REACHED",history:[]};
  const found=[];
  for(const n of names){
   if(!n.endsWith(".json"))continue;
   const r=load(n.slice(0,-5));
   if(r.status!=="READY")return {status:"HISTORY_CORRUPT_NEEDS_REPAIR",history:[]};
   const h=r.record;
   if(pos(characterID)&&!h.characters.includes(characterID))continue;
   if(pos(corporationID)&&h.corporationID!==corporationID)continue;
   found.push(h);
  }
  found.sort((a,b)=>b.recordedAt-a.recordedAt||a.contractID.localeCompare(b.contractID));
  const successful=found.filter(x=>x.outcome==="PAID");
  const refunded=found.filter(x=>x.outcome==="REFUNDED");
  return {status:"READY",history:copy(found.slice(0,Math.max(1,Math.min(50,limit)))),
   reputation:{paidContracts:successful.length,refundedContracts:refunded.length,
    earnedISK:successful.reduce((sum,x)=>sum+(pos(characterID)?x.amountISK/2:x.amountISK),0),
    score:successful.length*10,
    tier:successful.length>=20?"VETERAN":successful.length>=5?"TRUSTED":"ROOKIE"}};
 }
 return {recordVerified:add,read:load,list};
}
function listNativeHistory(session){
 if(process.env.EVEJS_COOP_ESCORT_REPUTATION!=="1")
  return {status:"DISABLED",message:"[Co-op Escort] Audited history is disabled."};
 const id=session?.characterID;
 if(!pos(id)||session?.socket?.destroyed===true)
  return {status:"UNAUTHENTICATED",message:"Select an active EVE character."};
 try{
  const unavailable=()=>{throw Error("NATIVE_REPUTATION_WRITER_NOT_WIRED")};
  const reader=createReputation({root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
   readContract:unavailable,verifySettlement:unavailable,
   verifyRefund:unavailable,readProof:unavailable});
  const result=reader.list({characterID:id,limit:8});
  if(result.status!=="READY")return {status:result.status,
   message:"[Co-op Escort] "+result.status};
  const rep=result.reputation;
  const details=result.history.map(x=>x.contractID+" / "+x.outcome+" / "+
   (x.outcome==="PAID"?(x.amountISK/2)+" ISK":"0 ISK (corporate refund)")).join("\n");
  return {status:"READY",message:"[Co-op Escort] Audited history: "+rep.tier+
   " | paid "+rep.paidContracts+" | refunded "+rep.refundedContracts+
   " | earned "+rep.earnedISK+" ISK | score "+rep.score+
   (details?"\n"+details:"\nNo independently verified payouts recorded.")};
 }catch{return {status:"NATIVE_HISTORY_UNAVAILABLE",
  message:"[Co-op Escort] Native history authority unavailable."}}
}
module.exports={createReputation,listNativeHistory};
