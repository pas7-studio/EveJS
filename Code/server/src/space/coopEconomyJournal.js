"use strict";
// A journal that survives a restart when it is given a durable store, and behaves exactly like a Map
// when it is not. Every money or goods module keeps an "already done" record; process-local maps made
// those records a lie across a restart (measured 2026-11-01: a settled fill was paid twice, a
// purchase was debited twice).
//
// durable: { get(key), set(key, value), has?(key), delete?(key), entries?() }
// The constructor loads what the store already knows, so a replay after a restart sees it.

class DurableMap extends Map {
  constructor(durable) {
    super();
    this.durable = durable && typeof durable.get === "function" && typeof durable.set === "function"
      ? durable
      : null;
    if (this.durable && typeof this.durable.entries === "function") {
      try {
        for (const entry of this.durable.entries()) {
          if (Array.isArray(entry) && entry.length === 2) super.set(entry[0], entry[1]);
        }
      } catch (_error) {
        // an unreadable store must not stop a module from working; it only loses durability
      }
    }
  }

  set(key, value) {
    super.set(key, value);
    if (this.durable) {
      try { this.durable.set(key, value); } catch (_error) { /* keep the in-memory record */ }
    }
    return this;
  }

  delete(key) {
    const removed = super.delete(key);
    if (this.durable && typeof this.durable.delete === "function") {
      try { this.durable.delete(key); } catch (_error) { /* ignore */ }
    }
    return removed;
  }

  has(key) {
    if (super.has(key)) return true;
    if (!this.durable) return false;
    if (typeof this.durable.has === "function") return this.durable.has(key) === true;
    try { return this.durable.get(key) !== undefined; } catch (_error) { return false; }
  }

  get(key) {
    if (super.has(key)) return super.get(key);
    if (!this.durable) return undefined;
    try { return this.durable.get(key); } catch (_error) { return undefined; }
  }
}

function createJournal(durable) {
  return new DurableMap(durable);
}

module.exports = { createJournal, DurableMap };
