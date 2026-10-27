"use strict";
// COOP-032C: OFFLINE ONLY. Never attach this directly to a running GameStore.
// Uses native SQLite rows and the persisted native identityState item allocator.
const SEP = "\u001f";
const ITEM_FLOOR = 1990000000;
const INSTALLED_LOCATION = 2003;
const MAX_STACK = 2147483647;
const TABLES = Object.freeze(["items", "industryJobs", "industryBlueprintState", "identityState"]);
const positive = v => Number.isSafeInteger(v) && v > 0;
const filetime = ms => BigInt(ms) * 10000n + 116444736000000000n;
const operationValid = x => typeof x === "string" && /^npc-manufacture:[A-Za-z0-9_-]{8,90}$/.test(x);
function createOfflineAtomicDelivery({db, offlineExclusive = false, verifyNativeOutput, verifyNativeOwner,
  verifyNativeIdFloor, buildNativeOutputItem, clock = () => Date.now(), faultAt = null} = {}) {
  if (!offlineExclusive || !db || typeof db.exec !== "function" || typeof db.prepare !== "function" ||
      typeof verifyNativeOutput !== "function" || typeof verifyNativeOwner !== "function" ||
      typeof verifyNativeIdFloor !== "function" || typeof buildNativeOutputItem !== "function") {
    throw Error("OFFLINE_EXCLUSIVE_VERIFIED_NATIVE_DEPENDENCIES_REQUIRED");
  }
  const read = (table,key) => {
    if (!TABLES.includes(table)) throw Error("TABLE_NOT_ALLOWLISTED");
    const record = db.prepare(`SELECT json FROM "${table}" WHERE key=?`).get(String(key));
    return record ? JSON.parse(record.json) : null;
  };
  const write = (table,key,value) => {
    if (!TABLES.includes(table)) throw Error("TABLE_NOT_ALLOWLISTED");
    db.prepare(`INSERT INTO "${table}" (key,json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json`)
      .run(String(key),JSON.stringify(value));
  };
  const jobs = () => db.prepare('SELECT key,json FROM "industryJobs" WHERE key LIKE ?').all(`jobs${SEP}%`);
  const find = operationID => {
    const entries = jobs().map(row => JSON.parse(row.json)).filter(job => job.coopOperationID === operationID);
    if (entries.length > 1) throw Error("DUPLICATE_OPERATION_JOBS");
    return entries[0] || null;
  };
  const outputIdentity = (item, job, expectedQuantity) => item && positive(item.itemID) &&
    item.typeID === job.productTypeID && item.ownerID === job.ownerID &&
    item.locationID === job.outputLocationID && item.flagID === job.outputFlagID &&
    item.singleton === 0 && item.categoryID === 8 &&
    item.quantity === expectedQuantity && item.stacksize === expectedQuantity;
  function deliverOnce(operationID) {
    if (!operationValid(operationID)) return {status:"BLOCKED",error:"INVALID_OPERATION_ID"};
    let begun = false;
    try {
      db.exec("BEGIN IMMEDIATE"); begun = true;
      if (faultAt === "AFTER_BEGIN") throw Error("TEST_FAULT_AFTER_BEGIN");
      const job = find(operationID);
      if (!job || !positive(job.jobID) || read("industryJobs",`jobs${SEP}${job.jobID}`)?.jobID !== job.jobID ||
          job.activityID !== 1 || !positive(job.ownerID) || !positive(job.stationID) ||
          job.facilityID !== job.stationID || !positive(job.blueprintID) ||
          !positive(job.productTypeID) || !positive(job.runs) ||
          job.outputLocationID !== job.stationID || job.outputFlagID !== 4 ||
          job.blueprintCopy !== false) throw Error("UNVERIFIED_NATIVE_JOB_IDENTITY");
      let quote;
      try { quote = JSON.parse(job.coopQuoteSignature); } catch { throw Error("INVALID_ORIGINAL_QUOTE"); }
      const output = quote?.outputs?.length === 1 ? quote.outputs[0] : null;
      const quantity = output?.quantity;
      if (!positive(quantity) || quantity > MAX_STACK || output.typeID !== job.productTypeID ||
          quote.ownerID !== job.ownerID || quote.blueprintID !== job.blueprintID ||
          quote.facilityID !== job.facilityID || quote.productTypeID !== job.productTypeID ||
          quote.activityID !== 1 || quote.runs !== job.runs ||
          verifyNativeOwner(job.ownerID,job.stationID) !== true ||
          verifyNativeOutput(job,quote) !== true) throw Error("NATIVE_OUTPUT_AUTHORITY_REJECTED");
      if (job.status === 4) {
        const receipt = job.coopDelivery;
        const item = receipt && read("items",String(receipt.itemID));
        const bp = read("items",String(job.blueprintID));
        const state = read("industryBlueprintState",`records${SEP}${job.blueprintID}`);
        if (!receipt || receipt.operationID !== operationID || !outputIdentity(item,job,quantity) ||
            item.itemID !== receipt.itemID || receipt.quantity !== quantity ||
            receipt.typeID !== job.productTypeID || item.customInfo !== `coop-industry:v1:${job.jobID}` ||
            !bp || bp.itemID !== job.blueprintID || bp.typeID !== job.blueprintTypeID || bp.ownerID !== job.ownerID ||
            bp.locationID !== job.blueprintLocationID || bp.flagID !== job.blueprintLocationFlagID ||
            state?.jobID !== null || state.original !== true ||
            !positive(read("identityState","nextItemID")) || read("identityState","nextItemID") <= item.itemID)
          throw Error("DELIVERY_RECEIPT_CORRUPT");
        db.exec("COMMIT"); begun = false;
        return {status:"ALREADY_DELIVERED",jobID:job.jobID,itemID:item.itemID,quantity};
      }
      if (job.status !== 3) throw Error("JOB_NOT_NATIVE_READY");
      const now = clock();
      if (!Number.isSafeInteger(now) || now <= 0 || !/^\d+$/.test(String(job.endDate)) ||
          filetime(now) < BigInt(job.endDate)) throw Error("NATIVE_END_DATE_NOT_REACHED");
      const bp = read("items",String(job.blueprintID));
      const stateKey = `records${SEP}${job.blueprintID}`;
      const state = read("industryBlueprintState",stateKey);
      if (!bp || bp.itemID !== job.blueprintID || bp.ownerID !== job.ownerID ||
          bp.locationID !== INSTALLED_LOCATION || bp.flagID !== job.blueprintLocationFlagID ||
          bp.singleton !== 1 || bp.categoryID !== 9 || bp.typeID !== job.blueprintTypeID ||
          !state || state.original !== true || state.jobID !== job.jobID)
        throw Error("BLUEPRINT_CUSTODY_MISMATCH");
      const next = read("identityState","nextItemID");
      if (!positive(next) || next < ITEM_FLOOR) throw Error("NATIVE_ITEM_SEQUENCE_MISSING");
      let maxExisting = ITEM_FLOOR - 1;
      for (const row of db.prepare('SELECT key,json FROM "items"').all()) {
        const item = JSON.parse(row.json);
        if (String(item.itemID) !== row.key || !positive(item.itemID)) throw Error("NATIVE_ITEM_KEY_MISMATCH");
        maxExisting = Math.max(maxExisting,item.itemID);
      }
      const itemID = Math.max(next,maxExisting+1,ITEM_FLOOR);
      if (!positive(itemID) || !positive(itemID+1) || read("items",String(itemID)) ||
          verifyNativeIdFloor(itemID) !== true) throw Error("NATIVE_ITEM_ID_NOT_SAFE");
      const item = buildNativeOutputItem({itemID,typeID:job.productTypeID,ownerID:job.ownerID,
        locationID:job.outputLocationID,flagID:job.outputFlagID,quantity});
      if (!outputIdentity(item,job,quantity) || item.itemID !== itemID ||
          item.customInfo != null) throw Error("INVALID_NATIVE_OUTPUT_ITEM");
      if (faultAt === "AFTER_VALIDATION") throw Error("TEST_FAULT_AFTER_VALIDATION");
      write("items",String(itemID),{...item,customInfo:`coop-industry:v1:${job.jobID}`});
      if (faultAt === "AFTER_OUTPUT") throw Error("TEST_FAULT_AFTER_OUTPUT");
      write("identityState","nextItemID",itemID+1);
      if (faultAt === "AFTER_IDENTITY") throw Error("TEST_FAULT_AFTER_IDENTITY");
      write("items",String(job.blueprintID),{...bp,locationID:job.blueprintLocationID});
      write("industryBlueprintState",stateKey,{...state,jobID:null,updatedAt:now});
      if (faultAt === "AFTER_BLUEPRINT") throw Error("TEST_FAULT_AFTER_BLUEPRINT");
      write("industryJobs",`jobs${SEP}${job.jobID}`,{...job,status:4,successfulRuns:job.runs,
        deliveredAt:String(filetime(now)),completedCharacterID:0,
        coopDelivery:{operationID,itemID,quantity,typeID:job.productTypeID}});
      if (faultAt === "BEFORE_COMMIT") throw Error("TEST_FAULT_BEFORE_COMMIT");
      db.exec("COMMIT");begun = false;
      return {status:"DELIVERED",jobID:job.jobID,itemID,quantity};
    } catch(error) {
      if (begun) { try {db.exec("ROLLBACK");} catch {} }
      return {status:"BLOCKED",error:String(error.message || error)};
    }
  }
  return {mode:"OFFLINE_ONLY",supportsAtomicDelivery:false,deliverOnce};
}
module.exports = {createOfflineAtomicDelivery};
