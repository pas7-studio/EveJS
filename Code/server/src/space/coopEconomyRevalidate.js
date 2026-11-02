'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

var DEFAULT_FIELDS = ["owner", "location", "version", "walletCents", "hullID"];

var CODES = {
    owner: "OWNER_CHANGED",
    location: "LOCATION_CHANGED",
    version: "VERSION_CHANGED",
    walletCents: "WALLET_CHANGED",
    hullID: "HULL_CHANGED"
};

function isMissing(v) {
    return v === void 0;
}

function revalidate(_ref) {
    var input = isMissing(_ref) ? {} : _ref;
    var before = input.before;
    var after = input.after;
    var fields = input.fields;

    // A caller that could not read one side of the comparison has NOT proved the state is
    // unchanged. Anything that is not an object is treated as a missing side (every field
    // changed) and a field list that is not an array falls back to the full list, so the gate
    // fails closed instead of crashing a guard that trusts it.
    var list = Array.isArray(fields) ? fields : DEFAULT_FIELDS;
    var beforeMissing = typeof before !== "object" || before === null;
    var afterMissing = typeof after !== "object" || after === null;

    var changed = [];
    for (var i = 0; i < list.length; i++) {
        var name = list[i];
        var code = CODES[name] || "FIELD_CHANGED";
        if (beforeMissing || afterMissing || before[name] !== after[name]) {
            changed.push(name);
        }
    }

    changed.sort();
    var codes = changed.map(function (n) { return CODES[n] || "FIELD_CHANGED"; });
    codes.sort();

    return { ok: changed.length === 0, changed: changed, codes: codes };
}

exports.revalidate = revalidate;
