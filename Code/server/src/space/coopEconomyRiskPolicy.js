'use strict';

function isNonEmpty(v) {
  return typeof v === 'string' && v.length > 0;
}

function createRiskPolicy(opts) {
  opts = opts || {};
  var minScore = opts.minScore;
  var maxScore = opts.maxScore;
  var step = opts.step;
  var cooldownTicks = opts.cooldownTicks;

  if (typeof minScore !== 'number' || isNaN(minScore)) minScore = 0;
  if (typeof maxScore !== 'number' || isNaN(maxScore)) maxScore = 10;
  if (typeof step !== 'number' || isNaN(step)) step = 1;
  if (typeof cooldownTicks !== 'number' || isNaN(cooldownTicks)) cooldownTicks = 60;

  var riskMap = new Map();
  var appliedIncidents = new Set();
  var lastIncidentTick = new Map();

  // IE-057: only routes the corporation really operates on are tracked; an incident that names an
  // untracked route is rejected rather than inventing a route.
  function register(args) {
    var routeID = args && args.routeID;
    if (!isNonEmpty(routeID)) return { ok: false, code: 'INVALID_INCIDENT' };
    if (!riskMap.has(routeID)) {
      var initial = args.riskScore;
      riskMap.set(routeID, typeof initial === 'number' && initial >= minScore && initial <= maxScore ? initial : minScore);
    }
    return { ok: true, code: 'REGISTERED', riskScore: riskMap.get(routeID) };
  }

  function apply(input) {
    var incidentID = input && input.incidentID;
    var routeID = input && input.routeID;
    var kind = input && input.kind;
    var receiptID = input && input.receiptID;
    var tick = input && input.tick;

    // 1. ids non-empty, kind LOSS/ATTACK, tick a non-negative safe integer
    if (
      !isNonEmpty(incidentID) ||
      !isNonEmpty(routeID) ||
      (kind !== 'LOSS' && kind !== 'ATTACK') ||
      typeof tick !== 'number' ||
      !Number.isSafeInteger(tick) ||
      tick < 0
    ) {
      return { ok: false, code: 'INVALID_INCIDENT' };
    }

    // 2. receiptID non-empty (authoritative evidence)
    if (!isNonEmpty(receiptID)) {
      return { ok: false, code: 'EVIDENCE_REQUIRED' };
    }

    // 3. same incidentID again -> never raises the score twice
    if (appliedIncidents.has(incidentID)) {
      return { ok: true, code: 'ALREADY_APPLIED', riskScore: riskMap.get(routeID) };
    }

    // 4. unknown routeID
    if (!riskMap.has(routeID)) {
      return { ok: false, code: 'UNKNOWN_ROUTE' };
    }

    // 5. raise the score by step, clamped to maxScore, bounded securityJobs
    var current = minScore;
    var prevTick = lastIncidentTick.get(routeID);
    if (prevTick !== undefined) current = riskMap.get(routeID);
    var newScore = Math.min(current + step, maxScore);

    var securityJobs;
    if (prevTick === undefined) {
      securityJobs = 1; // first incident on this route
    } else if (tick - prevTick < cooldownTicks) {
      securityJobs = 0; // another incident inside the same cooldown window
    } else {
      securityJobs = 1; // outside the window -> fresh response
    }

    riskMap.set(routeID, newScore);
    appliedIncidents.add(incidentID);
    lastIncidentTick.set(routeID, tick);

    return { ok: true, code: 'RISK_UPDATED', riskScore: newScore, securityJobs: securityJobs };
  }

  function riskOf(routeID) {
    if (routeID === undefined || routeID === null) return minScore;
    return riskMap.has(routeID) ? riskMap.get(routeID) : minScore;
  }

  return {
    register: register,
    apply: apply,
    riskOf: riskOf,
    riskMap: riskMap,
    appliedIncidents: appliedIncidents,
    lastIncidentTick: lastIncidentTick
  };
}

var RISK_CODE = {
  INVALID_INCIDENT: 'INVALID_INCIDENT',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  UNKNOWN_ROUTE: 'UNKNOWN_ROUTE',
  RISK_UPDATED: 'RISK_UPDATED'
};

module.exports = {
  createRiskPolicy: createRiskPolicy,
  RISK_CODE: RISK_CODE
};
