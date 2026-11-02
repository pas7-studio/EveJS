"use strict";

var GAP_STATUS = {
  READY: "REACHABLE",
  MISSING: "MISSING_MODULE",
  BLOCKED: "BLOCKED",
  UNKNOWN: "UNKNOWN"
};

function buildGapReport(input) {
  if (!input || !Array.isArray(input.chain)) {
    return { stages: [], firstBlockingEdge: null, verdict: "UNKNOWN" };
  }

  var presentSet = {};
  for (var i = 0; i < input.present.length; i++) {
    presentSet[input.present[i]] = true;
  }

  var reachableSet = {};
  for (var j = 0; j < input.reachable.length; j++) {
    reachableSet[input.reachable[j]] = true;
  }

  var stages = [];
  for (var k = 0; k < input.chain.length; k++) {
    var stage = input.chain[k];
    if (!stage || !Array.isArray(stage.modules)) {
      continue;
    }

    var missing = [];
    var reachableCount = 0;
    for (var m = 0; m < stage.modules.length; m++) {
      var moduleId = stage.modules[m];
      if (!presentSet[moduleId]) {
        missing.push(moduleId);
      }
      if (reachableSet[moduleId]) {
        reachableCount++;
      }
    }

    var status;
    var unreachable = [];
    if (missing.length > 0) {
      status = GAP_STATUS.MISSING;
    } else {
      // a module that exists but cannot be reached from the entry point is NOT an executor: a stage
      // that silently loses half of its modules must block, not read READY
      for (var r = 0; r < stage.modules.length; r++) {
        var moduleId = stage.modules[r];
        if (presentSet[moduleId] && !reachableSet[moduleId]) {
          unreachable.push(moduleId);
        }
      }
      if (reachableCount === 0) {
        status = GAP_STATUS.BLOCKED;
      } else if (unreachable.length > 0) {
        status = GAP_STATUS.BLOCKED;
      } else {
        status = GAP_STATUS.READY;
      }
    }

    stages.push({
      id: stage.id,
      title: stage.title,
      status: status,
      missing: missing,
      unreachable: unreachable,
      reachableCount: reachableCount,
      moduleCount: stage.modules.length
    });
  }

  var firstBlockingEdge = null;
  for (var n = 0; n < stages.length; n++) {
    if (stages[n].status !== GAP_STATUS.READY) {
      firstBlockingEdge = stages[n].id;
      break;
    }
  }

  var verdict = firstBlockingEdge === null ? "READY" : "BLOCKED";

  return {
    stages: stages,
    firstBlockingEdge: firstBlockingEdge,
    verdict: verdict
  };
}

module.exports = { buildGapReport: buildGapReport, GAP_STATUS: GAP_STATUS };
