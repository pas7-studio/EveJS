'use strict';

// IE-064: the two-player client end-to-end gate. A headless simulation can never satisfy this: the proof
// needs a real pinned EVE client build, two real accounts, and the authenticated UI showing the same numbers
// as the market, the inventory and the wallet. This module only verifies such an artifact; it never
// substitutes for it, and it reports NOT_RUN when the artifact is missing.

const E2E_CODE = {
  E2E_VERIFIED: 'E2E_VERIFIED',
  CLIENT_GATE_REQUIRED: 'CLIENT_GATE_REQUIRED',
  UI_MISMATCH: 'UI_MISMATCH',
  RECEIPT_MISSING: 'RECEIPT_MISSING',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_RUN: 'NOT_RUN',
};

const SUPPORTED_CLIENT = 'eve-pinned-client';
const REQUIRED_STEPS = ['SUPPLY', 'DELIVERY', 'SALE'];

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function clientGate(client) {
  if (!client || client.kind !== SUPPORTED_CLIENT) return false;
  if (!isID(client.buildID) || !isID(client.sha256)) return false;
  if (client.sha256.length !== 64) return false;
  return client.twoAccounts === true;
}

function verifyE2E(args) {
  const { client, players, ui, market, inventory, wallet, receipts } = args || {};

  if (!clientGate(client)) {
    return {
      ok: false,
      code: E2E_CODE.CLIENT_GATE_REQUIRED,
      simulated: false,
      reason: 'a pinned client build with two real accounts is required, a simulation cannot substitute it',
    };
  }

  if (!Array.isArray(players) || players.length !== 2 || !players.every((p) => p && isID(p.playerID))) {
    return { ok: false, code: E2E_CODE.INVALID_INPUT, reason: 'two player identities required' };
  }
  for (const name of ['ui', 'market', 'inventory', 'wallet']) {
    if (!args[name] || typeof args[name] !== 'object') {
      return { ok: false, code: E2E_CODE.INVALID_INPUT, reason: 'missing ' + name };
    }
  }
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { ok: false, code: E2E_CODE.RECEIPT_MISSING, reason: 'no native receipts' };
  }

  const steps = receipts.map((r) => r && r.step);
  const missingSteps = REQUIRED_STEPS.filter((step) => !steps.includes(step));
  if (missingSteps.length > 0) {
    return { ok: false, code: E2E_CODE.RECEIPT_MISSING, missing: missingSteps };
  }
  const receiptless = receipts.filter((r) => !r || !isID(r.receiptID));
  if (receiptless.length > 0) {
    return { ok: false, code: E2E_CODE.RECEIPT_MISSING, count: receiptless.length };
  }

  const discrepancies = [];
  const check = (field, uiValue, truthValue) => {
    if (!isCount(uiValue) || !isCount(truthValue)) {
      discrepancies.push({ field, reason: 'NON_INTEGER' });
      return;
    }
    if (uiValue !== truthValue) discrepancies.push({ field, ui: uiValue, truth: truthValue });
  };
  check('walletCents', ui.walletCents, wallet.cents);
  check('inventoryUnits', ui.inventoryUnits, inventory.units);
  check('marketUnits', ui.marketUnits, market.units);
  check('marketOrders', ui.marketOrders, market.orders);
  if (ui.playerID !== players[0].playerID && ui.playerID !== players[1].playerID) {
    discrepancies.push({ field: 'playerID', ui: ui.playerID });
  }

  if (discrepancies.length > 0) {
    return { ok: false, code: E2E_CODE.UI_MISMATCH, discrepancies };
  }
  return {
    ok: true,
    code: E2E_CODE.E2E_VERIFIED,
    buildID: client.buildID,
    players: players.map((p) => p.playerID),
    steps,
    receipts: receipts.map((r) => r.receiptID),
  };
}

// called by the rollout manifest when no client artifact exists yet
function notRun(reason) {
  return { ok: false, code: E2E_CODE.NOT_RUN, simulated: false, reason: reason || 'client artifact not provided' };
}

module.exports = { verifyE2E, notRun, E2E_CODE, SUPPORTED_CLIENT };
