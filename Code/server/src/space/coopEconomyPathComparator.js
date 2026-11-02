'use strict';

const VALID_KINDS = new Set(['BUY', 'MINE', 'REFINE', 'MANUFACTURE', 'SHIP']);

function compareOptions(options) {
  const rejected = [];
  const feasible = [];

  for (const opt of options) {
    if (opt === null || typeof opt !== 'object') {
      rejected.push({ kind: null, reason: 'INVALID_COST' });
      continue;
    }

    const kind = opt.kind;
    const cost = opt.landedCostCents;
    const isFeasible = opt.feasible === true;

    if (!isFeasible) {
      rejected.push({ kind, reason: 'INFEASIBLE' });
      continue;
    }

    if (!Number.isSafeInteger(cost) || cost < 0) {
      rejected.push({ kind, reason: 'INVALID_COST' });
      continue;
    }

    if (!VALID_KINDS.has(kind)) {
      rejected.push({ kind, reason: 'UNKNOWN_KIND' });
      continue;
    }

    feasible.push({ kind, landedCostCents: cost, feasible: true });
  }

  feasible.sort((a, b) => {
    if (a.landedCostCents !== b.landedCostCents) {
      return a.landedCostCents - b.landedCostCents;
    }
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    return 0;
  });

  return {
    best: feasible.length ? feasible[0] : null,
    ranked: feasible,
    rejected,
  };
}

module.exports = { compareOptions };
