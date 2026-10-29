"use strict";
// eve_public.cosmetic.ship.skin.thirdparty.api.Get: the record of one third-party skin.
//
// The designer can list a licence it owns, but without this call it cannot show what the skin
// actually looks like: the name, the line name, the creator, the design and whether it has been
// sequenced. The row comes from space/coopThirdPartySkins, which now keeps those fields when a
// sequencing job mints the copies.
//
// The design bytes are spliced back into the answer exactly as they were stored: the server
// never decoded the tree, so it does not re-encode it. Everything else is a plain field.
//
// A skin somebody else holds is NOT_FOUND here: this world has no public skin catalogue, and an
// empty answer would claim the skin exists with no design.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const API = "eve_public.cosmetic.ship.skin.thirdparty.api";

// `layout` is deliberately absent: it is appended as raw bytes (field 4) after encoding.
const SKIN_RECORD_PROTO_ROOT = protobuf.Root.fromJSON({
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
        cosmetic: {
          nested: {
            ship: {
              nested: {
                skin: {
                  nested: {
                    thirdparty: {
                      nested: {
                        Identifier: { fields: { hex: { type: "string", id: 1 } } },
                        Tier: { fields: { level: { type: "uint32", id: 1 } } },
                        Attributes: {
                          fields: {
                            name: { type: "string", id: 1 },
                            line_name: { type: "string", id: 2 },
                            creator: { type: "eve_public.character.Identifier", id: 3 },
                            tier: {
                              type: "eve_public.cosmetic.ship.skin.thirdparty.Tier",
                              id: 5,
                            },
                            not_sequenced: { type: "bool", id: 6 },
                            first_sequenced: {
                              type: "google.protobuf.Timestamp",
                              id: 7,
                            },
                          },
                        },
                        api: {
                          nested: {
                            GetRequest: {
                              fields: {
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            GetResponse: {
                              fields: {
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.Attributes",
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
        },
      },
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.skin.thirdparty.api.GetRequest",
]);

function varint(value) {
  const bytes = [];
  let remaining = Math.max(0, Math.trunc(Number(value) || 0));
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

// Field 4, wire type 2: the stored design bytes are appended without being understood.
function layoutField(base64) {
  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (bytes.length === 0) return Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x22]), varint(bytes.length), bytes]);
}

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function createThirdPartySkinRecordGatewayService(context = {}) {
  const skins = context.thirdPartySkins || require(path.join(
    __dirname,
    "../../../space/coopThirdPartySkins",
  )).shared();
  const types = {
    getRequest: SKIN_RECORD_PROTO_ROOT.lookupType(`${API}.GetRequest`),
    getResponse: SKIN_RECORD_PROTO_ROOT.lookupType(`${API}.GetResponse`),
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

  return {
    name: "third-party-skin-record",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);
      const decoded = decode(types.getRequest, requestEnvelope);
      const hex = String((decoded && decoded.skin && decoded.skin.hex) || "").trim();
      const row = hex ? skins.get(activeCharacterID, hex) : null;
      if (!row) {
        return error(5, "no such third-party skin", `${API}.GetResponse`);
      }

      const attributes = {
        name: String(row.name || ""),
        line_name: String(row.lineName || ""),
        creator: { sequential: Math.max(0, Number(row.creatorID) || 0) },
        not_sequenced: !(row.firstSequencedMs > 0),
      };
      const sequencer = timestampOf(row.firstSequencedMs);
      if (sequencer) attributes.first_sequenced = sequencer;
      // Every row in this store was minted by a completed sequencing job, so the tier is the
      // first tier; there is no levelling surface here to claim anything higher.
      attributes.tier = { level: 1 };

      const encoded = encodePayload(types.getResponse, { skin: attributes });
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: `${API}.GetResponse`,
        responsePayloadBuffer: Buffer.concat([encoded, layoutField(row.layout)]),
      };
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SKIN_RECORD_PROTO_ROOT,
  createThirdPartySkinRecordGatewayService,
  layoutField,
  varint,
};
