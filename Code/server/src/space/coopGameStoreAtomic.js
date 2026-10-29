"use strict";
/**
 * COOP-032D. In-process native SQLite/GameStore atomic row bridge.
 * Infrastructure only, never exports supportsAtomicInstall/Delivery.
 */
const ALLOWED=new Set(["items","characters","corporationRuntime","industryBlueprintState","industryJobs","identityState","marketEscrow","npcMarketFills","playerMarketFills","npcEntities","npcModules","npcCargo","miningRuntimeState","npcWreckItems","npcWrecks"]);
const SEP="\u001f",hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function assertTables(names){
 if(!Array.isArray(names)||names.length<1||names.length>ALLOWED.size||
    new Set(names).size!==names.length||names.some(t=>!ALLOWED.has(t)))throw Error("ATOMIC_TABLE_ALLOWLIST_VIOLATION");
 return names;
}
function assertRowKey(k){if(typeof k!=="string"||!k.length||k.length>200||k.includes("\0"))throw Error("INVALID_NATIVE_ROW_KEY");}
function serialize(v,t,k){
 const scalar=t==="identityState"&&["nextItemID","nextCharacterID","nextAccountID","version"].includes(k)&&Number.isSafeInteger(v)&&v>=1;
 if(!scalar&&(v===null||typeof v!=="object"||Array.isArray(v)))throw Error("NATIVE_ROW_MUST_BE_OBJECT");
 const encoded=JSON.stringify(v);
 if(typeof encoded!=="string"||encoded.length>2000000)throw Error("NATIVE_ROW_INVALID_SIZE");
 return encoded;
}
function createSqliteAdapter(getDb){
 if(typeof getDb!=="function")throw Error("NATIVE_SQLITE_PROVIDER_REQUIRED");
 let inside=false,claimed=false;
 function transact(tables,mutation){
  if(process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")throw Error("NATIVE_SQLITE_ATOMIC_DISABLED");
  assertTables(tables);
  if(typeof mutation!=="function"||inside)throw Error("INVALID_OR_REENTRANT_ATOMIC_MUTATION");
  const db=getDb();if(!db||typeof db.exec!=="function"||typeof db.prepare!=="function")throw Error("NATIVE_SQLITE_UNAVAILABLE");
  const mining=tables.includes("miningRuntimeState");
  const hauling=tables.includes("npcCargo") &&
    process.env.EVEJS_COOP_NATIVE_HAUL_TRANSFER_ATOMIC==="1";
  if(mining&&process.env.EVEJS_COOP_NATIVE_MINING_CYCLE_ATOMIC!=="1")
    throw Error("ALIFE07_MINING_ATOMIC_DISABLED");
  // Require a durable SQLite acknowledgement for every native economic
  // mutation, including inventory, wallet, contract, escrow and industry rows.
  // This pragma must be set BEFORE BEGIN IMMEDIATE.
  db.exec("PRAGMA synchronous = FULL");
  const pragma=db.prepare("PRAGMA synchronous").get();
  if(!pragma || Number(pragma.synchronous)!==2)
    throw Error(mining?"ALIFE07_SQLITE_DURABILITY_NOT_FULL":
      hauling?"ALIFE10_SQLITE_DURABILITY_NOT_FULL":
      "NATIVE_SQLITE_DURABILITY_NOT_FULL");
  // The exact serialized rows this transaction wrote, in order. The GameStore
  // adapter needs them to refresh its in-memory cache row by row instead of
  // reloading whole tables after commit (FW-098).
  const scope=new Set(tables),changed=new Map(),writes=new Map();
  const noteWrite=(t,k,json)=>{if(!writes.has(t))writes.set(t,[]);writes.get(t).push([k,json]);};
  const tbl=t=>{if(!scope.has(t))throw Error("UNDECLARED_NATIVE_TABLE");return '"'+t+'"';};
  let begun=false;inside=true;
  try{
   db.exec("BEGIN IMMEDIATE");begun=true;
   const tx=Object.freeze({
    get(t,k){const table=tbl(t);assertRowKey(k);const r=db.prepare('SELECT json FROM '+table+' WHERE key=?').get(k);return r?JSON.parse(r.json):null;},
    scan(t){const table=tbl(t);return db.prepare('SELECT key,json FROM '+table).all().map(r=>({key:r.key,value:JSON.parse(r.json)}));},
    put(t,k,value){const table=tbl(t);assertRowKey(k);const json=serialize(value,t,k);
     db.prepare('INSERT INTO '+table+'(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(k,json);
     if(!changed.has(t))changed.set(t,new Set());changed.get(t).add(k);noteWrite(t,k,json);},
    del(t,k){const table=tbl(t);assertRowKey(k);db.prepare('DELETE FROM '+table+' WHERE key=?').run(k);
     if(!changed.has(t))changed.set(t,new Set());changed.get(t).add(k);noteWrite(t,k,null);}
   });
   const result=mutation(tx);
   if(result&&typeof result.then==="function")throw Error("ASYNC_NATIVE_ATOMIC_MUTATION_FORBIDDEN");
   try{db.exec("COMMIT");}catch(cause){
    const uncertain=Error("NATIVE_SQLITE_COMMIT_OUTCOME_UNKNOWN");
    uncertain.coopCommitOutcomeUnknown=true;uncertain.cause=cause;throw uncertain;
   }
   begun=false;
   return {result,changed:Object.fromEntries([...changed].map(([t,keys])=>[t,[...keys]])),
     writes:Object.fromEntries([...writes].map(([t,rows])=>[t,rows]))};
  }catch(e){if(begun){try{db.exec("ROLLBACK")}catch{}}throw e;}
  finally{inside=false;}
 }
 // Only the GameStore owner can claim this SQLite writer; a second caller is refused.
 return Object.freeze({claimTransactor(){
  if(claimed)throw Error("NATIVE_SQLITE_WRITER_ALREADY_CLAIMED");
  claimed=true;return Object.freeze({transact});
 }});
}
function reconcileObject(target,source){
 if(!target||!source||typeof target!=="object"||typeof source!=="object"||Array.isArray(target)!==Array.isArray(source))return source;
 if(Array.isArray(target)){target.splice(0,target.length,...source.map((x,i)=>reconcileObject(target[i],x)));return target;}
 for(const k of Object.keys(target))if(!hasOwn(source,k))delete target[k];
 for(const k of Object.keys(source))target[k]=hasOwn(target,k)?reconcileObject(target[k],source[k]):source[k];
 return target;
}
function createGameStoreAdapter({sqliteStore,ensureSqliteReady,ensureCached,flushTableSync,
 cache,dirty,flushTimers,inFlightFlushes,transientPaths,dirtyRowKeys,fullDirty,
 rebuildFlushBaselineFromDisk,advanceFlushBaseline,invalidateNativeItems,
 invalidateNativeAccounts,fatal}={}){
 if(!sqliteStore||typeof sqliteStore.coopAtomicNativeRows?.claimTransactor!=="function"||
    typeof sqliteStore.loadTableObject!=="function"||typeof ensureSqliteReady!=="function"||
    typeof ensureCached!=="function"||typeof flushTableSync!=="function"||
    typeof rebuildFlushBaselineFromDisk!=="function"||!cache||!dirty||!flushTimers||
    !inFlightFlushes||!transientPaths||!dirtyRowKeys||!fullDirty||
    typeof invalidateNativeItems!=="function"||typeof fatal!=="function")
  throw Error("NATIVE_GAMESTORE_AUTHORITIES_REQUIRED");
 const sqliteWriter=sqliteStore.coopAtomicNativeRows.claimTransactor();
 let busy=false,poisoned=false;
 function transact(tables,mutation,options={}){
  if(poisoned)throw Error("NATIVE_GAMESTORE_POISONED");
  if(process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")throw Error("NATIVE_GAMESTORE_ATOMIC_DISABLED");
  assertTables(tables);
  if(busy)throw Error("NATIVE_GAMESTORE_ATOMIC_REENTRANT");
  if(typeof mutation!=="function")throw Error("NATIVE_ATOMIC_MUTATION_REQUIRED");
  busy=true;let committed=false;
  let cargoWitness=null;
  // A cargo-bearing transaction may mix with transient cache cargo only under a
  // declared contract: exact table set, its own flags, exact write set. A table
  // set that is not declared still fails closed with NATIVE_TRANSIENT_STATE_UNSAFE.
  // The caller may name its contract when two features share one table set.
  const contractName=typeof options?.contract==="string"?options.contract:null;
  const cargoContract=require("./coopNativeCargoTransientIsolation")
    .contractForTables(tables,process.env,contractName);
  const mixedMode=Boolean(cargoContract)&&
    process.env.EVEJS_COOP_NATIVE_CARGO_TRANSIENT_ISOLATION==="1"&&
    cargoContract.flags.every(flag=>process.env[flag]==="1");
  const isolation=mixedMode?require("./coopNativeCargoTransientIsolation"):null;
  try{
   ensureSqliteReady();
   for(const t of tables){
    if(!ensureCached(t))throw Error("NATIVE_GAMESTORE_TABLE_UNAVAILABLE:"+t);
    const activeTransient=Boolean(transientPaths[t]?.size);
    if(activeTransient&&!mixedMode)
      throw Error("NATIVE_TRANSIENT_STATE_UNSAFE:"+t);
    const result=flushTableSync(t,{log:false});
    if(!result?.success||dirty.has(t)||inFlightFlushes.has(t)||flushTimers[t])
      throw Error("NATIVE_GAMESTORE_PERSISTENCE_NOT_QUIESCENT:"+t);
    // No in-flight async worker or dirty write is allowed. Read the durable
    // source AFTER flush, then verify every transient cargo row is omitted.
    if(activeTransient){
      cargoWitness=isolation.capture({paths:transientPaths[t],
        live:cache[t],durable:sqliteStore.loadTableObject(t)});
    }
   }
   if(tables.includes("items")&&invalidateNativeItems("probe")!==true)
     throw Error("NATIVE_INVENTORY_INDEX_INVALIDATOR_UNAVAILABLE");
   const accountsTouched=tables.includes("characters")||tables.includes("corporationRuntime");
   // Probe stock character/corporation cache invalidators BEFORE mutation.
   if(accountsTouched&&(typeof invalidateNativeAccounts!=="function"||
     invalidateNativeAccounts("probe",tables)!==true))
     throw Error("NATIVE_ACCOUNT_CACHE_INVALIDATOR_UNAVAILABLE");
   const outcome=sqliteWriter.transact(tables,cargoWitness?
     tx=>{
      const guarded=isolation.guardMutation(tx,cargoWitness,cargoContract);
      const returned=mutation(guarded);
      guarded.assertWriteSetComplete();
      return returned;
     }:mutation);
   committed=true;
   // FW-098 (measured 2026-10-30 on the live play server with a CPU profile:
   // transact 36.5 %, reconcileObject 14.7 %, loadTableObject 14.3 %): after every
   // commit the cache used to be refreshed by re-reading the WHOLE table from
   // SQLite (loadTableObject parses every row), deep-reconciling it, and then
   // re-reading it a second time to rebuild the flush baseline. The writer now
   // reports the exact rows it wrote, so only those rows are applied - to the
   // cache through the store's own row-shape owner, and to the flush baseline
   // through the same `advanceFlushBaseline` the asynchronous flush acknowledgement
   // path already uses.
   const writeSets=outcome&&outcome.writes&&typeof outcome.writes==="object"?outcome.writes:null;
   const applyRowToObject=typeof sqliteStore.applyRowToObject==="function"?sqliteStore.applyRowToObject:null;
   const advanceBaseline=typeof advanceFlushBaseline==="function"?advanceFlushBaseline:null;
   for(const t of tables){
    const current=cache[t];
    if(!current||typeof current!=="object")throw Error("NATIVE_CACHE_SNAPSHOT_INVALID:"+t);
    // A table the transaction declared but never wrote has no entry at all; that
    // is "no writes", not "unknown". Only a writer that cannot report its write
    // set at all (writeSets === null) falls back to the historical reload.
    const rows=writeSets?Array.isArray(writeSets[t])?writeSets[t]:[]:null;
    // A cargo-bearing mixed transaction changes the durable shape of npcCargo
    // (transient rows must be put back), so that table keeps the full path.
    const witnessTable=Boolean(cargoWitness)&&t==="npcCargo";
    // A bare row key may be a wrapper-group skeleton (sqliteStore.ROW_GROUPS), and
    // merging one wrongly would erase every entity of that group, so the row path
    // is only taken when the store can answer "is this a group table".
    const groupAware=typeof sqliteStore.rowGroupsFor==="function";
    const rowLevel=Boolean(rows&&rows.length&&applyRowToObject&&advanceBaseline&&
      !witnessTable&&(groupAware||rows.every(([key])=>String(key).includes(SEP))));
    if(rowLevel){
      const upserts=[],deletes=[];
      for(const [key,json] of rows){
        if(json===null||json===undefined){
          applyRowToObject(t,current,key,undefined);deletes.push(key);continue;
        }
        const value=JSON.parse(json);
        // characterState caches a normalized record by raw child object identity.
        // Replacing the changed row (while preserving the table reference) forces
        // getCharacterRecord() to re-normalize actual committed wallet balances.
        // Every other table keeps its existing object identity in the cache.
        applyRowToObject(t,current,key,value,t==="characters"?undefined:reconcileObject);
        upserts.push([key,JSON.stringify(value)]);
      }
      advanceBaseline(t,upserts,deletes);
    }else if(rows&&rows.length===0&&!witnessTable){
      // Declared but untouched by this transaction: the quiescence check above
      // proved cache and disk already agree, so there is nothing to reload.
    }else{
      const persisted=sqliteStore.loadTableObject(t);
      const snapshot=cargoWitness&&t==="npcCargo"?
        isolation.rehydrate({persisted,live:current,paths:transientPaths[t],
          witness:cargoWitness}):persisted;
      if(!snapshot||typeof snapshot!=="object")
        throw Error("NATIVE_CACHE_SNAPSHOT_INVALID:"+t);
      if(t==="characters"){
        for(const k of Object.keys(current))if(!hasOwn(snapshot,k))delete current[k];
        for(const [k,v] of Object.entries(snapshot))current[k]=v;
      }else reconcileObject(current,snapshot);
      rebuildFlushBaselineFromDisk(t);
    }
    delete dirtyRowKeys[t];fullDirty.delete(t);dirty.delete(t);
   }
   if(tables.includes("items")&&invalidateNativeItems("commit")!==true)
     throw Error("NATIVE_INVENTORY_INDEX_INVALIDATION_FAILED");
   // A failed cache refresh AFTER durable COMMIT is an unsafe served-state
   // outcome. Poison and exit, never retry a possibly completed settlement.
   if(accountsTouched&&invalidateNativeAccounts("commit",tables)!==true)
     throw Error("NATIVE_ACCOUNT_CACHE_INVALIDATION_FAILED");
   return outcome.result;
  }catch(e){
   if(committed||e?.coopCommitOutcomeUnknown===true){poisoned=true;fatal(e);
    throw Error("NATIVE_GAMESTORE_COMMITTED_BUT_CACHE_UNSAFE:"+String(e.message||e));}
   throw e;
  }finally{busy=false;}
 }
 return Object.freeze({transact,mode:"SERVER_INTERNAL_FLAGGED",
  supportsAtomicInstall:false,supportsAtomicDelivery:false,isPoisoned:()=>poisoned});
}
module.exports={createSqliteAdapter,createGameStoreAdapter,assertTables,reconcileObject,SEP};
