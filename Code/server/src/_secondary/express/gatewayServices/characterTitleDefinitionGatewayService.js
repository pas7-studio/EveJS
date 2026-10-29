"use strict";
// eve_public.cosmetic.character.title.definition.api.GetLatest: where the client learns which
// title catalogue to download.
//
// The answer is a checkpoint: a URL, a semantic version and the CRC of the file. Ours points at
// our own server, because the catalogue is our content (space/coopTitleContent builds the
// flatbuffer and the loopback CDN responder serves it at that path).
//
// The checkpoint describes exactly the bytes we serve - URL, version and CRC come from the same
// frozen object - so a download can never disagree with the answer that advertised it.
const path = require("path");
const protobuf = require("protobufjs");

const API = "eve_public.cosmetic.character.title.definition.api";

const TITLE_DEFINITION_PROTO_ROOT = protobuf.Root.fromJSON({
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
              },
            },
          },
        },
        cosmetic: {
          nested: {
            character: {
              nested: {
                title: {
                  nested: {
                    definition: {
                      nested: {
                        api: {
                          nested: {
                            GetLatestRequest: {
                              fields: {
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
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.character.title.definition.api.GetLatestRequest",
]);

function createTitleDefinitionGatewayService(context = {}) {
  const content = context.titleContent || require(path.join(
    __dirname,
    "../../../space/coopTitleContent",
  )).content();
  const types = {
    response: TITLE_DEFINITION_PROTO_ROOT.lookupType(`${API}.GetLatestResponse`),
  };

  return {
    name: "character-title-definitions",
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
  HANDLED_REQUEST_TYPES,
  TITLE_DEFINITION_PROTO_ROOT,
  createTitleDefinitionGatewayService,
};
