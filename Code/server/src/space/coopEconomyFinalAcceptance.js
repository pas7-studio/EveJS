'use strict';

// IE-073: the final acceptance gate. Every gate must pass with real evidence, and PLAY promotion needs an
// explicit OWNER approval pinned to the integrated SHA. A reviewer PASS is necessary but never sufficient.

const REQUIRED_GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'];

const ACCEPTANCE_CODE = {
  PLAY_APPROVED: 'PLAY_APPROVED',
  NOT_PROMOTED: 'NOT_PROMOTED',
  OWNER_APPROVAL_REQUIRED: 'OWNER_APPROVAL_REQUIRED',
  GATE_INCOMPLETE: 'GATE_INCOMPLETE',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function evaluate(args) {
  const { gates, ownerApproval, reviewerApproval } = args || {};

  const missing = [];
  for (const gate of REQUIRED_GATES) {
    const entry = gates && gates[gate];
    if (!entry || entry.ok !== true || !isID(entry.evidence)) missing.push(gate);
  }
  if (missing.length > 0) {
    return { ok: false, code: ACCEPTANCE_CODE.GATE_INCOMPLETE, missing, readyForPlay: false };
  }

  const approval = ownerApproval || {};
  if (approval.role === 'REVIEWER' && approval.approved === true) {
    // a reviewer can sign the evidence, but only the owner may promote to PLAY
    return {
      ok: false,
      code: ACCEPTANCE_CODE.OWNER_APPROVAL_REQUIRED,
      readyForPlay: false,
      reviewerID: approval.approverID,
    };
  }
  if (approval.approved !== true || approval.role !== 'OWNER' || !isID(approval.approverID) || !isID(approval.sha)) {
    return { ok: false, code: ACCEPTANCE_CODE.NOT_PROMOTED, readyForPlay: false };
  }

  return {
    ok: true,
    code: ACCEPTANCE_CODE.PLAY_APPROVED,
    readyForPlay: true,
    approverID: approval.approverID,
    sha: approval.sha,
    gates: [...REQUIRED_GATES],
    reviewerID: reviewerApproval && reviewerApproval.reviewerID ? reviewerApproval.reviewerID : null,
  };
}

module.exports = { evaluate, REQUIRED_GATES, ACCEPTANCE_CODE };
