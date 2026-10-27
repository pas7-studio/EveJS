"use strict";
// Chat-30: conservative native contract mutation fencing. NO parallel inventory,
// wallet or escrow authority. This only surrounds original EveJS methods.
// Explicit default-OFF path; all uncertain outcomes require operator repair.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const OPERATIONS = new Set(["create", "accept", "complete", "delete", "delete-multi"]);
const TABLES = Object.freeze(["items", "characters", "corporationRuntime", "contractRuntime"]);
const id = x => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const safeFile = x => typeof x === "string" && /^[a-z0-9-]{1,128}$/.test(x);
function stable(value, depth=0) {
  if (depth>14) throw Error("CONTRACT_INPUT_DEPTH_EXCEEDED");
  if (value===null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {if (!Number.isFinite(value)) throw Error("CONTRACT_INPUT_NONFINITE");return value;}
  if (Array.isArray(value)) {if(value.length>1000)throw Error("CONTRACT_INPUT_TOO_LARGE");return value.map(v=>stable(v,depth+1));}
  if (typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)throw Error("CONTRACT_INPUT_UNSERIALIZABLE");
  const keys=Object.keys(value).sort();if(keys.length>200)throw Error("CONTRACT_INPUT_TOO_LARGE");
  return Object.fromEntries(keys.map(k=>[k,stable(value[k],depth+1)]));
}
function createFence({root,io=fs,clock=()=>Date.now(),flush,readContract,readItem,readBalance,
  getCreateReward}={}) {
  if(typeof root!=="string"||!path.isAbsolute(root)||root==="/"||
      typeof clock!=="function"||typeof flush!=="function"||typeof readContract!=="function"||typeof readItem!=="function"||
      typeof readBalance!=="function"||typeof getCreateReward!=="function")
    throw Error("CONTRACT_FENCE_NATIVE_DEPENDENCIES_REQUIRED");
  const receipts=path.join(root,"receipts"),locks=path.join(root,"locks");
  function syncDir(dir){let f;try{f=io.openSync(dir,"r");io.fsyncSync(f)}finally{if(f!==undefined)io.closeSync(f)}}
  function checkedDirectory(dir) {
    io.mkdirSync(dir,{recursive:true,mode:0o700});
    const stat=io.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("CONTRACT_FENCE_UNSAFE_DIRECTORY");
    return dir;
  }
  function save(filename,record,create){
    const output=path.join(receipts,filename+".json");
    const tmp=output+".tmp";
    const bytes=JSON.stringify(record)+"\n";
    if(Buffer.byteLength(bytes)>4096)throw Error("CONTRACT_FENCE_RECEIPT_TOO_LARGE");
    let fd;
    try {
      fd=io.openSync(create?output:tmp,create?"wx":"wx",0o600);
      io.writeFileSync(fd,bytes);io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
      if(!create)io.renameSync(tmp,output);
      syncDir(receipts);
    } finally {if(fd!==undefined)io.closeSync(fd)}
  }
  function read(filename){
    let text;try{text=io.readFileSync(path.join(receipts,filename+".json"),"utf8")}
    catch(e){if(e?.code==="ENOENT")return null;throw Error("CONTRACT_FENCE_RECEIPT_UNREADABLE")}
    if(Buffer.byteLength(text)>4096||!text.endsWith("\n"))throw Error("CONTRACT_FENCE_RECEIPT_CORRUPT");
    try{const rec=JSON.parse(text);if(rec.v!==1||rec.key!==filename||!["PREPARED","COMMITTED"].includes(rec.phase))throw Error();return rec}
    catch{throw Error("CONTRACT_FENCE_RECEIPT_CORRUPT")}
  }
  function keyOf(op,characterID,contractID,request) {
    if(!OPERATIONS.has(op)||!id(characterID))throw Error("CONTRACT_FENCE_ACTOR_INVALID");
    if(op!=="create"&&!id(contractID))throw Error("CONTRACT_FENCE_ID_INVALID");
    let json=JSON.stringify(stable(request===undefined?null:request));
    if(json.length>15000)throw Error("CONTRACT_FENCE_INPUT_TOO_LARGE");
    const hash=crypto.createHash("sha256").update(JSON.stringify([op,characterID,contractID||0,json])).digest("hex").slice(0,32);
    return op==="create"?`create-${characterID}-${hash}`:`contract-${contractID}-${op}-${hash}`;
  }
  function verify({operation,contractID,characterID,result,request}) {
    if(operation==="delete-multi"){
      if(!result||!Array.isArray(result.deleted)||!Array.isArray(result.failed)||result.failed.length||!result.deleted.length)return false;
      return result.deleted.every(n=>id(n)&&readContract(n)?.status===8);
    }
    const resultID=operation==="create"?result?.contractIDs?.[0]:contractID;
    if(!id(resultID))return false;
    const contract=readContract(resultID);
    if(!contract||contract.contractID!==resultID||!id(contract.issuerID))return false;
    const same=(item,ownerID,locationID,typeID,quantity)=>item&&
      item.ownerID===ownerID&&item.locationID===locationID&&item.typeID===typeID&&
      (item.singleton===1?quantity===1:Number(item.stacksize??item.quantity)===quantity);
    const escrow=contract.escrowLocationID;
    const offered=Array.isArray(contract.items)?contract.items.filter(i=>i.inCrate):[];
    const packageItems=Array.isArray(contract.packageItems)?contract.packageItems:[];
    const wrap=()=>readItem(contract.plasticWrapItemID);
    const validEscrow=()=>offered.every(i=>same(readItem(i.escrowItemID),1,escrow,i.itemTypeID,i.quantity));
    const validContents=(owner,location)=>packageItems.length>0&&packageItems.every(i=>
      same(readItem(i.itemID),owner,location,i.itemTypeID,i.quantity));
    if(operation==="create")return result?.success===true&&Array.isArray(result.contractIDs)&&result.contractIDs.length===1&&
      contract.issuerID===characterID&&contract.status===0&&
      (contract.type===1?validEscrow():contract.type===3&&
       same(wrap(),contract.issuerOwnerID,contract.packageLocationID,3468,1)&&
       validContents(1,contract.escrowLocationID));
    if(operation==="accept")return result?.contractID===resultID&&
      (contract.status===1||contract.status===4)&&contract.status===result.status&&id(contract.acceptorID)&&
      (contract.type===1?offered.every(i=>same(readItem(i.escrowItemID),
        contract.acceptorID,contract.startStationID,i.itemTypeID,i.quantity)):
       contract.type===3&&same(wrap(),contract.acceptorID,contract.startStationID,3468,1)&&
       validContents(1,contract.escrowLocationID));
    if(operation==="complete")return result===true&&contract.status===Number(request?.targetStatus??4)&&
      [4,6,7].includes(contract.status)&&
      (contract.status===6||contract.type===3&&contract.collateralEscrow===0&&
        contract.rewardEscrow===0&&!wrap()&&
        (contract.status===4?validContents(contract.issuerOwnerID,contract.endStationID):
         contract.status===7&&packageItems.every(i=>readItem(i.itemID)?.ownerID===contract.acceptorID)));
    if(operation==="delete")return result===true&&contract.status===8&&contract.rewardEscrow===0&&
      (contract.type===1?offered.every(i=>same(readItem(i.escrowItemID),
        contract.issuerOwnerID,contract.startStationID,i.itemTypeID,i.quantity)):
       contract.type===3&&!wrap()&&validContents(contract.issuerOwnerID,contract.startStationID));
    return false;
  }
  function pendingForContract(contractID){
    if(!id(contractID))return false;
    const names=io.readdirSync(receipts);
    if(names.length>10000)throw Error("CONTRACT_FENCE_TOO_MANY_RECEIPTS");
    const prefix=`contract-${contractID}-`;
    return names.some(n=>n.startsWith(prefix)&&n.endsWith(".json")&&
      read(n.slice(0,-5))?.phase!=="COMMITTED");
  }
  const toCents=n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&
    Number.isSafeInteger(Math.round(n*100))&&Math.abs(n*100-Math.round(n*100))<0.00001?
      Math.round(n*100):null;
  function walletPlan({operation,characterID,contractID,request}){
    const before=operation==="create"?null:readContract(contractID);
    if(operation!=="create"&&(!before||before.contractID!==contractID))
      throw Error("CONTRACT_FENCE_SOURCE_CONTRACT_MISSING");
    // Corporate contracts require role-verified native authority before this
    // financial fence can safely make any assumptions about wallet division.
    if(before&&(before.forCorp||before.acceptorWallet?.kind==="corporation"||
      before.issuerWallet?.kind==="corporation"))
      throw Error("CONTRACT_FENCE_CORPORATION_UNVERIFIED");
    const deltas=new Map();
    const add=(owner,amount)=>{
      if(!id(owner)||!Number.isSafeInteger(amount))throw Error("CONTRACT_FENCE_WALLET_PLAN_INVALID");
      deltas.set(owner,(deltas.get(owner)||0)+amount);
    };
    if(operation==="create"){
      const reward=toCents(getCreateReward(request));
      if(reward===null)throw Error("CONTRACT_FENCE_CREATE_REWARD_INVALID");
      add(characterID,-reward);
    }else if(operation==="accept"){
      if(before.status!==0)throw Error("CONTRACT_FENCE_STATUS_CHANGED");
      if(before.type===1){
        add(characterID,-(toCents(before.price)??NaN)+(toCents(before.rewardEscrow)??NaN));
        add(before.issuerID,toCents(before.price)??NaN);
      }else if(before.type===3) add(characterID,-(toCents(before.collateral)??NaN));
      else throw Error("CONTRACT_FENCE_UNSUPPORTED_TYPE");
    }else if(operation==="complete"){
      const status=Number(request?.targetStatus);
      if(status===6){ if(before.status!==0)throw Error("CONTRACT_FENCE_STATUS_CHANGED"); }
      else if(before.type===3&&before.status===1&&[4,7].includes(status)){
        if(!id(before.acceptorID)||!id(before.issuerID))throw Error("CONTRACT_FENCE_PARTY_UNVERIFIED");
        const amount=(toCents(before.collateralEscrow)??NaN)+(toCents(before.rewardEscrow)??NaN);
        add(status===4?before.acceptorID:before.issuerID,amount);
      }else throw Error("CONTRACT_FENCE_UNSUPPORTED_COMPLETION");
    }else if(operation==="delete"){
      if(![0,6].includes(before.status))throw Error("CONTRACT_FENCE_STATUS_CHANGED");
      add(before.issuerID,toCents(before.rewardEscrow)??NaN);
    }else throw Error("CONTRACT_FENCE_UNSUPPORTED_OPERATION");
    const starting=new Map();
    for(const owner of deltas.keys()){
      const balance=toCents(readBalance(owner));
      if(balance===null)throw Error("CONTRACT_FENCE_WALLET_UNAVAILABLE");
      starting.set(owner,balance);
    }
    return {before,deltas,starting};
  }
  function verifyWalletPlan(plan){
    for(const [owner,delta] of plan.deltas){
      if(!Number.isSafeInteger(delta)||toCents(readBalance(owner))!==plan.starting.get(owner)+delta)
        return false;
    }
    return true;
  }
  function run({operation,characterID,contractID=0,request=null,apply}={}){
    if(typeof apply!=="function")throw Error("CONTRACT_FENCE_APPLY_REQUIRED");
    const key=keyOf(operation,characterID,contractID,request);
    if(!safeFile(key))throw Error("CONTRACT_FENCE_KEY_INVALID");
    checkedDirectory(root);checkedDirectory(receipts);checkedDirectory(locks);
    // An uncertain prior mutation on this contract blocks ALL next operations,
    // even if the requested phase differs. No cross-phase bypass.
    if(operation!=="create"&&pendingForContract(contractID))throw Error("CONTRACT_FENCE_PENDING_OPERATOR_REPAIR");
    if(read(key))throw Error("CONTRACT_FENCE_REPLAY_REQUIRES_RECONCILIATION");
    const plan=walletPlan({operation,characterID,contractID,request});
    const lockKey=operation==="create"?key:`contract-${contractID}`;
    const lockFile=path.join(locks,lockKey+".lock");
    let fd,locked=false,committed=false;
    try{
      fd=io.openSync(lockFile,"wx",0o600);locked=true;
      io.writeFileSync(fd,`${key}\n`);io.fsyncSync(fd);io.closeSync(fd);fd=undefined;syncDir(locks);
      // All native item/ISK operations happen AFTER fsynced PREPARED.
      save(key,{v:1,key,phase:"PREPARED",operation,contractID,characterID,at:clock()},true);
      const result=apply();
      if(!verify({operation,contractID,characterID,result,request})||!verifyWalletPlan(plan))
        throw Error("CONTRACT_FENCE_NATIVE_OUTCOME_UNVERIFIED");
      // Same process/cache store, NOT an atomic cross-table transaction. Every
      // acknowledgement is required before recording COMMITTED.
      for(const table of TABLES)if(flush(table)?.success!==true)throw Error("CONTRACT_FENCE_NATIVE_FLUSH_UNVERIFIED:"+table);
      if(!verify({operation,contractID,characterID,result,request})||!verifyWalletPlan(plan))
        throw Error("CONTRACT_FENCE_POSTFLUSH_OUTCOME_CHANGED");
      save(key,{v:1,key,phase:"COMMITTED",operation,contractID,characterID,at:clock(),
        resultContractIDs:operation==="create"?result.contractIDs:undefined},false);
      committed=true;
      return result;
    }finally{
      if(fd!==undefined)try{io.closeSync(fd)}catch{}
      // Lost ACK or midflight crash leaves the lock; never auto-replay.
      if(locked&&committed){io.unlinkSync(lockFile);syncDir(locks)}
    }
  }
  return {run,inspect:({operation,characterID,contractID,request})=>{
    const key=keyOf(operation,characterID,contractID||0,request);
    try{return read(key)||{status:"NOT_FOUND"}}catch{return {status:"NEEDS_OPERATOR_REPAIR"}}
  }};
}
let instance=null;
function getFence(){
  if(instance)return instance;
  const root=process.env.EVEJS_COOP_NATIVE_CONTRACT_FENCE_ROOT;
  const db=require("../gameStore");
  const native=require("../services/contracts/contractRuntimeState");
  const items=require("../services/inventory/itemStore");
  const wallets=require("../services/account/walletState");
  return (instance=createFence({root,flush:table=>db.flushTableSync(table,{log:false}),
    readContract:id=>native.getContractRecord(id),readItem:id=>items.findItemById(id),
    readBalance:id=>wallets.getCharacterWallet(id)?.balance,
    getCreateReward:info=>info.reward}));
}
function guarded(operation,contractID,session,request,apply){
  if(process.env.EVEJS_COOP_NATIVE_CONTRACT_MUTATION_FENCE!=="1")
    throw Error("CONTRACT_FENCE_DISABLED");
  if(!id(session?.characterID))throw Error("CONTRACT_FENCE_SESSION_UNVERIFIED");
  return getFence().run({operation,characterID:session.characterID,contractID,request,apply});
}
function facade(){
  // Called ONLY by the opt-in native contractProxy patch. All mutations are
  // performed by original native contractRuntimeState implementation.
  const native=require("../services/contracts/contractRuntimeState");
  return {
    createContract:(rawInfo,session,opts)=>{
      // Marshaled client dictionaries are not necessarily plain objects.
      // Fingerprint the already-supported native normalized payload instead.
      const info=native.normalizeContractInfo(rawInfo);
      if(info.forCorp)throw Error("CONTRACT_FENCE_CORP_PERMISSION_NOT_VERIFIED");
      return guarded("create",0,session,info,()=>native.createContract(rawInfo,session,opts));
    },
    acceptContract:(contractID,session,forCorp)=>{
      if(forCorp)throw Error("CONTRACT_FENCE_CORP_PERMISSION_NOT_VERIFIED");
      return guarded("accept",contractID,session,{forCorp:false},()=>native.acceptContract(contractID,session,false));
    },
    completeContract:(contractID,status,session)=>{
      const c=native.getContractRecord(contractID);
      if(c?.forCorp||c?.acceptorWallet?.kind==="corporation")throw Error("CONTRACT_FENCE_CORP_PERMISSION_NOT_VERIFIED");
      return guarded("complete",contractID,session,{targetStatus:Number(status)},
        ()=>native.completeContract(contractID,status,session));
    },
    deleteContract:(contractID,session)=>{
      if(native.getContractRecord(contractID)?.forCorp)throw Error("CONTRACT_FENCE_CORP_PERMISSION_NOT_VERIFIED");
      return guarded("delete",contractID,session,null,()=>native.deleteContract(contractID,session));
    },
    deleteMultipleContracts:()=>{throw Error("CONTRACT_FENCE_BATCH_REQUIRES_OPERATOR_REVIEW");}
  };
}
module.exports={createFence,getFence,guarded,facade,TABLES};
