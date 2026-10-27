"use strict";
// COOP-032E: proof-only adapter. No external SQLite handle, no scheduler, no live enablement.
// Reuses the audited 032B/032C state machines behind the 032D GameStore transaction.
// The same module runs as .cjs in source tests and .js inside pinned EveJS.
const siblingSuffix=typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs";
const {createOfflineAtomicInstaller}=require("./coopNpcIndustryOfflineAtomic"+siblingSuffix);
const {createOfflineAtomicDelivery}=require("./coopNpcIndustryOfflineDelivery"+siblingSuffix);
const INSTALL_TABLES=Object.freeze(["items","corporationRuntime","industryBlueprintState","industryJobs"]);
const DELIVER_TABLES=Object.freeze(["items","industryJobs","industryBlueprintState","identityState"]);
const ALLOWED=new Set([...INSTALL_TABLES,...DELIVER_TABLES]);
const PASS=new Set(["INSTALLED","ALREADY_INSTALLED","DELIVERED","ALREADY_DELIVERED"]);
function createScopedSqlFacade(tx){
 if(!tx||["get","scan","put","del"].some(k=>typeof tx[k]!=="function"))
  throw Error("GAMESTORE_TRANSACTION_REQUIRED");
 let phase="NEW";
 const table=t=>{if(!ALLOWED.has(t))throw Error("SCOPED_SQL_TABLE_REJECTED");return t};
 const active=()=>{if(phase!=="ACTIVE")throw Error("SCOPED_SQL_NOT_ACTIVE:"+phase)};
 const key=k=>{const normalized=Number.isSafeInteger(k)&&k>0?String(k):k; if(typeof normalized!=="string"||!normalized||normalized.length>200||normalized.includes("\0"))throw Error("SCOPED_SQL_INVALID_KEY");return normalized};
 const json=value=>JSON.stringify(value);
 const parsed=(value)=>{
  if(typeof value!=="string")throw Error("SCOPED_SQL_JSON_REQUIRED");
  return JSON.parse(value);
 };
 function exec(statement){
  if(statement==="BEGIN IMMEDIATE"&&phase==="NEW"){phase="ACTIVE";return;}
  if(statement==="COMMIT"&&phase==="ACTIVE"){phase="COMMIT_REQUESTED";return;}
  if(statement==="ROLLBACK"&&phase==="ACTIVE"){phase="ROLLED_BACK";return;}
  throw Error("SCOPED_SQL_CONTROL_REJECTED:"+phase);
 }
 function prepare(raw){
  active();
  if(typeof raw!=="string")throw Error("SCOPED_SQL_STATEMENT_REJECTED");
  const s=raw.replace(/\s+/g," ").trim();
  let m=s.match(/^SELECT json FROM "([A-Za-z]+)" WHERE key=\?$/);
  if(m){const t=table(m[1]);return Object.freeze({get(k){active();const v=tx.get(t,key(k));return v===null||v===undefined?undefined:{json:json(v)};}})}
  m=s.match(/^SELECT (key,json|json) FROM "([A-Za-z]+)"(?: WHERE key LIKE \?)?$/);
  if(m){const projection=m[1],t=table(m[2]),like=s.endsWith("WHERE key LIKE ?");
   if(like&&t!=="industryJobs")throw Error("SCOPED_SQL_LIKE_REJECTED");
   return Object.freeze({all(pattern){active();
    if(like&&pattern!=="jobs\u001f%")throw Error("SCOPED_SQL_PATTERN_REJECTED");
    return tx.scan(t).filter(x=>!like||x.key.startsWith("jobs\u001f"))
     .map(x=>projection==="json"?{json:json(x.value)}:{key:x.key,json:json(x.value)});
   }});
  }
  m=s.match(/^INSERT INTO "([A-Za-z]+)"\s*\(key,json\) VALUES \(\?,\?\) ON CONFLICT\(key\) DO UPDATE SET json=excluded\.json$/);
  if(m){const t=table(m[1]);return Object.freeze({run(k,v){active();tx.put(t,key(k),parsed(v));}})}
  m=s.match(/^DELETE FROM "([A-Za-z]+)" WHERE key=\?$/);
  if(m){const t=table(m[1]);return Object.freeze({run(k){active();tx.del(t,key(k));}})}
  throw Error("SCOPED_SQL_STATEMENT_REJECTED");
 }
 return Object.freeze({exec,prepare,phase:()=>phase});
}
function createNpcIndustryScopedProof({gameStore,verifyNativeQuote,verifyNativeOwner,
 verifyNativeOutput,verifyNativeIdFloor,buildNativeOutputItem,clock=()=>Date.now(),faultAt=null}={}){
 if(!gameStore||typeof gameStore.transact!=="function"||
  [verifyNativeQuote,verifyNativeOwner,verifyNativeOutput,verifyNativeIdFloor,buildNativeOutputItem].some(x=>typeof x!=="function"))
  throw Error("GAMESTORE_AND_TRUSTED_NATIVE_VERIFIERS_REQUIRED");
 function execute(tables,operation){
  if(process.env.EVEJS_COOP_NATIVE_NPC_TX_PROOF!=="1"||process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return {status:"BLOCKED",error:"NATIVE_NPC_SCOPE_PROOF_DISABLED"};
  try{
   return gameStore.transact(tables,tx=>{
    const scoped=createScopedSqlFacade(tx),result=operation(scoped);
    if(!result||!PASS.has(result.status)||scoped.phase()!=="COMMIT_REQUESTED")
     throw Error("NATIVE_NPC_OPERATION_ABORTED:"+String(result?.error||result?.status||scoped.phase()));
    return result;
   });
  }catch(error){
   // Never hide ambiguous-commit or poisoned-cache errors behind a gameplay response.
   if(gameStore.isPoisoned?.()===true||error?.coopCommitOutcomeUnknown===true||
      /^NATIVE_GAMESTORE_COMMITTED_BUT_CACHE_UNSAFE/.test(String(error?.message)))throw error;
   return {status:"BLOCKED",error:String(error?.message||error)};
  }
 }
 return Object.freeze({
  mode:"MANUAL_ISOLATED_PROOF_ONLY",supportsAtomicInstall:false,supportsAtomicDelivery:false,
  installOnce(plan,quote,operationID){return execute(INSTALL_TABLES,db=>
   createOfflineAtomicInstaller({db,offlineExclusive:true,verifyNativeQuote,verifyNativeOwner,clock,faultAt})
    .installOnce(plan,quote,operationID));},
  deliverOnce(operationID){return execute(DELIVER_TABLES,db=>
   createOfflineAtomicDelivery({db,offlineExclusive:true,verifyNativeOutput,verifyNativeOwner,
    verifyNativeIdFloor,buildNativeOutputItem,clock,faultAt}).deliverOnce(operationID));}
 });
}
module.exports={createScopedSqlFacade,createNpcIndustryScopedProof,INSTALL_TABLES,DELIVER_TABLES};
