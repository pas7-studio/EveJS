'use strict';

// IE-072: performance protection. The economy must not steal the tick. Budgets are absolute and a hot-path
// p95 regression versus the baseline fails the check instead of being explained away.

const PERFORMANCE_CODE = {
  PASS: 'PASS',
  P95_REGRESSION: 'P95_REGRESSION',
  TICK_STARVATION: 'TICK_STARVATION',
  SLOW_CHECKER: 'SLOW_CHECKER',
  INVALID_MEASUREMENT: 'INVALID_MEASUREMENT',
};

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function p95ByPath(measurement) {
  const paths = new Map();
  for (const path of Array.isArray(measurement && measurement.paths) ? measurement.paths : []) {
    if (!path || typeof path.name !== 'string' || !isCount(path.p95Ms)) return null;
    paths.set(path.name, path.p95Ms);
  }
  return paths;
}

function check(args) {
  const { baseline, candidate, budgets } = args || {};
  if (!baseline || !candidate || !budgets) return { ok: false, code: PERFORMANCE_CODE.INVALID_MEASUREMENT };
  if (!isCount(budgets.p95TolerancePct) || !isCount(budgets.tickBudgetMs) || !isCount(budgets.maxCheckMinutes)) {
    return { ok: false, code: PERFORMANCE_CODE.INVALID_MEASUREMENT };
  }
  const baselinePaths = p95ByPath(baseline);
  const candidatePaths = p95ByPath(candidate);
  if (!baselinePaths || !candidatePaths) return { ok: false, code: PERFORMANCE_CODE.INVALID_MEASUREMENT };

  // the checker itself must stay cheap: a 30-45 minute run is a defect to investigate, not a pass
  if (budgets.checkMinutes !== undefined && budgets.checkMinutes > budgets.maxCheckMinutes) {
    return { ok: false, code: PERFORMANCE_CODE.SLOW_CHECKER, checkMinutes: budgets.checkMinutes };
  }

  const regressions = [];
  const newPaths = [];
  for (const [name, p95] of candidatePaths.entries()) {
    if (!baselinePaths.has(name)) {
      newPaths.push(name);
      continue;
    }
    const baseP95 = baselinePaths.get(name);
    // a zero baseline must not hide any nonzero candidate
    if (baseP95 === 0) {
      if (p95 > 0) regressions.push({ name, baselineP95Ms: 0, candidateP95Ms: p95, growthPct: Infinity });
      continue;
    }
    const growthPct = ((p95 - baseP95) / baseP95) * 100;
    if (growthPct > budgets.p95TolerancePct) {
      regressions.push({ name, baselineP95Ms: baseP95, candidateP95Ms: p95, growthPct });
    }
  }
  if (regressions.length > 0) {
    return { ok: false, code: PERFORMANCE_CODE.P95_REGRESSION, paths: regressions.map((r) => r.name), detail: regressions };
  }

  const slowest = candidate.ticks && candidate.ticks.slowestMs;
  if (isCount(slowest) && slowest > budgets.tickBudgetMs) {
    return { ok: false, code: PERFORMANCE_CODE.TICK_STARVATION, slowestMs: slowest, budgetMs: budgets.tickBudgetMs };
  }

  return { ok: true, code: PERFORMANCE_CODE.PASS, regressions: [], newPaths };
}

module.exports = { check, PERFORMANCE_CODE };
