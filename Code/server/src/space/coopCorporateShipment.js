"use strict";
// M003-L2. One durable corporate shipment identity, validated before anything moves.
//
// Why this module exists: the freight engine (coopDistributionRun) advances a run that an operator
// already journaled, and it refuses to plan one (PLAN -> PLAN_REQUIRED). Nothing validated what an
// operator was about to journal: a run could name a hull that is not the corporation's, a station
// pair with no gate between them, a manifest larger than the hold, or a destination nobody bids at.
// This module is that gate. It is pure: no I/O, no clock, no async, no mutation of its input.
//
// It models one shipment and never claims a step happened - state starts at PLANNED with zero
// attempts, and only the engine (or an operator, with evidence) may move it.

const INVALID_IDENTITY = "INVALID_IDENTITY";
const INVALID_GATE = "INVALID_GATE";
const INVALID_MANIFEST = "INVALID_MANIFEST";
const OVER_CAPACITY = "OVER_CAPACITY";
const NO_DESTINATION_BID = "NO_DESTINATION_BID";
const BID_TYPE_NOT_IN_MANIFEST = "BID_TYPE_NOT_IN_MANIFEST";
const MANIFEST_EXCEEDS_BID = "MANIFEST_EXCEEDS_BID";

const SHIPMENT_CODE = Object.freeze({
  INVALID_IDENTITY,
  INVALID_GATE,
  INVALID_MANIFEST,
  OVER_CAPACITY,
  NO_DESTINATION_BID,
  BID_TYPE_NOT_IN_MANIFEST,
  MANIFEST_EXCEEDS_BID,
});

const isPos = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const isPlain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};
const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * Validate and materialise one shipment record.
 * Returns {ok:true, code:"PLANNED", record} or {ok:false, code, reason}.
 */
