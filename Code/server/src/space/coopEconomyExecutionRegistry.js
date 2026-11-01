'use strict';

const REGISTRY_CODE = {
  OK: 'OK',
  ALREADY_OWNER: 'ALREADY_OWNER',
  INCOMPATIBLE_EXECUTORS: 'INCOMPATIBLE_EXECUTORS'
};

function createRegistry() {
  const map = new Map();

  function register(phase, owner) {
    if (
      typeof phase !== 'string' || phase.length === 0 ||
      typeof owner !== 'string' || owner.length === 0
    ) {
      return { ok: false, code: 'INCOMPATIBLE_EXECUTORS', conflict: null };
    }

    if (!map.has(phase)) {
      map.set(phase, owner);
      return { ok: true, code: 'OK', owner };
    }

    const current = map.get(phase);
    if (current === owner) {
      return { ok: true, code: 'ALREADY_OWNER', owner };
    }

    return {
      ok: false,
      code: 'INCOMPATIBLE_EXECUTORS',
      conflict: { phase, current, rejected: owner }
    };
  }

  function ownerOf(phase) {
    return map.has(phase) ? map.get(phase) : null;
  }

  function release(phase, owner) {
    if (!map.has(phase)) {
      return false;
    }
    if (map.get(phase) !== owner) {
      return false;
    }
    map.delete(phase);
    return true;
  }

  function phases() {
    return Array.from(map.keys()).sort();
  }

  return { register, ownerOf, release, phases };
}

module.exports = { createRegistry, REGISTRY_CODE };
