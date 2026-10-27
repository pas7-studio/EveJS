"use strict";
// PVE-004B-2: READ-ONLY provenance for authored boss -> original NPC
// profile -> loaded loot table -> native wreck -> original item rows.
// A catalog selector is NOT proof a rare item rolled or was received.
const id=n=>Number.isSafeInteger(n)&&n>0?n:null;
const key=v=>typeof v==="string"&&v.trim()===v&&v.length>0&&v.length<=200?v:null;
function verify({witness,wreck,profile,definition,lootTable}={}){
 if(!witness||!wreck||!id(witness.bossEntityID)||
    !id(witness.bossTypeID)||!id(witness.wreckID)||
    !id(witness.systemID)||!id(witness.instanceID)||!id(witness.siteID)||
    !Array.isArray(witness.originalItems)||witness.originalItems.length>512)
  return {status:"INVALID_AUTHORED_BOSS_WITNESS"};
 if(wreck.wreckID!==witness.wreckID||
    wreck.sourceEntityID!==witness.bossEntityID||
    wreck.launcherID!==witness.bossEntityID||
    wreck.sourceTypeID!==witness.bossTypeID||
    wreck.systemID!==witness.systemID||
    wreck.transient!==true)
  return {status:"NATIVE_BOSS_WRECK_SOURCE_MISMATCH"};
 const profileID=key(witness.profileID),tableID=key(witness.lootTableID);
 if(!profileID||!tableID)return {status:"NO_ORIGINAL_NPC_LOOT_BINDING"};
 if(wreck.profileID!==profileID||wreck.lootTableID!==tableID)
  return {status:"WRECK_PROFILE_LOOT_TABLE_MISMATCH"};
 if(!profile||profile.profileID!==profileID||
    profile.lootTableID!==tableID||
    !definition?.profile||definition.profile.profileID!==profileID||
    definition.profile.lootTableID!==tableID||
    !definition.lootTable||definition.lootTable.lootTableID!==tableID||
    !lootTable||lootTable.lootTableID!==tableID)
  return {status:"NPC_PROFILE_TABLE_NOT_RESOLVED"};
 const original=witness.originalItems;
 if(new Set(original.map(row=>row?.wreckItemID)).size!==original.length||
    original.some(row=>!id(row?.wreckItemID)||!id(row?.typeID)||
       !Number.isSafeInteger(row.quantity)||row.quantity<1))
  return {status:"ORIGINAL_NATIVE_ITEM_MANIFEST_INVALID"};
 // Native npcLoot.rollRuleLootEntries returns [] for zero selectors, and
 // also when selectors' candidate pools are empty. A nonempty selector is
 // merely configured, never proof any eligible type is in the runtime pool.
 const mode=typeof lootTable.mode==="string"?lootTable.mode.toLowerCase():"";
 const selectors=Array.isArray(lootTable.selectors)?lootTable.selectors:[];
 const rules=selectors.filter(s=>s&&typeof s==="object"&&
    Number.isFinite(Number(s.weight))&&Number(s.weight)>0);
 const configured=mode==="rule"&&lootTable.emptyRule!==true&&
    lootTable.disableRandomLoot!==true&&rules.length>0;
 const status=configured?"NATIVE_BOSS_LOOT_PROFILE_LINK_VERIFIED":
    "NATIVE_BOSS_LOOT_PROFILE_EMPTY_OR_UNSUPPORTED";
 const rareSelectors=rules.filter(s=>
    ["special","faction","deadspace","officer"].includes(String(s.grade||"").toLowerCase()));
 return {status,systemID:witness.systemID,instanceID:witness.instanceID,
  siteID:witness.siteID,bossEntityID:witness.bossEntityID,
  wreckID:witness.wreckID,profileID,lootTableID:tableID,
  originalItemIDs:original.map(row=>row.wreckItemID),
  originalItemCount:original.length,configuredRuleSelectorCount:rules.length,
  configuredRareSelectorCount:rareSelectors.length,
  // Critical: the NPC loot candidate pool/actual RNG roll is NOT
  // inferred from weights, group/name tags or catalog existence.
  candidatesResolved:false,actualRareDropVerified:false,
  evidence:"ORIGINAL_NATIVE_PROFILE_AND_WRECK_TABLE_LINK_NOT_RANDOM_ROLL_PROOF"};
}
function createAudit({getWreck,getProfile,getDefinition,getLootTable,observe=()=>true,
 maxSeen=2048}={}){
 if([getWreck,getProfile,getDefinition,getLootTable,observe]
    .some(fn=>typeof fn!=="function")||
    !Number.isSafeInteger(maxSeen)||maxSeen<1||maxSeen>20000)
  throw Error("INVALID_NATIVE_BOSS_LOOT_AUDIT");
 const seen=new Set();
 function note(witness){
  if(!id(witness?.wreckID))return {status:"INVALID_AUTHORED_BOSS_WITNESS"};
  if(seen.has(witness.wreckID))return {status:"BOSS_PROFILE_ALREADY_AUDITED"};
  if(seen.size>=maxSeen)return {status:"BOSS_PROFILE_AUDIT_CAP_REACHED"};
  let wreck,profile,definition,lootTable;
  try{
   wreck=getWreck(witness.wreckID);
   if(wreck){
    profile=getProfile(witness.profileID);
    definition=getDefinition(witness.profileID);
    lootTable=getLootTable(witness.lootTableID);
   }
  }catch{return {status:"NPC_LOOT_CATALOG_UNAVAILABLE"}}
  const output=verify({witness,wreck,profile,definition,lootTable});
  // Audit is intentionally read-only; failures should remain visible.
  let reported=false;
  try{reported=observe(output)===true}catch{}
  if(!reported)return {...output,telemetry:"NOT_RECORDED"};
  seen.add(witness.wreckID);
  return output;
 }
 return {note,snapshot:()=>({auditCount:seen.size})};
}
let instance=null;
function note(witness){
 if(process.env.EVEJS_COOP_PVE_BOSS_LOOT_PROFILE_AUDIT!=="1"||
    process.env.EVEJS_COOP_PVE_NATIVE_BOSSES!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1")
  return {status:"DISABLED"};
 if(!instance){
  const store=require("./npc/nativeNpcStore"),
   data=require("./npc/npcData");
  instance=createAudit({
   getWreck:id=>store.getNativeWreck(id),
   getProfile:id=>data.getNpcProfile(id),
   getDefinition:id=>data.buildNpcDefinition(id),
   getLootTable:id=>data.getNpcLootTable(id),
   observe:result=>require("./coopRuntimeProbe").observe(
    "living-pve-native-boss-loot-profile",null,
    {spaceState:{systemID:result.systemID}},result)
  });
 }
 return instance.note(witness);
}
module.exports={verify,createAudit,note};
