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
// The native client indexes this rowset by PARENT: `marketGroups[None]` are the roots and
// `marketGroups[9]` must be the groups under "Ship Equipment" (appConst.marketCategoryShipEquipment).
// The flat-from-types catalog above puts every group at the top level, so the fitting window's search
// - which reads marketGroups[9], [955], [157] … - finds no groups and returns nothing in any language.
// The SDE export that produced this data ships the real hierarchy in marketGroups.jsonl, so that is
// what gets served when it is present.
function sdeJsonlDir(env = process.env) {
  const explicit = String(env.EVEJS_SDE_JSONL_DIR || "").trim();
  if (explicit) return explicit;
  const dataDir = String(env.EVEJS_DATA_DIR || "/var/lib/evejs").trim();
  const base = require("path").join(dataDir, "sde");
  try {
    const entries = require("fs").readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = require("path").join(base, entry.name);
      if (require("fs").existsSync(require("path").join(candidate, "marketGroups.jsonl"))) {
        return candidate;
      }
    }
  } catch (_error) {
    return "";
  }
  return "";
}

function localized(value) {
  if (value && typeof value === "object") {
    for (const key of ["en", "en-us"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    for (const candidate of Object.values(value)) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
  }
  return String(value == null ? "" : value).trim();
}

function buildGroupsFromSde(dir) {
  if (!dir) return null;
  const path = require("path");
  const file = path.join(dir, "marketGroups.jsonl");
  let text = "";
  try {
    text = require("fs").readFileSync(file, "utf8");
  } catch (_error) {
    return null;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row = null;
    try {
      row = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    const marketGroupID = positive(row && row._key);
    if (!marketGroupID) continue;
    const parentGroupID = positive(row && row.parentGroupID);
    rows.push({
      // Roots must be null, not 0: the client puts them under the None key.
      parentGroupID: parentGroupID > 0 ? parentGroupID : null,
      marketGroupID,
      marketGroupName: localized(row && row.name) || `Market group ${marketGroupID}`,
      description: localized(row && row.description),
      graphicID: 0,
      hasTypes: row && row.hasTypes === true,
      iconID: positive(row && row.iconID),
      dataID: 0,
      marketGroupNameID: 0,
      descriptionID: 0,
    });
  }
  return rows.length > 0 ? rows : null;
}

function getMarketGroups({read,buildRowset,rowsetName="eve.common.script.sys.rowset.Rowset",sdeDir}={}) {
  if (typeof read!=="function"||typeof buildRowset!=="function") throw Error("Native market catalog helpers required");
  const tree = buildGroupsFromSde(sdeDir === undefined ? sdeJsonlDir() : sdeDir);
  const groups = tree || buildGroups(read());
  return buildRowset([...HEADERS],groups.map(group=>HEADERS.map(key=>group[key])),rowsetName);
}
module.exports={HEADERS,buildGroups,buildGroupsFromSde,getMarketGroups,sdeJsonlDir};