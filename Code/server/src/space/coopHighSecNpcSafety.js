"use strict";
// High-sec is protected space in the real game.
//
// Vanilla EveJS treats every NPC as hostile to every player hull, so the living-world pirate pilots
// opened fire on a Venture in Jita (0.94) and killed it (killmail 173, 2026-10-30 19:4x: corps
// 1000134/1000138, 1142 damage). A real pirate never does that outside low-sec/exceptions - CONCORD
// exists precisely to make high-sec safe.
//
// This is a narrow block: only NPC -> player aggression, only at security >= 0.45, and it always
// yields to real aggression:
//   * the player shot that NPC first within the retaliation window,
//   * the player is an enemy militia hull in an active faction war.
// NPC vs NPC, low-sec and null-sec keep the native behaviour untouched.
const HIGHSEC_MIN_SECURITY = 0.45;
const RETALIATION_WINDOW_MS = 5 * 60 * 1000;

function enabled(env = process.env) {
  return String(env.EVEJS_COOP_HIGHSEC_NPC_SAFETY || "1") !== "0";
}

function isHighSecurity(security) {
  const value = Number(security);
  return Number.isFinite(value) && value >= HIGHSEC_MIN_SECURITY;
}

// Pure decision so the rule can be tested without a scene.
function decide({
  security,
  aggressedAtMs = 0,
  aggressorIsTarget = false,
  enemyMilitia = false,
  nowMs = Date.now(),
  env = process.env,
} = {}) {
  if (!enabled(env)) return { blocked: false, reason: "DISABLED" };
  if (!isHighSecurity(security)) return { blocked: false, reason: "NOT_HIGHSEC" };
  if (enemyMilitia === true) return { blocked: false, reason: "ENEMY_MILITIA" };
  const age = Number(nowMs) - Number(aggressedAtMs || 0);
  if (aggressorIsTarget === true && Number.isFinite(age) && age >= 0 && age <= RETALIATION_WINDOW_MS) {
    return { blocked: false, reason: "RETALIATION" };
  }
  return { blocked: true, reason: "HIGHSEC_SAFE" };
}

function systemSecurityFor(systemID) {
  try {
    const worldData = require("./worldData");
    const record = worldData.getSolarSystemByID(Math.max(0, Number(systemID) || 0));
    if (!record) return null;
    const value = Number(record.securityStatus ?? record.security);
    return Number.isFinite(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function targetCharacterIDOf(target) {
  if (!target) return 0;
  const fromSession = Number(target.session && target.session.characterID) || 0;
  if (fromSession > 0) return fromSession;
  return Number(target.characterID || target.pilotCharacterID || 0) || 0;
}

// Scene-facing wrapper: true means "treat as friendly, do not open fire".
function blocksAggression(attacker, target, options = {}) {
  const env = options.env || process.env;
  if (!enabled(env)) return false;
  if (targetCharacterIDOf(target) <= 0) return false;

  let controller = null;
  try {
    const registry = require("./npc/npcRegistry");
    controller = registry.getControllerByEntityID(Number(attacker && attacker.itemID) || 0) || null;
  } catch (_error) {
    controller = null;
  }
  if (!controller) return false;

  const security = systemSecurityFor(controller.systemID);
  if (security === null) return false;

  let enemyMilitia = false;
  try {
    const verdict = require("./coopMilitiaWarPlayer").npcPlayerVerdict(attacker, target);
    enemyMilitia = Boolean(verdict && verdict.status === "ENEMY_MILITIA");
  } catch (_error) {
    enemyMilitia = false;
  }

  return decide({
    security,
    aggressedAtMs: Number(controller.lastAggressedAtMs) || 0,
    aggressorIsTarget: Number(controller.lastAggressorID) === (Number(target && target.itemID) || 0),
    enemyMilitia,
    nowMs: options.nowMs || Date.now(),
    env,
  }).blocked;
}

module.exports = {
  HIGHSEC_MIN_SECURITY,
  RETALIATION_WINDOW_MS,
  blocksAggression,
  decide,
  enabled,
  isHighSecurity,
  systemSecurityFor,
  targetCharacterIDOf,
};
