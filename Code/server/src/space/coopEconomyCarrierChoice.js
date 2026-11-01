'use strict';

// IE-049: internal trip versus a funded player freight contract. Both options are compared on real numbers
// (cost, ETA, capacity), an unpaid contract is never a carrier, and an impossible ETA is refused rather than
// promised.

const CARRIER_CODE = {
  INTERNAL: 'INTERNAL',
  EXTERNAL: 'EXTERNAL',
  INVALID_LIMIT: 'INVALID_LIMIT',
  UNPAID_CONTRACT: 'UNPAID_CONTRACT',
  IMPOSSIBLE_ETA: 'IMPOSSIBLE_ETA',
  NO_CARRIER: 'NO_CARRIER',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositive(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCost(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validInternal(internal, volumeM3) {
  return (
    internal &&
    isID(internal.hullID) &&
    internal.available === true &&
    isPositive(internal.capacityM3) &&
    isPositive(internal.etaSeconds) &&
    isCost(internal.costCents) &&
    (volumeM3 === undefined || internal.capacityM3 >= volumeM3)
  );
}

function chooseCarrier(args) {
  const { internal, external, maxEtaSeconds, volumeM3 } = args || {};
  if (!isPositive(maxEtaSeconds)) return { ok: false, code: CARRIER_CODE.INVALID_LIMIT };

  const externalGiven = !!external;
  if (externalGiven && !isID(external.contractID)) return { ok: false, code: CARRIER_CODE.INVALID_LIMIT };
  // an unfunded freight contract is not a carrier at all
  if (externalGiven && external.funded !== true) return { ok: false, code: CARRIER_CODE.UNPAID_CONTRACT };

  const externalFeasible =
    externalGiven &&
    isPositive(external.etaSeconds) &&
    isPositive(external.priceCents) &&
    external.etaSeconds <= maxEtaSeconds;

  const internalFeasible = validInternal(internal, volumeM3);

  if (!internalFeasible && !externalGiven) return { ok: false, code: CARRIER_CODE.NO_CARRIER };
  if (!internalFeasible && !externalFeasible) {
    // the only remaining option is an external contract that cannot arrive in time
    return { ok: false, code: CARRIER_CODE.IMPOSSIBLE_ETA };
  }

  if (internalFeasible && !externalFeasible) {
    return {
      ok: true,
      code: CARRIER_CODE.INTERNAL,
      choice: 'INTERNAL',
      hullID: internal.hullID,
      costCents: internal.costCents,
      etaSeconds: internal.etaSeconds,
    };
  }
  if (!internalFeasible) {
    return {
      ok: true,
      code: CARRIER_CODE.EXTERNAL,
      choice: 'EXTERNAL',
      contractID: external.contractID,
      costCents: external.priceCents,
      etaSeconds: external.etaSeconds,
    };
  }

  const externalWins =
    external.priceCents < internal.costCents ||
    (external.priceCents === internal.costCents && external.etaSeconds < internal.etaSeconds);
  if (externalWins) {
    return {
      ok: true,
      code: CARRIER_CODE.EXTERNAL,
      choice: 'EXTERNAL',
      contractID: external.contractID,
      costCents: external.priceCents,
      etaSeconds: external.etaSeconds,
    };
  }
  return {
    ok: true,
    code: CARRIER_CODE.INTERNAL,
    choice: 'INTERNAL',
    hullID: internal.hullID,
    costCents: internal.costCents,
    etaSeconds: internal.etaSeconds,
  };
}

module.exports = { chooseCarrier, CARRIER_CODE };
