"use strict";
// COOP-031: audited internal-only NPC refining; never call player session handlers.
// Native SDE quote -> one native items table debit+credit -> synchronous flush.
const fs=require("node:fs"),path=require("node:path");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const keyFor=(itemID,quantity)=>`coop-refine:v1:${itemID}:${quantity}`;
// The logical operation ID stays "coop-refine:v1:<itemID>:<quantity>", but ':' cannot
// appear in a Windows file name, so the path segment is escaped there. Journal rows,
// receipt identities and comparisons keep using the unescaped ID.
const segment=(id)=>String(id).replace(/[^A-Za-z0-9._-]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
const journalFile=(directory,id)=>path.join(directory,
 (process.platform==="win32"?segment(id):String(id))+".json");
const safe=(x)=>JSON.parse(JSON.stringify(x));
const phases=Object.freeze({PREPARED:"PREPARED",COMMITTED:"COMMITTED"});
function createRefinery({directory,items,reprocessing,getStation,getCorporation,isNpcCorporation,
  facilityAvailable,clock=()=>Date.now(),fsApi=fs}={}){
 if(!directory||!path.isAbsolute(directory)||!items||!reprocessing||
  typeof reprocessing.buildReprocessingQuoteForItem!=="function"||
  !["findItemById","refineNpcWarehouseOreAtomic","listOwnedItems"].every(k=>typeof items[k]==="function")||
  [getStation,getCorporation,isNpcCorporation,facilityAvailable].some(fn=>typeof fn!=="function"))
  throw Error("NPC_REFINERY_DEPENDENCIES_REQUIRED");
 const busy=new Set();
 function filepath(id){return journalFile(directory,id);}
 function acquire(id){
  fsApi.mkdirSync(directory,{recursive:true});
  return fsApi.openSync(filepath(id)+".lock","wx",0o600);
 }
 function release(id,fd){
  if(fd===null||fd===undefined)return;
  try{fsApi.closeSync(fd)}catch(_error){}
  // If lock removal fails, leave it as a visible fail-closed blocker.
  try{fsApi.unlinkSync(filepath(id)+".lock")}catch(_error){}
 }
 function store(id,row){
  fsApi.mkdirSync(directory,{recursive:true});
  const dest=filepath(id),tmp=dest+`.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try{
   handle=fsApi.openSync(tmp,"wx",0o600);fsApi.writeFileSync(handle,JSON.stringify(row));
   fsApi.fsyncSync(handle);fsApi.closeSync(handle);handle=null;
   fsApi.renameSync(tmp,dest);
   try{const fd=fsApi.openSync(directory,"r");try{fsApi.fsyncSync(fd);}finally{fsApi.closeSync(fd)}}
   catch(e){if(!["EINVAL","EISDIR","ENOTSUP","EPERM","EACCES"].includes(e.code))throw e;}
  }finally{
   if(handle!==null&&handle!==undefined)try{fsApi.closeSync(handle)}catch(_error){}
   try{fsApi.unlinkSync(tmp)}catch(_error){}
  }
 }
 function load(id){
  let row;try{row=JSON.parse(fsApi.readFileSync(filepath(id),"utf8"))}
  catch(e){if(e.code==="ENOENT")return null;throw Error("NPC_REFINERY_JOURNAL_UNREADABLE")}
  if(row?.version!==1||row.operationID!==id||!Object.values(phases).includes(row.phase)||
   !positive(row.oreItemID)||!positive(row.originalQuantity)||!positive(row.ownerID)||
   !positive(row.stationID)||!positive(row.oreTypeID)||!Array.isArray(row.outputs))
   throw Error("NPC_REFINERY_JOURNAL_INVALID");
  return row;
 }
 function validate({oreItemID,ownerID,stationID,feePaid=null}={}){
  const id=positive(oreItemID),owner=positive(ownerID),stationIDNum=positive(stationID);
  if(!id||!owner||!stationIDNum)return {status:"INVALID_REQUEST"};
  const corp=getCorporation(owner),station=getStation(stationIDNum);
  if(!corp||Number(corp.corporationID)!==owner||isNpcCorporation(owner)!==true||
     !station||Number(station.stationID)!==stationIDNum||
     !positive(station.solarSystemID)||facilityAvailable(station,owner)!==true)
    return {status:"NPC_FACILITY_UNAVAILABLE"};
  const item=items.findItemById(id);
  if(!item||Number(item.ownerID)!==owner||Number(item.locationID)!==stationIDNum||
     Number(item.flagID)!==Number(items.ITEM_FLAGS?.HANGAR)||
     !positive(item.typeID)||!positive(item.quantity)||
     item.stacksize!==item.quantity||Number(item.singleton)!==0||
     !/^coop-warehouse:v1:cargo:[0-9]+$/.test(String(item.customInfo||"")))
    return {status:"NATIVE_ORE_NOT_AVAILABLE"};
  // A real static station with no explicit session. Character 0 has no fake skills,
  // implants, standings or wallet; tax calculation uses actual native station data.
  const context={characterID:0,corporationID:owner,dockedLocationID:stationIDNum,
    dockedKind:"station",stationRecord:station,structure:null,
    skillMap:new Map(),implants:[],standing:0};
  const quote=reprocessing.buildReprocessingQuoteForItem(item,context,
    {includeRecoverablesFromRandomizedOutputs:false});
  if(!quote||quote.errorMsg)return {status:"NATIVE_REPROCESSING_RECIPE_UNAVAILABLE"};
  // A stack smaller than one native portion is not a missing recipe: the refinery did all
  // it could and only leftovers are left. Say that, so an operator does not chase a bug.
  if(!positive(quote.quantityToProcess)||!positive(quote.portions))
    return {status:"NATIVE_REFINERY_LEFTOVER_TOO_SMALL",quantity:Number(item.quantity)};
  if(!Number.isSafeInteger(Number(quote.leftOvers))||Number(quote.leftOvers)<0||
     Number(quote.quantityToProcess)+Number(quote.leftOvers)!==Number(item.quantity))
    return {status:"NATIVE_REPROCESSING_RECIPE_UNAVAILABLE"};
  // Tax must be paid from a real NPC corporate wallet. A positive native fee is
  // accepted ONLY when the caller proves it already paid that exact amount: the
  // witness must name this corporation, this station and this ISK cost, and its
  // durable receipt must exist on disk. Nothing is ever waived.
  const fee=Number(quote.totalISKCost);
  if(!Number.isFinite(fee))return {status:"NATIVE_REPROCESSING_FEE_UNPROVEN"};
  let feeWitness=null;
  if(fee!==0){
   const paid=feePaid&&typeof feePaid==="object"?feePaid:null;
   const sameReceipt=Boolean(paid&&positive(paid.receiptID)&&
    Number(paid.amountISK)===fee&&Number(paid.corporationID)===owner&&
    Number(paid.stationID)===stationIDNum);
   if(!sameReceipt)
    return {status:"NPC_CORPORATION_WALLET_SETTLEMENT_REQUIRED",iskCost:fee};
   let durable=false;
   try{durable=fsApi.existsSync(path.join(directory,"refinery-fees",paid.receiptID+".json"))}
   catch(_error){durable=false}
   if(!durable)return {status:"REFINERY_FEE_RECEIPT_NOT_DURABLE",iskCost:fee};
   feeWitness={receiptID:positive(paid.receiptID),amountISK:fee};
  }
  const outputs=[];
  const seen=new Set();
  for(const entry of quote.recoverables||[]){
   const typeID=positive(entry?.typeID),quantity=Number(entry?.client);
   if(!typeID||!Number.isSafeInteger(quantity)||quantity<0||
      !Number.isSafeInteger(Number(entry?.unrecoverable))||Number(entry.unrecoverable)<0)
     return {status:"NATIVE_RECOVERABLE_INVALID"};
   if(quantity>0){
    if(seen.has(typeID)||quantity>Number(items.CLIENT_INVENTORY_STACK_LIMIT))
     return {status:"NATIVE_RECOVERABLE_UNSUPPORTED"};
    seen.add(typeID);outputs.push({typeID,quantity});
   }
  }
  if(!outputs.length||outputs.length>16)return {status:"NATIVE_RECOVERABLE_UNSUPPORTED"};
  const operationID=keyFor(id,Number(item.quantity));
  return {status:"READY",operationID,ownerID:owner,stationID:stationIDNum,oreItemID:id,
    oreTypeID:Number(item.typeID),originalQuantity:Number(item.quantity),
    consumeQuantity:Number(quote.quantityToProcess),leftOvers:Number(quote.leftOvers),
    portions:Number(quote.portions),nativeEfficiency:Number(quote.efficiency),
    stationTax:Number(quote.stationTax),iskCost:fee,feeReceipt:feeWitness,outputs,
    sourceCustomInfo:item.customInfo};
 }
 function verifyCommitted(row){
  const found=items.listOwnedItems(row.ownerID,{locationID:row.stationID,flagID:items.ITEM_FLAGS.HANGAR})||[];
  const prefix=row.operationID+":mineral:";
  const matches=found.filter(x=>String(x.customInfo||"").startsWith(prefix));
  const expected=new Map(row.outputs.map(x=>[Number(x.typeID),Number(x.quantity)]));
  if(matches.length!==expected.size||matches.some(x=>Number(x.singleton)!==0||
     !positive(x.quantity)||x.stacksize!==x.quantity||
     Number(x.ownerID)!==row.ownerID||Number(x.locationID)!==row.stationID||
     Number(x.flagID)!==Number(items.ITEM_FLAGS.HANGAR)||
     expected.get(Number(x.typeID))!==Number(x.quantity)||
     String(x.customInfo)!==prefix+Number(x.typeID)))return false;
  const left=items.findItemById(row.oreItemID);
  if(row.leftOvers===0)return !left;
  return Boolean(left&&Number(left.quantity)===row.leftOvers&&
     left.stacksize===left.quantity&&Number(left.singleton)===0&&
     Number(left.flagID)===Number(items.ITEM_FLAGS.HANGAR)&&
     Number(left.ownerID)===row.ownerID&&Number(left.locationID)===row.stationID&&
     Number(left.typeID)===row.oreTypeID&&String(left.customInfo)===row.sourceCustomInfo);
 }
 function refine(args){
  // A caller retrying an already-debited ore item must include its durable
  // operationID. Never regenerate a quote from nonexistent/changed stock.
  const suppliedID=String(args?.operationID||"");
  if(/^coop-refine:v1:[0-9]+:[0-9]+$/.test(suppliedID)){
   try{
    const prior=load(suppliedID);
    if(prior){
     if(Number(args.oreItemID)!==prior.oreItemID||
        Number(args.ownerID)!==prior.ownerID||Number(args.stationID)!==prior.stationID)
      return {status:"RECEIPT_IDENTITY_CONFLICT",operationID:suppliedID};
     return {status:prior.phase===phases.COMMITTED?
       (verifyCommitted(prior)?"ALREADY_COMMITTED":"COMMITTED_STATE_INVALID"):
       "PENDING_RECONCILIATION",operationID:suppliedID};
    }
   }catch(e){return {status:"NEEDS_OPERATOR_REPAIR",operationID:suppliedID,reason:String(e.message)}}
  }
  let plan;try{plan=validate(args)}catch(e){return {status:"NATIVE_REFINERY_QUOTE_UNCERTAIN",reason:String(e.message)}}
  if(plan.status!=="READY")return plan;
  const id=plan.operationID;
  if(busy.has(id))return {status:"IN_PROGRESS",operationID:id};
  busy.add(id);
  let guard;
  try{
   try{guard=acquire(id)}catch(_error){return {status:"REFINERY_LOCKED_NEEDS_REVIEW",operationID:id}}
   const previous=load(id);
   if(previous){
    if(previous.phase===phases.COMMITTED)
     return {status:verifyCommitted(previous)?"ALREADY_COMMITTED":"COMMITTED_STATE_INVALID",operationID:id};
    return {status:"PENDING_RECONCILIATION",operationID:id};
   }
   const row={version:1,...safe(plan),phase:phases.PREPARED,at:clock()};
   store(id,row); // Durable journal BEFORE any native item mutation.
   const outcome=items.refineNpcWarehouseOreAtomic(plan);
   if(outcome?.success!==true)return {status:"NATIVE_ITEMS_UNCERTAIN",operationID:id,
     reason:outcome?.errorMsg||"NATIVE_REFINERY_UNKNOWN"};
   if(!verifyCommitted(row))return {status:"NATIVE_RESULT_NOT_VERIFIED",operationID:id};
   store(id,{...row,phase:phases.COMMITTED,completedAt:clock(),
     nativeItemIDs:outcome.data?.created?.map(x=>x.itemID)||[]});
   return {status:"COMMITTED",operationID:id,outputs:safe(row.outputs),
     consumed:row.consumeQuantity,leftOvers:row.leftOvers};
  }catch(e){return {status:"NEEDS_OPERATOR_REPAIR",operationID:id,reason:String(e.message)}}
  finally{release(id,guard);busy.delete(id)}
 }
 function reconcile(oreItemID,originalQuantity,{authorize=false}={}){
  if(authorize!==true)return {status:"REPAIR_AUTHORIZATION_REQUIRED"};
  const item=positive(oreItemID),qty=positive(originalQuantity);
  if(!item||!qty)return {status:"INVALID_REQUEST"};
  const id=keyFor(item,qty);if(busy.has(id))return {status:"IN_PROGRESS"};busy.add(id);
  let guard;
  try{
   try{guard=acquire(id)}catch(_error){return {status:"REFINERY_LOCKED_NEEDS_REVIEW",operationID:id}}
   const row=load(id);if(!row)return {status:"RECEIPT_NOT_FOUND"};
   if(verifyCommitted(row)){
    if(row.phase!==phases.COMMITTED)store(id,{...row,phase:phases.COMMITTED,completedAt:clock()});
    return {status:row.phase===phases.COMMITTED?"ALREADY_COMMITTED":"COMMITTED",operationID:id};
   }
   return {status:"PENDING_OPERATOR_RECONCILIATION",operationID:id,phase:row.phase};
  }catch(e){return {status:"NEEDS_OPERATOR_REPAIR",reason:String(e.message),operationID:id}}
  finally{release(id,guard);busy.delete(id)}
 }
 return {preview:validate,refine,reconcile};
}
module.exports={createRefinery,keyFor,journalFile};