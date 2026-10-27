"use strict";
// Optional L2 PI authority: validate only native items, colonies, orbitals and receipts.
// This guard does NOT create commodities, simulate production, or fix cross-store atomicity.
const positive = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const amount = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const own = (x, id) => positive(x?.ownerID) === id;
const CODE = Object.freeze({
  SOURCE: "PI_COMMAND_CENTER_SOURCE_UNVERIFIED",
  OWNER: "PI_NATIVE_OWNER_MISMATCH",
  OFFICE: "PI_CUSTOMS_OFFICE_MISMATCH",
  SETTINGS: "PI_CUSTOMS_SETTINGS_PERMISSION_DENIED",
  LAUNCH: "PI_LAUNCH_NEEDS_OPERATOR_RECONCILIATION",
  CARGO: "PI_PHYSICAL_LAUNCH_CARGO_UNVERIFIED",
  GM: "PI_GM_COMMODITY_MUTATION_DISABLED",
  NATIVE: "PI_NATIVE_AUTHORITY_UNAVAILABLE",
});
function reject(code) { const error = Error(code); error.code = code; throw error; }
const validContents = source => {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const entries = Object.entries(source);
  if (!entries.length || entries.length > 80) return null;
  const result = new Map();
  for (const [type,qty] of entries) {
    const id = positive(type),quantity = amount(qty);
    if (!id || !quantity || result.has(id)) return null;
    result.set(id,quantity);
  }
  return result;
};
function createPiIntegrityGuard({inventory,staticData,runtime,orbitals,clock=()=>Date.now(),
  canManageCorporateOrbital=()=>false}={}) {
  function assertCommandCenterEdit({session,planetID,ownerID,serializedChanges,existingColony}={}) {
    const character=positive(session?.characterID),owner=positive(ownerID),planet=positive(planetID);
    if (!character || !owner || character!==owner || !planet) reject(CODE.OWNER);
    if (!runtime?.COMMAND || !staticData?.getPinEntityType || !inventory?.findItemById ||
        !inventory?.ITEM_FLAGS) reject(CODE.NATIVE);
    if (!Array.isArray(serializedChanges)) reject(CODE.SOURCE);
    // Use native CREATEPIN = 1 and native pin classification; ignore routes/processors.
    const requests = serializedChanges.map(entry=>Array.isArray(entry)
      ? {id:Number(entry[0]),args:entry[1]}
      : {id:Number(entry?.id ?? entry?.commandID),args:entry?.args ?? entry?.argTuple});
    if (requests.some(x=>!Number.isSafeInteger(x.id) || x.id<1 ||
        !Array.isArray(x.args)))reject(CODE.SOURCE);
    const commandPins=requests.filter(x=>x.id===runtime.COMMAND.CREATEPIN &&
      Array.isArray(x.args) && staticData.getPinEntityType(Number(x.args[1]))==="command");
    if (!commandPins.length) return {ok:true,sourceItems:[]};
    // An existing native command center is not a source for a second free center.
    if (commandPins.length!==1 || (existingColony?.pins||[]).some(p=>
        staticData.getPinEntityType(Number(p.typeID))==="command")) reject(CODE.SOURCE);
    const shipID=positive(session?._space?.shipID ?? session?.shipID ?? session?.shipid);
    const submitted=positive(commandPins[0].args[0]);
    const typeID=positive(commandPins[0].args[1]);
    if (!shipID || !submitted || !typeID) reject(CODE.SOURCE);
    // Pinned EveJS consumes a command center ONLY when pinID === physical itemID;
    // temporary pin IDs are therefore unsafe until Chat 01 adds atomic debit.
    const item=inventory.findItemById(submitted);
    const flags=new Set([inventory.ITEM_FLAGS.CARGO_HOLD,
      inventory.ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD,
      inventory.ITEM_FLAGS.COLONY_RESOURCES_HOLD]);
    if (!item || !own(item,owner) || positive(item.typeID)!==typeID ||
        positive(item.locationID)!==shipID || !flags.has(Number(item.flagID)) ||
        (Number(item.singleton)!==1 && !amount(item.stacksize ?? item.quantity))) reject(CODE.SOURCE);
    return {ok:true,sourceItems:[submitted]};
  }
  function assertOfficeTransfer({session,ownerID,officeID,spaceportPinID,colony,office}={}) {
    const character=positive(session?.characterID),owner=positive(ownerID),officeItem=positive(officeID);
    if (!character || owner!==character || !own(colony,character)) reject(CODE.OWNER);
    if (!officeItem || !positive(spaceportPinID) || !office ||
        positive(office.itemID)!==officeItem ||
        Number(office.groupID)!==1025 ||
        positive(office.planetID)!==positive(colony.planetID) ||
        positive(office.solarSystemID)!==positive(colony.solarSystemID) ||
        ![-4,0,1].includes(Number(office.state))) reject(CODE.OFFICE);
    const spaceport=(colony.pins||[]).filter(x=>positive(x.pinID)===positive(spaceportPinID));
    if (spaceport.length!==1 || !own(spaceport[0],character) ||
        staticData?.getPinEntityType?.(spaceport[0].typeID)!=="spaceport") reject(CODE.OFFICE);
    return {ok:true,officeID:officeItem,planetID:positive(colony.planetID)};
  }
  function assertOfficeSettings({session,officeID,office}={}) {
    const actor=positive(session?.characterID), target=positive(officeID);
    if (!actor || !target || target!==positive(office?.itemID) || !positive(office?.ownerID)) reject(CODE.SETTINGS);
    if (positive(office.ownerID)===actor)return {ok:true,authority:"PERSONAL_OWNER"};
    // Corporate office management requires explicit *native verified* corp roles.
    // Merely sharing a corporation or being a fleet member is never enough.
    if (positive(office.corporationID)===positive(office.ownerID) &&
        canManageCorporateOrbital({session,office})===true)
      return {ok:true,authority:"VERIFIED_CORPORATE_ROLE"};
    reject(CODE.SETTINGS);
  }
  function assertLaunchReady({session,planetID,launches}={}) {
    const actor=positive(session?.characterID),planet=positive(planetID);
    if (!actor || !planet || !Array.isArray(launches))reject(CODE.NATIVE);
    const now=Number(clock());
    if (!Number.isFinite(now))reject(CODE.NATIVE);
    for(const l of launches){
      if (!own(l,actor) || positive(l.planetID)!==planet || l.deleted===true)continue;
      if (positive(l.physicalContainerID))continue;
      // A stale orphan launch remains an unresolved native custody loss.
      // Passage of seven days, or a future-dated clock, cannot establish that
      // the missing physical commodity container was recovered/consumed.
      // Only native deletion/reconciliation can release this guard.
      reject(CODE.LAUNCH);
    }
    return {ok:true};
  }
  function assertLaunchPhysicalized({session,launch,readLaunch,container,items,sceneEntity}={}) {
    const actor=positive(session?.characterID),launchID=positive(launch?.launchID);
    if(!actor || !launchID || !own(launch,actor) || typeof readLaunch!=="function" ||
      !Array.isArray(items))reject(CODE.CARGO);
    const committed=readLaunch(launchID,actor);
    const id=positive(committed?.physicalContainerID);
    if(!id || !own(committed,actor) || positive(committed.launchID)!==launchID ||
      positive(committed.planetID)!==positive(launch.planetID) ||
      !container || positive(container.itemID)!==id || !own(container,actor) ||
      positive(container.locationID)!==positive(launch.solarSystemID) ||
      !sceneEntity || positive(sceneEntity.itemID)!==id ||
      (positive(sceneEntity.ownerID) && !own(sceneEntity,actor)))reject(CODE.CARGO);
    const expected=validContents(launch.contents),received=new Map();
    if(!expected)reject(CODE.CARGO);
    for(const item of items){
      const type=positive(item.typeID),qty=Number(item.singleton)===1?1:amount(item.stacksize ?? item.quantity);
      if(!type || !qty || !own(item,actor) || positive(item.locationID)!==id)reject(CODE.CARGO);
      received.set(type,(received.get(type)||0)+qty);
    }
    if(received.size!==expected.size || [...expected].some(([type,qty])=>received.get(type)!==qty))reject(CODE.CARGO);
    return {ok:true,launchID,physicalContainerID:id};
  }
  return {assertCommandCenterEdit,assertOfficeTransfer,assertOfficeSettings,
    assertLaunchReady,assertLaunchPhysicalized,disableGmCommodity:()=>reject(CODE.GM)};
}
function native() {
  const inventory=require("../services/inventory/itemStore");
  const staticData=require("../services/planet/planetStaticData");
  const runtime=require("../services/planet/planetRuntimeStore");
  const orbitals=require("../services/planet/planetOrbitalState");
  return {inventory,staticData,runtime,orbitals};
}
function guarded(run){
 if(process.env.EVEJS_COOP_PI_INTEGRITY!=="1")return null;
 try{return run(createPiIntegrityGuard(native()));}
 catch(error){
  const {throwWrappedUserError}=require("../common/machoErrors");
  throwWrappedUserError("CustomNotify",{notify:"Planetary industry blocked: "+String(error.code||"PI_NATIVE_AUTHORITY_UNAVAILABLE")});
 }
}
function beforeNetwork({session,planetID,ownerID,serializedChanges}={}){
 return guarded(g=>g.assertCommandCenterEdit({session,planetID,ownerID,serializedChanges,
  existingColony:g&&require("../services/planet/planetRuntimeStore").getColony(planetID,ownerID)}));
}
function beforeCustoms({session,characterID,customsOfficeID,spaceportPinID,colony}={}){
 return guarded(g=>{
  const {orbitals}=native();
  const office=orbitals.getOrbitalByID(customsOfficeID) ||
   orbitals.listDefaultCustomsOfficesForSystem(colony?.solarSystemID)?.find(x=>Number(x.itemID)===Number(customsOfficeID));
  return g.assertOfficeTransfer({session,ownerID:characterID,officeID:customsOfficeID,spaceportPinID,colony,office});
 });
}
function beforeOfficeSettings({session,orbitalID}={}){
 return guarded(g=>g.assertOfficeSettings({session,officeID:orbitalID,
  office:require("../services/planet/planetOrbitalState").getOrbitalByID(orbitalID)}));
}
function beforeLaunch({session,planetID}={}){
 return guarded(g=>g.assertLaunchReady({session,planetID,
  launches:require("../services/planet/planetRuntimeStore").listLaunchesForCharacter(session?.characterID)}));
}
function afterLaunch({session,launch}={}){
 return guarded(g=>{
  const {inventory,runtime}=native();
  const full=runtime.getLaunch(launch?.launchID,session?.characterID);
  const containerID=positive(full?.physicalContainerID);
  return g.assertLaunchPhysicalized({session,launch,
   readLaunch:id=>runtime.getLaunch(id,session?.characterID),
   container:containerID?inventory.findItemById(containerID):null,
   items:containerID?inventory.listContainerItems(session?.characterID,containerID,inventory.ITEM_FLAGS.HANGAR):[],
   // The native PI launch path physically spawns this item into the system
   // Ballpark. An ItemStore container alone is not evidence of a visible,
   // recoverable launch. Resolve the real native entity rather than passing
   // the previously omitted sceneEntity (which denied every legitimate launch).
   sceneEntity:containerID && positive(full?.solarSystemID)?
    require("../space/runtime").ensureScene(full.solarSystemID)?.getEntityByID?.(containerID):null});
 });
}
function beforeGmMutation(){return guarded(g=>g.disableGmCommodity());}
module.exports={createPiIntegrityGuard,CODE,beforeNetwork,beforeCustoms,
 beforeOfficeSettings,beforeLaunch,afterLaunch,beforeGmMutation};
