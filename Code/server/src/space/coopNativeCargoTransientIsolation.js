"use strict";
/**
 * ALIFE-11: mixed transient NPC cargo isolation, original GameStore authority.
 * A transient cargoID is NEVER included in sqliteStore's cargo root row.
 * All validation is synchronous and must run on the one GameStore owner.
 */
const {isDeepStrictEqual}=require("node:util");
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const numeric=x=>typeof x==="string"&&/^[1-9]\d{0,15}$/.test(x)&&
 Number.isSafeInteger(Number(x))&&Number(x)>0;
const clone=x=>JSON.parse(JSON.stringify(x));
const error=why=>{throw Error("ALIFE11_"+why)};

/**
 * A cargo-bearing transaction may mix with transient cache cargo only under a
 * declared contract. Each contract fixes three things and nothing else may vary:
 *  - the exact table set (order-insensitive),
 *  - the feature flags that must be on,
 *  - the exact set of rows it may write.
 * A set that is not listed here keeps the original NATIVE_TRANSIENT_STATE_UNSAFE
 * behaviour. Adding a contract is a reviewable change, not a configuration.
 */
const HAUL_TRANSFER=Object.freeze({
 name:"haul-transfer",
 tables:Object.freeze(["npcCargo"]),
 flags:Object.freeze(["EVEJS_COOP_NATIVE_HAUL_TRANSFER_ATOMIC"]),
 cargoRootWrites:Object.freeze({min:1,max:1}),
 cargoOtherKeys:"receipt",
 journal:null,
});
// ALIFE-07: one mining cycle commits the rock source, the miner's ore stack and
// its own immutable journal row in a single native transaction. An all-waste
// cycle legitimately moves no cargo, so zero cargo-root writes is valid there.
const MINING_CYCLE=Object.freeze({
 name:"mining-cycle",
 tables:Object.freeze(["miningRuntimeState","npcCargo"]),
 flags:Object.freeze(["EVEJS_COOP_NATIVE_MINING_CYCLE_ATOMIC"]),
 cargoRootWrites:Object.freeze({min:0,max:1}),
 cargoOtherKeys:"forbid",
 journal:Object.freeze({table:"miningRuntimeState",status:"COMMITTED",
  requires:Object.freeze(["op","fingerprint","cargoID","nextCargo"])}),
});
// COOP-046: the same single-table contract also covers one atomic NPC ammo-bank
// cycle: exactly one cargo root rewrite plus exactly one per-ship replay fence
// row. It never touches a still-transient cargo row (the transaction reads the
// durable SQLite root). Without this the GameStore owner refused the whole bank
// whenever any transient NPC hull existed, so a loaded warship could activate a
// turret and never debit a charge or apply damage.
const AMMO_BANK=Object.freeze({
 name:"npc-ammo-bank",
 tables:Object.freeze(["npcCargo"]),
 flags:Object.freeze(["EVEJS_COOP_NPC_STRICT_AMMO",
  "EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE","EVEJS_COOP_NPC_BANK_ATOMIC",
  "EVEJS_COOP_NATIVE_ATOMIC_ROWS"]),
 cargoRootWrites:Object.freeze({min:1,max:1}),
 cargoOtherKeys:"ammo-fence",
 journal:null,
});
// Two declared contracts share the single npcCargo table set. The caller names
// its policy explicitly (the GameStore transaction carries an optional contract
// name), so neither feature can silently borrow the other's write-set rules.
const CONTRACTS=Object.freeze([HAUL_TRANSFER,MINING_CYCLE,AMMO_BANK]);
function sameTableSet(contractTables,tables){
 return contractTables.length===tables.length&&
  [...contractTables].sort().every((table,index)=>table===tables[index]);
}
function contractForTables(tables,env=null,name=null){
 if(!Array.isArray(tables)||tables.length<1)return null;
 const wanted=[...new Set(tables)].sort();
 if(wanted.length!==tables.length)return null;
 const matches=CONTRACTS.filter(c=>sameTableSet(c.tables,wanted));
 if(!matches.length)return null;
 if(name)return matches.find(c=>c.name===name&&
  (!env||c.flags.every(flag=>env[flag]==="1")))||null;
 return matches[0];
}
function getCargo(root){
 if(!root||typeof root!=="object"||Array.isArray(root)||
    !root.cargo||typeof root.cargo!=="object"||Array.isArray(root.cargo))
  error("NATIVE_CARGO_SHAPE_INVALID["+
   (root&&typeof root==="object"&&!Array.isArray(root)?
    Object.keys(root).slice(0,8).join("|"):typeof root)+"]");
 return root.cargo;
}
/**
 * The caller has already synchronized pending worker writes with
 * flushTableSync('npcCargo') AND checked that its table is quiescent.
 * Neither durable (DB) nor transient (cache) is modified here.
 */
