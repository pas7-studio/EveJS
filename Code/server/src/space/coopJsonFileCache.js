// Small, boring JSON-file cache for the co-op runtime.
//
// Why: a tick phase that reads+parses the same JSON file on every tick is a
// measured lag source (the identity registry and the salvage witness manifests
// were both read from disk inside advance* phases). Node's fs cache does not
// help: readFileSync still copies bytes and JSON.parse still runs.
//
// Behaviour: the first read parses the file; later reads return the same object
// unless (mtimeMs, size) changed, so a rewritten file is seen immediately. The
// returned object is shared - callers must treat it as read-only, or ask for
// `clone: true` when they intend to mutate.
//
// No over-engineering on purpose: no background refresh, no watch, no TTL, no
// eviction. A file that disappears throws like a plain read would.

const fs = require('node:fs');

const entries = new Map();

function readJsonFile(file, options = {}) {
  const stat = fs.statSync(file);
  const hit = entries.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    if (options.maxBytes && stat.size > options.maxBytes) throw new Error('JSON_FILE_TOO_LARGE');
    return options.clone ? JSON.parse(JSON.stringify(hit.value)) : hit.value;
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (options.maxBytes && raw.length > options.maxBytes) throw new Error('JSON_FILE_TOO_LARGE');
  const value = JSON.parse(raw);
  entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return options.clone ? JSON.parse(JSON.stringify(value)) : value;
}

function forget(file) {
  if (file === undefined) entries.clear();
  else entries.delete(file);
}

module.exports = { readJsonFile, forget, size: () => entries.size };
