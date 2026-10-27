"use strict";
// One campaign = one operation on one front.
//
// Owner model (2026-10-27): a front is the border between two factions' sectors.
// On that border a faction runs an operation - assault, defence, breakthrough -
// and separately it can send a small force DEEP behind the enemy line to cut
// trade and supply. Everything is validated against real ownership, and a
// campaign only changes state on real evidence, never on a timer alone.
const ROLES = Object.freeze(["assault", "defence", "breakthrough", "deep-op"]);
const STATES = Object.freeze(["ACTIVE", "WON", "LOST", "EXPIRED"]);

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const num = (value) => Number(value) || 0;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function ownerOf(territories, systemID) {
  const value = territories && territories[systemID];
  const owner = typeof value === "object" && value ? value.factionID : value;
  return typeof owner === "string" && owner ? owner : null;
}

function refuse(reason, extra) {
  return Object.assign({ status: "REFUSED", reason }, extra || {});
}

// `deep-op` deliberately ignores the front: its objective sits behind the enemy
// line, which is exactly what makes it a sabotage run and not a push.
function planCampaign(options = {}) {
  const {
    frontID, factions, role, originSystemID, objectiveSystemID,
    territories, attacker, nowMs, ttlMs,
  } = options;
  if (!ROLES.includes(String(role))) return refuse("UNKNOWN_ROLE", { role: String(role || "") });
  if (!positive(originSystemID) || !positive(objectiveSystemID)) return refuse("SYSTEM_IDS_REQUIRED");
  if (originSystemID === objectiveSystemID) return refuse("SAME_SYSTEM");
  const originOwner = ownerOf(territories, originSystemID);
  const objectiveOwner = ownerOf(territories, objectiveSystemID);
  if (!originOwner || !objectiveOwner) return refuse("UNOWNED_SYSTEM");
  const side = String(attacker || "");
  if (!side || !(originOwner === side || objectiveOwner === side)) {
    return refuse("ATTACKER_NOT_INVOLVED", { originOwner, objectiveOwner, attacker: side });
  }
  if (role === "defence") {
    // A defence is fought from our own system for our own system.
    if (originOwner !== side || objectiveOwner !== side) {
      return refuse("DEFENCE_NEEDS_OWN_SYSTEMS", { originOwner, objectiveOwner, attacker: side });
    }
  } else {
    // An offensive starts on our side and takes an enemy system.
    if (originOwner !== side) return refuse("ORIGIN_NOT_OURS", { originOwner, attacker: side });
    if (objectiveOwner === side) return refuse("OBJECTIVE_ALREADY_OURS", { objectiveOwner, attacker: side });
  }
  if (role !== "deep-op" && Array.isArray(factions) && factions.length === 2) {
    const pair = [originOwner, objectiveOwner].sort().join("|");
    if (pair !== [...factions].sort().join("|")) return refuse("NOT_THIS_FRONT", { pair, factions });
  }
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  const ttl = positive(ttlMs) ? num(ttlMs) : DEFAULT_TTL_MS;
  return {
    status: "PLANNED",
    campaignID: `${role}:${frontID || "deep"}:${originSystemID}-${objectiveSystemID}:${at}`,
    frontID: role === "deep-op" ? null : String(frontID || ""),
    role: String(role),
    attacker: side,
    defender: originOwner === side ? objectiveOwner : originOwner,
    originSystemID,
    objectiveSystemID,
    state: "ACTIVE",
    createdAtMs: at,
    expiresAtMs: at + ttl,
    history: [{ at, kind: "planned", role: String(role) }],
  };
}

// A campaign ends on evidence, or by running out of time. Nothing here can turn
// a campaign into a win without an explicit captured/taken proof.
function resolveCampaign(campaign, { nowMs, evidence } = {}) {
  if (!campaign || !STATES.includes(String(campaign.state))) return refuse("INVALID_CAMPAIGN");
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  if (campaign.state !== "ACTIVE") return { status: "ALREADY_CLOSED", state: campaign.state };
  const proof = evidence || {};
  const history = Array.isArray(campaign.history) ? campaign.history.slice() : [];
  const close = (state, kind) => Object.assign({}, campaign, {
    state,
    closedAtMs: at,
    history: history.concat([{ at, kind }]),
  });
  if (proof.objectiveCaptured === true) {
    return { status: "RESOLVED", state: "WON", campaign: close("WON", "objective-captured") };
  }
  if (proof.fleetDestroyed === true || proof.forceLost === true) {
    return { status: "RESOLVED", state: "LOST", campaign: close("LOST", "force-lost") };
  }
  if (num(campaign.expiresAtMs) > 0 && at > num(campaign.expiresAtMs)) {
    return { status: "RESOLVED", state: "EXPIRED", campaign: close("EXPIRED", "expired") };
  }
  return { status: "ACTIVE", state: "ACTIVE", campaign };
}

// Which roles a front can host right now: an offensive needs an enemy system we
// do not own, a defence needs our own system under threat.
function rolesForFront({ front, attacker, territories } = {}) {
  const roles = [];
  if (!front || !Array.isArray(front.edges) || !front.edges.length) return roles;
  const side = String(attacker || "");
  for (const edge of front.edges) {
    const originOwner = ownerOf(territories, edge.fromSystemID);
    const objectiveOwner = ownerOf(territories, edge.toSystemID);
    if (originOwner === side && objectiveOwner !== side) roles.push("assault");
    if (objectiveOwner === side && originOwner !== side) roles.push("assault");
    if (originOwner === side && objectiveOwner === side) roles.push("defence");
  }
  return [...new Set(roles)];
}

module.exports = { ROLES, STATES, DEFAULT_TTL_MS, planCampaign, resolveCampaign, rolesForFront, ownerOf };
