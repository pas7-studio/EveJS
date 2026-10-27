"use strict";
// EX-03B4: strict opt-in NATIVE authoring of scanner hardware for a small,
// deterministic subset of fresh physical NPC patrols. The original NPC spawn
// allocates modules + original cargoIDs and enforces slot/capability limits.
// Never retrofit existing hulls or mint stock outside original source store.
const LAUNCHER_TYPE_ID=17938;  // Core Probe Launcher I, group 481
const CHARGE_TYPE_ID=30013;   // Core Scanner Probe I, group 479
function createNpcScoutLoadout({resolveItemByTypeID,compatibleCharges,
 resolveItemByName=null,typeHasEffectName=null,withAnalyzers=false}={}){
 if(withAnalyzers===true&&
    (typeof resolveItemByName!=="function"||typeof typeHasEffectName!=="function"))
  throw Error("EX03_NATIVE_ANALYZER_TYPE_AUTHORITIES_REQUIRED");
 if(typeof resolveItemByTypeID!=="function"||typeof compatibleCharges!=="function")
  throw Error("NPC_SCOUT_NATIVE_ITEM_AUTHORITIES_REQUIRED");
 function apply(definition){
  const fail=reason=>({success:false,errorMsg:reason});
  if(!definition?.loadout||!Array.isArray(definition.loadout.modules)||
    !Array.isArray(definition.loadout.charges)||
    !definition.profile?.profileID)return fail("NPC_SCOUT_LOADOUT_DEFINITION_INVALID");
  let launcher,probe,compatible;
  try{
   launcher=resolveItemByTypeID(LAUNCHER_TYPE_ID);
   probe=resolveItemByTypeID(CHARGE_TYPE_ID);
   compatible=compatibleCharges(LAUNCHER_TYPE_ID);
  }catch{return fail("NPC_SCOUT_NATIVE_STATIC_UNAVAILABLE")}
  if(!launcher||launcher.typeID!==LAUNCHER_TYPE_ID||
     launcher.groupID!==481||launcher.categoryID!==7||
     !probe||probe.typeID!==CHARGE_TYPE_ID||probe.groupID!==479||
     probe.categoryID!==8||!Array.isArray(compatible)||
     !compatible.includes(CHARGE_TYPE_ID))return fail("NPC_SCOUT_NATIVE_TYPES_UNVERIFIED");
  if(definition.loadout.modules.length>12||definition.loadout.charges.length>12)
   return fail("NPC_SCOUT_LOADOUT_TOO_LARGE");
  // No duplicate launcher: an existing authored scanner must be preserved,
  // and a scout cannot sneak in a second scanner group.
  for(const row of definition.loadout.modules){
   if(!Number.isSafeInteger(row?.typeID)||row.typeID<=0)return fail("NPC_SCOUT_MODULE_INVALID");
   let item;try{item=resolveItemByTypeID(row.typeID)}catch{return fail("NPC_SCOUT_MODULE_UNVERIFIED")}
   if(!item)return fail("NPC_SCOUT_MODULE_UNVERIFIED");
   if(item.groupID===481)return fail("NPC_SCOUT_LAUNCHER_ALREADY_PRESENT");
  }
  // EX-03B15: only original item-type registry/effect metadata may add a
  // real fitted analyzer. Original nativeNpcService still validates slots and
  // allocates every original moduleID; no synthetic module in runtime.
  const analyzers=[];
  if(withAnalyzers===true){
   for(const name of ["Data Analyzer I","Relic Analyzer I"]){
    let entry,type;
    try{
     const lookup=resolveItemByName(name);
     entry=lookup?.success===true?lookup.match:null;
     type=resolveItemByTypeID(entry?.typeID);
    }catch{return fail("EX03_ANALYZER_NATIVE_STATIC_UNAVAILABLE")}
    if(!entry||!type||!Number.isSafeInteger(type.typeID)||
       type.typeID<=0||type.categoryID!==7||
       typeHasEffectName(type.typeID,"doHacking")!==true||
       !String(type.name||type.typeName||"").toLowerCase()
        .includes(name.toLowerCase()))
     return fail("EX03_ANALYZER_NATIVE_TYPE_INVALID");
    if(!definition.loadout.modules.some(x=>x.typeID===type.typeID))
     analyzers.push({typeID:type.typeID,quantity:1});
   }
   if(definition.loadout.modules.length+analyzers.length+1>12)
    return fail("EX03_ANALYZER_NATIVE_SLOT_BUDGET");
  }
  const loadout={...definition.loadout,
   modules:[...definition.loadout.modules.map(x=>({...x})),
    {typeID:LAUNCHER_TYPE_ID,quantity:1},...analyzers],
   charges:[...definition.loadout.charges.map(x=>({...x})),
    {typeID:CHARGE_TYPE_ID,quantityPerModule:4,singleton:false}]};
  return {success:true,definition:{...definition,loadout},
   addedLauncherTypeID:LAUNCHER_TYPE_ID,addedChargeTypeID:CHARGE_TYPE_ID,
   originalProbeCharges:4,originalAnalyzerModules:analyzers.length};
 }
 return Object.freeze({apply});
}
module.exports={createNpcScoutLoadout,LAUNCHER_TYPE_ID,CHARGE_TYPE_ID};
