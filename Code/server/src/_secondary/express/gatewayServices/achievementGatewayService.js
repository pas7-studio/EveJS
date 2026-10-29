"use strict";
// eve_public.achievement.*: progress, completion, the rewards completion unlocks, category
// scores and the showcase score.
//
// Every answer here comes from space/coopAchievements, which owns the per-character rows. The
// catalogue of achievements is client content (a definition checkpoint our server can serve);
// this service never invents an achievement id, so an id nobody ever progressed simply has no
// row and Get answers not_completed with zero progress rather than a made-up target.
//
// Two honest refusals worth knowing:
//   - AddProgress with a checklist is refused, because checklist progress has no storage here yet
//     and silently dropping it would report work that did not happen;
//   - Claim pays the skill points our catalogue declares for that achievement and only then
//     removes it from the unclaimed list (space/coopAchievements owns both steps).
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const ACH = "eve_public.achievement";

const ACHIEVEMENT_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: { type: "int64", id: 1 },
                nanos: { type: "int32", id: 2 },
              },
            },
          },
        },
      },
    },
    eve_public: {
      nested: {
        character: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        achievement: {
          nested: {
            definition: {
              nested: {
                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
              },
            },
            // Declared so that a checklist delta can be DETECTED and refused: its contents are
            // not modelled here, and dropping it silently would report work that never happened.
            contribution: {
              nested: {
                ChecklistProgress: { fields: {} },
              },
            },
            category: {
              nested: {
                definition: {
                  nested: {
                    Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                  },
                },
                milestone: {
                  nested: {
                    definition: {
                      nested: {
                        Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                      },
                    },
                  },
                },
                api: {
                  nested: {
                    GetRequest: {
                      fields: {
                        category: {
                          type: "eve_public.achievement.category.definition.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetResponse: {
                      fields: {
                        score: { type: "uint32", id: 1 },
                        reached_milestones: {
                          rule: "repeated",
                          type: "eve_public.achievement.category.api.GetResponse.ReachedMilestone",
                          id: 2,
                        },
                      },
                      nested: {
                        ReachedMilestone: {
                          fields: {
                            milestone: {
                              type: "eve_public.achievement.category.milestone.definition.Identifier",
                              id: 1,
                            },
                            reached_date: { type: "google.protobuf.Timestamp", id: 2 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            api: {
              nested: {
                GetRequest: {
                  fields: {
                    achievement: {
                      type: "eve_public.achievement.definition.Identifier",
                      id: 1,
                    },
                  },
                },
                GetResponse: {
                  fields: {
                    completed_date: { type: "google.protobuf.Timestamp", id: 1 },
                    not_completed: { type: "bool", id: 2 },
                    progress_value: { type: "uint64", id: 3 },
                    reached_milestones: {
                      rule: "repeated",
                      type: "eve_public.achievement.api.GetResponse.ReachedMilestone",
                      id: 5,
                    },
                  },
                  nested: {
                    ReachedMilestone: {
                      fields: {
                        milestone: {
                          type: "eve_public.achievement.category.milestone.definition.Identifier",
                          id: 1,
                        },
                        reached_date: { type: "google.protobuf.Timestamp", id: 2 },
                        category_points_awarded: { type: "uint32", id: 3 },
                      },
                    },
                  },
                },
                admin: {
                  nested: {
                    AddProgressRequest: {
                      fields: {
                        achievement: {
                          type: "eve_public.achievement.definition.Identifier",
                          id: 1,
                        },
                        progress_delta: { type: "uint64", id: 2 },
                        checklist: {
                          type: "eve_public.achievement.contribution.ChecklistProgress",
                          id: 3,
                        },
                        unique_item_count: { type: "uint64", id: 4 },
                      },
                    },
                    AddProgressResponse: { fields: {} },
                    CompleteRequest: {
                      fields: {
                        achievement: {
                          type: "eve_public.achievement.definition.Identifier",
                          id: 1,
                        },
                      },
                    },
                    CompleteResponse: { fields: {} },
                    ResetRequest: {
                      fields: {
                        achievement: {
                          type: "eve_public.achievement.definition.Identifier",
                          id: 1,
                        },
                      },
                    },
                    ResetResponse: { fields: {} },
                  },
                },
              },
            },
            reward: {
              nested: {
                api: {
                  nested: {
                    GetUnclaimedRequest: { fields: {} },
                    GetUnclaimedResponse: {
                      fields: {
                        rewards: {
                          rule: "repeated",
                          type: "eve_public.achievement.reward.api.GetUnclaimedResponse.Reward",
                          id: 1,
                        },
                      },
                      nested: {
                        Reward: {
                          fields: {
                            achievement_source: {
                              type: "eve_public.achievement.reward.api.ClaimRequest.AchievementSource",
                              id: 1,
                            },
                            category_source: {
                              type: "eve_public.achievement.reward.api.ClaimRequest.CategorySource",
                              id: 2,
                            },
                          },
                        },
                      },
                    },
                    ClaimRequest: {
                      fields: {
                        achievement_source: {
                          type: "eve_public.achievement.reward.api.ClaimRequest.AchievementSource",
                          id: 1,
                        },
                        category_source: {
                          type: "eve_public.achievement.reward.api.ClaimRequest.CategorySource",
                          id: 2,
                        },
                      },
                      nested: {
                        AchievementSource: {
                          fields: {
                            achievement: {
                              type: "eve_public.achievement.definition.Identifier",
                              id: 1,
                            },
                            milestone: {
                              type: "eve_public.achievement.category.milestone.definition.Identifier",
                              id: 2,
                            },
                          },
                        },
                        CategorySource: {
                          fields: {
                            category: {
                              type: "eve_public.achievement.category.definition.Identifier",
                              id: 1,
                            },
                            milestone: {
                              type: "eve_public.achievement.category.milestone.definition.Identifier",
                              id: 2,
                            },
                          },
                        },
                      },
                    },
                    ClaimResponse: { fields: {} },
                  },
                },
              },
            },
            showcase: {
              nested: {
                api: {
                  nested: {
                    GetCharacterScoreRequest: {
                      fields: {
                        character: { type: "eve_public.character.Identifier", id: 1 },
                      },
                    },
                    GetCharacterScoreResponse: {
                      fields: { score: { type: "uint32", id: 1 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.achievement.api.GetRequest",
  "eve_public.achievement.api.admin.AddProgressRequest",
  "eve_public.achievement.api.admin.CompleteRequest",
  "eve_public.achievement.api.admin.ResetRequest",
  "eve_public.achievement.category.api.GetRequest",
  "eve_public.achievement.reward.api.GetUnclaimedRequest",
  "eve_public.achievement.reward.api.ClaimRequest",
  "eve_public.achievement.showcase.api.GetCharacterScoreRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function identifierOf(uuid) {
  return { uuid: Buffer.from(String(uuid || ""), "hex") };
}

function createAchievementGatewayService(context = {}) {
  const achievements = context.achievements || require(path.join(
    __dirname,
    "../../../space/coopAchievements",
  )).shared();
  const types = {
    getRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.api.GetRequest`),
    getResponse: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.api.GetResponse`),
    addProgressRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.api.admin.AddProgressRequest`),
    completeRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.api.admin.CompleteRequest`),
    resetRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.api.admin.ResetRequest`),
    categoryRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.category.api.GetRequest`),
    categoryResponse: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.category.api.GetResponse`),
    unclaimedResponse: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.reward.api.GetUnclaimedResponse`),
    claimRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.reward.api.ClaimRequest`),
    scoreRequest: ACHIEVEMENT_PROTO_ROOT.lookupType(`${ACH}.showcase.api.GetCharacterScoreRequest`),
    scoreResponse: ACHIEVEMENT_PROTO_ROOT.lookupType(
      `${ACH}.showcase.api.GetCharacterScoreResponse`,
    ),
  };

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  function error(statusCode, message, responseTypeName) {
    return {
      statusCode,
      statusMessage: message,
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  function ok(responseTypeName, type = null, payload = null) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: type ? encodePayload(type, payload || {}) : Buffer.alloc(0),
    };
  }

  function refusalFor(status, responseTypeName) {
    const refusals = {
      ACHIEVEMENT_REQUIRED: [3, "an achievement id is required"],
      DELTA_REQUIRED: [3, "progress_delta must not be zero"],
      ALREADY_COMPLETE: [9, "that achievement is already completed"],
      NOT_FOUND: [5, "there is nothing to undo or claim here"],
      SOURCE_REQUIRED: [3, "a reward source is required"],
      CHECKLIST_UNSUPPORTED: [9, "checklist progress is not supported yet"],
      NO_CHARACTER: [7, "no character in this session"],
      WRITE_FAILED: [13, "the achievement state could not be stored"],
      REWARD_FAILED: [13, "the reward could not be paid, so it stays claimable"],
    };
    const refusal = refusals[status] || [13, `achievement request failed: ${status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "achievements",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${ACH}.api.GetRequest`) {
        const decoded = decode(types.getRequest, requestEnvelope);
        const row = achievements.get(
          activeCharacterID,
          decoded && decoded.achievement && decoded.achievement.uuid,
        );
        const payload = {
          not_completed: !(row && row.completedMs > 0),
          progress_value: row ? row.progress : 0,
        };
        const completed = row && timestampOf(row.completedMs);
        if (completed) payload.completed_date = completed;
        return ok(`${ACH}.api.GetResponse`, types.getResponse, payload);
      }

      if (requestTypeName === `${ACH}.api.admin.AddProgressRequest`) {
        const decoded = decode(types.addProgressRequest, requestEnvelope);
        if (decoded && decoded.checklist) {
          return refusalFor("CHECKLIST_UNSUPPORTED", `${ACH}.api.admin.AddProgressResponse`);
        }
        const result = achievements.addProgress(
          activeCharacterID,
          decoded && decoded.achievement && decoded.achievement.uuid,
          Number(decoded && decoded.progress_delta) || 0,
        );
        if (result.status === "RECORDED") return ok(`${ACH}.api.admin.AddProgressResponse`);
        return refusalFor(result.status, `${ACH}.api.admin.AddProgressResponse`);
      }

      if (requestTypeName === `${ACH}.api.admin.CompleteRequest`) {
        const decoded = decode(types.completeRequest, requestEnvelope);
        const result = achievements.complete(
          activeCharacterID,
          decoded && decoded.achievement && decoded.achievement.uuid,
        );
        if (result.status === "COMPLETED") return ok(`${ACH}.api.admin.CompleteResponse`);
        return refusalFor(result.status, `${ACH}.api.admin.CompleteResponse`);
      }

      if (requestTypeName === `${ACH}.api.admin.ResetRequest`) {
        const decoded = decode(types.resetRequest, requestEnvelope);
        const result = achievements.reset(
          activeCharacterID,
          decoded && decoded.achievement && decoded.achievement.uuid,
        );
        if (result.status === "RESET") return ok(`${ACH}.api.admin.ResetResponse`);
        return refusalFor(result.status, `${ACH}.api.admin.ResetResponse`);
      }

      if (requestTypeName === `${ACH}.category.api.GetRequest`) {
        const decoded = decode(types.categoryRequest, requestEnvelope);
        const row = achievements.category(
          activeCharacterID,
          decoded && decoded.category && decoded.category.uuid,
        );
        return ok(`${ACH}.category.api.GetResponse`, types.categoryResponse, {
          score: row ? row.score : 0,
          reached_milestones: (row && row.milestones ? row.milestones : [])
            .map((entry) => ({
              milestone: identifierOf(entry.milestone),
              reached_date: timestampOf(entry.reachedMs),
            })),
        });
      }

      if (requestTypeName === `${ACH}.reward.api.GetUnclaimedRequest`) {
        return ok(`${ACH}.reward.api.GetUnclaimedResponse`, types.unclaimedResponse, {
          rewards: achievements.unclaimed(activeCharacterID).map((entry) => ({
            achievement_source: { achievement: identifierOf(entry.achievement) },
          })),
        });
      }

      if (requestTypeName === `${ACH}.reward.api.ClaimRequest`) {
        const decoded = decode(types.claimRequest, requestEnvelope);
        const result = achievements.claim(activeCharacterID, {
          achievement: decoded && decoded.achievement_source
            && decoded.achievement_source.achievement
            && decoded.achievement_source.achievement.uuid,
          category: decoded && decoded.category_source
            && decoded.category_source.category
            && decoded.category_source.category.uuid,
          milestone: (decoded && decoded.achievement_source && decoded.achievement_source.milestone
            && decoded.achievement_source.milestone.uuid)
            || (decoded && decoded.category_source && decoded.category_source.milestone
              && decoded.category_source.milestone.uuid),
        });
        if (result.status === "CLAIMED") return ok(`${ACH}.reward.api.ClaimResponse`);
        return refusalFor(result.status, `${ACH}.reward.api.ClaimResponse`);
      }

      const decoded = decode(types.scoreRequest, requestEnvelope);
      const characterID = Number(
        (decoded && decoded.character && decoded.character.sequential) || activeCharacterID,
      );
      return ok(`${ACH}.showcase.api.GetCharacterScoreResponse`, types.scoreResponse, {
        score: achievements.score(characterID),
      });
    },
  };
}

module.exports = {
  ACHIEVEMENT_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  createAchievementGatewayService,
};
