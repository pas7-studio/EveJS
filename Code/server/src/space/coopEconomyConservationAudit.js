"use strict";
/**
 * Chat 40: read-only, source-explicit cross-ledger recovery and conservation
 * evidence. Never modifies GameStore, Rust, inventory, wallet, escrow or a
 * journal. Unknown / absent inputs are not accepted as proof of safety.
 */
const SOURCES = Object.freeze([
  "nativeItems", "npcCargo", "rustClaims", "gameStoreReceipts",
  "marketEscrows", "industryDeliveries", "contractReceipts",
  "walletSettlements", "journals", "conservationWindows",
]);
const LIMIT = 50000;
const integer = n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = n => integer(n) && n > 0;
const key = n => typeof n === "string" && n.length > 0 && n.length <= 200 && !/[\x00-\x1f]/.test(n);
const qty = row => row.quantity ?? row.stacksize;
function auditEconomyEvidence(snapshot = {}) {
  const issues = [], missingSources = [], counts = {};
  const issue = (code, source, identity = "") => issues.push(Object.freeze({ code, source, identity: String(identity).slice(0, 200) }));
  const sources = {};
  for (const source of SOURCES) {
    const rows = snapshot[source];
    if (!Array.isArray(rows)) { missingSources.push(source); sources[source] = []; continue; }
    if (rows.length > LIMIT) { issue("SOURCE_TOO_LARGE", source); sources[source] = []; continue; }
    sources[source] = rows;
    counts[source] = rows.length;
  }
  const build = (source, field, valid, label = field) => {
    const byKey = new Map();
    for (const row of sources[source]) {
      if (!row || typeof row !== "object" || !valid(row) || !key(String(row[field] ?? ""))) {
        issue("MALFORMED_EVIDENCE", source); continue;
      }
      const id = String(row[field]);
      if (byKey.has(id)) issue("DUPLICATE_" + label.toUpperCase(), source, id);
      else byKey.set(id, row);
    }
    return byKey;
  };
  const itemOk = i => positive(i.itemID) && positive(i.typeID) && positive(i.ownerID) &&
    positive(i.locationID) && positive(qty(i)) && (i.stacksize === undefined || i.stacksize === qty(i));
  const items = build("nativeItems", "itemID", itemOk, "native_item_id");
  const claims = build("rustClaims", "claimKey", r => key(r.claimKey) && positive(r.fillID) &&
    positive(r.orderID) && ["settling", "filled"].includes(r.state), "rust_claim_key");
  const receipts = build("gameStoreReceipts", "claimKey", r => key(r.claimKey) && positive(r.fillID) &&
    positive(r.itemID) && positive(r.ownerID) && positive(r.typeID) && positive(r.quantity), "gamestore_claim_key");
  const rustFillIDs = new Set(), receiptFillIDs = new Set();
  for (const [claimKey, r] of receipts) {
    if (receiptFillIDs.has(r.fillID)) issue("DUPLICATE_NATIVE_FILL_ID", "gameStoreReceipts", claimKey);
    receiptFillIDs.add(r.fillID);
  }
  for (const [claimKey, c] of claims) {
    if (rustFillIDs.has(c.fillID)) issue("DUPLICATE_RUST_FILL_ID", "rustClaims", c.fillID);
    rustFillIDs.add(c.fillID);
    const r = receipts.get(claimKey);
    if (!r) { issue(c.state === "filled" ? "RUST_FILLED_WITHOUT_NATIVE_RECEIPT" : "RUST_SETTLING_NEEDS_RECONCILIATION", "rustClaims", claimKey); continue; }
    if (c.fillID !== r.fillID || (r.orderID !== undefined && c.orderID !== r.orderID))
      issue("CROSS_DB_CLAIM_IDENTITY_MISMATCH", "gameStoreReceipts", claimKey);
    if (c.state === "settling") issue("RUST_FINALIZATION_PENDING", "rustClaims", claimKey);
    const item = items.get(String(r.itemID));
    if (!item || item.ownerID !== r.ownerID || item.typeID !== r.typeID || qty(item) !== r.quantity ||
      (r.locationID !== undefined && item.locationID !== r.locationID))
      issue("MARKET_RECEIPT_NATIVE_ITEM_NOT_ATTESTED", "nativeItems", claimKey);
  }
  for (const [claimKey] of receipts) if (!claims.has(claimKey))
    issue("GAMESTORE_RECEIPT_WITHOUT_RUST_CLAIM", "gameStoreReceipts", claimKey);
  const verifyCustody = (row, source, label) => {
    const item = items.get(String(row.itemID));
    if (!item || item.ownerID !== row.ownerID || item.typeID !== row.typeID ||
      qty(item) !== row.quantity || item.locationID !== row.locationID)
      issue(label, source, row.operationID ?? row.orderID ?? row.jobID ?? row.contractID);
  };
  const custodian = (r, identity) => positive(r[identity]) && positive(r.itemID) &&
    positive(r.ownerID) && positive(r.typeID) && positive(r.quantity) && positive(r.locationID);
  const activeEscrowItems = new Set();
  // An original native item cannot simultaneously be the active custody of
  // independent economic systems. Track the item across market, contract,
  // manufacturing output and NPC cargo, not only multiple market orders.
  const activeCustody = new Map();
  const claimCustody = (nativeItemID, source, claimID) => {
    const id = String(nativeItemID);
    const previous = activeCustody.get(id);
    if (previous && (previous.source !== source || previous.claimID !== claimID))
      issue("NATIVE_ITEM_MULTIPLE_ACTIVE_CUSTODIANS", source, id);
    else activeCustody.set(id, {source, claimID});
  };
  for (const [source, field, label] of [
    ["marketEscrows", "orderID", "GHOST_OR_MISMATCHED_MARKET_ESCROW"],
    ["industryDeliveries", "jobID", "GHOST_OR_MISMATCHED_INDUSTRY_DELIVERY"],
    ["contractReceipts", "contractID", "GHOST_OR_MISMATCHED_CONTRACT_CUSTODY"],
  ]) {
    const seen = new Set();
    for (const r of sources[source]) {
      if (!r || !custodian(r, field)) { issue("MALFORMED_EVIDENCE", source); continue; }
      const identity = String(r[field]);
      if (seen.has(identity)) issue("DUPLICATE_SETTLEMENT_ID", source, identity);
      seen.add(identity);
      if (r.active === false) continue;
      claimCustody(r.itemID, source, identity);
      if (source === "marketEscrows") {
        if (activeEscrowItems.has(r.itemID)) issue("ITEM_CLAIMED_BY_MULTIPLE_MARKET_ORDERS", source, r.itemID);
        activeEscrowItems.add(r.itemID);
      }
      verifyCustody(r, source, label);
    }
  }
  const cargoIDs = new Set();
  for (const r of sources.npcCargo) {
    if (!r || !positive(r.cargoID) || !positive(r.ownerID) || !positive(r.typeID) || !positive(r.quantity)) {
      issue("MALFORMED_EVIDENCE", "npcCargo"); continue;
    }
    if (cargoIDs.has(r.cargoID)) issue("DUPLICATE_NPC_CARGO_ID", "npcCargo", r.cargoID);
    cargoIDs.add(r.cargoID);
    if (r.nativeItemID !== undefined) {
      const item = items.get(String(r.nativeItemID));
      if (!item || item.ownerID !== r.ownerID || item.typeID !== r.typeID || qty(item) !== r.quantity)
        issue("NPC_CARGO_ITEM_CUSTODY_DIVERGED", "npcCargo", r.cargoID);
      if (activeEscrowItems.has(r.nativeItemID))
        issue("NPC_CARGO_AND_MARKET_ESCROW_DOUBLE_CLAIM", "npcCargo", r.cargoID);
      claimCustody(r.nativeItemID, "npcCargo", String(r.cargoID));
    }
  }
  const walletOperations = new Set();
  for (const r of sources.walletSettlements) {
    if (!r || !key(r.operationID) || !integer(r.debitCents) ||
      !integer(r.creditCents) || !integer(r.feeCents)) {
      issue("MALFORMED_EVIDENCE", "walletSettlements"); continue;
    }
    if (walletOperations.has(r.operationID)) issue("DUPLICATE_WALLET_SETTLEMENT", "walletSettlements", r.operationID);
    walletOperations.add(r.operationID);
    if (BigInt(r.debitCents) !== BigInt(r.creditCents) + BigInt(r.feeCents))
      issue("WALLET_VALUE_NOT_CONSERVED", "walletSettlements", r.operationID);
  }
  const journals = new Map();
  for (const r of sources.journals) {
    if (!r || !key(r.operationID) || !key(r.phase)) { issue("MALFORMED_EVIDENCE", "journals"); continue; }
    if (!journals.has(r.operationID)) journals.set(r.operationID, []);
    journals.get(r.operationID).push(r.phase);
  }
  const terminal = new Set(["AWARDED", "COMMITTED", "DELIVERED", "SETTLED", "FINALIZED"]);
  for (const [operationID, phases] of journals) {
    if (phases.filter(p => terminal.has(p)).length > 1)
      issue("DUPLICATE_TERMINAL_JOURNAL", "journals", operationID);
    if (["UNKNOWN", "PREPARED", "INSTALL_UNKNOWN", "DELIVERY_UNKNOWN"].includes(phases.at(-1)))
      issue("AMBIGUOUS_JOURNAL_REQUIRES_MANUAL_RECONCILIATION", "journals", operationID);
  }
  for (const w of sources.conservationWindows) {
    const fields = ["opening", "produced", "received", "consumed", "destroyed", "sent", "closing"];
    if (!w || !key(w.operationID) || !positive(w.typeID) || fields.some(f => !integer(w[f]))) {
      issue("MALFORMED_EVIDENCE", "conservationWindows"); continue;
    }
    if (BigInt(w.opening) + BigInt(w.produced) + BigInt(w.received) !==
      BigInt(w.consumed) + BigInt(w.destroyed) + BigInt(w.sent) + BigInt(w.closing))
      issue("COMMODITY_NOT_CONSERVED", "conservationWindows", w.operationID);
  }
  const status = issues.length ? "HOLD_MANUAL" : missingSources.length ? "INCOMPLETE" :
    Object.values(counts).every(x => x === 0) ? "NO_EVIDENCE" : "SNAPSHOT_CONSISTENT";
  return Object.freeze({ status, changed: false, missingSources: Object.freeze(missingSources),
    counts: Object.freeze(counts), issues: Object.freeze(issues) });
}
module.exports = { auditEconomyEvidence, SOURCES };
