"use strict";
// Restore the pinned marketProxy.GetMarketGroups catalog from the actual
// persisted EveJS SDE itemTypes. No orders, prices or stock are invented.
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const clean = value => String(value == null ? "" : value).trim();
const HEADERS = Object.freeze([
  "parentGroupID", "marketGroupID", "marketGroupName", "description",
  "graphicID", "hasTypes", "iconID", "dataID", "marketGroupNameID", "descriptionID"
]);
function readTypes(payload) {
  if (Array.isArray(payload?.types)) return payload.types;
  if (payload?.types && typeof payload.types === "object")
    return Object.entries(payload.types).map(([key,value])=>
      value && typeof value==="object"?{_key:key,...value}:null).filter(Boolean);
  if (Array.isArray(payload)) return payload;
  return [];
}
function buildGroups(payload) {
  const groups = new Map();
  for (const type of readTypes(payload)) {
    if (!type || (type.published !== true && type.published !== 1)) continue;
    const groupID = positive(type.marketGroupID);
    const typeID = positive(type.typeID ?? type._key);
    if (!groupID || !typeID) continue;
    let group = groups.get(groupID);
    if (!group) {
      group = {id:groupID,names:new Map(),count:0,iconID:0,graphicID:0};
      groups.set(groupID,group);
    }
    const name=clean(type.groupName);
    if (name) group.names.set(name,(group.names.get(name)||0)+1);
    group.count++;
    if (!group.iconID) group.iconID=positive(type.iconID);
    if (!group.graphicID) group.graphicID=positive(type.graphicID);
  }
  return [...groups.values()].map(group=>{
    // The shipped static itemTypes lacks the parent market-group hierarchy;
    // never fabricate IDs for parent groups that the native client cannot resolve.
    const label=[...group.names].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||`Market group ${group.id}`;
    return {parentGroupID:0,marketGroupID:group.id,marketGroupName:label,
      description:"",graphicID:group.graphicID,hasTypes:true,
      iconID:group.iconID,dataID:0,marketGroupNameID:0,descriptionID:0};
  }).sort((a,b)=>a.marketGroupName.localeCompare(b.marketGroupName)||a.marketGroupID-b.marketGroupID);
}
function getMarketGroups({read,buildRowset,rowsetName="eve.common.script.sys.rowset.Rowset"}={}) {
  if (typeof read!=="function"||typeof buildRowset!=="function") throw Error("Native market catalog helpers required");
  const groups=buildGroups(read());
  return buildRowset([...HEADERS],groups.map(group=>HEADERS.map(key=>group[key])),rowsetName);
}
module.exports={HEADERS,buildGroups,getMarketGroups};