function createShipment(args) {
  if (!isPlain(args)) return fail(INVALID_IDENTITY, "args must be an object");

  const { shipmentID, corpID, hullID, fromStationID, toStationID, gate, manifest,
    capacityM3, destinationBid, fromSystemID, toSystemID, createdAt } = args;

  // 1. Identity. `shipmentID` is a STRING; the rest are positive safe integers.
  if (typeof shipmentID !== "string" || shipmentID.length === 0)
    return fail(INVALID_IDENTITY, "shipmentID must be a non-empty string");
  if (!isPos(corpID)) return fail(INVALID_IDENTITY, "corpID must be a positive safe integer");
  if (!isPos(hullID)) return fail(INVALID_IDENTITY, "hullID must be a positive safe integer");
  if (!isPos(fromStationID))
    return fail(INVALID_IDENTITY, "fromStationID must be a positive safe integer");
  if (!isPos(toStationID))
    return fail(INVALID_IDENTITY, "toStationID must be a positive safe integer");
  if (fromStationID === toStationID)
    return fail(INVALID_IDENTITY, "destination station must differ from the origin");

  // 2. Gate. Systems are cross-checked only against systems, never against station IDs.
  if (!isPlain(gate)) return fail(INVALID_GATE, "gate must be an object");
  if (!isPos(gate.sourceGateID)) return fail(INVALID_GATE, "gate.sourceGateID is invalid");
  if (!isPos(gate.destinationGateID)) return fail(INVALID_GATE, "gate.destinationGateID is invalid");
  if (!isPos(gate.sourceSystemID)) return fail(INVALID_GATE, "gate.sourceSystemID is invalid");
  if (!isPos(gate.destinationSystemID))
    return fail(INVALID_GATE, "gate.destinationSystemID is invalid");
  if (fromSystemID !== undefined && gate.sourceSystemID !== fromSystemID)
    return fail(INVALID_GATE, "gate.sourceSystemID does not match the origin system");
  if (toSystemID !== undefined && gate.destinationSystemID !== toSystemID)
    return fail(INVALID_GATE, "gate.destinationSystemID does not match the destination system");

  // 3. Manifest. An array is the only valid shape here.
  if (!Array.isArray(manifest) || manifest.length === 0)
    return fail(INVALID_MANIFEST, "manifest must be a non-empty array");
  const rows = [];
  for (let index = 0; index < manifest.length; index += 1) {
    const row = manifest[index];
    if (!isPlain(row)) return fail(INVALID_MANIFEST, "manifest row " + index + " is not an object");
    if (!isPos(row.typeID)) return fail(INVALID_MANIFEST, "manifest row " + index + " has no typeID");
    if (!isPos(row.quantity))
      return fail(INVALID_MANIFEST, "manifest row " + index + " has no quantity");
    if (!isNum(row.m3PerUnit) || row.m3PerUnit < 0)
      return fail(INVALID_MANIFEST, "manifest row " + index + " has no usable m3PerUnit");
    if (!isNum(row.price) || row.price < 0)
      return fail(INVALID_MANIFEST, "manifest row " + index + " has no usable price");
    rows.push(Object.freeze({ typeID: row.typeID, quantity: row.quantity,
      m3PerUnit: row.m3PerUnit, price: row.price }));
  }

  // 4. Capacity. The hold is volume, and filling it exactly is allowed.
  if (!isNum(capacityM3) || capacityM3 < 0)
    return fail(OVER_CAPACITY, "capacityM3 must be a finite number");
  const totalM3 = round(rows.reduce((sum, row) => sum + row.quantity * row.m3PerUnit, 0), 3);
  if (totalM3 > capacityM3)
    return fail(OVER_CAPACITY, "totalM3 " + totalM3 + " exceeds capacityM3 " + capacityM3);

  // 5. The destination must really bid for the cargo, at a real price and volume.
  if (!isPlain(destinationBid)) return fail(NO_DESTINATION_BID, "destinationBid must be an object");
  if (!isPos(destinationBid.typeID))
    return fail(NO_DESTINATION_BID, "destinationBid.typeID is invalid");
  if (!isNum(destinationBid.price) || destinationBid.price <= 0)
    return fail(NO_DESTINATION_BID, "destinationBid.price must be greater than zero");
  if (!isNum(destinationBid.volume) || destinationBid.volume < 1)
    return fail(NO_DESTINATION_BID, "destinationBid.volume must be at least one unit");

  const bidRow = rows.find((row) => row.typeID === destinationBid.typeID);
  if (!bidRow) return fail(BID_TYPE_NOT_IN_MANIFEST, "the bid type is not in the manifest");
  if (bidRow.quantity > destinationBid.volume)
    return fail(MANIFEST_EXCEEDS_BID,
      "manifest quantity " + bidRow.quantity + " exceeds the bid volume " + destinationBid.volume);

  const expectedIsk = round(rows.reduce((sum, row) => sum + row.quantity * row.price, 0), 2);
  const gateCopy = Object.freeze({ sourceGateID: gate.sourceGateID,
    destinationGateID: gate.destinationGateID, sourceSystemID: gate.sourceSystemID,
    destinationSystemID: gate.destinationSystemID });

  const record = Object.freeze({
    version: 1,
    shipmentID,
    corpID,
    hullID,
    fromStationID,
    toStationID,
    gate: gateCopy,
    manifest: Object.freeze(rows),
    totalM3,
    expectedIsk,
    state: "PLANNED",
    attempts: Object.freeze({ load: 0, cross: 0, sell: 0 }),
    createdAt: isNum(createdAt) ? createdAt : null,
  });
  return { ok: true, code: "PLANNED", record };
}

/** The one shipment identity this mission uses: corp:from:to:hull:firstItemID. */
function shipmentIdentity({ corpID, fromStationID, toStationID, hullID, firstItemID } = {}) {
  if (!isPos(corpID) || !isPos(fromStationID) || !isPos(toStationID) || !isPos(hullID))
    return null;
  if (!Number.isSafeInteger(Number(firstItemID)) || Number(firstItemID) <= 0) return null;
  return [corpID, fromStationID, toStationID, hullID, Number(firstItemID)].join(":");
}

module.exports = { createShipment, shipmentIdentity, SHIPMENT_CODE };
