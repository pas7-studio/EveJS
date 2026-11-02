'use strict';

/**
 * coopEconomyRecovery
 *
 * Builds a capital-recovery plan for a cooperative economy wallet.
 * No external dependencies. CommonJS module.
 *
 * Rules:
 *  - Capital is never minted: mintedCents is 0 in every branch.
 *  - Escrowed assets are never sold.
 *  - Existing escrow claims are never cancelled: preservedEscrowCents is
 *    always escrowClaimsCents plus the value of escrowed assets.
 */

function isNonNegativeSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function buildRecoveryPlan({ walletCents, commitmentsCents, escrowClaimsCents, assets } = {}) {
  if (
    !isNonNegativeSafeInt(walletCents) ||
    !isNonNegativeSafeInt(commitmentsCents) ||
    !isNonNegativeSafeInt(escrowClaimsCents) ||
    !Array.isArray(assets)
  ) {
    return { ok: false, code: 'INVALID_STATE' };
  }

  for (const asset of assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      asset.itemID === undefined ||
      asset.quantity === undefined ||
      asset.unitValueCents === undefined
    ) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    // Units and cents are integers: a fractional or negative quantity (or a numeric string coerced
    // by `*`) silently changes the amount of money the plan claims to recover, and a NaN infects
    // every comparison below. A corrupt row is refused, never discounted.
    if (!isNonNegativeSafeInt(asset.quantity) || !isNonNegativeSafeInt(asset.unitValueCents)) {
      return { ok: false, code: 'INVALID_STATE' };
    }
  }

  const sellableCents = assets.reduce((sum, asset) => {
    if (asset.escrowed !== true) {
      return sum + asset.quantity * asset.unitValueCents;
    }
    return sum;
  }, 0);

  const escrowedValueCents = assets.reduce((sum, asset) => {
    if (asset.escrowed === true) {
      return sum + asset.quantity * asset.unitValueCents;
    }
    return sum;
  }, 0);

  const preservedEscrowCents = escrowClaimsCents + escrowedValueCents;

  const shortfallCents = Math.max(commitmentsCents + escrowClaimsCents - walletCents, 0);

  if (shortfallCents === 0) {
    return { ok: true, code: 'NOT_DISTRESSED', mintedCents: 0, sellableCents, preservedEscrowCents };
  }

  if (shortfallCents <= sellableCents) {
    const sellableAssets = assets.filter((asset) => asset.escrowed !== true);
    return {
      ok: true,
      code: 'RECOVERY_PLAN',
      sellCents: shortfallCents,
      preservedEscrowCents,
      mintedCents: 0,
      assets: sellableAssets.map((asset) => ({ itemID: asset.itemID, quantity: asset.quantity })),
    };
  }

  return {
    ok: false,
    code: 'STILL_DISTRESSED',
    sellCents: sellableCents,
    preservedEscrowCents,
    mintedCents: 0,
  };
}

module.exports = { buildRecoveryPlan, RECOVERY_CODE: 'RECOVERY_PLAN' };
