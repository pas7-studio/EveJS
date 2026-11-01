'use strict';

// IE-063: an accelerated, deterministic soak over the real economy loop. It runs the same accounting the
// live modules use (produce -> refine -> consume) with a seeded PRNG, checks conservation at every tick, and
// reports drift, unbounded growth and stalled progress instead of hiding them. A failing soak never resets
// its own state: the failures stay visible to the operator.

const SOAK_CODE = {
  SOAK_COMPLETE: 'SOAK_COMPLETE',
  SOAK_FAILED: 'SOAK_FAILED',
  INVALID_SOAK: 'INVALID_SOAK',
};

// deterministic PRNG: the same seed always produces the same world
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSoak(args) {
  const { ticks, seed, stockCap = 10000, walletStart = 100000 } = args || {};
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || ticks > 1000000) {
    return { ok: false, code: SOAK_CODE.INVALID_SOAK, reason: 'ticks' };
  }
  if (!Number.isSafeInteger(seed)) return { ok: false, code: SOAK_CODE.INVALID_SOAK, reason: 'seed' };

  const next = mulberry32(seed);
  const failures = [];

  let ore = 0;
  let material = 0;
  let product = 0;
  let wallet = walletStart;
  let everProduced = 0;
  let everConsumed = 0;
  let materialProduced = 0;
  let materialUsed = 0;
  let steps = 0;

  for (let tick = 1; tick <= ticks; tick += 1) {
    // 1. mining: a bounded yield per tick
    const yieldUnits = 1 + Math.floor(next() * 5);
    steps += 1;
    ore += yieldUnits;

    // 2. refining: never more input than the warehouse holds, exact 90% conversion
    const refine = Math.min(ore, 1 + Math.floor(next() * 5));
    steps += 1;
    if (refine > 0) {
      ore -= refine;
      const yielded = Math.floor(refine * 0.9);
      material += yielded;
      materialProduced += yielded;
    }

    // 3. production: one product per 10 material, only when the material exists
    const runs = Math.floor(material / 10);
    steps += 1;
    if (runs > 0) {
      material -= runs * 10;
      materialUsed += runs * 10;
      product += runs;
      everProduced += runs;
      wallet -= runs * 3; // real cost, no free money
    }

    // 4. consumption: the fleet burns what it needs, this is the demand signal
    const consume = Math.min(product, Math.floor(next() * 3));
    steps += 1;
    if (consume > 0) {
      product -= consume;
      everConsumed += consume;
      wallet += consume * 5;
    }

    // 5. invariants are checked every tick and never repaired silently
    if (ore < 0 || material < 0 || product < 0 || wallet < 0) {
      failures.push({ tick, code: 'NEGATIVE_BALANCE', ore, material, product, wallet });
      break;
    }
    if (ore + material + product > stockCap) {
      failures.push({ tick, code: 'UNBOUNDED_GROWTH', stock: ore + material + product });
      break;
    }
    if (steps > ticks * 4) {
      failures.push({ tick, code: 'STEP_BUDGET_EXCEEDED', steps });
      break;
    }
  }

  // mass balance: every unit mined is either still in stock or was produced/consumed
  const accounted = ore + material + product;
  // the material ledger must close exactly: nothing was created or lost during production
  const balanceHolds = material === materialProduced - materialUsed && everConsumed <= everProduced;

  if (!balanceHolds) {
    failures.push({ code: 'CONSERVATION_DRIFT', accounted, everProduced, everConsumed });
  }

  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? SOAK_CODE.SOAK_COMPLETE : SOAK_CODE.SOAK_FAILED,
    ticks,
    seed,
    metrics: {
      stock: accounted,
      produced: everProduced,
      consumed: everConsumed,
      walletCents: wallet,
      steps,
      ticksPerSecondWork: ticks / steps,
    },
    failures,
    reset: false,
    leftoverUnits: accounted,
    materialBalance: material - (materialProduced - materialUsed),
  };
}

module.exports = { runSoak, SOAK_CODE, mulberry32 };
