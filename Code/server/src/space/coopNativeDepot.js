"use strict";
// Durable native-hauler custody journal. PREPARED does not credit virtual ore.
// Exactly-once COMMITTED receipts are still NOT station stock or player items.
const fs=require("node:fs"),path=require("node:path");
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function createDepot({file,clock=()=>Date.now(),fsApi=fs}){
 if(!file)throw Error("depot file required");
 let state={version:1,receipts:{},totals:{},pending:{}};
 // After an uncertain rename/directory fsync the in-memory state may be
 // OLDER than the just-replaced disk journal. No further write may use it.
 let persistenceUnverified=false;
 let journalPresent=false;
 let readFailure=null;
 // Damaged loaded journals cannot be amended or presented as valid supply.
 let stateUnreconciled=false;
 try{
  const saved=JSON.parse(fsApi.readFileSync(file,"utf8"));
  if(saved?.version!==1||!saved.receipts||!saved.totals||
     typeof saved.receipts!=="object"||Array.isArray(saved.receipts)||
     typeof saved.totals!=="object"||Array.isArray(saved.totals)||
     (saved.pending!=null&&(typeof saved.pending!=="object"||Array.isArray(saved.pending))))
   throw Error("bad depot state");
  state={...saved,pending:saved.pending||{}};
  journalPresent=true;
 }catch(e){if(e.code!=="ENOENT")throw e;}
 // A writer CAS prevents stale writes, but without a read fence an old
 // instance still advertises stale original cargo supply via audit/snapshot.
 // Verify the same journal image before EVERY trusted read. An active or
 // crash-abandoned writer lock makes that read uncertain, too.
 function verifyCurrentRead(){
  if(persistenceUnverified)return false;
  try{
   try{
    fsApi.readFileSync(file+".lock","utf8");
    throw Error("DEPOT_JOURNAL_WRITE_IN_PROGRESS");
   }catch(error){if(error?.code!=="ENOENT")throw error;}
   let disk=null;
   try{disk=JSON.parse(fsApi.readFileSync(file,"utf8"));}
   catch(error){if(error?.code!=="ENOENT")throw error;}
   if((disk!==null)!==journalPresent||
      (journalPresent&&JSON.stringify({...disk,pending:disk?.pending||{}})!==JSON.stringify(state)))
    throw Error("DEPOT_CONCURRENT_JOURNAL_DRIFT");
   return true;
  }catch(error){
   // Do not return an apparently valid supply figure from a stale,
   // unreadable or actively changing journal. Require a fresh reopen.
   persistenceUnverified=true;
   readFailure=String(error?.message||error).slice(0,95);
   return false;
  }
 }
 function persist(next){
  if(persistenceUnverified)throw Error("DEPOT_PERSISTENCE_UNVERIFIED");
  const folder=path.dirname(file),lock=file+".lock",tmp=file+".tmp-"+process.pid;
  let lockFd=null,locked=false,tmpCreated=false;
  try{
   fsApi.mkdirSync(folder,{recursive:true});
   // Cross-process exclusive creation: no writer may enter the compare/rename
   // window while another instance is persisting this same depot journal.
   // An abandoned lock after a crash intentionally requires operator review;
   // silently breaking it could credit original ore twice.
   lockFd=fsApi.openSync(lock,"wx",0o600);
   locked=true;
   fsApi.writeFileSync(lockFd,String(process.pid));
   fsApi.fsyncSync(lockFd);
   let disk=null;
   try{disk=JSON.parse(fsApi.readFileSync(file,"utf8"));}
   catch(error){
    if(error?.code!=="ENOENT")throw error;
   }
   if((disk!==null)!==journalPresent||
      (journalPresent&&JSON.stringify({...disk,pending:disk?.pending||{}})!==JSON.stringify(state)))
    throw Error("DEPOT_CONCURRENT_JOURNAL_DRIFT");
   const encoded=JSON.stringify(next);
   // Never overwrite another in-flight/crash-abandoned temp of this PID.
   // Only a temp exclusively created here may be removed on failure.
   const fd=fsApi.openSync(tmp,"wx",0o600);tmpCreated=true;
   try{fsApi.writeFileSync(fd,encoded);fsApi.fsyncSync(fd);}
   finally{fsApi.closeSync(fd);}
   fsApi.renameSync(tmp,file);
   // File fsync is compulsory. Directory fsync is best effort on platforms
   // where the directory handle is explicitly unsupported (Windows).
   try{
    const dirfd=fsApi.openSync(folder,"r");
    try{fsApi.fsyncSync(dirfd);}finally{fsApi.closeSync(dirfd);}
   }catch(error){
    if(!["EPERM","EACCES","EISDIR","EINVAL","EBADF"].includes(error?.code))throw error;
   }
  }catch(error){
   // A failed CAS, lock, rename or fsync makes THIS stale instance untrusted.
   // Never retry an older in-memory receipts/totals map over a newer disk.
   persistenceUnverified=true;
   if(tmpCreated)try{fsApi.unlinkSync(tmp);}catch(_ignored){}
   throw error;
  }finally{
   let unlockError=null;
   if(lockFd!==null)try{fsApi.closeSync(lockFd);}catch(e){unlockError=e;}
   if(locked)try{fsApi.unlinkSync(lock);}catch(e){unlockError=unlockError||e;}
   if(unlockError){persistenceUnverified=true;throw unlockError;}
  }
  state=next;
  journalPresent=true;
 }
 const normalize=({systemID,fleetID,item,legacy=false}={})=>{
  const cargoID=positive(item?.cargoID),typeID=positive(item?.typeID),
    quantity=Number(item?.quantity),haulerID=positive(item?.haulerID);
  if(!positive(systemID)||!positive(fleetID)||!cargoID||!typeID||!haulerID||
     (!legacy&&!haulerID)||!Number.isSafeInteger(quantity)||quantity<=0)return null;
  return {cargoID,typeID,quantity,haulerID:haulerID||null,systemID:Number(systemID),fleetID:Number(fleetID)};
 };
 // A valid receipt is made from positive native integer identities. Numeric
 // strings are not trusted physical cargo provenance, even when Number()
 // would make their totals appear internally consistent in audit().
 const nativePositive=v=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
 const nativeReceipt=row=>row&&typeof row==="object"&&!Array.isArray(row)&&
   ["cargoID","typeID","quantity","haulerID","systemID","fleetID"].every(
     key=>nativePositive(row[key]));
 const same=(a,b)=>a&&b&&a.cargoID===b.cargoID&&a.typeID===b.typeID&&
   a.quantity===b.quantity&&a.haulerID===b.haulerID&&
   a.systemID===b.systemID&&a.fleetID===b.fleetID;
 function prepare({systemID,fleetID,item}={}){
  if(persistenceUnverified)return {status:"DEPOT_PERSISTENCE_UNVERIFIED"};
  if(stateUnreconciled)return {status:"DEPOT_STATE_UNRECONCILED"};
  // Even ALREADY_COMMITTED and PREPARED are custody decisions: validate
  // the disk journal BEFORE consulting in-memory receipt/pending entries.
  if(!verifyCurrentRead())return {status:"DEPOT_PERSISTENCE_UNVERIFIED"};
  const candidate=normalize({systemID,fleetID,item});
  if(!candidate)return {status:"INVALID"};
  const key=String(candidate.cargoID);
  if(state.receipts[key])return {status:same(state.receipts[key],candidate)?"ALREADY_COMMITTED":"CONFLICT"};
  if(state.pending[key])return {status:same(state.pending[key],candidate)?"PREPARED":"CONFLICT"};
  persist({...state,pending:{...state.pending,[key]:{...candidate,at:clock()}}});
  return {status:"PREPARED"};
 }
 function commit({systemID,fleetID,item}={}){
  if(persistenceUnverified)return {status:"DEPOT_PERSISTENCE_UNVERIFIED"};
  if(stateUnreconciled)return {status:"DEPOT_STATE_UNRECONCILED"};
  if(!verifyCurrentRead())return {status:"DEPOT_PERSISTENCE_UNVERIFIED"};
  const candidate=normalize({systemID,fleetID,item});
  if(!candidate)return {status:"INVALID"};
  const key=String(candidate.cargoID);
  if(state.receipts[key])return {status:same(state.receipts[key],candidate)?"ALREADY_COMMITTED":"CONFLICT"};
  if(!same(state.pending[key],candidate))return {status:"NOT_PREPARED_OR_MISMATCH"};
  // The native receipt identity is already canonicalized by normalize().
  // Never use the raw caller's spelling (e.g. "030000142") as a distinct
  // solar-system inventory key after returning COMMITTED.
  const systemKey=String(candidate.systemID);
  const previous=Number(state.totals[systemKey]||0);
  if(!Number.isSafeInteger(previous)||previous<0||
     !Number.isSafeInteger(previous+candidate.quantity))return {status:"TOTAL_OVERFLOW"};
  const pending={...state.pending};delete pending[key];
  persist({...state,pending,receipts:{...state.receipts,
    [key]:{...candidate,at:clock()}},totals:{...state.totals,
     [systemKey]:previous+candidate.quantity}});
  return {status:"COMMITTED",quantity:candidate.quantity};
 }
 // Legacy direct credits are deliberately disabled: the old API was able to
 // invent virtual ore without a witnessed removal from native hauler cargo.
 function record(){return {status:'UNVERIFIED_DIRECT_CREDIT_DISABLED',accepted:0,quantity:0};}
 function audit(){
  if(!verifyCurrentRead())return {status:"NEEDS_OPERATOR_REPAIR",
   reason:readFailure||"DEPOT_PERSISTENCE_UNVERIFIED",committed:0,unresolved:0,invalid:1,
   bySystemType:{},totals:{}};
  // Derive physical input quantities from immutable committed cargo receipts.
  // Never use synthetic system totals as the source of item/type provenance.
  const bySystemType={},derived={};
  let invalid=0,committed=0;
  for(const [key,entry] of Object.entries(state.receipts)){
   // Numeric aliases such as "000777", "7e2" or "+777" can point to
   // the same original cargoID as canonical "777". An audit must NEVER
   // certify multiple receipts for the same physical source item.
   if(!positive(key)||key!==String(Number(key))||
      !nativeReceipt(entry)||Number(key)!==entry.cargoID||
      state.pending[key]){invalid++;continue;}
   const system=String(entry.systemID),type=String(entry.typeID),amount=Number(entry.quantity);
   bySystemType[system]??={};
   const previous=Number(bySystemType[system][type]||0);
   const total=Number(derived[system]||0);
   if(!Number.isSafeInteger(previous+amount)||!Number.isSafeInteger(total+amount)){invalid++;continue;}
   bySystemType[system][type]=previous+amount;
   derived[system]=total+amount;
   committed++;
  }
  const keys=new Set([...Object.keys(derived),...Object.keys(state.totals)]);
  for(const key of keys){
   if(!positive(key)||key!==String(Number(key))||
      (Object.hasOwn(state.totals,key)&&
       (typeof state.totals[key]!=="number"||
        !Number.isSafeInteger(state.totals[key])||state.totals[key]<0))||
      Number(derived[key]||0)!==Number(state.totals[key]||0))invalid++;
  }
  const unresolved=Object.keys(state.pending).length;
  for(const [key,entry] of Object.entries(state.pending)){
   // Pending may be legitimate source debits, but a malformed or aliased
   // key is NOT proof the receipt is unique and safe to finalize.
   if(!positive(key)||key!==String(Number(key))||
      !nativeReceipt(entry)||Number(key)!==entry.cargoID||
      state.receipts[key])invalid++;
  }
  return {status:invalid?'NEEDS_OPERATOR_REPAIR':unresolved?'PENDING_CUSTODY_RECONCILIATION':'OK',
   committed,unresolved,invalid,bySystemType,totals:derived};
 }
 // A pending-but-well-formed source debit is legitimate and may resume.
 // Any invalid receipt/totals/pending index freezes new writes instead.
 if(audit().invalid!==0)stateUnreconciled=true;
 return {record,prepare,commit,audit,snapshot:()=>{
  if(!verifyCurrentRead())throw Error("DEPOT_PERSISTENCE_UNVERIFIED");
  if(stateUnreconciled)throw Error("DEPOT_STATE_UNRECONCILED");
  return structuredClone(state);
 }};
}
let nativeDepot=null;
function getNativeDepot(){
 if(!nativeDepot)nativeDepot=createDepot({
  file:process.env.EVEJS_COOP_DEPOT_FILE||"/var/lib/evejs/coop-native-depot.json"
 });
 return nativeDepot;
}
module.exports={createDepot,getNativeDepot};