function capture({paths,live,durable}={}){
 if(!(paths instanceof Set)||paths.size<1||paths.size>10000)
  error("TRANSIENT_PATH_SET_UNAVAILABLE");
 const current=getCargo(live),persisted=getCargo(durable);
 const shadows={};
 for(const transientPath of paths){
  if(typeof transientPath!=="string"||!/^\/cargo\/[1-9]\d{0,15}$/.test(transientPath))
   error("TRANSIENT_PATH_NOT_ROW_SCOPED");
  const id=transientPath.slice("/cargo/".length);
  if(!numeric(id)||String(Number(id))!==id||own(shadows,id))
   error("TRANSIENT_ID_NOT_CANONICAL");
  if(!own(current,id)||own(persisted,id))
   error("TRANSIENT_ROW_MISSING_OR_ALREADY_DURABLE");
  const row=current[id];
  if(!row||typeof row!=="object"||Array.isArray(row)||
     Number(row.cargoID)!==Number(id)||!numeric(String(row.entityID))||
     !numeric(String(row.ownerID))||!numeric(String(row.typeID))||
     !Number.isSafeInteger(row.quantity)||row.quantity<=0||
     row.transient!==true)
   error("TRANSIENT_ROW_CUSTODY_UNPROVEN");
  shadows[id]=clone(row);
 }
 // The current cache stripped of exactly those explicitly transient
 // entries must match the actual SQLite root AND every other SQLite row.
 // This catches lost/pending writeback, stale baselines and orphan rows.
 const durableCache=clone(live);
 for(const id of Object.keys(shadows))delete durableCache.cargo[id];
 if(!isDeepStrictEqual(durableCache,durable))
  error("CACHE_AND_SQLITE_DURABLE_PREIMAGE_CONFLICT");
 return Object.freeze({ids:Object.freeze(Object.keys(shadows)),shadows});
}
function guardMutation(tx,witness,contract){
 if(!witness)return tx;
 const policy=contract||HAUL_TRANSFER;
 const ids=witness.ids,deny=()=>error("TRANSIENT_CARGO_SQL_WRITE_FORBIDDEN");
 let cargoWrites=0,receiptWrites=0,fenceWrites=0,journalWrites=0,cargoRoot=null,journalRow=null;
 const guarded=Object.freeze({
  get:(table,key)=>tx.get(table,key),
  scan:table=>tx.scan(table),
  put(table,key,value){
   if(table==="npcCargo"){
    if(key==="cargo"){
     if(cargoWrites>=policy.cargoRootWrites.max||
        !value||typeof value!=="object"||Array.isArray(value)||
        ids.some(id=>own(value,id)))deny();
     cargoWrites++;cargoRoot=value;
    }else if(policy.cargoOtherKeys==="ammo-fence"){
     // One atomic ammo-bank cycle owns exactly one per-ship replay fence and no
     // other cargo side row. The fence must describe this ship and version.
     const match=typeof key==="string"&&
       /^coopAmmoCycles_([1-9]\d{0,15})$/.exec(key);
     if(!match||fenceWrites!==0||ids.includes(match[1])||
        Number(value?.entityID)!==Number(match[1])||value?.version!==1||
        !value.modules||typeof value.modules!=="object"||
        Array.isArray(value.modules))
      error("UNEXPECTED_MIXED_CARGO_SQL_FENCE");
     fenceWrites++;
    }else if(policy.cargoOtherKeys==="forbid"){     // A mining cycle owns exactly one cargo row update and no side rows; a haul
     // receipt or allocator counter in the same transaction is not that cycle.
     error("UNEXPECTED_MIXED_CARGO_SQL_KEY");
    }else{
     const match=typeof key==="string"&&
       /^coopNativeHaulTransfer:([1-9]\d{0,15})$/.exec(key);
     if(!match||receiptWrites!==0||
        ids.includes(match[1])||Number(value?.cargoID)!==Number(match[1])||
        value?.status!=="COMMITTED")
      error("UNEXPECTED_MIXED_CARGO_SQL_RECEIPT");
     receiptWrites++;
    }
   }else if(policy.journal&&table===policy.journal.table&&
    value&&value.status===policy.journal.status&&
    policy.journal.requires.every(field=>own(value,field))){
    journalWrites++;journalRow=value;
   }
   tx.put(table,key,value);
  },
  del(){deny();},
  assertTransferComplete(){return this.assertWriteSetComplete();},
  assertWriteSetComplete(){
   if(policy.cargoOtherKeys==="ammo-fence"){
    // Exactly one cargo root rewrite plus exactly one matching replay fence.
    if(cargoWrites!==1||fenceWrites!==1)
     error("INCOMPLETE_NATIVE_AMMO_BANK_WRITE_SET");
    return;
   }
   if(policy.cargoOtherKeys==="receipt"){
    // ALIFE-10 contract, unchanged: exactly one cargo root rewrite plus exactly one
    // matching immutable COMMITTED receipt.
    if(cargoWrites!==1||receiptWrites!==1)
     error("INCOMPLETE_NATIVE_HAUL_WRITE_SET");
    return;
   }
   if(cargoWrites<policy.cargoRootWrites.min||cargoWrites>policy.cargoRootWrites.max)
    error("INCOMPLETE_NATIVE_CARGO_WRITE_SET");
   if(policy.journal){
    // One committed journal entry authorizes the cycle, and it must describe the
    // cargo row the same transaction wrote. Without this the cargo delta and the
    // rock/receipt would be two independent claims.
    if(journalWrites!==1)error("INCOMPLETE_NATIVE_MINING_CYCLE_JOURNAL");
    if(cargoWrites===1){
     const cargoID=String(journalRow?.cargoID||"");
     const written=cargoID&&cargoRoot?cargoRoot[cargoID]:null;
     if(!written||!own(cargoRoot,cargoID)||
        Number(written.quantity)!==Number(journalRow?.nextCargo))
      error("MINING_CYCLE_JOURNAL_CARGO_MISMATCH");
    }
   }
  }
 });
 return guarded;
}
/**
 * SQL COMMIT already happened. A failure here is FATAL to the GameStore
 * owner; DO NOT run a compensating cargo write or a second SQLite operation.
 */
function rehydrate({persisted,live,paths,witness}={}){
 if(!witness)return persisted;
 const durableCargo=getCargo(persisted),currentCargo=getCargo(live);
 const result=clone(persisted);
 if(!(paths instanceof Set)||paths.size!==witness.ids.length)
  error("TRANSIENT_PATHS_CHANGED_DURING_COMMIT");
 for(const id of witness.ids){
  if(!paths.has("/cargo/"+id)||
     own(durableCargo,id)||
     !own(currentCargo,id)||
     !isDeepStrictEqual(currentCargo[id],witness.shadows[id]))
   error("TRANSIENT_CARGO_CHANGED_DURING_COMMIT");
  // Only the original in-process shadow returns to the GameStore cache,
  // never to SQLite, a SQL journal or a native warehouse receipt.
  result.cargo[id]=clone(witness.shadows[id]);
 }
 return result;
}
module.exports={capture,guardMutation,rehydrate,contractForTables,
 CONTRACTS,HAUL_TRANSFER,MINING_CYCLE,AMMO_BANK};
