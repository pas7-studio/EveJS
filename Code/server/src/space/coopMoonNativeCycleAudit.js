"use strict";
// Read-only before/after conservation witness for pinned Metenox. NEVER
// creates output, credits a wallet, or proves a two-client harvest.
const HOUR_MS=3600000,TYPE_METENOX=81826,FLAG_FUEL=172,FLAG_MATERIAL=186;
const GROUP_MOON_MATERIAL=427,TYPE_LAVA=81143;
const pos=v=>Number.isSafeInteger(v)&&v>0?v:null;
const zeroOrPositive=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function itemsByType(items, locationID, ownerID, flagID, lookupType) {
  if(!Array.isArray(items)||typeof lookupType!=="function")return null;
  const totals=new Map(),seenIDs=new Set();
  for(const item of items){
    if(!item||!pos(item.itemID)||seenIDs.has(item.itemID)||
       !pos(item.typeID)||item.locationID!==locationID||item.ownerID!==ownerID||item.flagID!==flagID)
      return null;
    seenIDs.add(item.itemID);
    const type=lookupType(item.typeID);
    if(!type||Number(type.typeID)!==item.typeID||!pos(type.groupID)||
       !Number.isFinite(type.volume)||type.volume<0)return null;
    const quantity=item.singleton===1?1:zeroOrPositive(item.stacksize??item.quantity);
    if(!pos(quantity))return null;
    const next=(totals.get(item.typeID)||0)+quantity;
    if(!Number.isSafeInteger(next))return null;
    totals.set(item.typeID,next);
  }
  return totals;
}
function aggregateByGroup(totals,groupID,lookupType){
  let sum=0;
  for(const [typeID,quantity] of totals){
    if(lookupType(typeID).groupID!==groupID)continue;
    sum+=quantity;
    if(!Number.isSafeInteger(sum))return null;
  }
  return sum;
}
function audit({before,after,profile,fuelProfile,fuelBefore,fuelAfter,
 materialsBefore,materialsAfter,lookupType}={}){
  const base={scope:"NATIVE_INVENTORY_DELTAS_ONLY",gameplayVerified:false,
    atomicityVerified:false,clientVerified:false,twoPlayerVerified:false};
  const fail=(status,detail)=>({...base,status,detail});
  const a=before,b=after;
  const owner=pos(a?.ownerCorpID),id=pos(a?.structureID);
  if(!id||!owner||a?.typeID!==TYPE_METENOX||b?.structureID!==id||
     b?.ownerCorpID!==owner||b?.typeID!==TYPE_METENOX||a?.destroyedAt||b?.destroyedAt)
    return fail("INVALID_NATIVE_MOON_STRUCTURE","Physical structure identity/owner changed or is destroyed");
  const beforeAt=a?.devFlags?.autoMoonFuelState?.nextCycleAt;
  const afterAt=b?.devFlags?.autoMoonFuelState?.nextCycleAt;
  if(!pos(beforeAt)||!pos(afterAt)||afterAt<=beforeAt||
     (afterAt-beforeAt)%HOUR_MS!==0)return fail("INVALID_FUEL_CYCLE","No exact native hourly cycle advance");
  const cycles=(afterAt-beforeAt)/HOUR_MS;
  if(!pos(cycles)||cycles>24)return fail("UNBOUNDED_CATCHUP","Manual evidence window limited to 24 hours");
  if(!profile||!pos(profile.moonID)||profile.ownerID!==owner||
     profile.structureID!==id||!fuelProfile||fuelProfile.typeID!==TYPE_METENOX||
     !pos(fuelProfile.hourlyFuelBlocks)||!pos(fuelProfile.hourlyMagmaticGas)||
     !pos(fuelProfile.fuelGroupID))return fail("NO_AUTHORITATIVE_MOON_PROFILE","Native moon/resource/fuel profile missing or mismatched");
  const expected=profile.autoMoonMiningCycleOutput;
  if(!expected||typeof expected!=="object"||Array.isArray(expected)||
     Object.keys(expected).length===0)return fail("NO_AUTHORED_MOON_OUTPUT","No native type/quantity per-cycle recipe; do not mint items");
  if(typeof lookupType!=="function")return fail("NATIVE_TYPE_LOOKUP_UNAVAILABLE","Native SDE type registry required");
  const expectedTypes=new Map();
  for(const [k,v] of Object.entries(expected)){
    const typeID=Number(k),type=pos(typeID)?lookupType(typeID):null;
    if(!type||type.typeID!==typeID||type.groupID!==GROUP_MOON_MATERIAL||
       !pos(v)||!Number.isSafeInteger(v*cycles))return fail("INVALID_MOON_OUTPUT_RECIPE","Only exact native moon material types and positive integer quantities");
    expectedTypes.set(typeID,v*cycles);
  }
  const f0=itemsByType(fuelBefore,id,owner,FLAG_FUEL,lookupType);
  const f1=itemsByType(fuelAfter,id,owner,FLAG_FUEL,lookupType);
  const m0=itemsByType(materialsBefore,id,owner,FLAG_MATERIAL,lookupType);
  const m1=itemsByType(materialsAfter,id,owner,FLAG_MATERIAL,lookupType);
  if(!f0||!f1||!m0||!m1)return fail("INVALID_NATIVE_INVENTORY_SNAPSHOT","Wrong owner/location/flag/type/quantity/itemID in evidence");
  const block0=aggregateByGroup(f0,fuelProfile.fuelGroupID,lookupType);
  const block1=aggregateByGroup(f1,fuelProfile.fuelGroupID,lookupType);
  const gas0=f0.get(TYPE_LAVA)||0,gas1=f1.get(TYPE_LAVA)||0;
  if(block0===null||block1===null||
     block0-block1!==fuelProfile.hourlyFuelBlocks*cycles||
     gas0-gas1!==fuelProfile.hourlyMagmaticGas*cycles)
    return fail("NATIVE_FUEL_DEBIT_MISMATCH","Native fuel block and magmatic gas debits do not equal scheduled cycle cost");
  const typeIDs=new Set([...m0.keys(),...m1.keys(),...expectedTypes.keys()]);
  const observed={};
  for(const typeID of typeIDs){
    const delta=(m1.get(typeID)||0)-(m0.get(typeID)||0);
    if(delta!==(expectedTypes.get(typeID)||0)){
      if(delta===0&&expectedTypes.has(typeID))
        return fail("FUEL_BURNED_WITHOUT_MOON_OUTPUT","Native fuel was charged but expected material not delivered");
      return fail("MOON_OUTPUT_QUANTITY_MISMATCH","Native material quantities do not match exact authored cycle output");
    }
    observed[String(typeID)]=delta;
  }
  return {...base,status:"MATCHED_NATIVE_BALANCES_NOT_ATOMIC_PROOF",cycles,
    structureID:id,ownerCorpID:owner,materialDeltas:observed,
    detail:"Balance deltas agree, but no atomic debit+grant receipt or two-client observation is established"};
}
module.exports={audit,itemsByType,HOUR_MS,TYPE_METENOX,FLAG_FUEL,FLAG_MATERIAL};
