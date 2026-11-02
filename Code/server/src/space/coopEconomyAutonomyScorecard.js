'use strict';

// IE-071: the autonomy scorecard. The only honest measure is who actually wrote each accepted file. A
// DeepSeek rescue is counted as a rescue even when it unblocked a task that an Ornith agent started, so a
// rescued task is never reported as autonomous success.

const SCORECARD_CODE = {
  SCORECARD: 'SCORECARD',
  UNATTRIBUTED: 'UNATTRIBUTED',
  INVALID_EVENTS: 'INVALID_EVENTS',
};

const KNOWN_ACTORS = new Set(['ornith-a', 'ornith-b', 'deepseek']);
const KNOWN_KINDS = new Set(['PRODUCTION', 'TEST', 'RESCUE']);

function isCount(value) {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function buildScorecard(args) {
  const { events } = args || {};
  if (!Array.isArray(events)) return { ok: false, code: SCORECARD_CODE.INVALID_EVENTS };

  let ornithAuthoredProductionLOC = 0;
  let ornithAuthoredTestLOC = 0;
  let deepseekRescueLOC = 0;
  let deepseekAuthoredProductionLOC = 0;
  let toolFailures = 0;
  let reviewRounds = 0;
  let noCandidateAttempts = 0;

  const producedBy = new Map(); // taskID -> 'ornith' | 'deepseek'
  const rescuedTasks = new Set();
  const acceptedTasks = new Set();

  for (const event of events) {
    if (!event || typeof event.taskID !== 'string' || event.taskID.length === 0) {
      return { ok: false, code: SCORECARD_CODE.INVALID_EVENTS };
    }
    if (!KNOWN_KINDS.has(event.kind)) {
      return { ok: false, code: SCORECARD_CODE.INVALID_EVENTS, taskID: event.taskID };
    }
    if (!KNOWN_ACTORS.has(event.actor)) {
      // an accepted file with no real author is not attributed to anybody
      if (event.accepted === true) {
        return { ok: false, code: SCORECARD_CODE.UNATTRIBUTED, taskID: event.taskID };
      }
      continue;
    }
    const loc = isCount(event.loc) ? event.loc || 0 : 0;
    toolFailures += Number.isSafeInteger(event.toolFailures) ? event.toolFailures : 0;
    reviewRounds += Number.isSafeInteger(event.reviewRounds) ? event.reviewRounds : 0;
    if (event.accepted === false && loc === 0) noCandidateAttempts += 1;

    if (event.kind === 'RESCUE') {
      deepseekRescueLOC += loc;
      rescuedTasks.add(event.taskID);
      continue;
    }

    const ornith = event.actor === 'ornith-a' || event.actor === 'ornith-b';
    if (!ornith) {
      // Work this author really produced is not invisible: dropping it made the ledger read
      // as if every accepted file came from an agent, which is exactly the flattery the
      // scorecard exists to prevent. It is counted, attributed, and never autonomous.
      if (event.kind === 'PRODUCTION') {
        deepseekAuthoredProductionLOC += loc;
        if (event.accepted === true && !producedBy.has(event.taskID)) {
          producedBy.set(event.taskID, 'deepseek');
        }
      }
      continue;
    }

    if (event.kind === 'PRODUCTION') ornithAuthoredProductionLOC += loc;
    if (event.kind === 'TEST') ornithAuthoredTestLOC += loc;
    // only an accepted production change counts as a verified task; an accepted test is its own ledger
    if (event.accepted === true && event.kind === 'PRODUCTION') {
      acceptedTasks.add(event.taskID);
      if (!producedBy.has(event.taskID)) producedBy.set(event.taskID, 'ornith');
    }
  }

  // a task with any rescue is a rescued task, even if an agent also contributed to it
  let autonomousVerifiedTasks = 0;
  for (const taskID of acceptedTasks) {
    if (!rescuedTasks.has(taskID)) autonomousVerifiedTasks += 1;
  }

  return {
    ok: true,
    code: SCORECARD_CODE.SCORECARD,
    ornithAuthoredProductionLOC,
    ornithAuthoredTestLOC,
    deepseekRescueLOC,
    deepseekAuthoredProductionLOC,
    autonomousVerifiedTasks,
    rescuedTasks: rescuedTasks.size,
    noCandidateAttempts,
    toolFailures,
    reviewRounds,
    files: [...producedBy.entries()].map(([taskID, author]) => ({ taskID, author })),
  };
}

module.exports = { buildScorecard, SCORECARD_CODE };
