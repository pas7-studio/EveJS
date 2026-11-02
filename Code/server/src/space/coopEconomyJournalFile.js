"use strict";
// A file-backed journal for the modules that must not forget an obligation across a process
// restart. The interface is the one createJournal() expects: {get, set, has?, delete?, entries?}.
//
// It writes the whole file on every change (tmp + rename), which is what the shadow already does for
// its state: a crash either leaves the previous file or the new one, never a half-written one.
//
// Fail-closed rule (independent review 2026-11-02): a journal that cannot be parsed is not an empty
// journal, and a flush that failed is not a stored row. Both throw (JOURNAL_UNREADABLE /
// JOURNAL_WRITE_FAILED) and leave memory matching what the disk actually holds.

const fs = require("node:fs");
const path = require("node:path");

function journalError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function createFileJournal(file, options) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("createFileJournal: a file path is required");
  }
  const fsApi = (options && options.fs) || fs;
  const rows = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = fsApi.readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return; // no file yet is the normal first run
      throw journalError("JOURNAL_UNREADABLE",
        "journal cannot be read: " + String((error && error.message) || error), error);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // keep a forensic copy, then refuse: continuing with an empty map is how a settled fill is
      // paid a second time after a restart
      const broken = file + ".corrupt";
      try { fsApi.renameSync(file, broken); } catch (_e) { /* the original text stays in the error */ }
      throw journalError("JOURNAL_UNREADABLE",
        "journal is not valid JSON (copy kept at " + broken + "): " + String((error && error.message) || error), error);
    }
    if (!Array.isArray(parsed)) {
      throw journalError("JOURNAL_UNREADABLE", "journal is not an array of [key, value] pairs");
    }
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw journalError("JOURNAL_UNREADABLE", "journal contains a row that is not a [key, value] pair");
      }
      rows.set(entry[0], entry[1]);
    }
  }

  function flush(nextRows) {
    const body = JSON.stringify([...nextRows.entries()]);
    const tmp = file + ".tmp";
    try {
      const dir = path.dirname(file);
      if (dir && dir !== ".") fsApi.mkdirSync(dir, { recursive: true });
      fsApi.writeFileSync(tmp, body, "utf8");
      fsApi.renameSync(tmp, file);
    } catch (error) {
      throw journalError("JOURNAL_WRITE_FAILED",
        "journal could not be written: " + String((error && error.message) || error), error);
    }
  }

  return {
    get(key) { load(); return rows.get(key); },
    set(key, value) {
      load();
      const next = new Map(rows);
      next.set(key, value);
      flush(next);
      rows.set(key, value);
    },
    has(key) { load(); return rows.has(key); },
    delete(key) {
      load();
      if (!rows.has(key)) return false;
      const next = new Map(rows);
      next.delete(key);
      flush(next);
      rows.delete(key);
      return true;
    },
    entries() { load(); return [...rows.entries()]; },
    get size() { load(); return rows.size; },
  };
}

module.exports = { createFileJournal };
