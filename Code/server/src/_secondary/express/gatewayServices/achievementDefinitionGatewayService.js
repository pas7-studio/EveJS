"use strict";
// eve_public.achievement.definition.api.cdn.GetLatest: where the client learns which achievement
// catalogue to download.
//
// The answer is a checkpoint - url, semantic version and the CRC of the file - and ours points at
// our own content host, because the catalogue is our content (space/coopAchievementContent builds
// the flatbuffer and serves it at that path). The checkpoint is taken from the same frozen object
// that produces the bytes, so the advertisement can never disagree with the download.
//
// The request carries a oneof (a version the client already has, or "none available"). Both are
// declared so a real client request decodes instead of failing as an unknown field; the answer
// does not depend on them, because we publish exactly one catalogue.
const path = require("path");
const protobuf = require("protobufjs");

const API = "eve_public.achievement.definition.api.cdn";

const ACHIEVEMENT_DEFINITION_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        cdn: {
          nested: {
            Checksum: { fields: { crc: { type: "uint32", id: 1 } } },
            Checkpoint: {
              fields: {
                url: { type: "string", id: 1 },
                version: { type: "eve_public.semanticversion.Specification", id: 2 },
                crc: { type: "eve_public.cdn.Checksum", id: 3 },
              },
            },
          },
        },
        semanticversion: {
          nested: {
            Specification: {
              fields: {
                major: { type: "uint32", id: 1 },
                minor: { type: "uint32", id: 2 },
                patch: { type: "uint32", id: 3 },
                prerelease_tags: { rule: "repeated", type: "string", id: 4 },
                build_tags: { rule: "repeated", type: "string", id: 5 },
              },
            },
          },
        },
        achievement: {
          nested: {
            definition: {
              nested: {
                api: {
                  nested: {
                    cdn: {
                      nested: {
                        GetLatestRequest: {
                          fields: {
                            current_version: {
                              type: "eve_public.semanticversion.Specification",
                              id: 1,
                            },
                            no_local_version_available: { type: "bool", id: 2 },
                          },
                        },
                        GetLatestResponse: {
                          fields: {
                            checkpoint: { type: "eve_public.cdn.Checkpoint", id: 1 },
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
  `${API}.GetLatestRequest`,
]);

function createAchievementDefinitionGatewayService(context = {}) {
  const content = context.achievementContent || require(path.join(
    __dirname,
    "../../../space/coopAchievementContent",
  )).content();
  const types = {
    response: ACHIEVEMENT_DEFINITION_PROTO_ROOT.lookupType(`${API}.GetLatestResponse`),
  };

  return {
    name: "achievement-definitions",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }
      const payload = types.response.encode(types.response.create({
        checkpoint: {
          url: content.url,
          version: { ...content.version },
          crc: { crc: content.crc },
        },
      })).finish();
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: `${API}.GetLatestResponse`,
        responsePayloadBuffer: Buffer.from(payload),
      };
    },
  };
}

module.exports = {
  ACHIEVEMENT_DEFINITION_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  createAchievementDefinitionGatewayService,
};
