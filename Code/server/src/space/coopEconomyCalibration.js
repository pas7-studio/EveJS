'use strict';

var CALIBRATION_CODE = 'CALIBRATED';

function calibrate(opts) {
  opts = opts || {};
  var measured = opts.measured;
  var bounds = opts.bounds;

  if (!measured || typeof measured !== 'object') {
    return { ok: false, code: 'INVALID_MEASUREMENT' };
  }
  if (!bounds || typeof bounds !== 'object') {
    return { ok: false, code: 'INVALID_MEASUREMENT' };
  }

  var required = [
    'safetyStockTicks',
    'productionCadenceTicks',
    'offerRefreshTicks',
    'riskStep',
    'demandMultiplier'
  ];

  for (var i = 0; i < required.length; i++) {
    if (typeof measured[required[i]] !== 'number' || !isFinite(measured[required[i]])) {
      return { ok: false, code: 'INVALID_MEASUREMENT' };
    }
  }

  // demandMultiplier must be exactly 1.
  if (measured.demandMultiplier !== 1) {
    return { ok: false, code: 'DEMAND_PUMP_REFUSED' };
  }

  var clamped = {};
  var clampedNames = [];

  var pairs = [
    'safetyStockTicks',
    'productionCadenceTicks',
    'offerRefreshTicks',
    'riskStep'
  ];

  for (var j = 0; j < pairs.length; j++) {
    var name = pairs[j];
    var b = bounds[name];
    var val = measured[name];
    if (b && typeof b === 'object' && Array.isArray(b) && b.length === 2) {
      var lo = b[0];
      var hi = b[1];
      if (val < lo) {
        clamped[name] = lo;
        clampedNames.push(name);
      } else if (val > hi) {
        clamped[name] = hi;
        clampedNames.push(name);
      } else {
        clamped[name] = val;
      }
    } else {
      clamped[name] = val;
    }
  }

  return { ok: true, code: CALIBRATION_CODE, config: { ...clamped, demandMultiplier: 1 }, clamped: clampedNames };
}

module.exports = { calibrate: calibrate, CALIBRATION_CODE: CALIBRATION_CODE };
