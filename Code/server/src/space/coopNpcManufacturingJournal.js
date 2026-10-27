"use strict";
// COOP-032A: durable safety fence for a future truly-atomic native job adapter.
// Never invoke the stock player-session industry APIs with forged credentials.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const pos=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const clone=v=>JSON.parse(JSON.stringify(v));
function createJournal({file,planner,native,enabled=false,clock=()=>Date.now()}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||!planner||typeof planner.plan!=='function')throw Error('NPC_INDUSTRY_JOURNAL_DEPENDENCIES');
 const lockFile=file+'.lock';
 function read(){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data?.version!==1||!data.entries||Array.isArray(data.entries)||typeof data.entries!=='object')throw Error('NPC_INDUSTRY_CORRUPT_JOURNAL');
  return data;}catch(e){if(e.code==='ENOENT')return {version:1,entries:{}};throw e;}}
 function write(data){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid+'-'+crypto.randomUUID();let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);
   try{const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir)}}catch(e){if(process.platform!=='win32'||!['EPERM','EINVAL','ENOTSUP','EBADF','EISDIR'].includes(e.code))throw e;}
  }finally{if(fd!==undefined&&fd!==null)fs.closeSync(fd);try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}
 }
 function locked(fn){fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
  try{fd=fs.openSync(lockFile,'wx',0o600)}catch{return {status:'INDUSTRY_LOCKED_NEEDS_REVIEW'}}
  try{return fn()}finally{try{fs.closeSync(fd)}finally{try{fs.unlinkSync(lockFile)}catch{}}}
 }
 function status(entry,st,extra={}){return {...entry,status:st,updatedAt:clock(),...extra}}
 function planAndPrepare(args){return locked(()=>{if(!enabled)return {status:'NPC_INDUSTRY_DISABLED'};
  const state=read();const activeEntries=Object.values(state.entries).filter(e=>!['DELIVERED','CANCELLED'].includes(e.status));
  const stationEntries=activeEntries.filter(e=>e.plan?.ownerID===Number(args?.ownerID)&&e.plan?.stationID===Number(args?.stationID));
  if(stationEntries.length>=2)return {status:'STATION_JOB_LIMIT'};
  const lockedMaterials={};
  for(const e of stationEntries)for(const m of e.plan.materials){const k=String(m.typeID);lockedMaterials[k]=(lockedMaterials[k]||0)+m.quantity;}
  for(const [k,v] of Object.entries(args?.reservedMaterials||{})){
   if(!Number.isSafeInteger(Number(v))||Number(v)<0)return {status:'RESERVATION_UNVERIFIED'};
   lockedMaterials[k]=(lockedMaterials[k]||0)+Number(v);
  }
  const p=planner.plan({...args,reservedMaterials:lockedMaterials});
  if(p.status!=='PLAN_READY'||!p.jobs.length)return {status:p.status,blocked:p.blocked||[]};
  const active=new Set(activeEntries.map(e=>String(e.plan?.blueprintItemID)));
  const candidate=p.jobs.find(x=>!active.has(String(x.blueprintItemID)));
  if(!candidate)return {status:'BLUEPRINT_JOB_ALREADY_RESERVED'};
  const id=crypto.randomUUID(),stamp=clock(),entry={operationID:id,status:'PREPARED',plan:clone(candidate),jobID:null,
   outputItems:[],preparedAt:stamp,updatedAt:stamp};
  write({...state,entries:{...state.entries,[id]:entry}});
  return {status:'PREPARED',operationID:id,plan:clone(candidate)};
 })}
 function install(operationID){return locked(()=>{if(!enabled)return {status:'NPC_INDUSTRY_DISABLED'};
  const state=read(),entry=state.entries[String(operationID)];if(!entry)return {status:'UNKNOWN_OPERATION'};
  if(entry.status!=='PREPARED')return {status:entry.status,jobID:entry.jobID};
  if(!native||native.supportsAtomicInstall!==true||typeof native.revalidate!=='function'||typeof native.installOnce!=='function'||typeof native.getJobByOperation!=='function')return {status:'ATOMIC_NATIVE_INSTALL_UNAVAILABLE'};
  // A prepared plan must not be mistaken for a financial reservation. No debit
  // until a real native transaction can reserve all inventory, wallet and BPO.
  if(native.revalidate(entry.plan)!==true)return {status:'NATIVE_PLAN_CHANGED'};
  state.entries[operationID]=status(entry,'INSTALL_OUTCOME_UNKNOWN');write(state);
  try{const result=native.installOnce(entry.plan,operationID);
   const jobID=pos(result?.jobID),job=jobID?native.getJobByOperation(operationID):null;
   if(!jobID||pos(job?.jobID)!==jobID||Number(job.ownerID)!==entry.plan.ownerID||
      Number(job.blueprintID)!==entry.plan.blueprintItemID||Number(job.facilityID)!==entry.plan.facilityID||
      Number(job.productTypeID)!==entry.plan.productTypeID)return {status:'INSTALL_OUTCOME_UNKNOWN'};
   state.entries[operationID]=status(entry,'INSTALLED',{jobID});write(state);
   return {status:'INSTALLED',jobID,operationID};
  }catch{return {status:'INSTALL_OUTCOME_UNKNOWN'}}
 })}
 function deliver(operationID){return locked(()=>{if(!enabled)return {status:'NPC_INDUSTRY_DISABLED'};
  const state=read(),entry=state.entries[String(operationID)];if(!entry)return {status:'UNKNOWN_OPERATION'};
  if(entry.status==='DELIVERED')return {status:'DELIVERED',jobID:entry.jobID,outputItems:clone(entry.outputItems)};
  if(entry.status!=='INSTALLED')return {status:entry.status};
  if(!native||native.supportsAtomicDelivery!==true||typeof native.getJobByOperation!=='function'||
     typeof native.deliverOnce!=='function'||typeof native.verifyDelivered!=='function')return {status:'ATOMIC_NATIVE_DELIVERY_UNAVAILABLE'};
  const job=native.getJobByOperation(operationID);
  if(pos(job?.jobID)!==entry.jobID||Number(job.ownerID)!==entry.plan.ownerID||
     Number(job.blueprintID)!==entry.plan.blueprintItemID)return {status:'JOB_IDENTITY_MISMATCH'};
  // Pinned EveJS status READY=3. In particular don't change endDate to force it.
  if(Number(job.status)!==3)return {status:'JOB_NOT_READY',jobID:entry.jobID};
  state.entries[operationID]=status(entry,'DELIVERY_OUTCOME_UNKNOWN');write(state);
  try{native.deliverOnce(job,operationID);
   const proof=native.verifyDelivered(operationID);
   const out=Array.isArray(proof?.items)?proof.items:[];
   if(proof?.delivered!==true||!out.length||out.some(x=>!pos(x.itemID)||!pos(x.typeID)||!pos(x.quantity)||
      Number(x.ownerID)!==entry.plan.ownerID||Number(x.locationID)!==entry.plan.stationID||Number(x.typeID)!==entry.plan.productTypeID)||
      out.reduce((n,x)=>n+Number(x.quantity),0)!==entry.plan.outputQuantity||
      new Set(out.map(x=>x.itemID)).size!==out.length)return {status:'DELIVERY_OUTCOME_UNKNOWN'};
   state.entries[operationID]=status(entry,'DELIVERED',{outputItems:clone(out)});write(state);
   return {status:'DELIVERED',jobID:entry.jobID,outputItems:clone(out)};
  }catch{return {status:'DELIVERY_OUTCOME_UNKNOWN'}}
 })}
 function inspect(operationID){const x=read().entries[String(operationID)];return x?clone(x):null}
 function audit(){const state=read(),counts={};for(const e of Object.values(state.entries))counts[e.status]=(counts[e.status]||0)+1;
  return {status:Object.keys(counts).some(x=>x.includes('UNKNOWN'))?'NEEDS_OPERATOR_RECONCILIATION':'OK',counts,operations:Object.keys(state.entries).length}}
 // Intentionally NO force-retry method for uncertain native calls.
 return {prepare:planAndPrepare,install,deliver,inspect,audit};
}
module.exports={createJournal};