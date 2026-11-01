'use strict';

/**
 * assessLiveReadiness
 * -------------------
 * Determines whether a module is ready to run in a live runtime.
 *
 * Importing or requiring a module is NOT evidence of live readiness.
 * Only an explicit attestation can promote a module to live.
 *
 * @param {object} opts
 * @param {{id:string, supportsLiveRuntime:boolean}} [opts.binding]
 * @param {{id:string, reviewedBy:string, reviewSHA:string}} [opts.attestation]
 * @returns {{live:boolean, code:string, reason:string, attestation?:object}}
 */
function assessLiveReadiness(opts) {
  opts = opts || {};
  var binding = opts.binding || {};
  var attestation = opts.attestation || undefined;

  // Rule 1: a module that only supports a manual path is never promoted to live.
  if (binding.supportsLiveRuntime !== true) {
    return {
      live: false,
      code: 'MANUAL_ONLY',
      reason:
        'Module only supports a manual path; importing it does not promote it to live.'
    };
  }

  // Rule 2: attestation must exist, match the binding id, and carry both
  // non-empty string reviewedBy and reviewSHA fields.
  if (!attestation) {
    return {
      live: false,
      code: 'ATTESTATION_REQUIRED',
      reason:
        'Binding supports live runtime but no attestation was provided.'
    };
  }

  if (attestation.id !== binding.id) {
    return {
      live: false,
      code: 'ATTESTATION_REQUIRED',
      reason:
        'Attestation id does not match the binding id.'
    };
  }

  if (
    typeof attestation.reviewedBy !== 'string' ||
    attestation.reviewedBy.length === 0 ||
    typeof attestation.reviewSHA !== 'string' ||
    attestation.reviewSHA.length === 0
  ) {
    return {
      live: false,
      code: 'ATTESTATION_REQUIRED',
      reason:
        'Attestation is missing a non-empty reviewedBy and/or reviewSHA string.'
    };
  }

  // Rule 3: fully attested -> live.
  return {
    live: true,
    code: 'LIVE_ATTESTED',
    reason:
      'Binding supports live runtime and attestation matches and is complete.',
    attestation: {
      reviewedBy: attestation.reviewedBy,
      reviewSHA: attestation.reviewSHA
    }
  };
}

module.exports = {
  assessLiveReadiness: assessLiveReadiness
};
