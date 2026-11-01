'use strict';

var SNAPSHOT_ERROR = {
    MISSING_TIME: 'MISSING_OBSERVED_AT',
    STALE: 'STALE',
    MISSING_SOURCE: 'MISSING_SOURCE',
    CONTRADICTORY: 'CONTRADICTORY',
    NEGATIVE_QUANTITY: 'NEGATIVE_QUANTITY'
};

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function collectQuantities(obj) {
    var out = [];
    if (isPlainObject(obj)) {
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
                out.push(obj[k]);
            }
        }
    }
    return out;
}

function validateSnapshot(snapshot, options) {
    options = options || {};
    var now = options.now === undefined ? Date.now() : options.now;

    var errors = {};

    // A missing or non-object snapshot is invalid, not a crash: this function is the gate every
    // caller trusts, so it must fail closed on anything it was handed.
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        errors[SNAPSHOT_ERROR.MISSING_TIME] = true;
        errors[SNAPSHOT_ERROR.MISSING_SOURCE] = true;
        errors[SNAPSHOT_ERROR.CONTRADICTORY] = true;
        return { ok: false, errors: Object.keys(errors).sort() };
    }

    // MISSING_TIME: observedAt is not a finite number.
    if (typeof snapshot.observedAt !== 'number' || !isFinite(snapshot.observedAt)) {
        errors[SNAPSHOT_ERROR.MISSING_TIME] = true;
    }

    // STALE: expiresAt is not a finite number or is <= now.
    if (
        typeof snapshot.expiresAt !== 'number' ||
        !isFinite(snapshot.expiresAt) ||
        snapshot.expiresAt <= now
    ) {
        errors[SNAPSHOT_ERROR.STALE] = true;
    }

    // MISSING_SOURCE: sources is not a non-empty array of strings.
    var sources = snapshot.sources;
    if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        !sources.every(function (s) { return typeof s === 'string'; })
    ) {
        errors[SNAPSHOT_ERROR.MISSING_SOURCE] = true;
    }

    // CONTRADICTORY: itemsByType and incomingByType are not plain objects, or the
    // same type key appears in both reservedByType and itemsByType with
    // reservedByType > itemsByType.
    var itemsByType = snapshot.itemsByType;
    var incomingByType = snapshot.incomingByType;
    var reservedByType = snapshot.reservedByType;
    if (!isPlainObject(itemsByType) || !isPlainObject(incomingByType)) {
        errors[SNAPSHOT_ERROR.CONTRADICTORY] = true;
    }
    if (isPlainObject(reservedByType) && isPlainObject(itemsByType)) {
        for (var t in reservedByType) {
            if (Object.prototype.hasOwnProperty.call(reservedByType, t)) {
                if (
                    Object.prototype.hasOwnProperty.call(itemsByType, t) &&
                    reservedByType[t] > itemsByType[t]
                ) {
                    errors[SNAPSHOT_ERROR.CONTRADICTORY] = true;
                    break;
                }
            }
        }
    }

    // NEGATIVE_QUANTITY: any quantity in itemsByType, incomingByType or
    // reservedByType is not a non-negative safe integer.
    var quantities = collectQuantities(itemsByType)
        .concat(collectQuantities(incomingByType))
        .concat(collectQuantities(reservedByType));
    for (var i = 0; i < quantities.length; i++) {
        var q = quantities[i];
        if (!Number.isSafeInteger(q) || q < 0) {
            errors[SNAPSHOT_ERROR.NEGATIVE_QUANTITY] = true;
            break;
        }
    }

    var errorCodes = Object.keys(errors);
    errorCodes.sort();

    return { ok: errorCodes.length === 0, errors: errorCodes };
}

function createSnapshot(spec, options) {
    var now = options && Number.isFinite(options.now) ? options.now : spec && spec.observedAt;
    var result = validateSnapshot(spec, { now: now });
    if (!result.ok) {
        throw new TypeError('invalid snapshot: ' + result.errors.join(','));
    }
    var out = Object.assign({}, spec, { version: 1 });
    return Object.freeze(out);
}

module.exports = {
    validateSnapshot: validateSnapshot,
    createSnapshot: createSnapshot,
    SNAPSHOT_ERROR: SNAPSHOT_ERROR
};


