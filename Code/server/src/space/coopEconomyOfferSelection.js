'use strict';

var OFFER_CODE = {
    INVALID_OFFERS: 'INVALID_OFFERS',
    ZERO_COST_TELEPORT: 'ZERO_COST_TELEPORT',
    PRICE_CAP: 'PRICE_CAP',
    INSUFFICIENT_CAPACITY: 'INSUFFICIENT_CAPACITY',
    REFRESH_TOO_SOON: 'REFRESH_TOO_SOON',
    INVALID_OFFER: 'INVALID_OFFER',
    SELECTED: 'SELECTED',
    NO_OFFER: 'NO_OFFER'
};

function classifyOffer(offer, ctx) {
    if (!offer || typeof offer !== 'object') {
        return 'INVALID_OFFER';
    }

    var priceCents = offer.priceCents;
    var etaSeconds = offer.etaSeconds;
    var capacity = offer.capacity;

    if (priceCents == null || etaSeconds == null || capacity == null) {
        return 'INVALID_OFFER';
    }

    if (priceCents <= 0 || etaSeconds <= 0) {
        return 'ZERO_COST_TELEPORT';
    }

    if (priceCents > ctx.maxPriceCents) {
        return 'PRICE_CAP';
    }

    if (capacity < ctx.requiredQuantity) {
        return 'INSUFFICIENT_CAPACITY';
    }

    if (offer.refreshTick != null && ctx.tick != null &&
        ctx.tick - offer.refreshTick < ctx.minRefreshTicks) {
        return 'REFRESH_TOO_SOON';
    }

    if (typeof offer.supplierID !== 'string' || offer.supplierID.length === 0) {
        return 'INVALID_OFFER';
    }

    return null;
}

function selectOffer(opts) {
    opts = opts || {};

    var offers = opts.offers;
    var npcOffer = opts.npcOffer;
    var requiredQuantity = opts.requiredQuantity;
    var tick = opts.tick;
    var minRefreshTicks = opts.minRefreshTicks;
    var maxPriceCents = opts.maxPriceCents;

    if (!Array.isArray(offers) ||
        typeof requiredQuantity !== 'number' ||
        typeof tick !== 'number' ||
        typeof minRefreshTicks !== 'number' ||
        typeof maxPriceCents !== 'number') {
        return { ok: false, code: OFFER_CODE.INVALID_OFFERS };
    }

    var ctx = {
        requiredQuantity: requiredQuantity,
        tick: tick,
        minRefreshTicks: minRefreshTicks,
        maxPriceCents: maxPriceCents
    };

    var candidates = [];
    for (var i = 0; i < offers.length; i++) {
        candidates.push(offers[i]);
    }
    if (npcOffer && typeof npcOffer === 'object') {
        candidates.push(npcOffer);
    }

    var rejected = [];
    for (var j = 0; j < candidates.length; j++) {
        var reason = classifyOffer(candidates[j], ctx);
        if (reason) {
            rejected.push({
                offerID: candidates[j].offerID,
                supplierID: candidates[j].supplierID,
                reason: reason
            });
        }
    }

    var best = null;
    for (var k = 0; k < candidates.length; k++) {
        var c = candidates[k];
        var reason = classifyOffer(c, ctx);
        if (reason) {
            continue;
        }
        if (best === null) {
            best = c;
            continue;
        }
        if (c.priceCents < best.priceCents) {
            best = c;
        } else if (c.priceCents === best.priceCents) {
            if (c.etaSeconds < best.etaSeconds) {
                best = c;
            } else if (c.etaSeconds === best.etaSeconds && c.offerID < best.offerID) {
                best = c;
            }
        }
    }

    if (best === null) {
        return { ok: false, code: OFFER_CODE.NO_OFFER, rejected: rejected };
    }

    return {
        ok: true,
        code: OFFER_CODE.SELECTED,
        offerID: best.offerID,
        supplierID: best.supplierID,
        priceCents: best.priceCents,
        etaSeconds: best.etaSeconds,
        rejected: rejected
    };
}

module.exports = { selectOffer: selectOffer, OFFER_CODE: OFFER_CODE };
