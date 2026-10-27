"use strict";
// Grant real native skill items to a character without the client UI.
//
// Why: skill items are ordinary rows in the `skills` document (typeID ->
// {itemID, skillLevel, trainedSkillLevel, ...}), so a skill can be granted
// deterministically. Nothing is invented: the entry is cloned from a skill the
// character already owns, then only identity/level values are replaced, and the
// resulting level is the one EveJS itself reads.
//
// Skill points follow the retail curve exactly:
//   sp(rank, level) = 250 * rank * 2^(2.5 * (level - 1))
// which gives the known rank-1 values 250 / 1414 / 8000 / 45255 / 256000.

const MAX_LEVEL = 5;

function skillPointsFor(rank, level) {
  const safeRank = Math.max(1, Math.floor(Number(rank) || 1));
  const safeLevel = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(level) || 0)));
  if (safeLevel === 0) return 0;
  return Math.round(250 * safeRank * Math.pow(2, 2.5 * (safeLevel - 1)));
}

function skillItemID(characterID, typeID) {
  return Number(`${Math.floor(Number(characterID))}${String(Math.floor(Number(typeID))).padStart(5, "0")}`);
}

function buildSkillEntry({ template, type, characterID, level }) {
  if (!template || typeof template !== "object") throw new Error("a template skill entry is required");
  if (!type || !Number.isInteger(Number(type.typeID)) || Number(type.typeID) <= 0) {
    throw new Error("resolved type with a positive typeID is required");
  }
  const safeLevel = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(level) || 1)));
  const rank = Math.max(1, Math.floor(Number(type.rank) || 1));
  const typeID = Number(type.typeID);
  return {
    ...template,
    itemID: skillItemID(characterID, typeID),
    typeID,
    ownerID: Number(characterID),
    locationID: Number(characterID),
    flagID: 7,
    categoryID: Number(type.categoryID || 16),
    groupID: Number(type.groupID || template.groupID),
    groupName: String(type.groupName || template.groupName || ""),
    itemName: String(type.name || template.itemName || ""),
    published: type.published !== false,
    skillLevel: safeLevel,
    trainedSkillLevel: safeLevel,
    effectiveSkillLevel: safeLevel,
    virtualSkillLevel: null,
    skillRank: rank,
    skillPoints: skillPointsFor(rank, safeLevel),
  };
}

// existing: the character's skill document (typeID -> entry)
// wanted:   [{ name, typeID, rank, groupID, groupName, categoryID, published, level }]
function planSkillGrants({ existing, wanted, characterID }) {
  const owned = existing && typeof existing === "object" ? existing : {};
  const template = Object.values(owned).find((entry) => entry && Number(entry.categoryID) === 16);
  if (!template) throw new Error("character has no skill entry to use as a template");
  const add = [];
  const skip = [];
  for (const skill of wanted || []) {
    const current = owned[String(skill.typeID)] || owned[Number(skill.typeID)];
    const have = Number(current && current.trainedSkillLevel) || 0;
    if (have >= skill.level) {
      skip.push({ typeID: skill.typeID, name: skill.name, have, want: skill.level, reason: "ALREADY_TRAINED" });
      continue;
    }
    add.push(buildSkillEntry({ template, type: skill, characterID, level: skill.level }));
  }
  return { add, skip, templateTypeID: Number(template.typeID) };
}

function applyPlan(existing, plan) {
  const next = { ...(existing || {}) };
  for (const entry of plan.add) next[String(entry.typeID)] = entry;
  return next;
}

module.exports = { MAX_LEVEL, skillPointsFor, skillItemID, buildSkillEntry, planSkillGrants, applyPlan };
