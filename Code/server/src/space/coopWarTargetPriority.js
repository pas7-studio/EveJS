"use strict";
// FW-117: who shoots whom, by ROLE.
//
// MEASURED on the play stack 2026-10-31: a five-hull squad-lead formation fielded tackle,
// anti-tackle, brawler, EWAR and logistics, and every one of them shot the NEAREST enemy -
// so the destroyer built to kill tackle, the EWAR ship and the remote-repair frigate all
// behaved like a brawler. The roles existed in the fitting and nowhere in the fight.
//
// This module answers one question and nothing else: for an attacker of a given role, how
// much is each enemy role worth shooting first? It is pure, deterministic, and an unknown
// role (or no role at all) scores 0 for everybody, which reproduces the old nearest-first
// order exactly - a fleet without roles never changes behaviour because of this file.
const PRIORITY = Object.freeze({
  // A destroyer exists to remove the enemy's tackle, then its support.
  "anti-tackle": Object.freeze({ tackle: 4, ewar: 3, logistics: 2 }),
  // EWAR removes the enemy's ability to repair and to see, before trading shots.
  ewar: Object.freeze({ logistics: 4, ewar: 3, tackle: 2 }),
  // Tackle fights tackle: whoever holds the other side's point wins the fight.
  tackle: Object.freeze({ tackle: 3, ewar: 1 }),
  // A sniper removes the biggest hull it can reach.
  sniper: Object.freeze({ heavy: 3, sniper: 2, brawler: 1 }),
  heavy: Object.freeze({ brawler: 2, heavy: 1 }),
  brawler: Object.freeze({ tackle: 1 }),
  logistics: Object.freeze({ tackle: 1 }),
});

function targetPriority({ attackerRole, targetRole } = {}) {
  const table = PRIORITY[String(attackerRole || "")];
  if (!table) return 0;
  const score = Number(table[String(targetRole || "")]);
  return Number.isFinite(score) ? score : 0;
}

// Stable ordering: role priority first, then real distance, then the same native-hull
// preference the director already had, then insertion order. Nothing here invents a
// candidate or a distance - it only decides which of the real ones is aimed at first.
function orderCandidates({ candidates = [], attackerRole = "", kindPreference = "WAR_SHIP" } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return rows
    .map((row, index) => ({ row, index, priority: targetPriority({
      attackerRole, targetRole: String((row && row.targetRole) || "") }) }))
    .sort((a, b) => b.priority - a.priority ||
      (Number(a.row && a.row.distance) || 0) - (Number(b.row && b.row.distance) || 0) ||
      ((a.row && a.row.kind) === (b.row && b.row.kind) ? 0
        : (a.row && a.row.kind) === kindPreference ? -1 : 1) ||
      a.index - b.index)
    .map((entry) => entry.row);
}

module.exports = { PRIORITY, targetPriority, orderCandidates };
