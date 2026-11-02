'use strict';

// IE-061: crash-window generator. Every native write boundary (intent, debit, credit, escrow, finalize) is
// wrapped so a SIGKILL can be injected before or after it. A restart must be idempotent: a step whose effect
// was applied is never applied again, and a step whose outcome is unknown is reported UNKNOWN instead of
// being swallowed into an "empty journal" success.

const CRASH_WINDOWS = [
  'BEFORE_INTENT',
  'AFTER_INTENT',
  'AFTER_APPLY_BEFORE_DONE',
  'AFTER_DEBIT',
  'AFTER_CREDIT',
  'AFTER_ESCROW',
  'BEFORE_FINALIZE',
];

const STEPS = ['INTENT', 'DEBIT', 'CREDIT', 'ESCROW', 'FINALIZE'];

const CRASH_CODE = {
  RECOVERED: 'RECOVERED',
  RECOVERED_WITH_UNKNOWN: 'RECOVERED_WITH_UNKNOWN',
  JOURNAL_INCOMPLETE: 'JOURNAL_INCOMPLETE',
  INVALID_WINDOW: 'INVALID_WINDOW',
};

function createJournal() {
  const entries = new Map(); // operationID -> Map(step -> { status, receiptID })
  function slot(operationID) {
    let entry = entries.get(operationID);
    if (!entry) {
      entry = new Map();
      entries.set(operationID, entry);
    }
    return entry;
  }
  return {
    intent(operationID, step) {
      slot(operationID).set(step, { status: 'PENDING' });
    },
    done(operationID, step, receiptID) {
      slot(operationID).set(step, { status: 'DONE', receiptID });
    },
    unknown(operationID, step) {
      slot(operationID).set(step, { status: 'UNKNOWN' });
    },
    read(operationID, step) {
      const entry = entries.get(operationID);
      return entry ? entry.get(step) : undefined;
    },
    entries(operationID) {
      const entry = entries.get(operationID);
      return entry ? [...entry.entries()] : [];
    },
  };
}

function createExecutor(stepFunctions) {
  const counts = {};
  for (const step of STEPS) counts[step] = 0;
  return {
    counts,
    apply(step, args) {
      const fn = stepFunctions[step];
      if (typeof fn !== 'function') return { receiptID: 'noop:' + step };
      counts[step] += 1;
      return fn(args);
    },
  };
}

function drive(journal, executor, operationID, crashAt) {
  const applied = [];
  const skipped = [];
  const unknown = [];

  for (const step of STEPS) {
    const existing = journal.read(operationID, step);
    if (existing && existing.status === 'DONE') {
      skipped.push(step);
      continue;
    }
    if (existing && existing.status === 'UNKNOWN') {
      unknown.push(step);
      continue;
    }

    if (crashAt === 'BEFORE_INTENT' && step === 'INTENT') {
      return { applied, skipped, unknown, crashed: true, crashStep: step };
    }
    if (existing && existing.status === 'PENDING') {
      // a resumed intent: the effect may or may not have reached the native store before the crash, so the
      // native readback decides. Re-applying a step that already happened is the failure we are hunting.
      if (executor.counts[step] > 0) {
        journal.unknown(operationID, step);
        unknown.push(step);
        continue;
      }
      journal.intent(operationID, step);
    } else {
      journal.intent(operationID, step);
    }
    if (crashAt === 'AFTER_INTENT' && step === 'INTENT') {
      return { applied, skipped, unknown, crashed: true, crashStep: step };
    }

    const result = executor.apply(step, { operationID });
    applied.push(step);

    // the most dangerous window: the real effect happened but the journal entry never got written
    if (crashAt === 'AFTER_APPLY_BEFORE_DONE' && step === 'DEBIT') {
      return { applied, skipped, unknown, crashed: true, crashStep: step, afterApply: true };
    }

    journal.done(operationID, step, result && result.receiptID ? result.receiptID : 'noop:' + step);

    if (crashAt === 'AFTER_' + step) {
      return { applied, skipped, unknown, crashed: true, crashStep: step };
    }
  }
  return { applied, skipped, unknown, crashed: false };
}
function runWindow({ window, operationID, steps }) {
  if (!CRASH_WINDOWS.includes(window)) return { ok: false, code: CRASH_CODE.INVALID_WINDOW };
  if (typeof operationID !== 'string' || operationID.length === 0) {
    return { ok: false, code: CRASH_CODE.JOURNAL_INCOMPLETE, reason: 'missing operationID' };
  }

  const journal = createJournal();
  const executor = createExecutor(steps || {});

  const first = drive(journal, executor, operationID, window);
  // the "applied but not recorded" window leaves a real effect with no journal entry: on restart that step
  // is UNKNOWN and the caller must reconcile with a readback instead of re-applying it
  const recorded = journal.entries(operationID).map(([step]) => step);
  const lost = first.applied.filter((step) => !recorded.includes(step));
  if (lost.length > 0) {
    for (const step of lost) journal.unknown(operationID, step);
  }

  const resumed = drive(journal, executor, operationID, null);
  const finalCounts = { ...executor.counts };
  const unknownSteps = [...lost, ...resumed.unknown];
  const doubled = STEPS.filter((step) => finalCounts[step] > 1);

  return {
    ok: doubled.length === 0,
    code: unknownSteps.length > 0 ? CRASH_CODE.RECOVERED_WITH_UNKNOWN : CRASH_CODE.RECOVERED,
    window,
    crashed: first.crashed,
    counts: finalCounts,
    unknown: [...new Set(unknownSteps)],
    doubled,
    journal: journal.entries(operationID),
  };
}

module.exports = { runWindow, createJournal, CRASH_WINDOWS, CRASH_CODE, STEPS };
