"use strict";
// One row written through coopAtomicNativeRows has TWO shapes:
//   * the durable SQLite row key is the whole string, e.g.
//     "coop-faction-war\u001fstate-v1";
//   * the in-memory GameStore cache nests it at the \u001f separator, so the
//     same row is reached with the JSON path "/coop-faction-war/state-v1".
// Reading the raw key with gameStore.read(table, "/"+KEY) therefore answers
// ENTRY_NOT_FOUND even though the row exists, and every consumer silently
// behaves as if the record were absent (that is exactly how the war battle
// director lost its war/fleet snapshot and never issued an order).
//
// This module is the single read-only conversion point. It never writes, never
// opens a transaction and never caches: a hot projectile path must stay cheap.
const SEP = "\u001f";

function cachePath(key) {
  if (typeof key !== "string" || !key.length) throw Error("NATIVE_ROW_KEY_REQUIRED");
  return "/" + key.split(SEP).join("/");
}

// Returns the row object, or null when neither shape holds a value. A validator
// that throws is propagated: a corrupt row must never look like a missing one.
function readRow(gameStore, table, key, validate) {
  if (typeof gameStore?.read !== "function" || typeof table !== "string") return null;
  for (const path of [cachePath(key), "/" + key]) {
    const read = gameStore.read(table, path);
    if (read?.success === true && read.data !== null && read.data !== undefined) {
      if (typeof validate === "function") validate(read.data);
      return read.data;
    }
  }
  return null;
}

module.exports = { SEP, cachePath, readRow };
