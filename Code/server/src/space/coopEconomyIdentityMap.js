'use strict';

/**
 * coopEconomyIdentityMap
 *
 * Maps the ledger sources that can back a station's available stock.
 * A "physical" source is real on-hand stock; a "receipt" source is a
 * COMMITTED depot delivery that is NOT station stock until it lands.
 */

var LEDGER_SOURCES = Object.freeze([
  Object.freeze({
    id: 'item',
    title: 'GameStore item row',
    owner: 'services/inventory/itemStore.js',
    key: 'itemID',
    countsAs: 'physical',
    evidence: 'itemStore.js exports grantItemToCharacterLocation/removeInventoryItem'
  }),
  Object.freeze({
    id: 'cargo',
    title: 'Native NPC cargo',
    owner: 'space/npc/nativeNpcStore.js',
    key: 'cargoID',
    countsAs: 'physical',
    evidence: 'nativeNpcStore.js/nativeNpcService.js carry cargoID'
  }),
  Object.freeze({
    id: 'depot_receipt',
    title: 'Hauler depot receipt',
    owner: 'space/coopNativeDepot.js',
    key: 'cargoID',
    countsAs: 'receipt',
    evidence: 'coopNativeDepot.js header: a COMMITTED receipt is NOT station stock'
  }),
  Object.freeze({
    id: 'industry_job',
    title: 'Industry job',
    owner: 'services/industry/industryRuntimeState.js',
    key: 'jobID',
    countsAs: 'receipt',
    evidence: 'industryRuntimeState.js holds job records'
  }),
  Object.freeze({
    id: 'market_fill',
    title: 'Rust market fill',
    owner: 'rust market service',
    key: 'fillID',
    countsAs: 'receipt',
    evidence: 'market fills are canonical on the Rust side'
  }),
  Object.freeze({
    id: 'corp_wallet',
    title: 'Corporation wallet',
    owner: 'services/corporation/corpWalletState.js',
    key: 'walletEntryID',
    countsAs: 'receipt',
    evidence: 'corpWalletState.js is the canonical balance'
  })
]);

/**
 * describeSource(id)
 * Returns the matching record, or null when the id is unknown.
 * Throws TypeError for non-string ids.
 */
function describeSource(id) {
  if (typeof id !== 'string') {
    throw new TypeError('id must be a string');
  }
  for (var i = 0; i < LEDGER_SOURCES.length; i++) {
    if (LEDGER_SOURCES[i].id === id) {
      return LEDGER_SOURCES[i];
    }
  }
  return null;
}

/**
 * isStationStock(sourceId)
 * True only when the source countsAs "physical" AND its id is "item".
 * Unknown ids return false.
 */
function isStationStock(sourceId) {
  if (typeof sourceId !== 'string') {
    return false;
  }
  var rec = describeSource(sourceId);
  if (!rec) {
    return false;
  }
  return rec.countsAs === 'physical' && rec.id === 'item';
}

/**
 * availableAtStation({ itemStoreQuantity, depotCommittedQuantity } = {})
 *
 * Mandatory safety rule: a receipt (COMMITTED depot) is not stock, and a
 * missing station quantity is not proof that no delivery happened.
 *
 * - both values are optional numbers; treat non-finite, negative or
 *   non-number as 0.
 * - available: itemStoreQuantity only; depot receipts are never added.
 * - ignoredReceipts: depotCommittedQuantity when > 0, else 0.
 * - blocked: true when ignoredReceipts > 0 and available === 0.
 */
function availableAtStation(opts) {
  opts = opts || {};

  function toNumber(value) {
    if (typeof value !== 'number') {
      return 0;
    }
    if (!isFinite(value) || value < 0) {
      return 0;
    }
    return value;
  }

  var itemStoreQuantity = toNumber(opts.itemStoreQuantity);
  var depotCommittedQuantity = toNumber(opts.depotCommittedQuantity);

  var available = itemStoreQuantity;
  var ignoredReceipts = depotCommittedQuantity > 0 ? depotCommittedQuantity : 0;
  var blocked = ignoredReceipts > 0 && available === 0;

  return {
    available: available,
    ignoredReceipts: ignoredReceipts,
    blocked: blocked
  };
}

module.exports = {
  LEDGER_SOURCES: LEDGER_SOURCES,
  describeSource: describeSource,
  availableAtStation: availableAtStation,
  isStationStock: isStationStock
};
