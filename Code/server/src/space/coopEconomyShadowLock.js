"use strict";
// A cross-process lock for the shadow's state file.
//
// Measured live 2026-11-02: two writers (the server and a reconcile/repair tool) both read the file,
// both merged into their own memory, and the second rename erased the first writer's receipts. The
// merge in coopEconomyV2 makes the file append-only within one writer; only a lock makes it
// append-only across writers.
//
// The lock is a file created with O_EXCL so the kernel decides the race, not the processes. A lock is
// stale only when its owner is gone: a dead pid, or an `at` timestamp older than staleMs. A live pid
// is never stolen, whatever the age, because a slow writer is still a writer.

const fs = require("node:fs");

function read(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile + ".lock", "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { pid: Number(parsed.pid) || 0, at: Number(parsed.at) || 0 };
  } catch (_error) {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours; ESRCH means it is gone
    return !!(error && error.code === "EPERM");
  }
}

function isStale(holder) {
  if (!holder) return true;                       // unreadable lock: the writer is gone
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) return true;
  // a live pid keeps its lock whatever its age: a slow writer is still a writer. A dead pid is
  // stale immediately, which is the only case that can leave a lock behind after a crash.
  return !isAlive(holder.pid);
}

function acquire(stateFile, options) {
  const staleMs = Number(options && options.staleMs) > 0 ? Number(options.staleMs) : 30000;
  const lockPath = stateFile + ".lock";
  const noop = { ok: false, code: "LOCK_ERROR", release() {} };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return { ...noop, error: String((error && error.message) || error) };
      }
      const holder = read(stateFile);
      if (!isStale(holder)) {
        return { ok: false, code: "LOCK_BUSY", holders: holder, release() {} };
      }
      try { fs.unlinkSync(lockPath); } catch (_e) { /* another writer won the takeover */ }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
    let released = false;
    return {
      ok: true,
      code: "LOCKED",
      holders: { pid: process.pid, at: Date.now() },
      release() {
        if (released) return;
        released = true;
        const holder = read(stateFile);
        // never delete a lock another writer acquired after a stale takeover
        if (holder && holder.pid === process.pid) {
          try { fs.unlinkSync(lockPath); } catch (_e) { /* already gone */ }
        }
      },
    };
  }
  return { ok: false, code: "LOCK_BUSY", holders: read(stateFile), release() {} };
}

module.exports = { acquire, read };

