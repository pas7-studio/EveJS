"use strict";
// COOP-032A: pure planning from actual EveJS SDE recipes, owned native inventory,
// registered original blueprints and confirmed jobs. NEVER mutates stock or ISK.
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const count=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):null;
const exact=x=>Number.isFinite(Number(x))&&Number(x)>=0?Number(x):null;
const sort=(a,b)=>a-b;
const validArray=x=>Array.isArray(x)?x:[];
const findMap=(rows)=>{
 const out=new Map();
 for(const row of rows){const t=pos(row?.typeID),q=count(row?.quantity??row?.stacksize);
  if(!t||q===null)continue;
  out.set(t,(out.get(t)||0)+q);
 }
 return out;
};
function createPlanner(deps={}){
 const required=['getCorporation','isNpcCorporation','getStation','getFacility','getBlueprintDefinition','getIndustryActivity','buildMaterials','getBlueprintStates','listOwnerItems','listJobs','getType'];
 if(required.some(k=>typeof deps[k]!=='function'))throw Error('NPC_MANUFACTURING_PLANNER_DEPENDENCIES');
 function plan({ownerID,stationID,productTypeIDs=[],targetStock={},marketStock={},reservedMaterials={},maxJobs=2}={}){
  const owner=pos(ownerID),station=pos(stationID),limit=count(maxJobs);
  if(!owner||!station||limit===null||limit>2)return{status:'INVALID_CONTEXT',jobs:[]};
  if(!deps.isNpcCorporation(owner)||!deps.getCorporation(owner))return{status:'NPC_CORPORATION_UNVERIFIED',jobs:[]};
  const nativeStation=deps.getStation(station);
  if(!nativeStation||pos(nativeStation.stationID)!==station||!pos(nativeStation.solarSystemID))return{status:'NATIVE_STATION_NOT_FOUND',jobs:[]};
  const facility=deps.getFacility(station);
  if(pos(facility?.facilityID)!==station||pos(facility?.solarSystemID)!==pos(nativeStation.solarSystemID)||facility.online!==true||!facility.activities?.[1])return{status:'NATIVE_FACTORY_UNAVAILABLE',jobs:[]};
  const all=deps.listOwnerItems(owner);
  if(!Array.isArray(all))return{status:'NATIVE_ITEMS_UNAVAILABLE',jobs:[]};
  const owned=all.filter(i=>pos(i?.ownerID)===owner&&pos(i?.locationID)===station&&[4,115].includes(Number(i.flagID)));
  // Never turn invalid or duplicate native inventory records into zero stock.
  // In particular a negative mineral stack must not become another free batch.
  const ids=new Set();
  for(const item of owned){
   const q=count(item.quantity??item.stacksize??(Number(item.singleton)===1?1:undefined));
   if(!pos(item.itemID)||!pos(item.typeID)||q===null||ids.has(item.itemID))
    return{status:'NATIVE_ITEM_PROVENANCE_UNVERIFIED',jobs:[]};
   ids.add(item.itemID);
  }
  const bpState=deps.getBlueprintStates();
  if(!bpState||typeof bpState!=='object'||!bpState.records)return{status:'BLUEPRINT_STATE_UNAVAILABLE',jobs:[]};
  const installed=deps.listJobs(owner);
  if(!Array.isArray(installed))return{status:'NATIVE_JOBS_UNAVAILABLE',jobs:[]};
  const rawAvailable=findMap(owned.filter(i=>Number(i.categoryID)!==9));
  const remaining=new Map(rawAvailable);
  for(const [key,q] of Object.entries(reservedMaterials)){const type=pos(key),qty=count(q);if(!type||qty===null||qty>(remaining.get(type)||0))return{status:'RESERVATION_UNVERIFIED',jobs:[]};remaining.set(type,(remaining.get(type)||0)-qty);}
  // Industry: 1=INSTALLED, 2=PAUSED, 3=READY; COOP delivery=4.
  // Treating status 4 (or cancelled jobs) as WIP causes permanent ghost stock:
  // the NPC never restarts manufacturing after the finished batch is sold.
  // Only active manufacturing jobs at this EXACT station reserve output.
  // Stock EveJS status 100 is COMPLETED but not necessarily DELIVERED.
  // Treat its undelivered output as an operator reconciliation boundary, not
  // either confirmed hangar stock or safely discarded WIP.
  if(installed.some(j=>Number(j?.ownerID)===owner&&
     Number(j.stationID??j.facilityID)===station&&Number(j.activityID)===1&&
     Number(j.status)===100))
   return{status:'NATIVE_COMPLETED_JOB_RECONCILIATION_REQUIRED',jobs:[]};
  // Active native jobs missing station/activity identity are NOT evidence of
  // zero pending stock. Refuse a new paid install until the reader is repaired.
  if(installed.some(j=>Number(j?.ownerID)===owner&&
     [1,2,3].includes(Number(j.status))&&
     (!pos(j.stationID??j.facilityID)||!pos(j.activityID))))
   return{status:'NATIVE_ACTIVE_JOB_SCOPE_UNVERIFIED',jobs:[]};
  const existingJobs=installed.filter(j=>Number(j.ownerID)===owner&&
    Number(j.stationID??j.facilityID)===station&&Number(j.activityID)===1&&
    [1,2,3].includes(Number(j.status)));
  const candidateProducts=[...new Set(validArray(productTypeIDs).map(pos).filter(Boolean))].sort(sort);
  const candidates=[],blocked=[];
  for(const typeID of candidateProducts){
   const type=deps.getType(typeID);
   if(Number(type?.categoryID)!==8){blocked.push({typeID,reason:'NOT_AMMUNITION'});continue;}
   const def=deps.getBlueprintDefinition(typeID),bpType=pos(def?.blueprintTypeID),activity=deps.getIndustryActivity(def,1);
   if(!bpType||!activity){blocked.push({typeID,reason:'NATIVE_BLUEPRINT_RECIPE_MISSING'});continue;}
   const product=validArray(activity.products).find(p=>Number(p.typeID)===typeID&&pos(p.quantity));
   if(!product){blocked.push({typeID,reason:'NATIVE_PRODUCT_OUTPUT_MISSING'});continue;}
   const original=owned.filter(i=>Number(i.categoryID)===9&&Number(i.typeID)===bpType&&Number(i.singleton)===1)
    .sort((a,b)=>a.itemID-b.itemID).find(i=>{const st=bpState.records[String(i.itemID)];return st&&st.original===true&&!st.jobID&&Number(st.typeID)===bpType;});
   if(!original){blocked.push({typeID,reason:'REAL_ORIGINAL_BLUEPRINT_REQUIRED'});continue;}
   const target=count(targetStock[String(typeID)]),market=count(marketStock[String(typeID)]);
   if(target===null||market===null||target>1000000){blocked.push({typeID,reason:'DEMAND_NOT_VERIFIED'});continue;}
   const local=owned.filter(i=>Number(i.typeID)===typeID&&Number(i.categoryID)!==9).reduce((sum,i)=>sum+Math.max(0,Number(i.quantity)||0),0);
   const matchingJobs=existingJobs.filter(j=>Number(j.productTypeID)===typeID);
   if(matchingJobs.some(j=>!Number.isSafeInteger(j.productQuantity)||j.productQuantity<=0||
       !Number.isSafeInteger(j.jobID)||j.jobID<=0)||
      new Set(matchingJobs.map(j=>j.jobID)).size!==matchingJobs.length){
    blocked.push({typeID,reason:'NATIVE_ACTIVE_JOB_PROOF_INVALID'});continue;
   }
   const inProgress=matchingJobs.reduce((sum,j)=>sum+j.productQuantity,0);
   if(!Number.isSafeInteger(inProgress)){
    blocked.push({typeID,reason:'NATIVE_JOB_OUTPUT_OVERFLOW'});continue;
   }
   const shortage=target-market-local-inProgress;
   if(shortage<=0){blocked.push({typeID,reason:'SUFFICIENT_STOCK'});continue;}
   const state=bpState.records[String(original.itemID)];
   const materials=deps.buildMaterials(def,1,1,{materialEfficiency:Number(state.materialEfficiency)||0,facility,productTypeID:typeID});
   if(!Array.isArray(materials)||!materials.length||materials.some(m=>!pos(m.typeID)||!pos(m.quantity))) {blocked.push({typeID,reason:'INVALID_NATIVE_MATERIAL_QUOTE'});continue;}
   const qty=pos(product.quantity);
   if(!qty){blocked.push({typeID,reason:'INVALID_NATIVE_OUTPUT'});continue;}
   candidates.push({ownerID:owner,stationID:station,systemID:nativeStation.solarSystemID,
    productTypeID:typeID,blueprintItemID:Number(original.itemID),blueprintTypeID:bpType,
    runs:1,outputQuantity:qty,shortage,materials:materials.map(m=>({typeID:Number(m.typeID),quantity:Number(m.quantity)})),
    materialEfficiency:Number(state.materialEfficiency)||0,facilityID:station,source:'NATIVE_SDE_READ_ONLY'});
  }
  candidates.sort((a,b)=>b.shortage-a.shortage||a.productTypeID-b.productTypeID||a.blueprintItemID-b.blueprintItemID);
  const jobs=[],reservedBlueprints=new Set();
  for(const candidate of candidates){
   if(jobs.length>=limit){blocked.push({typeID:candidate.productTypeID,reason:'STATION_JOB_LIMIT'});continue;}
   if(reservedBlueprints.has(candidate.blueprintItemID)){blocked.push({typeID:candidate.productTypeID,reason:'BLUEPRINT_BUSY'});continue;}
   const needs=findMap(candidate.materials);
   if([...needs].some(([t,q])=>(remaining.get(t)||0)<q)){
    blocked.push({typeID:candidate.productTypeID,reason:'NEEDS_MINERALS'});continue;
   }
   for(const [t,q] of needs)remaining.set(t,remaining.get(t)-q);
   reservedBlueprints.add(candidate.blueprintItemID);
   jobs.push(candidate);
  }
  return {status:jobs.length?'PLAN_READY':'NO_ELIGIBLE_JOB',jobs,blocked,
   remainingMaterials:Object.fromEntries([...remaining].sort((a,b)=>a[0]-b[0]))};
 }
 return {plan};
}
module.exports={createPlanner};