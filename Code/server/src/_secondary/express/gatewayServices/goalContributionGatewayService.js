"use strict";
// eve_public.goal.contribution.api: who contributed how much to one goal, and
// how much this character contributed.
//
// The corporation-goal package (eve_public.corporationgoal.api.*) already answers
// these two questions from the real goal store; the generic goal.contribution
// package, which the client uses from the plain goal window, had no handler at
// all, so the contribution list was empty while the goals themselves rendered.
//
// Both read the same record: services/corporation/corpGoalsState owns the goal
// and its contributors map, and this service does not keep a second copy. The
// only difference is the wire shape - this package reports the contributed sum as
// `total_sum_of_progress_added` (uint64) instead of `progress` with `earnings`.
//
// Messages are declared in a private root: the shared local gateway root does not
// carry eve_public.goal.contribution.api.*, and an eager lookupType() on a missing
// type throws at require time (that took the gateway down once).
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");
const {
  getContributorSummaryForGoal,
  listContributorSummariesForGoal,
} = require(path.join(
  __dirname,
  "../../../services/corporation/corpGoalsState",
));

const CONTRIBUTION_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        character: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        goal: {
          nested: {
            Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
            contribution: {
              nested: {
                api: {
                  nested: {
                    // One message serves both responses: the client's descriptor
                    // declares an identical nested ContributorSummary per response,
                    // and a nested name is not on the wire.
                    ContributorSummary: {
                      fields: {
                        contributor: { type: "eve_public.character.Identifier", id: 1 },
                        total_sum_of_progress_added: { type: "uint64", id: 2 },
                        goal: { type: "eve_public.goal.Identifier", id: 3 },
                      },
                    },
                    GetContributorSummariesForGoalRequest: {
                      fields: { goal: { type: "eve_public.goal.Identifier", id: 1 } },
                    },
                    GetContributorSummariesForGoalResponse: {
                      fields: {
                        summaries: {
                          rule: "repeated",
                          type: "eve_public.goal.contribution.api.ContributorSummary",
                          id: 1,
                        },
                      },
                    },
                    GetMyContributorSummaryForGoalRequest: {
                      fields: { goal: { type: "eve_public.goal.Identifier", id: 1 } },
                    },
                    GetMyContributorSummaryForGoalResponse: {
                      fields: {
                        summary: {
                          type: "eve_public.goal.contribution.api.ContributorSummary",
                          id: 1,
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
  "eve_public.goal.contribution.api.GetContributorSummariesForGoalRequest",
  "eve_public.goal.contribution.api.GetMyContributorSummaryForGoalRequest",
]);

function extractGoalID(identifier) {
  return identifier && identifier.uuid ? uuidBufferToString(identifier.uuid) : "";
}

function buildSummaryPayload(goalID, contributor) {
  return {
    contributor: { sequential: Number(contributor.characterID || 0) },
    total_sum_of_progress_added: Number(contributor.progress || 0),
    goal: { uuid: uuidStringToBuffer(goalID) },
  };
}

function createGoalContributionGatewayService() {
  const types = {
    getSummariesRequest: CONTRIBUTION_PROTO_ROOT.lookupType(
      "eve_public.goal.contribution.api.GetContributorSummariesForGoalRequest",
    ),
    getSummariesResponse: CONTRIBUTION_PROTO_ROOT.lookupType(
      "eve_public.goal.contribution.api.GetContributorSummariesForGoalResponse",
    ),
    getMineRequest: CONTRIBUTION_PROTO_ROOT.lookupType(
      "eve_public.goal.contribution.api.GetMyContributorSummaryForGoalRequest",
    ),
    getMineResponse: CONTRIBUTION_PROTO_ROOT.lookupType(
      "eve_public.goal.contribution.api.GetMyContributorSummaryForGoalResponse",
    ),
  };

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  return {
    name: "goal-contributions",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      if (requestTypeName ===
        "eve_public.goal.contribution.api.GetContributorSummariesForGoalRequest") {
        const goalID = extractGoalID(decode(types.getSummariesRequest, requestEnvelope).goal);
        if (!goalID) {
          return {
            statusCode: 3,
            statusMessage: "goal is required",
            responseTypeName:
              "eve_public.goal.contribution.api.GetContributorSummariesForGoalResponse",
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        const paged = listContributorSummariesForGoal(goalID, undefined);
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.goal.contribution.api.GetContributorSummariesForGoalResponse",
          responsePayloadBuffer: encodePayload(types.getSummariesResponse, {
            summaries: (paged.items || [])
              .map((contributor) => buildSummaryPayload(goalID, contributor)),
          }),
        };
      }

      const goalID = extractGoalID(decode(types.getMineRequest, requestEnvelope).goal);
      if (!goalID) {
        return {
          statusCode: 3,
          statusMessage: "goal is required",
          responseTypeName:
            "eve_public.goal.contribution.api.GetMyContributorSummaryForGoalResponse",
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }
      const characterID = Number(getActiveCharacterID(requestEnvelope) || 0);
      const summary = characterID ? getContributorSummaryForGoal(goalID, characterID) : null;
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName:
          "eve_public.goal.contribution.api.GetMyContributorSummaryForGoalResponse",
        responsePayloadBuffer: encodePayload(
          types.getMineResponse,
          summary ? { summary: buildSummaryPayload(goalID, summary) } : {},
        ),
      };
    },
  };
}

module.exports = {
  CONTRIBUTION_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  buildSummaryPayload,
  createGoalContributionGatewayService,
  extractGoalID,
};
