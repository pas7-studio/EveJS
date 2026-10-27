"use strict";
/**
 * Chat 25: native personal-station ore debit and mineral creation.
 * ONLY called from an explicit opt-in server-side reprocessing hook.
 * Native reprocessingRuntime supplies the SDE quote and ownership context.
 */
const fs=require("node:fs"),path=require("node:path");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const qty=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):null;
const fail=(errorMsg,details={})=>({success:false,errorMsg,...details});
function createReprocessor({items,industry,staticData,root,io=fs,clock=()=>Date.now()}={}){
 if(!items||typeof items.findItemById!=="function"||
  typeof items.coopPlayerOreReprocessAtomic!=="function"||!industry||
  typeof industry.resolveReprocessingContext!=="function"||
  typeof industry.buildReprocessingQuoteForItem!=="function"||
  !staticData||typeof staticData.typeHasRandomizedMaterials!=="function"||
  typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("PLAYER_ORE_NATIVE_AUTHORITIES_REQUIRED");
 const busy=new Set();
 const receiptFile=id=>path.join(root,id+".json");
 const validKey=id=>/^coop-player-ore-v1-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/.test(id);
 function load(id){
  if(!validKey(id))throw Error("PLAYER_ORE_RECEIPT_KEY_INVALID");
  try{
   const saved=JSON.parse(io.readFileSync(receiptFile(id),"utf8"));
   if(saved?.version!==1||saved.operationID!==id||
    !["PREPARED","COMMITTED"].includes(saved.phase)||
    !positive(saved.characterID)||!positive(saved.itemID)||
    !positive(saved.originalQuantity)||!positive(saved.typeID)||
    !positive(saved.stationID)||!Array.isArray(saved.outputs))
    throw Error("PLAYER_ORE_RECEIPT_INVALID");
   return saved;
  }catch(error){
   if(error.code==="ENOENT")return null;
   throw error;
  }
 }
 function persist(row){
  io.mkdirSync(root,{recursive:true});
  const dest=receiptFile(row.operationID),temp=dest+".tmp-"+process.pid;
  let fd=null;
  try{
   fd=io.openSync(temp,"wx",0o600);
   io.writeFileSync(fd,JSON.stringify(row)+"\n");
   io.fsyncSync(fd);
   io.closeSync(fd);fd=null;
   io.renameSync(temp,dest);
   // A receipt that cannot be durably acknowledged must never trigger mutation.
   const dfd=io.openSync(root,"r");
   try{io.fsyncSync(dfd);}finally{io.closeSync(dfd);}
  }finally{
   if(fd!==null)try{io.closeSync(fd);}catch(_e){}
   try{io.unlinkSync(temp);}catch(error){if(error.code!=="ENOENT")throw error;}
  }
 }
 function outputVerified(row){
  const source=items.findItemById(row.itemID);
  if(row.leftOvers===0){if(source)return false;}
  else if(!source||Number(source.itemID)!==row.itemID||
   Number(source.ownerID)!==row.characterID||
   Number(source.locationID)!==row.stationID||
   Number(source.flagID)!==items.ITEM_FLAGS.HANGAR||
   Number(source.typeID)!==row.typeID||Number(source.quantity)!==row.leftOvers)
   return false;
  if(!Array.isArray(row.created)||row.created.length!==row.outputs.length)return false;
  const seen=new Set();
  for(const expected of row.created){
   if(!positive(expected.itemID)||seen.has(expected.itemID))return false;
   seen.add(expected.itemID);
   const actual=items.findItemById(expected.itemID);
   if(!actual||Number(actual.ownerID)!==row.characterID||
    Number(actual.locationID)!==row.stationID||
    Number(actual.flagID)!==items.ITEM_FLAGS.HANGAR||
    Number(actual.typeID)!==expected.typeID||
    Number(actual.quantity)!==expected.quantity||
    String(actual.customInfo||"")!==row.operationID+":mineral:"+expected.typeID)
    return false;
  }
  return true;
 }
 function processItem(session,options={}){
  if(!session||session.socket?.destroyed===true||
   !positive(session.characterID))
   return fail("PLAYER_ORE_SESSION_UNAUTHENTICATED");
  const refs=options.itemIDs;
  // One original item stack per atomic operation. Multi-item input cannot be
  // piecemeal acknowledged as an all-or-nothing reprocessing RPC.
  if(!Array.isArray(refs)||refs.length!==1||
   !positive(refs[0]?.itemID??refs[0]))
   return fail("PLAYER_ORE_SINGLE_STACK_REQUIRED");
  const itemID=positive(refs[0]?.itemID??refs[0]);
  const contextResult=industry.resolveReprocessingContext(session);
  if(contextResult?.success!==true||!contextResult.data)
   return fail(contextResult?.errorMsg||"PLAYER_ORE_NOT_DOCKED");
  const context=contextResult.data,characterID=positive(context.characterID),
    stationID=positive(context.dockedLocationID);
  if(characterID!==Number(session.characterID)||!stationID)
   return fail("PLAYER_ORE_DOCKED_OWNER_MISMATCH");
  if(options.fromLocationID!=null&&Number(options.fromLocationID)!==stationID)
   return fail("PLAYER_ORE_FROM_LOCATION_MISMATCH");
  if(options.outputLocationID!=null&&Number(options.outputLocationID)!==stationID)
   return fail("PLAYER_ORE_OUTPUT_LOCATION_MISMATCH");
  if(options.outputFlagID!=null&&Number(options.outputFlagID)!==Number(items.ITEM_FLAGS.HANGAR))
   return fail("PLAYER_ORE_OUTPUT_FLAG_MISMATCH");
  if(options.ownerID!=null&&Number(options.ownerID)>0&&Number(options.ownerID)!==characterID)
   return fail("PLAYER_ORE_OUTPUT_OWNER_MISMATCH");
  if(context.dockedKind!=="station"&&context.dockedKind!=="structure")
   return fail("PLAYER_ORE_NATIVE_STATION_REQUIRED");
  const item=items.findItemById(itemID);
  if(!item||Number(item.ownerID)!==characterID||
   Number(item.locationID)!==stationID||
   Number(item.flagID)!==Number(items.ITEM_FLAGS.HANGAR)||
   Number(item.singleton)!==0||!positive(item.typeID)||
   !positive(item.quantity)||Number(item.quantity)!==Number(item.stacksize))
   return fail("PLAYER_ORE_NOT_IN_PERSONAL_STATION_HANGAR");
  if(staticData.typeHasRandomizedMaterials(item.typeID))
   return fail("PLAYER_ORE_RANDOMIZED_RECIPE_UNSUPPORTED");
  const quote=industry.buildReprocessingQuoteForItem(item,context,{
   includeRecoverablesFromRandomizedOutputs:false
  });
  if(!quote||quote.errorMsg||Number(quote.itemID)!==itemID||
   Number(quote.typeID)!==Number(item.typeID)||
   !positive(quote.quantityToProcess)||!positive(quote.portions)||
   qty(quote.leftOvers)===null||
   Number(quote.quantityToProcess)+Number(quote.leftOvers)!==Number(item.quantity)||
   !Number.isFinite(Number(quote.totalISKCost)))
   return fail("PLAYER_ORE_NATIVE_QUOTE_UNVERIFIED");
  // Wallet and items are separate native stores. No double-charge/lost ore
  // allowed: the taxed path needs a GameStore multi-table transaction.
  if(Number(quote.totalISKCost)!==0)
   return fail("PLAYER_ORE_ATOMIC_WALLET_TAX_REQUIRED",{requiredISK:quote.totalISKCost});
  const outputs=[],seen=new Set();
  if(!Array.isArray(quote.recoverables)||quote.recoverables.length>16)
   return fail("PLAYER_ORE_NATIVE_OUTPUTS_UNSUPPORTED");
  for(const r of quote.recoverables){
   const typeID=positive(r.typeID),quantity=qty(r.client);
   if(!typeID||quantity===null||!Number.isFinite(Number(r.unrecoverable))||
    Number(r.unrecoverable)<0||seen.has(typeID))
    return fail("PLAYER_ORE_NATIVE_OUTPUT_INVALID");
   seen.add(typeID);
   if(quantity>0){
    const limit=Number(items.CLIENT_INVENTORY_STACK_LIMIT);
    const metadata=typeof items.getItemMetadata==="function"?
     items.getItemMetadata(typeID):null;
    if(!Number.isSafeInteger(limit)||quantity>limit||
       !metadata||!positive(metadata.groupID)||!positive(metadata.categoryID))
     return fail("PLAYER_ORE_NATIVE_MATERIAL_UNSUPPORTED");
    outputs.push({typeID,quantity});
   }
  }
  if(!outputs.length||outputs.length>16)
   return fail("PLAYER_ORE_NO_VERIFIED_MATERIALS");
  const operationID="coop-player-ore-v1-"+characterID+"-"+itemID+"-"+item.quantity+"-"+item.typeID;
  if(busy.has(operationID))return fail("PLAYER_ORE_IN_PROGRESS");
  busy.add(operationID);
  try{
   let prior;
   try{prior=load(operationID);}catch(error){
    return fail("PLAYER_ORE_RECEIPT_UNREADABLE");
   }
   if(prior){
    if(prior.phase!=="COMMITTED")
     return fail("PLAYER_ORE_PENDING_OPERATOR_RECONCILIATION",{operationID});
    // Do not mint mineral rows again from a stale/replayed EVE client RPC.
    return {success:true,data:{
     processedItemIDs:[],outputByTypeID:{},inputChanges:[],outputChanges:[],
     reprocessedEvents:[],outputLocationID:stationID,
     outputFlagID:items.ITEM_FLAGS.HANGAR,outputOwnerID:characterID,
     context,alreadyCommitted:true,operationID
    }};
   }
   const plan={operationID,itemID,typeID:Number(item.typeID),characterID,
    stationID,originalQuantity:Number(item.quantity),
    consumeQuantity:Number(quote.quantityToProcess),
    leftOvers:Number(quote.leftOvers),outputs};
   const row={version:1,...plan,phase:"PREPARED",at:clock()};
   try{persist(row);}catch(error){
    return fail("PLAYER_ORE_PREPARE_UNCERTAIN",{operationID});
   }
   let mutation;
   try{mutation=items.coopPlayerOreReprocessAtomic(plan);}catch(error){
    return fail("PLAYER_ORE_NATIVE_MUTATION_UNCERTAIN",{operationID});
   }
   if(mutation?.success!==true)
    return fail("PLAYER_ORE_NATIVE_MUTATION_UNCERTAIN",{operationID});
   const completed={...row,phase:"COMMITTED",created:mutation.data?.created||[],
    completedAt:clock()};
   if(!outputVerified(completed))
    return fail("PLAYER_ORE_NATIVE_READBACK_FAILED",{operationID});
   try{persist(completed);}catch(error){
    return fail("PLAYER_ORE_COMMIT_RECEIPT_UNCERTAIN",{operationID});
   }
   const outputByTypeID=Object.fromEntries(outputs.map(e=>[e.typeID,e.quantity]));
   return {success:true,data:{
    processedItemIDs:[itemID],outputByTypeID,
    inputChanges:mutation.data.inputChanges||[],
    outputChanges:mutation.data.outputChanges||[],
    reprocessedEvents:[{characterID,dockedKind:context.dockedKind,
     dockedLocationID:stationID,inputTypeID:Number(item.typeID),
     quantity:plan.consumeQuantity,
     outputs:outputs.map(e=>({outputTypeID:e.typeID,quantity:e.quantity}))}],
    outputLocationID:stationID,outputFlagID:items.ITEM_FLAGS.HANGAR,
    outputOwnerID:characterID,context,operationID
   }};
  }finally{busy.delete(operationID);}
 }
 function review({operationID,authorize=false}={}){
  if(!validKey(operationID))return {status:"INVALID"};
  let row;
  try{row=load(operationID);}catch{return {status:"NEEDS_OPERATOR_REPAIR"}}
  if(!row)return {status:"NOT_FOUND"};
  if(row.phase==="COMMITTED")return {
   status:outputVerified(row)?"COMMITTED_VERIFIED":"COMMITTED_ITEMS_MOVED_OR_UNVERIFIED",
   operationID
  };
  // The only recovery allowed is a manual proof-only commit of an ALREADY
  // executed native transaction. Never mint new mineral items or retry debit.
  if(authorize!==true)return {status:"PENDING_OPERATOR_RECONCILIATION",operationID};
  if(typeof items.listContainerItems!=="function")
   return {status:"NATIVE_STATION_INVENTORY_UNAVAILABLE",operationID};
  try{
   const native=items.listContainerItems(row.characterID,row.stationID,
    items.ITEM_FLAGS.HANGAR);
   if(!Array.isArray(native))
    return {status:"NATIVE_STATION_INVENTORY_UNAVAILABLE",operationID};
   const prefix=row.operationID+":mineral:";
   const observed=native.filter(item=>String(item.customInfo||"").startsWith(prefix));
   const byType=new Map(row.outputs.map(o=>[Number(o.typeID),Number(o.quantity)]));
   if(!observed.length||observed.length!==byType.size)
    return {status:"NATIVE_READBACK_INCOMPLETE",operationID};
   const created=[];
   for(const item of observed){
    const expected=byType.get(Number(item.typeID));
    if(!positive(item.itemID)||!positive(expected)||
       Number(item.quantity)!==expected||Number(item.ownerID)!==row.characterID||
       Number(item.locationID)!==row.stationID||
       Number(item.flagID)!==items.ITEM_FLAGS.HANGAR||
       String(item.customInfo)!==prefix+item.typeID)
     return {status:"NATIVE_READBACK_INCOMPLETE",operationID};
    created.push({itemID:Number(item.itemID),
      typeID:Number(item.typeID),quantity:Number(item.quantity)});
   }
   const complete={...row,phase:"COMMITTED",created,
    completedAt:clock(),operatorReconciled:true};
   if(!outputVerified(complete))
    return {status:"NATIVE_READBACK_INCOMPLETE",operationID};
   persist(complete);
   return {status:"RECOVERED_NATIVE_COMMIT",operationID};
  }catch(error){return {status:"NEEDS_OPERATOR_REPAIR",operationID}}
 }
 return {processItem,review};
}
// Prevent the stock ReprocessingService from modifying/splitting input stacks
// BEFORE the durable single-stack journal and native atomic item mutation.
function materializeWithoutSplit(session,itemIDs){
 if(!Array.isArray(itemIDs)||itemIDs.length!==1||
  !positive(itemIDs[0]?.itemID??itemIDs[0]))
  return fail("PLAYER_ORE_SINGLE_STACK_REQUIRED");
 return {success:true,data:{itemIDs:[positive(itemIDs[0]?.itemID??itemIDs[0])],
  splitChanges:[]}};
}
let runtime=null;
function reprocess(session,options){
 if(process.env.EVEJS_COOP_PLAYER_ORE_ATOMIC!=="1")
  return fail("PLAYER_ORE_DISABLED");
 try{
  if(!runtime){
   const items=require(path.join(__dirname,"../services/inventory/itemStore"));
   const industry=require(path.join(__dirname,"../services/reprocessing/reprocessingRuntime"));
   const staticData=require(path.join(__dirname,"../services/reprocessing/reprocessingStaticData"));
   runtime=createReprocessor({items,industry,staticData,
    root:process.env.EVEJS_COOP_PLAYER_ORE_RECEIPTS_DIR});
  }
  return runtime.processItem(session,options);
 }catch(error){
  return fail("PLAYER_ORE_NATIVE_DEPENDENCY_UNAVAILABLE");
 }
}
module.exports={createReprocessor,reprocess,materializeWithoutSplit};
