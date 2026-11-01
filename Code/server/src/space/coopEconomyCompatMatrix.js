'use strict';

// IE-069: compatibility regression matrix. With the feature OFF the world must be byte-for-byte what it was;
// with it ON only the economy area may move, and no pirate or security policy may switch itself on.

const PROTECTED_AREAS = ['combat', 'salvage', 'factionWarfare', 'market', 'clientRpc'];

const COMPAT_CODE = {
  OFF_PARITY: 'OFF_PARITY',
  ON_PARITY: 'ON_PARITY',
  OFF_DIFF: 'OFF_DIFF',
  ON_DISRUPTION: 'ON_DISRUPTION',
  AUTO_ENABLED_POLICY: 'AUTO_ENABLED_POLICY',
  INVALID_MATRIX: 'INVALID_MATRIX',
};

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

function same(a, b) {
  return stable(a) === stable(b);
}

function autoEnabled(candidate, baseline) {
  const candidatePolicy = candidate && candidate.securityPolicy;
  const baselinePolicy = baseline && baseline.securityPolicy;
  if (!candidatePolicy) return false;
  return candidatePolicy.autoEnabled === true && (!baselinePolicy || baselinePolicy.autoEnabled !== true);
}

function run(args) {
  const { baseline, candidate, flags } = args || {};
  if (!baseline || !candidate || typeof baseline !== 'object' || typeof candidate !== 'object') {
    return { ok: false, code: COMPAT_CODE.INVALID_MATRIX };
  }
  const economyOn = !!(flags && flags.economy === true);

  // a policy that turns itself on is a defect in both modes
  if (autoEnabled(candidate, baseline)) {
    return { ok: false, code: COMPAT_CODE.AUTO_ENABLED_POLICY };
  }

  const differing = PROTECTED_AREAS.filter((area) => !same(baseline[area], candidate[area]));

  if (!economyOn) {
    if (differing.length > 0) return { ok: false, code: COMPAT_CODE.OFF_DIFF, areas: differing };
    return { ok: true, code: COMPAT_CODE.OFF_PARITY, areas: [...PROTECTED_AREAS] };
  }

  if (differing.length > 0) return { ok: false, code: COMPAT_CODE.ON_DISRUPTION, areas: differing };
  return { ok: true, code: COMPAT_CODE.ON_PARITY, areas: [...PROTECTED_AREAS] };
}

module.exports = { run, PROTECTED_AREAS, COMPAT_CODE };
