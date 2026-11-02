'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var UNKNOWN = 'UNKNOWN';
var UNAVAILABLE = 'UNAVAILABLE';

function _toId(source) {
  var id = source && source.id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return id;
}

function _readStatus(read) {
  if (typeof read !== 'function') {
    return { status: UNAVAILABLE };
  }
  try {
    var value = read();
    return { status: 'OK', value: value };
  } catch (err) {
    return { status: UNKNOWN, error: String(err && err.message ? err.message : err) };
  }
}

function recordBaseline(opts) {
  opts = opts || {};
  var sources = opts.sources || [];
  var clock = typeof opts.clock === 'function' ? opts.clock : Date.now;

  var entries = [];
  var unknown = [];
  var unavailable = [];

  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var id = _toId(source);
    if (id === null) {
      continue;
    }
    var result = _readStatus(source.read);
    var entry = { id: id };
    if (result.status === UNAVAILABLE) {
      entry.status = UNAVAILABLE;
      unavailable.push(id);
    } else if (result.status === UNKNOWN) {
      entry.status = UNKNOWN;
      entry.error = result.error;
      unknown.push(id);
    } else {
      entry.status = 'OK';
      entry.value = result.value;
    }
    entries.push(entry);
  }

  return {
    recordedAt: clock(),
    sources: entries,
    ok: unknown.length === 0 && unavailable.length === 0,
    unknown: unknown,
    unavailable: unavailable
  };
}

function _lookup(baseline) {
  var map = {};
  var sources = baseline && baseline.sources;
  if (sources) {
    for (var i = 0; i < sources.length; i++) {
      var entry = sources[i];
      if (entry && typeof entry.id === 'string' && entry.id.length > 0) {
        map[entry.id] = entry;
      }
    }
  }
  return map;
}

function _valuesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
      return false;
    }
  }
  return false;
}

function compareBaselines(before, after) {
  before = before || {};
  after = after || {};
  var beforeMap = _lookup(before);
  var afterMap = _lookup(after);

  var ids = [];
  var seen = {};
  Object.keys(beforeMap).forEach(function (id) {
    if (!seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  });
  Object.keys(afterMap).forEach(function (id) {
    if (!seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  });

  var entries = [];
  var hasUnknown = false;

  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var b = beforeMap[id];
    var a = afterMap[id];
    var entry = { id: id, from: null, to: null };

    if (!b || !a) {
      entry.status = UNKNOWN;
      hasUnknown = true;
    } else if (b.status === UNKNOWN || b.status === UNAVAILABLE || a.status === UNKNOWN || a.status === UNAVAILABLE) {
      entry.status = UNKNOWN;
      hasUnknown = true;
    } else if (_valuesEqual(b.value, a.value)) {
      entry.status = 'UNCHANGED';
    } else {
      entry.status = 'CHANGED';
    }

    if (b && b.value !== undefined && b.value !== null) {
      entry.from = b.value;
    }
    if (a && a.value !== undefined && a.value !== null) {
      entry.to = a.value;
    }

    entries.push(entry);
  }

  return {
    ok: !hasUnknown,
    entries: entries
  };
}

exports.UNKNOWN = UNKNOWN;
exports.UNAVAILABLE = UNAVAILABLE;
exports.recordBaseline = recordBaseline;
exports.compareBaselines = compareBaselines;
