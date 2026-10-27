"use strict";
// Offline/operator-gated native EveJS skill-speed cutover coordinator.
// Never changes training speed, skillbooks, SP, clone state or queue itself.
// Its only native mutation invokes the pinned rebaseActiveTrainingProgress
// under the OLD rate, then verifies and fsyncs a per-character receipt.
// INCOMPLETE receipts stop ALL automatic retries, even after restart.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const RATES = Object.freeze([1, 6, 12, 24, 48, 100]);
const MAX_BYTES = 4 * 1024 * 1024;
const RATE_EPOCH_VERSION = 1;
const positive = x => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null;
const stableIds = xs => [...new Set(xs.map(positive))].sort((a, b) => a - b);
const hash = x => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
function activeRoster(table) {
 if (!table || typeof table !== "object" || Array.isArray(table)) throw Error("QUEUE_TABLE_UNAVAILABLE");
 return Object.entries(table).filter(([, q]) => q?.active === true && Array.isArray(q?.queue) && q.queue.length)
  .map(([id]) => positive(id)).sort((a,b)=>a-b);
}
function readJournal(file) {
 if (!path.isAbsolute(file)) return {status:"INVALID_JOURNAL_PATH"};
 let payload;
 try { payload = fs.readFileSync(file, "utf8"); }
 catch (e) { return e?.code === "ENOENT" ? {status:"ABSENT"} : {status:"JOURNAL_UNAVAILABLE"}; }
 if (!payload || Buffer.byteLength(payload) > MAX_BYTES || !payload.endsWith("\n"))
  return {status:"JOURNAL_CORRUPT"};
 let entries;
 try { entries = payload.trimEnd().split("\n").map(s=>JSON.parse(s)); }
 catch { return {status:"JOURNAL_CORRUPT"}; }
 const types = new Set(["PREPARED", "CHAR_PREPARED", "CHAR_REBASED", "READY_FOR_SWITCH"]);
 if (entries.some(e=> e?.v !== RATE_EPOCH_VERSION || !types.has(e?.state) ||
   typeof e?.manifestHash !== "string" || !Number.isFinite(e?.at) ||
   (e.characterID !== undefined && !positive(e.characterID))) ||
   entries[0]?.state !== "PREPARED" ||
   entries.some(e=>e.manifestHash !== entries[0].manifestHash))
  return {status:"JOURNAL_CORRUPT"};
 const first=entries[0];
 if (!first.manifest || hash(first.manifest)!==first.manifestHash)
  return {status:"JOURNAL_CORRUPT"};
 const states=new Map();
 for (const e of entries.slice(1)) {
  if (e.state === "READY_FOR_SWITCH") {
   if (e !== entries[entries.length-1] || states.size!==first.manifest.activeCharacters.length ||
     [...states.values()].some(s=>s!=="CHAR_REBASED"))return {status:"JOURNAL_CORRUPT"};
   continue;
  }
  if (!first.manifest.activeCharacters.includes(e.characterID))return {status:"JOURNAL_CORRUPT"};
  const previous=states.get(e.characterID);
  if ((e.state === "CHAR_PREPARED" && previous) ||
      (e.state === "CHAR_REBASED" && previous !== "CHAR_PREPARED"))
   return {status:"JOURNAL_CORRUPT"};
  states.set(e.characterID,e.state);
 }
 const done=entries.at(-1).state === "READY_FOR_SWITCH";
 return {status:done?"READY_FOR_SWITCH":"REQUIRES_MANUAL_RECONCILIATION",manifest:first.manifest,
  manifestHash:first.manifestHash,entries,states};
}
function append(file, record, create=false) {
 let fd;
 try {
  const data=Buffer.from(JSON.stringify({...record,v:RATE_EPOCH_VERSION,at:Date.now()})+"\n");
  fd=fs.openSync(file,create?"wx":"a",0o600);
  if (fs.writeSync(fd,data,0,data.length,null)!==data.length) return false;
  fs.fsyncSync(fd);return true;
 } catch {return false;}
 finally {if (fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function syncDirectory(dir) {
 let fd;try {fd=fs.openSync(dir,"r");fs.fsyncSync(fd);return true;}
 catch {return false;}
 finally {if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function readSkills(native,id) {
 const list=native.getCharacterBaseSkills(id);
 if (!Array.isArray(list)) throw Error("SKILL_RECORDS_UNAVAILABLE");
 const values=new Map();
 for(const s of list){const type=positive(s?.typeID);if(!type)continue;
  const sp=Number(s?.trainedSkillPoints ?? s?.skillPoints);
  if(!Number.isSafeInteger(sp)||sp<0)throw Error("INVALID_NATIVE_SP");
  values.set(type,sp);
 }
 return values;
}
function verifyMonotone(before,after) {
 for(const [typeID,sp] of before)if(!after.has(typeID)||after.get(typeID)<sp)throw Error("SKILL_SP_REGRESSED");
}
function validateNative(native) {
 for(const f of ["getAllQueueStates","getCharacterQueueState","getCharacterBaseSkills",
  "rebaseActiveTrainingProgress","getTrainingMultiplier","getNowFileTime"])
  if(typeof native?.[f]!=="function")throw Error("NATIVE_API_MISSING_"+f);
}
function prepare({oldRate,newRate,expectedCharacterIDs,queueTable}) {
 if(!RATES.includes(oldRate)||!RATES.includes(newRate)||oldRate===newRate)
  throw Error("INVALID_RATE_CHANGE");
 if(!Array.isArray(expectedCharacterIDs)||expectedCharacterIDs.some(x=>!positive(x))||
    new Set(expectedCharacterIDs).size!==expectedCharacterIDs.length)
  throw Error("INVALID_CHARACTER_ROSTER");
 const declared=stableIds(expectedCharacterIDs),active=activeRoster(queueTable);
 if(active.some(x=>!x)||active.some(id=>!declared.includes(id)))
  throw Error("ACTIVE_TRAINING_CHARACTER_OMITTED");
 // The list must name EVERY character being migrated, including inactive ones;
 // omit nothing and silently infer no account ownership.
 const stateRows=declared.map(id=>{
  const row=queueTable[String(id)]||{queue:[],active:false};
  const queue=Array.isArray(row.queue)?row.queue:[];
  if(row.active===true && queue.length && !/^[0-9]{15,22}$/.test(String(row.activeStartTime||"")))
   throw Error("ACTIVE_START_TIME_UNTRUSTED");
  return [id, row.active===true, queue.map(x=>[positive(x.typeID),Number(x.toLevel)]),
   row.activeStartTime===null?null:String(row.activeStartTime||"")];
 });
 const manifest={oldRate,newRate,characters:declared,activeCharacters:active,
  nativeQueueDigest:hash(stateRows),queueIdentity:stateRows};
 return {manifest,manifestHash:hash(manifest)};
}
function executeCutover({oldRate,newRate,expectedCharacterIDs,journalFile,native,
 systemQuiesced=false,backupVerified=false,operatorApproved=false}={}) {
 try {
  if(!systemQuiesced||!backupVerified||!operatorApproved)return {status:"QUIESCE_BACKUP_APPROVAL_REQUIRED"};
  if(typeof journalFile!=="string"||!path.isAbsolute(journalFile))return {status:"INVALID_JOURNAL_PATH"};
  validateNative(native);
  if(Number(native.getTrainingMultiplier())!==oldRate)return {status:"OLD_RATE_NOT_RUNNING"};
  const existing=readJournal(journalFile);
  if(existing.status!=="ABSENT")return {status:existing.status,manifestHash:existing.manifestHash};
  const {manifest,manifestHash}=prepare({oldRate,newRate,expectedCharacterIDs,
   queueTable:native.getAllQueueStates()});
  const dir=path.dirname(journalFile);
  fs.mkdirSync(dir,{recursive:true});
  const lockFile=journalFile+".lock";
  let lock;
  try{lock=fs.openSync(lockFile,"wx",0o600);fs.fsyncSync(lock);}
  catch{return {status:"RATE_CUTOVER_LOCKED"};}
  finally{if(lock!==undefined)try{fs.closeSync(lock);}catch{}}
  if(!syncDirectory(dir))return {status:"RATE_CUTOVER_DIR_FSYNC_FAILED"};
  if(!append(journalFile,{state:"PREPARED",manifestHash,manifest},true))
   return {status:"JOURNAL_PREPARE_FAILED"};
  if(!syncDirectory(dir))return {status:"RATE_CUTOVER_DIR_FSYNC_FAILED"};
  for(const characterID of manifest.activeCharacters){
   if(Number(native.getTrainingMultiplier())!==oldRate)return {status:"RATE_CHANGED_DURING_CUTOVER",characterID};
   const beforeQueue=native.getCharacterQueueState(characterID);
   const beforeSkills=readSkills(native,characterID);
   const expectedRow=manifest.queueIdentity.find(r=>r[0]===characterID);
   const observedRow=[characterID,beforeQueue?.active===true,
    (Array.isArray(beforeQueue?.queue)?beforeQueue.queue:[]).map(x=>[positive(x.typeID),Number(x.toLevel)]),
    beforeQueue?.activeStartTime===null?null:String(beforeQueue?.activeStartTime||"")];
   if(!expectedRow||hash(expectedRow)!==hash(observedRow))
    return {status:"NATIVE_QUEUE_CHANGED_BEFORE_REBASE",characterID};
   if(!beforeQueue?.active||!Array.isArray(beforeQueue.queue)||!beforeQueue.queue.length)
    return {status:"NATIVE_QUEUE_CHANGED_BEFORE_REBASE",characterID};
   if(!append(journalFile,{state:"CHAR_PREPARED",manifestHash,characterID,
    beforeQueueHash:hash(beforeQueue)},false))return {status:"JOURNAL_WRITE_UNCERTAIN",characterID};
   // Native method settles all completed entries under the old rate, records
   // earned partial SP, and resets activeStartTime. Never hand-write SP.
   const startedAt=BigInt(native.getNowFileTime());
   const result=native.rebaseActiveTrainingProgress(characterID);
   if(result?.success!==true)return {status:"NATIVE_REBASE_UNCERTAIN",characterID};
   const afterQueue=native.getCharacterQueueState(characterID),
    afterSkills=readSkills(native,characterID);
   verifyMonotone(beforeSkills,afterSkills);
   // Native old-rate settlement may remove ONLY a completed prefix.
   // Neither an inserted queue entry nor a reordered/dropped future entry
   // is a legitimate rate-cutover side effect.
   const beforeEntries=beforeQueue.queue.map(e=>[positive(e.typeID),Number(e.toLevel)]);
   const afterEntries=(Array.isArray(afterQueue?.queue)?afterQueue.queue:[])
    .map(e=>[positive(e.typeID),Number(e.toLevel)]);
   const suffixStart=beforeEntries.length-afterEntries.length;
   if(suffixStart<0 || hash(beforeEntries.slice(suffixStart))!==hash(afterEntries) ||
      (afterEntries.length>0 && afterQueue.active!==true) ||
      (afterEntries.length===0 && afterQueue?.active===true))
    return {status:"NATIVE_QUEUE_SEQUENCE_CHANGED",characterID};
   const now=BigInt(native.getNowFileTime());
   if(afterQueue?.active && afterQueue.queue?.length){
    const updated=BigInt(afterQueue.activeStartTime||0);
    if(updated<BigInt(beforeQueue.activeStartTime)||updated<startedAt-10000000n||updated>now+10000000n)
     return {status:"ACTIVE_START_REBASE_NOT_PROVED",characterID};
   }
   if(!append(journalFile,{state:"CHAR_REBASED",manifestHash,characterID,
    afterQueueHash:hash(afterQueue),afterSkillsHash:hash([...afterSkills])},false))
    return {status:"JOURNAL_WRITE_UNCERTAIN",characterID};
  }
  // Quiescent caller must stop server, back up persisted GameStore state,
  // verify queue/skill records and THEN change the runtime multiplier.
  if(Number(native.getTrainingMultiplier())!==oldRate)return {status:"RATE_CHANGED_DURING_CUTOVER"};
  if(!append(journalFile,{state:"READY_FOR_SWITCH",manifestHash},false))
   return {status:"JOURNAL_WRITE_UNCERTAIN"};
  const journal=readJournal(journalFile);
  if(journal.status!=="READY_FOR_SWITCH")return {status:"JOURNAL_VERIFY_FAILED"};
  try{fs.unlinkSync(lockFile);}catch{} // Journal itself prevents repeat/replay.
  return {status:"READY_FOR_SWITCH",manifestHash,characters:manifest.characters,
   activeCharacters:manifest.activeCharacters,oldRate,newRate};
 }catch(e){return {status:"NEEDS_OPERATOR_REPAIR",reason:String(e?.message||e).slice(0,120)};}
}
function verifyCutover({journalFile,oldRate,newRate,expectedCharacterIDs}={}){
 const journal=readJournal(journalFile);
 if(journal.status!=="READY_FOR_SWITCH")return {status:journal.status};
 const m=journal.manifest;
 if(m.oldRate!==oldRate||m.newRate!==newRate ||
  JSON.stringify(m.characters)!==JSON.stringify(stableIds(expectedCharacterIDs||[])))
  return {status:"RATE_CUTOVER_MANIFEST_MISMATCH"};
 return {status:"READY_FOR_SWITCH",manifestHash:journal.manifestHash};
}
module.exports={RATES,prepare,readJournal,executeCutover,verifyCutover};
