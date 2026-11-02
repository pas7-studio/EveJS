"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

var REASON = {
    OK: "OK",
    NO_STOCK: "NO_STOCK",
    INCOMING_ONLY: "INCOMING_ONLY"
};

function toZero(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0) {
        return 0;
    }
    return value;
}

function computeAvailable(state) {
    var onHand = toZero(state.onHand);
    var hardCommitted = toZero(state.hardCommitted);
    var softReserved = toZero(state.softReserved);
    var available = Math.max(0, onHand - hardCommitted - softReserved);
    var incomingVerified = toZero(state.incomingVerified);
    var projected = available + incomingVerified;

    var reason;
    if (available > 0) {
        reason = REASON.OK;
    }
    else if (available === 0 && incomingVerified > 0) {
        reason = REASON.INCOMING_ONLY;
    }
    else {
        reason = REASON.NO_STOCK;
    }

    return { available: available, projected: projected, reason: reason };
}

function availableToPromise(state) {
    return computeAvailable(state || {});
}

function canReserve(state, quantity) {
    if (
        typeof quantity !== "number" ||
        !isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(Math.trunc(quantity))
    ) {
        return false;
    }

    var result = computeAvailable(state);
    return quantity <= result.available;
}

exports.REASON = REASON;
exports.availableToPromise = availableToPromise;
exports.canReserve = canReserve;
