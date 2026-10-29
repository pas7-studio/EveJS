"use strict";
// The skin market's fee policy (eve_public.cosmetic.market.api.*).
//
// These are the numbers the market window quotes before a player lists or buys anything, so they
// must be one real policy, not a different answer per call. Rates are fractions of the ISK price
// expressed in nanos-per-unit (10 000 000 nanos = 1%), and the buyer fee is loyalty points per
// item because that is what the client's buyer-fee message carries.
//
// The values are our own market policy for this world; nothing here claims to match New Eden.
const BROKER_FEE_RATES = Object.freeze([
  { days: 1, nanos: 10_000_000 }, // 1.0 %
  { days: 3, nanos: 20_000_000 }, // 2.0 %
  { days: 7, nanos: 30_000_000 }, // 3.0 %
  { days: 14, nanos: 50_000_000 }, // 5.0 %
]);

const TAX_RATE_NANOS = 25_000_000; // 2.5 %, charged on the sale price
const BUYER_FEE_VERSION = "1.0.0";

// Buyer fee per skin tier, in loyalty points. A branded listing doubles it.
const BUYER_FEES = Object.freeze([
  { tier: 1, defaultFee: 100, brandedFee: 200 },
  { tier: 2, defaultFee: 250, brandedFee: 500 },
  { tier: 3, defaultFee: 500, brandedFee: 1000 },
]);

function brokerFees() {
  return BROKER_FEE_RATES.map((row) => ({
    durationSeconds: row.days * 86400,
    nanos: row.nanos,
  }));
}

function taxRate() {
  return { units: 0, nanos: TAX_RATE_NANOS };
}

function buyerFee() {
  // Every skin this world mints is tier 1 (see coopThirdPartySkins), so the quote is the tier-1
  // default. It is a quote for the window, not a charge.
  const tier = BUYER_FEES[0];
  return { loyaltyPoints: tier.defaultFee, tier: tier.tier };
}

function buyerFeesDefinition() {
  return {
    version: BUYER_FEE_VERSION,
    tiers: BUYER_FEES.map((row) => ({ ...row })),
  };
}

module.exports = {
  BROKER_FEE_RATES,
  BUYER_FEES,
  BUYER_FEE_VERSION,
  TAX_RATE_NANOS,
  brokerFees,
  buyerFee,
  buyerFeesDefinition,
  taxRate,
};
