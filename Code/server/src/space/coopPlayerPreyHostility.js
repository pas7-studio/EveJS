"use strict";
// EVEJS_COOP_PIRATE_PREY_PLAYERS=1: the one player-facing hostility rule in this world.
//
// The stock behaviour loop answers "is this target friendly?" and hard-codes npc -> player as
// friendly (`sourceClass === "npc" ? targetClass === "npc" : false`). That is correct for the stock
// world and wrong for a co-op world where a pirate is really ordered to hunt a player: measured
// 2026-10-31 18:49 in Jita, three pirates with real attack orders sat at 207 m in mode STOP with
// zero damage while the player destroyed them one by one.
//
// This module answers only that question, and only for two honest cases:
//   * the hull holds a real native attack order on this exact player,
//   * or the player shot this hull within the retaliation window.
// High-sec safety keeps the first word: if it still protects the player hull, nothing here overrides
// it, so a pirate does not open fire in high sec on a player who has done nothing.
const enabled = env => String((env && env.EVEJS_COOP_PIRATE_PREY_PLAYERS) || "") === "1";
const pos = value => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const RETALIATION_MS = 5 * 60 * 1000;

function playerCharacterIDOf(target) {
  return pos(target && target.session && target.session.characterID);
}

function allowsPlayerPrey(source, target, options = {}) {
  const env = options.env || process.env;
  if (!enabled(env)) return false;
  const attackerID = pos(source && source.itemID);
  const targetID = pos(target && target.itemID);
  const note = (verdict, detail) => {
    if (options.probe === false) return;
    try {
      require("./coopRuntimeProbe").observe("coop-player-prey-decision", null, null, {
        attackerID, targetID, verdict, ...detail,
      });
    } catch (_error) { /* a probe must never change the decision */ }
  };
  if (!attackerID || !targetID || attackerID === targetID) return false;
  // Only a real player hull is eligible: an NPC never becomes a "player" through this rule.
  if (target.nativeNpc === true) return false;
  if (!playerCharacterIDOf(target)) return false;

  let controller = null;
  try {
    const registry = options.registry || require("./npc/npcRegistry");
    controller = registry.getControllerByEntityID(attackerID) || null;
  } catch (_error) {
    note(false, {reason: "NO_CONTROLLER_LOOKUP"});
    return false;
  }
  if (!controller) {
    note(false, {reason: "NOT_AN_NPC"});
    return false;
  }

  // High-sec safety is a verdict, not a suggestion: if it still protects this hull, the answer stays
  // "friendly" and the stock loop keeps the player safe.
  let highSecBlocked = false;
  try {
    const safety = options.safety || require("./coopHighSecNpcSafety");
    highSecBlocked = safety.blocksAggression(source, target, { env }) === true;
  } catch (_error) {
    note(false, {reason: "SAFETY_UNAVAILABLE"});
    return false;
  }

  const order = controller.manualOrder;
  const ordered = Boolean(order) &&
    String(order.type || "").toLowerCase() === "attack" &&
    pos(order.targetID) === targetID;
  const nowMs = Number(options.nowMs) || Date.now();
  const aggressedAt = Number(controller.lastAggressedAtMs) || 0;
  const retaliating = pos(controller.lastAggressorID) === targetID && aggressedAt > 0 &&
    nowMs >= aggressedAt && nowMs - aggressedAt <= RETALIATION_MS;
  const hostile = !highSecBlocked && (ordered || retaliating);
  note(hostile, {ordered, retaliating, highSecBlocked,
    aggressorID: pos(controller.lastAggressorID), aggressedAgeMs: aggressedAt ? nowMs - aggressedAt : 0});
  return hostile;
}

module.exports = { allowsPlayerPrey, enabled, playerCharacterIDOf, RETALIATION_MS };
