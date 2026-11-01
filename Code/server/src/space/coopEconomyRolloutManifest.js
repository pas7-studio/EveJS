'use strict';

// IE-065: staged admission OFF -> SHADOW -> CORP1 -> CORP2. A stage only writes when every flag it needs is
// strictly true, SHADOW never writes, and every stage is reversible without deleting a single row.

const STAGES = ['OFF', 'SHADOW', 'CORP1', 'CORP2'];

const ROLLOUT_CODE = {
  OFF: 'OFF',
  SHADOW: 'SHADOW',
  WRITING: 'WRITING',
  INVALID_STAGE: 'INVALID_STAGE',
  INVALID_FLAG_COMBINATION: 'INVALID_FLAG_COMBINATION',
  ROLLBACK: 'ROLLBACK',
};

const REQUIRED = {
  OFF: [],
  SHADOW: [],
  CORP1: ['EVEJS_COOP_ECONOMY'],
  CORP2: ['EVEJS_COOP_ECONOMY', 'EVEJS_COOP_SECOND_CORP'],
};

function requiredFlagsFor(stage) {
  return REQUIRED[stage] ? [...REQUIRED[stage]] : [];
}

function evaluate(args) {
  const { stage, flags } = args || {};
  if (!STAGES.includes(stage)) return { ok: false, code: ROLLOUT_CODE.INVALID_STAGE, writes: false };
  if (flags !== undefined && (flags === null || typeof flags !== 'object')) {
    return { ok: false, code: ROLLOUT_CODE.INVALID_STAGE, writes: false };
  }
  const active = flags || {};

  if (stage === 'OFF') return { ok: true, code: ROLLOUT_CODE.OFF, writes: false, observes: false };
  if (stage === 'SHADOW') return { ok: true, code: ROLLOUT_CODE.SHADOW, writes: false, observes: true };

  const required = requiredFlagsFor(stage);
  const missing = required.filter((name) => active[name] !== true);

  // CORP2 is a strict superset of CORP1: skipping a stage is an invalid combination, not a shortcut
  if (stage === 'CORP2') {
    const corp1Ready = REQUIRED.CORP1.every((name) => active[name] === true);
    if (!corp1Ready && !missing.includes('CORP1')) missing.push('CORP1');
  }

  if (missing.length > 0) {
    return { ok: false, code: ROLLOUT_CODE.INVALID_FLAG_COMBINATION, missing, writes: false };
  }
  return { ok: true, code: ROLLOUT_CODE.WRITING, writes: true, observes: true };
}

function rollback(args) {
  const { stage } = args || {};
  if (!STAGES.includes(stage)) return { ok: false, code: ROLLOUT_CODE.INVALID_STAGE };
  const index = STAGES.indexOf(stage);
  const previous = STAGES[Math.max(index - 1, 0)];
  return { ok: true, code: ROLLOUT_CODE.ROLLBACK, stage: previous, deletesData: false };
}

module.exports = { evaluate, rollback, requiredFlagsFor, STAGES, ROLLOUT_CODE };
