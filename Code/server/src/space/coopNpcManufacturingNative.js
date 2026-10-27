"use strict";
// Load only within the trusted server process. Every dependency is the pinned
// native EveJS store, not a parallel factory or a fabricated player session.
function createNativePlanner(){
 const suffix=typeof __filename==='string'&&__filename.endsWith('.js')?'':'.cjs';
 const {createPlanner}=require('./coopNpcManufacturingPlanner'+suffix);
 const corp=require('../services/corporation/corporationState');
 const world=require('./worldData');
 const staticData=require('../services/industry/industryStaticData');
 const parity=require('../services/industry/industryParityHelpers');
 const inventory=require('../services/inventory/itemStore');
 const database=require('../gameStore');
 const constants=require('../services/industry/industryConstants');
 function readTable(name){const r=database.read(name,'/');return r?.success?r.data:null;}
 return createPlanner({
  getCorporation:id=>corp.getCorporationRecord(id),
  isNpcCorporation:id=>corp.isNpcCorporationID(id)===true,
  getStation:id=>world.getStationByID(id),
  getFacility:id=>staticData.getFacilityPayloadByID(id,null),
  getBlueprintDefinition:type=>staticData.getBlueprintDefinitionByProductTypeID(type),
  getIndustryActivity:(def,activity)=>parity.getIndustryActivity(def,activity),
  buildMaterials:(def,activity,runs,opts)=>parity.buildIndustryActivityMaterials(def,activity,runs,opts),
  getBlueprintStates:()=>readTable(constants.INDUSTRY_BLUEPRINT_STATE_TABLE),
  listOwnerItems:id=>inventory.listOwnedItems(id),
  listJobs:id=>{const t=readTable(constants.INDUSTRY_JOBS_TABLE);return t&&t.jobs?Object.values(t.jobs):null;},
  getType:id=>inventory.getItemMetadata(id)
 });
}
module.exports={createNativePlanner};