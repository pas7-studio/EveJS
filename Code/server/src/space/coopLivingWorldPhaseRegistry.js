"use strict";
// LW-03B: source-only classification of the EXISTING Living World phases.
// A phase description is not a native receipt, economic grant, command lease,
// independent timer, feature activation or authorisation to mutate EveJS.
const groups=[
 ["opportunities",["courier-observe","courier-dispatch"]],
 ["world-state",["virtual-travel","virtual-economy","native-depot"]],
 ["alife-strategy",["alife-native-mining-proof","alife-native-economy-observe","native-expeditions","faction"]],
 ["combat",["native-ammo-readiness","native-ammo-survival","native-ammo-supply",
  "native-raids","native-tactics","native-pve-boss-wreck","native-pve-site-defense","native-pve-wave-reinforcements","native-pve-objective-doctrine","native-ammo-observe"]],
 ["salvage",["native-wreck-recovery","native-salvage-rivals","native-salvage-market",
  "native-wreck-custody","native-loot-station-delivery"]],
 ["movement",["native-gate-approach","native-patrols","npc-recognition","native-civilians"]],
 ["market",["native-market-schedule","economy-destination-ore"]],
 ["activity",["native-activity"]],
 ["reconciliation",["npc-reconcile:"]]
];
const phasePattern=/^[a-z][a-z0-9:-]{0,95}$/;
const dynamicPrefix="npc-reconcile:";
const groupOrder=Object.freeze(groups.map(([name])=>name));
const entries=Object.freeze(groups.flatMap(([group,names])=>
 names.map(name=>Object.freeze({name,group,mode:"EXISTING_NATIVE_OWNER_ONLY"}))));
const names=Object.freeze(entries.map(x=>x.name));
const byName=new Map(entries.map(x=>[x.name,x]));
if(names.length!==32||new Set(names).size!==32||
   groupOrder.length!==new Set(groupOrder).size||
   names.filter(x=>x===dynamicPrefix).length!==1)
 throw Error("LIVING_WORLD_PHASE_REGISTRY_INVALID");
function classifyPhase(name){
 if(typeof name!=="string"||!phasePattern.test(name))
  return {status:"INVALID",group:null,canonical:null};
 if(byName.has(name)&&name!==dynamicPrefix)
  return {status:"KNOWN",group:byName.get(name).group,canonical:name};
 // Dynamic work is still the same original materialized system reconcile,
 // not a separate scheduler. Never accept arbitrary suffixes/IDs.
 if(name.startsWith(dynamicPrefix)){
  const id=name.slice(dynamicPrefix.length);
  if(/^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id)))
   return {status:"KNOWN",group:"reconciliation",canonical:dynamicPrefix};
 }
 return {status:"UNCLASSIFIED",group:"unclassified",canonical:null};
}
function catalog(){
 return {groupOrder:groupOrder.slice(),phases:entries.map(x=>({...x}))};
}
module.exports={classifyPhase,catalog,phaseNames:names};
