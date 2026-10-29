"use strict";
// One place that grants skill points to a character, used by both the daily goals and the
// career portal. It is the same path the campaign skill crates use: the character record
// owns freeSkillPoints, and the live client is told through the skill queue notification
// so the number on screen moves without a relog.
//
// Nothing is minted from nowhere in the sense that matters: SP is character state, and the
// alternative (paying ISK) would need a funded account the co-op world does not have for
// players. Callers must have decided the reward is earned.
const path = require("path");

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function createSkillPointGrant({
  characterState = null,
  sessionRegistry = null,
  notifications = null,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const sessions = () => sessionRegistry || require(path.join(
    __dirname,
    "../services/chat/sessionRegistry",
  ));
  const queueNotifications = () => notifications || require(path.join(
    __dirname,
    "../services/skills/training/skillQueueNotifications",
  ));

  return function grantSkillPoints(characterID, amount) {
    const points = int(amount);
    if (points <= 0) {
      throw Error("SKILL_POINT_GRANT_AMOUNT_REQUIRED");
    }
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      freeSkillPoints: Math.max(0, int(record && record.freeSkillPoints)) + points,
    }));
    if (!result || result.success !== true) {
      throw Error("SKILL_POINT_GRANT_WRITE_FAILED");
    }
    // Tell the live client exactly like a campaign skill crate does. Without a session
    // the points are already on the record and arrive on the next login.
    try {
      const session = typeof sessions().findSessionByCharacterID === "function"
        ? sessions().findSessionByCharacterID(characterID)
        : null;
      const emit = queueNotifications().emitSkillSessionState;
      if (typeof emit === "function") {
        emit(session, characterID, [], {
          freeSkillPoints: int(result.data && result.data.freeSkillPoints),
        });
      }
    } catch (_error) {
      // the reward is durable; a missed notification is not a lost reward
    }
    return points;
  };
}

module.exports = { createSkillPointGrant };
