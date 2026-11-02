"use strict";
// A journal that survives a restart when it is given a durable store, and behaves exactly like a Map
// when it is not. Every money or goods module keeps an "already done" record; process-local maps made
// those records a lie across a restart (measured 2026-11-01: a settled fill was paid twice, a
// purchase was debited twice).
//
// Fail-closed rule (independent review 2026-11-02): a store fault is never hidden. A journal that
// cannot be read must not start as an empty one (that is how a replay is paid twice), and a write the
// store did not accept must not stay in memory as if it were durable. Both cases throw an Error
// carrying a code: JOURNAL_UNREADABLE or JOURNAL_WRITE_FAILED.
//
// durable: { get(key), set(key, value), has?(key), delete?(key), entries?() }

function journalError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

class DurableMap extends Map {
  constructor(durable) {
    super();
    this.durable = durable && typeof durable.get === "function" && typeof durable.set === "function"
      ? durable
      : null;
    if (this.durable && typeof this.durable.entries === "function") {
      let rows;
      try {
        rows = this.durable.entries();
      } catch (error) {
        throw journalError("JOURNAL_UNREADABLE",
          "durable journal cannot be read: " + String((error && error.message) || error), error);
      }
      for (const entry of rows || []) {
        if (Array.isArray(entry) && entry.length === 2) super.set(entry[0], entry[1]);
      }
    }
  }

  // write-through: the store accepts the value before the map claims it
  set(key, value) {
    if (this.durable) {
      try {
        this.durable.set(key, value);
      } catch (error) {
        throw journalError("JOURNAL_WRITE_FAILED",
          "durable journal refused a write: " + String((error && error.message) || error), error);
      }
    }
    super.set(key, value);
    return this;
  }

  delete(key) {
    const had = super.has(key);
    if (this.durable && typeof this.durable.delete === "function") {
      try {
        this.durable.delete(key);
      } catch (error) {
        throw journalError("JOURNAL_WRITE_FAILED",
          "durable journal refused a delete: " + String((error && error.message) || error), error);
      }
    }
    return super.delete(key) || had;
  }

  has(key) {
    if (super.has(key)) return true;
    if (!this.durable) return false;
    try {
      if (typeof this.durable.has === "function") return this.durable.has(key) === true;
      return this.durable.get(key) !== undefined;
    } catch (error) {
      throw journalError("JOURNAL_UNREADABLE",
        "durable journal cannot be read: " + String((error && error.message) || error), error);
    }
  }

  get(key) {
    if (super.has(key)) return super.get(key);
    if (!this.durable) return undefined;
    try {
      return this.durable.get(key);
    } catch (error) {
      throw journalError("JOURNAL_UNREADABLE",
        "durable journal cannot be read: " + String((error && error.message) || error), error);
    }
  }
}

function createJournal(durable) {
  return new DurableMap(durable);
}

module.exports = { createJournal, DurableMap };
