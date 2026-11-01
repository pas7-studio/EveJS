"use strict";
// A file-backed journal for the modules that must not forget an obligation across a process
// restart. The interface is the one createJournal() expects: {get, set, has?, delete?, entries?}.
//
// It writes the whole file on every change (tmp + rename), which is what the shadow already does for
// its state: a crash either leaves the previous file or the new one, never a half-written one.

const fs = require("node:fs");
const path = require("node:path");

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
      return; // no file yet is the normal first run
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // an unreadable journal must not be silently treated as empty: it must be visible
      const broken = file + ".corrupt";
      try { fsApi.renameSync(file, broken); } catch (_e) { /* leave it */ }
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (Array.isArray(entry) && entry.length === 2) rows.set(entry[0], entry[1]);
    }
  }

  function flush() {
    const body = JSON.stringify([...rows.entries()]);
    const tmp = file + ".tmp";
    try {
      const dir = path.dirname(file);
      if (dir && dir !== ".") fsApi.mkdirSync(dir, { recursive: true });
      fsApi.writeFileSync(tmp, body, "utf8");
      fsApi.renameSync(tmp, file);
    } catch (error) {
      // a journal that cannot write must not take the economy down with it
    }
  }

  return {
    get(key) { load(); return rows.get(key); },
    set(key, value) { load(); rows.set(key, value); flush(); },
    has(key) { load(); return rows.has(key); },
    delete(key) { load(); const removed = rows.delete(key); if (removed) flush(); return removed; },
    entries() { load(); return [...rows.entries()]; },
    get size() { load(); return rows.size; },
  };
}

module.exports = { createFileJournal };
