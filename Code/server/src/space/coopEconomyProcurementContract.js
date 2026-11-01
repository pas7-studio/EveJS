'use strict';

// IE-050: the player procurement contract is only open when the quote is really funded and escrowed.
// A bare quote is a legitimate state, but it is always reported UNPAID, never FUNDED.

const CONTRACT_CODE = {
  OPEN: 'OPEN',
  NOT_FUNDED: 'NOT_FUNDED',
  INVALID_CONTRACT: 'INVALID_CONTRACT',
  EXPIRED: 'EXPIRED',
  NOT_OPEN: 'NOT_OPEN',
};

const openContracts = new Map();

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositive(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function openContract(args) {
  const {
    contractID,
    typeID,
    stationID,
    quantity,
    unitPriceCents,
    expiryTick,
    buyerCorpID,
    supplierID,
    funding,
  } = args || {};

  if (
    !isID(contractID) ||
    !isID(typeID) ||
    !isID(stationID) ||
    !isID(buyerCorpID) ||
    !isID(supplierID) ||
    !isPositive(quantity) ||
    !isPositive(unitPriceCents) ||
    !isPositive(expiryTick)
  ) {
    return { ok: false, code: CONTRACT_CODE.INVALID_CONTRACT };
  }

  const liabilityCents = quantity * unitPriceCents;
  const hold = funding || {};
  const funded =
    hold.funded === true &&
    isID(hold.receiptID) &&
    typeof hold.reservedCents === 'number' &&
    Number.isSafeInteger(hold.reservedCents) &&
    hold.reservedCents >= liabilityCents;

  if (!funded) {
    return { ok: false, code: CONTRACT_CODE.NOT_FUNDED, status: 'UNPAID', liabilityCents };
  }

  const contract = {
    contractID,
    typeID,
    stationID,
    quantity,
    unitPriceCents,
    liabilityCents,
    expiryTick,
    buyerCorpID,
    supplierID,
    status: 'FUNDED',
    fundingReceiptID: hold.receiptID,
  };
  openContracts.set(contractID, contract);
  return {
    ok: true,
    code: CONTRACT_CODE.OPEN,
    status: 'FUNDED',
    contractID,
    liabilityCents,
    expiryTick,
  };
}

function expire(contractID, tick) {
  const contract = openContracts.get(contractID);
  if (!contract) return { ok: false, code: CONTRACT_CODE.NOT_OPEN };
  if (Number.isSafeInteger(tick) && tick > contract.expiryTick) {
    contract.status = 'EXPIRED';
    return { ok: true, code: CONTRACT_CODE.EXPIRED, status: 'EXPIRED', contractID };
  }
  return { ok: true, code: CONTRACT_CODE.OPEN, status: 'FUNDED', contractID };
}

function open(contractID) {
  const contract = openContracts.get(contractID);
  return contract ? { ...contract } : null;
}

module.exports = { openContract, expire, open, CONTRACT_CODE };
