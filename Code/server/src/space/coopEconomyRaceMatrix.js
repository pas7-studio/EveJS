'use strict';
const { createJournal } = require("./coopEconomyJournal");

// IE-062: a two-process race matrix over durable leases. Only one writer may ever hold a resource key at a
// time, a reclaim needs proof that the old owner is really gone, and a paused-but-alive owner is never
// stolen just because a wall clock moved.

const RACE_CODE = {
  ACQUIRED: 'ACQUIRED',
  LOCK_HELD: 'LOCK_HELD',
  RECLAIMED: 'RECLAIMED',
  RECLAIM_REFUSED: 'RECLAIM_REFUSED',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  RELEASED: 'RELEASED',
  ALIVE: 'ALIVE',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function createLeases({ ttlTicks = 30, graceTicks = 5, journal } = {}) {
  // a lease that forgets itself across a restart is not a fence
  const leases = createJournal(journal); // key -> { ownerID, acquiredTick, heartbeatTick }
  const history = [];

  function acquire(args) {
    const { key, ownerID, tick } = args || {};
    if (!isID(key) || !isID(ownerID) || !Number.isSafeInteger(tick) || tick < 0) {
      return { ok: false, code: RACE_CODE.INVALID_REQUEST };
    }
    const held = leases.get(key);
    if (held) {
      // the same owner re-acquiring is not a second writer
      if (held.ownerID === ownerID) {
        held.heartbeatTick = Math.max(held.heartbeatTick, tick);
        return { ok: true, code: RACE_CODE.ACQUIRED, key, ownerID, reentrant: true };
      }
      return { ok: false, code: RACE_CODE.LOCK_HELD, key, ownerID: held.ownerID };
    }
    leases.set(key, { ownerID, acquiredTick: tick, heartbeatTick: tick });
    history.push({ key, ownerID, tick, action: 'ACQUIRE' });
    return { ok: true, code: RACE_CODE.ACQUIRED, key, ownerID };
  }

  function heartbeat(args) {
    const { key, ownerID, tick } = args || {};
    const held = leases.get(key);
    if (!held || held.ownerID !== ownerID) return { ok: false, code: RACE_CODE.UNKNOWN_KEY };
    held.heartbeatTick = Math.max(held.heartbeatTick, tick);
    return { ok: true, code: RACE_CODE.ALIVE, key, heartbeatTick: held.heartbeatTick };
  }

  function reclaim(args) {
    const { key, ownerID, tick, evidence } = args || {};
    const held = leases.get(key);
    if (!held) return { ok: false, code: RACE_CODE.UNKNOWN_KEY };
    if (held.ownerID === ownerID) return { ok: true, code: RACE_CODE.ACQUIRED, key, ownerID, reentrant: true };
    // The grace period exists so a slow heartbeat is not punished, and sweep already honours it
    // (ttl + grace). reclaim used the bare ttl, so a recovered owner could lose the lease one tick
    // after the ttl while sweep still considered it alive: the grace was decorative. Both paths now
    // use the same deadline - a lease is dead only after ttl + grace.
    const alive = Number.isSafeInteger(held.heartbeatTick) && tick >= held.heartbeatTick &&
      tick - held.heartbeatTick <= ttlTicks + graceTicks;
    if (alive) {
      // a paused owner that still beats is alive: reclaim is refused, never granted silently
      return { ok: false, code: RACE_CODE.RECLAIM_REFUSED, key, ownerID: held.ownerID };
    }
    if (!isID(evidence)) return { ok: false, code: RACE_CODE.EVIDENCE_REQUIRED, key };
    leases.set(key, { ownerID, acquiredTick: tick, heartbeatTick: tick });
    history.push({ key, ownerID, tick, action: 'RECLAIM' });
    return { ok: true, code: RACE_CODE.RECLAIMED, key, ownerID };
  }

  function sweep({ tick } = {}) {
    if (!Number.isSafeInteger(tick) || tick < 0) return { ok: false, code: RACE_CODE.INVALID_REQUEST, released: [] };
    const released = [];
    for (const [key, held] of [...leases.entries()]) {
      if (tick - held.heartbeatTick > ttlTicks + graceTicks) {
        leases.delete(key);
        released.push({ key, ownerID: held.ownerID });
      }
    }
    return { ok: true, released };
  }

  function release({ key, ownerID } = {}) {
    const held = leases.get(key);
    if (!held || held.ownerID !== ownerID) return { ok: false, code: RACE_CODE.UNKNOWN_KEY };
    leases.delete(key);
    return { ok: true, code: RACE_CODE.RELEASED, key };
  }

  function holderOf(key) {
    const held = leases.get(key);
    return held ? held.ownerID : null;
  }

  function simulate({ writers, resourceKeys, tick = 0 } = {}) {
    const results = [];
    for (const key of Array.isArray(resourceKeys) ? resourceKeys : []) {
      let winners = 0;
      for (const writer of Array.isArray(writers) ? writers : []) {
        const outcome = acquire({ key, ownerID: writer, tick });
        if (outcome.ok) winners += 1;
        results.push({ key, writer, code: outcome.code });
      }
      if (winners > 1) {
        return { ok: false, code: 'MULTIPLE_WRITERS', key, winners, results };
      }
    }
    return { ok: true, code: 'SINGLE_WRITER', results };
  }

  return { acquire, heartbeat, reclaim, sweep, release, holderOf, simulate, history };
}

module.exports = { createLeases, RACE_CODE };
