"use strict";
// Stage-2 bridge: a COMMITTED NPC cargo-removal receipt can become one real
// itemStore station stock credit. This does NOT give any character free ore,
// create player market orders, or claim to complete refinery/industry settlement.
// There is deliberately NO automatic retry after a grant may have been sent.
const fs = require("node:fs");
const path = require("node:path");
const pos = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null;
const qty = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null;
const clone = value => JSON.parse(JSON.stringify(value));
function read(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state?.version !== 1 || !state.entries || Array.isArray(state.entries) ||
        typeof state.entries !== "object") throw Error("INVALID_STATION_SETTLEMENT_JOURNAL");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return {version: 1, entries: {}};
    throw error;
  }
}
function persist(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + ".tmp-" + process.pid;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    // Windows filesystems may not support directory fsync; the durable fence
    // remains fail-closed even when power-loss guarantees are not available.
    try {
      const dir = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) {
      if (process.platform !== "win32" ||
          !["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EBADF"].includes(error.code)) throw error;
    }
  } finally {
    try { fs.unlinkSync(temp); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function createStationOreSettlement({file, depot, inventory, getStation,
  isWarehouseOwner, isOreType, flushNativeItems = null,
  clock = () => Date.now()} = {}) {
  if (typeof file !== "string" || !file || !depot ||
      typeof depot.snapshot !== "function" || typeof depot.audit !== "function" ||
      !inventory || typeof inventory.grantItemToOwnerLocation !== "function" ||
      typeof inventory.listContainerItems !== "function" ||
      typeof getStation !== "function" || typeof isWarehouseOwner !== "function" ||
      typeof isOreType !== "function" ||
      !Number.isSafeInteger(inventory.ITEM_FLAGS?.HANGAR)) {
    throw Error("STATION_SETTLEMENT_DEPENDENCIES_REQUIRED");
  }
  read(file); // reject damaged journal before any operation
  const lockFile = file + ".lock";
  function evidence(cargoID, stationID) {
    const id = pos(cargoID), destination = pos(stationID);
    if (!id || !destination) return {status: "INVALID_REFERENCE"};
    let audit;
    try { audit = depot.audit(); } catch (_error) {
      return {status: "CUSTODY_AUDIT_UNAVAILABLE"};
    }
    if (audit?.status !== "OK" || audit?.unresolved !== 0 || audit?.invalid !== 0)
      return {status: "CUSTODY_NOT_RECONCILED"};
    let receipt;
    try { receipt = depot.snapshot()?.receipts?.[String(id)]; }
    catch (_error) { return {status: "CUSTODY_RECEIPT_UNAVAILABLE"}; }
    if (pos(receipt?.cargoID) !== id || !pos(receipt?.typeID) || !qty(receipt?.quantity) ||
        !pos(receipt?.systemID) || !pos(receipt?.fleetID) || !pos(receipt?.haulerID))
      return {status: "INVALID_COMMITTED_RECEIPT"};
    const station = getStation(destination);
    const warehouseOwnerID = pos(station?.ownerID);
    if (pos(station?.stationID) !== destination ||
        pos(station?.solarSystemID) !== pos(receipt.systemID) || !warehouseOwnerID)
      return {status: "STATION_NOT_IN_SOURCE_SYSTEM"};
    if (isWarehouseOwner(warehouseOwnerID, station) !== true)
      return {status: "WAREHOUSE_OWNER_UNVERIFIED"};
    if (isOreType(pos(receipt.typeID), receipt) !== true)
      return {status: "RECEIPT_TYPE_NOT_VERIFIED_ORE"};
    return {status: "READY", cargoID: id, stationID: destination,
      ownerID: warehouseOwnerID, systemID: pos(receipt.systemID),
      fleetID: pos(receipt.fleetID), haulerID: pos(receipt.haulerID),
      typeID: pos(receipt.typeID), quantity: qty(receipt.quantity)};
  }
  function stock(ticket) {
    const rows = inventory.listContainerItems(ticket.ownerID, ticket.stationID,
      inventory.ITEM_FLAGS.HANGAR);
    if (!Array.isArray(rows)) throw Error("STATION_STOCK_UNAVAILABLE");
    let count = 0;
    for (const row of rows) {
      if (pos(row?.typeID) !== ticket.typeID) continue;
      if (pos(row.ownerID) !== ticket.ownerID || pos(row.locationID) !== ticket.stationID ||
          Number(row.flagID) !== Number(inventory.ITEM_FLAGS.HANGAR) ||
          Number(row.singleton) !== 0 || !qty(row.stacksize ?? row.quantity))
        throw Error("STATION_STOCK_INCONSISTENT");
      count += Number(row.stacksize ?? row.quantity);
      if (!Number.isSafeInteger(count)) throw Error("STATION_STOCK_OVERFLOW");
    }
    return count;
  }
  function matches(entry, ticket) {
    return ["cargoID", "stationID", "ownerID", "systemID", "fleetID",
      "haulerID", "typeID", "quantity"].every(key => entry?.[key] === ticket[key]);
  }
  function settle(cargoID, stationID) {
    // Explicit invocation only. No scheduled background task, retry, or
    // implicit credit from the virtual economy counter.
    let lock;
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      lock = fs.openSync(lockFile, "wx", 0o600);
    } catch (_error) { return {status: "SETTLEMENT_LOCKED_NEEDS_REVIEW"}; }
    try {
      const state = read(file);
      const ticket = evidence(cargoID, stationID);
      if (ticket.status !== "READY") return ticket;
      const key = String(ticket.cargoID);
      const prior = state.entries[key];
      if (prior) {
        if (!matches(prior, ticket)) return {status: "SETTLEMENT_RECEIPT_CONFLICT"};
        return {status: prior.phase === "COMPLETED" ? "ALREADY_SETTLED" : "NEEDS_OPERATOR_REPAIR",
          cargoID: ticket.cargoID};
      }
      const strict = process.env.EVEJS_COOP_NATIVE_WAREHOUSE_ORE_SOURCE_PROOF === "1";
      const marker = "coop-warehouse:v1:cargo:" + ticket.cargoID;
      // COOP-030 already patches the genuine ItemStore to create exactly
      // one isolated cargo-marked stack; unlike the stock grant it never merges.
      if (strict && (typeof inventory.grantUniqueNpcDepotItem !== "function" ||
          typeof inventory.findWarehouseItem !== "function" ||
          typeof flushNativeItems !== "function"))
        return {status: "WAREHOUSE_ORIGINAL_DURABLE_HOOKS_REQUIRED"};
      let before;
      try {
        before = stock(ticket);
        if (strict) {
          const found = inventory.findWarehouseItem({cargoID: ticket.cargoID});
          if (found) return {status: "WAREHOUSE_ORIGINAL_SOURCE_ALREADY_PRESENT"};
        }
      } catch (_error) { return {status: "STATION_STOCK_UNAVAILABLE"}; }
      if (!Number.isSafeInteger(before + ticket.quantity))
        return {status: "STATION_STOCK_OVERFLOW"};
      // Fence is durable BEFORE itemStore.grantItemToOwnerLocation is called.
      // If we crash at any point afterwards the record remains ambiguous;
      // never repeat the same source credit automatically.
      const entry = {...ticket, before, phase: "GRANT_OUTCOME_UNKNOWN", at: clock()};
      persist(file, {...state, entries: {...state.entries, [key]: entry}});
      let result, originalSource = null;
      try {
        result = strict
          ? inventory.grantUniqueNpcDepotItem({
              ownerID: ticket.ownerID, stationID: ticket.stationID,
              typeID: ticket.typeID, quantity: ticket.quantity,
              cargoID: ticket.cargoID
            })
          : inventory.grantItemToOwnerLocation(ticket.ownerID, ticket.stationID,
              inventory.ITEM_FLAGS.HANGAR, {typeID: ticket.typeID},
              ticket.quantity, {singleton: 0});
        if (result?.success !== true ||
            (strict ? (result.data?.existing !== false || !pos(result.data?.itemID))
              : Number(result.data?.quantity) !== ticket.quantity))
          return {status: "NEEDS_OPERATOR_REPAIR", cargoID: ticket.cargoID};
        if (strict) {
          // writeItems only updates a deferred GameStore cache. Do not
          // persist a COMPLETED receipt until the already-existing native
          // synchronous flush confirms the original items table.
          if (flushNativeItems("items")?.success !== true)
            return {status: "NEEDS_OPERATOR_REPAIR", cargoID: ticket.cargoID};
        }
        if (stock(ticket) !== before + ticket.quantity)
          return {status: "NEEDS_OPERATOR_REPAIR", cargoID: ticket.cargoID};
        if (strict) {
          // Original native ItemStore must actually honor the provenance
          // marker and create ONE separate physical source stack. An ignored
          // option or an automatic merge leaves GRANT_OUTCOME_UNKNOWN.
          // Never repeat the grant to try to guess which item was changed.
          const found = inventory.findWarehouseItem({cargoID: ticket.cargoID});
          if (!found || Number(found.itemID) !== Number(result.data.itemID) ||
              Number(found.ownerID) !== ticket.ownerID ||
              Number(found.locationID) !== ticket.stationID ||
              Number(found.flagID) !== inventory.ITEM_FLAGS.HANGAR ||
              Number(found.typeID) !== ticket.typeID ||
              Number(found.quantity) !== ticket.quantity ||
              Number(found.stacksize) !== ticket.quantity ||
              Number(found.singleton) !== 0 ||
              found.customInfo !== marker)
            return {status: "NEEDS_OPERATOR_REPAIR", cargoID: ticket.cargoID};
          originalSource = {oreItemID: Number(found.itemID),
            sourceCustomInfo: marker};
        }
        persist(file, {...state, entries: {...state.entries,
          [key]: {...entry, ...originalSource, phase: "COMPLETED",
            after: before + ticket.quantity, completedAt: clock()}}});
      } catch (_error) {
        return {status: "NEEDS_OPERATOR_REPAIR", cargoID: ticket.cargoID};
      }
      return {status: "STATION_STOCK_SETTLED", cargoID: ticket.cargoID,
        stationID: ticket.stationID, ownerID: ticket.ownerID,
        typeID: ticket.typeID, quantity: ticket.quantity,
        ...(originalSource || {})};
    } catch (_error) {
      return {status: "NEEDS_OPERATOR_REPAIR"};
    } finally {
      try { fs.closeSync(lock); } finally {
        try { fs.unlinkSync(lockFile); } catch (_error) { /* lock remains fail-closed */ }
      }
    }
  }
  return {preview: evidence, settle, snapshot: () => clone(read(file))};
}
module.exports = {createStationOreSettlement};
