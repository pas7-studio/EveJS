"use strict";
// Who really attacked a native NPC, and when.
//
// EveJS does not always record a player as the controller's last aggressor, so
// self-defence could silently never happen. The killmail tracker does report
// applied damage together with a unique live session, so that verified receipt is
// the honest source. This ledger keeps the last verified attack per victim for a
// short window; it never accepts a client claim, a chat message or a guess.
const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

const DEFAULT_WINDOW_MS = 120000;
const MAX_ENTRIES = 2000;

function createAggressionLedger({
  windowMs = DEFAULT_WINDOW_MS,
  maxEntries = MAX_ENTRIES,
  clock = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 600000)
    throw Error("AGGRESSION_WINDOW_INVALID");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000)
    throw Error("AGGRESSION_CAP_INVALID");
  if (typeof clock !== "function") throw Error("AGGRESSION_CLOCK_REQUIRED");
  const entries = new Map();
  const keyFor = (systemID, victimEntityID) => systemID + ":" + victimEntityID;

  function evict(now) {
    for (const [key, record] of entries) {
      if (now - record.atMs > windowMs) entries.delete(key);
    }
    // Oldest first: Map preserves insertion order, and a re-note replaces the
    // value without moving the key, so expired keys are already gone above.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function note({ systemID, victimEntityID, attackerShipID, characterID, atMs } = {}) {
    const system = num(systemID);
    const victim = num(victimEntityID);
    const ship = num(attackerShipID);
    const character = num(characterID);
    const provided = atMs !== undefined && atMs !== null;
    const at = provided ? num(atMs) : num(clock());
    if (!pos(system) || !pos(victim) || !pos(ship) || !pos(character) ||
      ship === victim || !Number.isSafeInteger(at) || at <= 0)
      return { status: "REFUSED", reason: "INVALID_AGGRESSION" };
    entries.delete(keyFor(system, victim));
    entries.set(keyFor(system, victim), {
      systemID: system,
      victimEntityID: victim,
      attackerShipID: ship,
      characterID: character,
      atMs: at,
    });
    evict(at);
    return {
      status: "RECORDED", systemID: system, victimEntityID: victim,
      attackerShipID: ship, characterID: character, atMs: at,
    };
  }

  // A record is only usable inside its window and never from the future.
  function lastFor({ systemID, victimEntityID, nowMs } = {}) {
    const system = num(systemID);
    const victim = num(victimEntityID);
    if (!pos(system) || !pos(victim)) return null;
    const record = entries.get(keyFor(system, victim));
    if (!record) return null;
    const now = num(nowMs) > 0 ? num(nowMs) : num(clock());
    if (!Number.isSafeInteger(now) || now < record.atMs || now - record.atMs > windowMs) return null;
    return Object.assign({}, record);
  }

  return { note, lastFor, size: () => entries.size, windowMs };
}

// One process-wide ledger: the damage witness writes, the tactics director reads.
let shared = null;
function getSharedLedger() {
  if (!shared) shared = createAggressionLedger();
  return shared;
}

module.exports = {
  DEFAULT_WINDOW_MS, MAX_ENTRIES, createAggressionLedger, getSharedLedger,
};
