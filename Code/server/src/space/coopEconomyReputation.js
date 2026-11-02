'use strict';
const { createJournal } = require("./coopEconomyJournal");

function createReputation(opts) {
  opts = opts || {};
  var maxScore = opts.maxScore !== undefined ? opts.maxScore : 100;

  const durable = opts && opts.journal;
  const namespaced = (prefix) => {
    if (!durable) return undefined;
    return {
      get: (k) => durable.get(prefix + k),
      set: (k, v) => durable.set(prefix + k, v),
      has: (k) => (typeof durable.has === "function" ? durable.has(prefix + k) : durable.get(prefix + k) !== undefined),
      delete: (k) => (typeof durable.delete === "function" ? durable.delete(prefix + k) : undefined),
      entries: () => (typeof durable.entries === "function"
        ? [...durable.entries()].filter((e) => String(e[0]).startsWith(prefix))
            .map((e) => [String(e[0]).slice(prefix.length), e[1]])
        : []),
    };
  };
  var records = createJournal(namespaced("record:"));
  var idSet = new Set();
  // the journal already knows the recorded contracts; the fast set must start from it, or a restart
  // re-records the same contract and inflates the score
  records.forEach(function (_entry, idKey) { idSet.add(idKey); });
  var scores = createJournal(namespaced("score:"));

  function isSafePositiveInt(n) {
    return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
  }

  function record(input) {
    if (!input) {
      return { ok: false, code: 'INVALID_RECORD' };
    }

    var playerID = input.playerID;
    var contractID = input.contractID;
    var outcome = input.outcome;
    var receiptID = input.receiptID;
    var selfDealing = input.selfDealing;
    var cancelled = input.cancelled;
    var reason = input.reason;

    if (
      typeof playerID !== 'string' || playerID.length === 0 ||
      typeof contractID !== 'string' || contractID.length === 0 ||
      !isSafePositiveInt(maxScore)
    ) {
      return { ok: false, code: 'INVALID_RECORD' };
    }

    var idKey = playerID + '|' + contractID;
    if (idSet.has(idKey)) {
      return { ok: true, code: 'ALREADY_RECORDED', score: score(playerID) };
    }

    if (selfDealing === true) {
      return { ok: false, code: 'NOT_ELIGIBLE' };
    }

    if (cancelled === true) {
      return { ok: false, code: 'NOT_ELIGIBLE' };
    }

    if (outcome === 'SUCCESS') {
      if (typeof receiptID !== 'string' || receiptID.length === 0) {
        return { ok: false, code: 'EVIDENCE_REQUIRED' };
      }
      var newScore = Math.min(maxScore, (score(playerID) || 0) + 1);
      records.set(idKey, { playerID: playerID, contractID: contractID, outcome: outcome, score: newScore });
      idSet.add(idKey);
      scores.set(playerID, newScore);
      return { ok: true, code: 'RECORDED', score: newScore };
    }

    if (outcome === 'FAILURE') {
      if (typeof receiptID !== 'string' || receiptID.length === 0 || typeof reason !== 'string' || reason.length === 0) {
        return { ok: false, code: 'EVIDENCE_REQUIRED' };
      }
      var current = score(playerID) || 0;
      var newScore = Math.max(0, current - 1);
      records.set(idKey, { playerID: playerID, contractID: contractID, outcome: outcome, score: newScore });
      idSet.add(idKey);
      scores.set(playerID, newScore);
      return { ok: true, code: 'RECORDED', score: newScore };
    }

    return { ok: false, code: 'INVALID_RECORD' };
  }

  function score(playerID) {
    if (typeof playerID !== 'string' || playerID.length === 0) {
      return 0;
    }
    return scores.get(playerID) || 0;
  }

  function entries() {
    var result = [];
    records.forEach(function (entry, idKey) {
      var parts = idKey.split('|');
      result.push({
        playerID: parts[0],
        contractID: parts[1],
        outcome: entry.outcome
      });
    });
    result.sort(function (a, b) {
      if (a.playerID < b.playerID) return -1;
      if (a.playerID > b.playerID) return 1;
      if (a.contractID < b.contractID) return -1;
      if (a.contractID > b.contractID) return 1;
      return 0;
    });
    return result;
  }

  return {
    record: record,
    score: score,
    entries: entries
  };
}

var REPUTATION_CODE = {
  INVALID_RECORD: 'INVALID_RECORD',
  ALREADY_RECORDED: 'ALREADY_RECORDED',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  RECORDED: 'RECORDED'
};

module.exports = {
  createReputation: createReputation,
  REPUTATION_CODE: REPUTATION_CODE
};
