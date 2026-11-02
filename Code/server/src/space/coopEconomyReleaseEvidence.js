'use strict';

/**
 * coopEconomyReleaseEvidence
 *
 * Validates that a cooperative-economy release is ready to ship by checking
 * that the integrated/tested/deployed SHAs line up, that every required audit
 * passed with evidence, that an end-to-end verified client exists, that the
 * rollback posture is safe, that migrations are present (array, may be empty),
 * and that a reviewer has signed off against the integrated SHA.
 *
 * CommonJS, no external dependencies.
 */

var RELEASE_CODE = 'RELEASE_READY';

var AUDIT_NAMES = ['conservation', 'crash', 'race', 'soak', 'compat'];

function build(opts) {
  opts = opts || {};

  var integratedSHA = opts.integratedSHA;
  var testedSHA = opts.testedSHA;
  var deployedSHA = opts.deployedSHA;
  var audits = opts.audits;
  var client = opts.client;
  var rollback = opts.rollback;
  var migrations = opts.migrations;
  var reviewer = opts.reviewer;

  // 1. The integrated, tested and deployed SHAs must all be the same,
  //    non-empty string. The exact integrated SHA must equal the tested code.
  if (
    !integratedSHA ||
    !testedSHA ||
    !deployedSHA ||
    integratedSHA !== testedSHA ||
    integratedSHA !== deployedSHA
  ) {
    return { ok: false, code: 'SHA_MISMATCH' };
  }

  // 2. Every required audit must be present, marked ok, and carry non-empty
  //    evidence. A missing or failed audit fails the build.
  var missingAudits = [];
  for (var i = 0; i < AUDIT_NAMES.length; i++) {
    var name = AUDIT_NAMES[i];
    var audit = audits && audits[name];
    if (
      !audit ||
      !audit.ok ||
      !audit.evidence ||
      typeof audit.evidence !== 'string' ||
      audit.evidence.length === 0
    ) {
      missingAudits.push(name);
    }
  }
  if (missingAudits.length > 0) {
    return { ok: false, code: 'AUDIT_INCOMPLETE', missing: missingAudits };
  }

  // 3. A verified client must be present and explicitly E2E verified.
  //    A missing client is not a pass.
  if (
    !client ||
    !client.ok ||
    client.code !== 'E2E_VERIFIED' ||
    !client.buildID
  ) {
    return { ok: false, code: 'CLIENT_NOT_VERIFIED' };
  }

  // 4. Rollback must be tested and must not delete data.
  if (
    !rollback ||
    rollback.tested !== true ||
    rollback.deletesData !== false
  ) {
    return { ok: false, code: 'ROLLBACK_UNVERIFIED' };
  }

  // 5. Migrations must be an array (an empty array is acceptable).
  if (!Array.isArray(migrations)) {
    return { ok: false, code: 'MIGRATIONS_MISSING' };
  }

  // 6. A reviewer must have signed off against the integrated SHA.
  if (
    !reviewer ||
    reviewer.role !== 'REVIEWER' ||
    reviewer.sha !== integratedSHA
  ) {
    return { ok: false, code: 'SIGN_OFF_REQUIRED' };
  }

  // 7. Everything checks out.
  return {
    ok: true,
    code: RELEASE_CODE,
    integratedSHA: integratedSHA,
    audits: AUDIT_NAMES.slice(),
    clientBuildID: client.buildID,
    rollbackTo: integratedSHA,
    migrations: migrations,
    reviewerID: reviewer.reviewerID
  };
}

module.exports = { build: build, RELEASE_CODE: RELEASE_CODE };
