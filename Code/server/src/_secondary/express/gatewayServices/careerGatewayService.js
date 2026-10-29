"use strict";
// Career portal claim + admin completion (eve_public.career.goal.api.ClaimReward,
// eve_public.app.eveonline.career.goal.ClaimReward, and the two admin calls).
//
// The portal's list is answered by the compatibility service from space/coopCareerGoals;
// this service is the write side: claim a completed goal (skill points, once) and the
// admin path that marks a goal complete or sets its progress. A claim on an incomplete
// goal is refused with the real numbers instead of a silent success.
//
// The two claim packages carry the same identifier; only app.eveonline echoes the goal
// back in its response.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");

const CAREER_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        career: {
          nested: {
            goal: {
              nested: {
                Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                api: {
                  nested: {
                    ClaimRewardRequest: {
                      fields: {
                        goal: { type: "eve_public.career.goal.Identifier", id: 1 },
                        // RewardLabel enum; the world has one reward per goal, so the
                        // label is accepted and ignored rather than selected between.
                        label: { type: "int32", id: 2 },
                      },
                    },
                    ClaimRewardResponse: { fields: {} },
                    admin: {
                      nested: {
                        CompleteRequest: {
                          fields: {
                            goal: { type: "eve_public.career.goal.Identifier", id: 1 },
                          },
                        },
                        CompleteResponse: { fields: {} },
                        ProgressRequest: {
                          fields: {
                            goal: { type: "eve_public.career.goal.Identifier", id: 1 },
                            progress: { type: "uint32", id: 2 },
                          },
                        },
                        ProgressResponse: { fields: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        app: {
          nested: {
            eveonline: {
              nested: {
                career: {
                  nested: {
                    goal: {
                      nested: {
                        ClaimRewardRequest: {
                          fields: {
                            goal: { type: "eve_public.career.goal.Identifier", id: 1 },
                          },
                        },
                        ClaimRewardResponse: {
                          fields: {
                            goal: { type: "eve_public.career.goal.Identifier", id: 1 },
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
      },
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.career.goal.api.ClaimRewardRequest",
  "eve_public.app.eveonline.career.goal.ClaimRewardRequest",
  "eve_public.career.goal.api.admin.CompleteRequest",
  "eve_public.career.goal.api.admin.ProgressRequest",
]);

function createCareerGatewayService(context = {}) {
  const careerGoals = context.careerGoals || require(path.join(
    __dirname,
    "../../../space/coopCareerGoals",
  )).shared();
  const types = {
    claimRequest: CAREER_PROTO_ROOT.lookupType(
      "eve_public.career.goal.api.ClaimRewardRequest",
    ),
    appClaimRequest: CAREER_PROTO_ROOT.lookupType(
      "eve_public.app.eveonline.career.goal.ClaimRewardRequest",
    ),
    appClaimResponse: CAREER_PROTO_ROOT.lookupType(
      "eve_public.app.eveonline.career.goal.ClaimRewardResponse",
    ),
    completeRequest: CAREER_PROTO_ROOT.lookupType(
      "eve_public.career.goal.api.admin.CompleteRequest",
    ),
    progressRequest: CAREER_PROTO_ROOT.lookupType(
      "eve_public.career.goal.api.admin.ProgressRequest",
    ),
  };

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  function goalIDOf(identifier) {
    return identifier && identifier.uuid ? uuidBufferToString(identifier.uuid) : "";
  }

  function error(statusCode, message, responseTypeName) {
    return {
      statusCode,
      statusMessage: message,
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  function ok(responseTypeName, payload, type) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: type ? encodePayload(type, payload) : Buffer.alloc(0),
    };
  }

  function claimRefusal(result, responseTypeName) {
    if (result.status === "NOT_COMPLETED") {
      return error(9, `goal is not complete (${result.progress}/${result.target})`,
        responseTypeName);
    }
    if (result.status === "ALREADY_CLAIMED") {
      return error(9, "goal reward already claimed", responseTypeName);
    }
    if (result.status === "UNKNOWN_GOAL") {
      return error(5, "unknown career goal", responseTypeName);
    }
    if (result.status === "NO_CHARACTER") {
      return error(9, "an active character is required", responseTypeName);
    }
    return error(13, `claim failed: ${result.status}`, responseTypeName);
  }

  return {
    name: "career-goals",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const characterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === "eve_public.career.goal.api.ClaimRewardRequest") {
        const goalID = goalIDOf(decode(types.claimRequest, requestEnvelope).goal);
        const result = careerGoals.claim(characterID, goalID);
        if (result.status === "CLAIMED") {
          return ok("eve_public.career.goal.api.ClaimRewardResponse", null, null);
        }
        return claimRefusal(result, "eve_public.career.goal.api.ClaimRewardResponse");
      }

      if (requestTypeName === "eve_public.app.eveonline.career.goal.ClaimRewardRequest") {
        const goalID = goalIDOf(decode(types.appClaimRequest, requestEnvelope).goal);
        const result = careerGoals.claim(characterID, goalID);
        if (result.status === "CLAIMED") {
          return ok("eve_public.app.eveonline.career.goal.ClaimRewardResponse", {
            goal: { uuid: uuidStringToBuffer(goalID) },
          }, types.appClaimResponse);
        }
        return claimRefusal(result,
          "eve_public.app.eveonline.career.goal.ClaimRewardResponse");
      }

      if (requestTypeName === "eve_public.career.goal.api.admin.CompleteRequest") {
        const goalID = goalIDOf(decode(types.completeRequest, requestEnvelope).goal);
        const result = careerGoals.completeFor(characterID, goalID);
        if (result.status === "COMPLETED") {
          return ok("eve_public.career.goal.api.admin.CompleteResponse", null, null);
        }
        return error(result.status === "UNKNOWN_GOAL" ? 5 : 9,
          `completion was not recorded: ${result.status}`,
          "eve_public.career.goal.api.admin.CompleteResponse");
      }

      const request = decode(types.progressRequest, requestEnvelope);
      const goalID = goalIDOf(request.goal);
      const result = careerGoals.setProgressFor(
        characterID,
        goalID,
        Number(request.progress) || 0,
      );
      if (result.status === "RECORDED") {
        return ok("eve_public.career.goal.api.admin.ProgressResponse", null, null);
      }
      return error(result.status === "UNKNOWN_GOAL" ? 5 : 9,
        `progress was not recorded: ${result.status}`,
        "eve_public.career.goal.api.admin.ProgressResponse");
    },
  };
}

module.exports = {
  CAREER_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  createCareerGatewayService,
};
