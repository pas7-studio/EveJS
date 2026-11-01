'use strict';

const DECISIONS = Object.freeze([
  {
    id: 'ADR-01',
    title: 'one execution scheduler',
    decision: 'one execution scheduler',
    status: 'DECIDED',
    evidence: ['coopLoopDriver.js returns DISABLED unless EVEJS_COOP_LOOP_DRIVER=1'],
    risk: 'P0',
  },
  {
    id: 'ADR-02',
    title: 'production via original GameStore/SDE kernel',
    decision: 'production via original GameStore/SDE kernel',
    status: 'DECIDED',
    evidence: ['coopAlifeNativeManufacturingRuntime.js declares supportsLiveRuntime:false'],
    risk: 'P0',
  },
  {
    id: 'ADR-03',
    title: 'cross-DB transaction or durable claim',
    decision: 'cross-DB transaction or durable claim',
    status: 'DECIDED',
    evidence: ['EVEJS_COOP_NATIVE_ATOMIC_ROWS read in 69 files'],
    risk: 'P0',
  },
  {
    id: 'ADR-04',
    title: 'existing Rust matching + native escrow',
    decision: 'existing Rust matching + native escrow',
    status: 'DECIDED',
    evidence: [],
    risk: 'P0',
  },
  {
    id: 'ADR-05',
    title: 'offline gameplay waits for native authority',
    decision: 'offline gameplay waits for native authority',
    status: 'DECIDED',
    evidence: [],
    risk: 'P0',
  },
  {
    id: 'ADR-06',
    title: 'funded contracts need escrow before OPEN',
    decision: 'funded contracts need escrow before OPEN',
    status: 'DECIDED',
    evidence: [],
    risk: 'P0',
  },
  {
    id: 'ADR-07',
    title: 'player UI through supported endpoints',
    decision: 'player UI through supported endpoints',
    status: 'OPEN',
    evidence: [],
    risk: 'P1',
  },
  {
    id: 'ADR-08',
    title: 'two corps, bounded pilots, one factory',
    decision: 'two corps, bounded pilots, one factory',
    status: 'DECIDED',
    evidence: [],
    risk: 'P1',
  },
  {
    id: 'ADR-09',
    title: 'demand from receipts with bounded EMA',
    decision: 'demand from receipts with bounded EMA',
    status: 'OPEN',
    evidence: [],
    risk: 'P1',
  },
  {
    id: 'ADR-10',
    title: 'distress: downsize, no bailout',
    decision: 'distress: downsize, no bailout',
    status: 'DECIDED',
    evidence: [],
    risk: 'P1',
  },
  {
    id: 'ADR-11',
    title: 'provenance after split/merge',
    decision: 'provenance after split/merge',
    status: 'OPEN',
    evidence: ['M002-B remains unapproved; depot header: COMMITTED is not station stock'],
    risk: 'P0',
  },
  {
    id: 'ADR-12',
    title: 'runtime opt-in OFF -> SHADOW -> LIVE',
    decision: 'runtime opt-in OFF -> SHADOW -> LIVE',
    status: 'DECIDED',
    evidence: [],
    risk: 'P0',
  },
]);

// A decision registry is read-only evidence: a frozen array alone still allows editing a record in
// place, which would let a later phase rewrite a P0 decision without a commit.
for (const decision of DECISIONS) {
  Object.freeze(decision);
  if (Array.isArray(decision.evidence)) Object.freeze(decision.evidence);
}

function blockingDecisions() {
  const ids = DECISIONS
    .filter((r) => r.status !== 'DECIDED' || (r.evidence && r.evidence.length === 0))
    .map((r) => r.id)
    .sort();
  return ids;
}

function isReadyToImplement() {
  for (const r of DECISIONS) {
    if (r.risk === 'P0') {
      if (r.status !== 'DECIDED' || (r.evidence && r.evidence.length === 0)) {
        return false;
      }
    }
  }
  return true;
}

module.exports = { DECISIONS, blockingDecisions, isReadyToImplement };
