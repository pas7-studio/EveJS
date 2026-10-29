"use strict";
// eve_public.cosmetic.ship.skin.thirdparty.draft.api: the design-draft half of the SKIN
// designer. A draft is what the editor saves while a player is still designing; it is not a
// licence and it does not become a skin until a sequencing job runs (step 4, not here).
//
// Save / Update / Delete / Get / GetAllSaved / GetShared / GetSaveCapacity read and write real
// rows owned by space/coopSkinDrafts, and capacity is the limit that save actually enforces.
//
// The layout is NOT decoded here on purpose. The client sends a deep design tree whose nested
// configuration messages this build of the server does not model, so the bytes of the `layout`
// field are pulled straight off the wire and stored verbatim; re-encoding a partially decoded
// tree would silently drop what we do not understand.
//
// On read the contract is narrow: draft.Attributes carries only the source skin hex and the
// editor configurations - no name, no line_name, no layout. The name and layout are still
// stored, because sequencing needs them, but they are not part of a read answer.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const DRAFT = "eve_public.cosmetic.ship.skin.thirdparty.draft";
const DRAFT_API = `${DRAFT}.api`;

const SKIN_DRAFT_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
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
                        slot: {
                          nested: {
                            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
                          },
                        },
                        draft: {
                          nested: {
                            Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                            EditorConfiguration: {
                              fields: {
                                offset_u_ratio: { type: "float", id: 1 },
                                offset_v_ratio: { type: "float", id: 2 },
                                yaw: { type: "float", id: 3 },
                                pitch: { type: "float", id: 4 },
                                roll: { type: "float", id: 5 },
                                scaling: { type: "float", id: 6 },
                              },
                            },
                            SlotEditorConfiguration: {
                              fields: {
                                id: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.slot.Identifier",
                                  id: 1,
                                },
                                config: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.draft.EditorConfiguration",
                                  id: 2,
                                },
                              },
                            },
                            Attributes: {
                              fields: {
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                                  id: 1,
                                },
                                editor_configuration: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.draft.EditorConfiguration",
                                  id: 2,
                                },
                                editor_configurations: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.draft.SlotEditorConfiguration",
                                  id: 3,
                                },
                              },
                            },
                            api: {
                              nested: {
                                SaveRequest: {
                                  fields: {
                                    name: { type: "string", id: 1 },
                                    line_name: { type: "string", id: 2 },
                                    editor_configurations: {
                                      rule: "repeated",
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.SlotEditorConfiguration",
                                      id: 4,
                                    },
                                  },
                                },
                                SaveResponse: {
                                  fields: {
                                    id: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 1,
                                    },
                                    attributes: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Attributes",
                                      id: 2,
                                    },
                                  },
                                },
                                UpdateRequest: {
                                  fields: {
                                    id: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 1,
                                    },
                                    name: { type: "string", id: 2 },
                                    line_name: { type: "string", id: 3 },
                                    editor_configurations: {
                                      rule: "repeated",
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.SlotEditorConfiguration",
                                      id: 5,
                                    },
                                  },
                                },
                                UpdateResponse: {
                                  fields: {
                                    id: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 1,
                                    },
                                    attributes: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Attributes",
                                      id: 2,
                                    },
                                  },
                                },
                                DeleteRequest: {
                                  fields: {
                                    id: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 1,
                                    },
                                  },
                                },
                                DeleteResponse: { fields: {} },
                                GetAllSavedRequest: { fields: {} },
                                GetAllSavedResponse: {
                                  fields: {
                                    drafts: {
                                      rule: "repeated",
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.api.GetAllSavedResponse.Draft",
                                      id: 1,
                                    },
                                  },
                                  nested: {
                                    Draft: {
                                      fields: {
                                        id: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                          id: 1,
                                        },
                                        attributes: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Attributes",
                                          id: 2,
                                        },
                                      },
                                    },
                                  },
                                },
                                GetRequest: {
                                  fields: {
                                    draft: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 1,
                                    },
                                  },
                                },
                                GetResponse: {
                                  fields: {
                                    draft: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Attributes",
                                      id: 2,
                                    },
                                  },
                                },
                                GetSharedRequest: {
                                  fields: {
                                    character: {
                                      type: "eve_public.character.Identifier",
                                      id: 1,
                                    },
                                    draft: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Identifier",
                                      id: 2,
                                    },
                                  },
                                },
                                GetSharedResponse: {
                                  fields: {
                                    draft: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.draft.Attributes",
                                      id: 1,
                                    },
                                  },
                                },
                                GetSaveCapacityRequest: { fields: {} },
                                GetSaveCapacityResponse: {
                                  fields: { capacity: { type: "uint64", id: 1 } },
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

// Spelled out rather than built from the package prefix: the contract register scans the tree
// for these literal names, and a built string is invisible to it.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.SaveRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.UpdateRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.DeleteRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.GetRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.GetAllSavedRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.GetSharedRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.draft.api.GetSaveCapacityRequest",
]);

// The `layout` field is length-delimited inside the request; walk the wire format and take the
// bytes of that one field exactly as sent. A malformed payload yields no layout, never a throw.
function rawLayoutField(payload, fieldNumber) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) return "";
  let offset = 0;
  const chunks = [];
  try {
    while (offset < payload.length) {
      let key = 0;
      let shift = 0;
      let byte;
      do {
        if (offset >= payload.length) return "";
        byte = payload[offset];
        offset += 1;
        key += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (shift > 63) return "";
      } while (byte >= 0x80);
      const field = Math.floor(key / 8);
      const wireType = key % 8;
      if (wireType === 0) {
        while (offset < payload.length && payload[offset] >= 0x80) offset += 1;
        offset += 1;
      } else if (wireType === 2) {
        let length = 0;
        let lengthShift = 0;
        let lengthByte;
        do {
          if (offset >= payload.length) return "";
          lengthByte = payload[offset];
          offset += 1;
          length += (lengthByte & 0x7f) * 2 ** lengthShift;
          lengthShift += 7;
          if (lengthShift > 63) return "";
        } while (lengthByte >= 0x80);
        if (offset + length > payload.length) return "";
        if (field === fieldNumber) {
          chunks.push(Buffer.from(payload.slice(offset, offset + length)));
        }
        offset += length;
      } else if (wireType === 5) {
        offset += 4;
      } else if (wireType === 1) {
        offset += 8;
      } else {
        return "";
      }
    }
  } catch (_error) {
    return "";
  }
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("base64");
}

function configurationPayload(row) {
  const config = (row && row.config) || {};
  return {
    id: { sequential: Number(row && row.id && row.id.sequential) || 0 },
    config: {
      offset_u_ratio: Number(config.offsetURatio) || 0,
      offset_v_ratio: Number(config.offsetVRatio) || 0,
      yaw: Number(config.yaw) || 0,
      pitch: Number(config.pitch) || 0,
      roll: Number(config.roll) || 0,
      scaling: Number(config.scaling) || 0,
    },
  };
}

function draftAttributes(draft) {
  return {
    skin: { hex: String(draft.skinHex || "") },
    editor_configurations: (draft.configurations || []).map(configurationPayload),
  };
}

function draftIdentifier(draft) {
  return { uuid: Buffer.from(String(draft.uuid || ""), "hex") };
}

function decodeConfigurations(rows, limit) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: { sequential: Number(row && row.id && row.id.sequential) || 0 },
    config: {
      offsetURatio: Number(row && row.config && row.config.offset_u_ratio) || 0,
      offsetVRatio: Number(row && row.config && row.config.offset_v_ratio) || 0,
      yaw: Number(row && row.config && row.config.yaw) || 0,
      pitch: Number(row && row.config && row.config.pitch) || 0,
      roll: Number(row && row.config && row.config.roll) || 0,
      scaling: Number(row && row.config && row.config.scaling) || 0,
    },
  })).slice(0, limit);
}

function createThirdPartySkinDraftGatewayService(context = {}) {
  const drafts = context.skinDrafts || require(path.join(
    __dirname,
    "../../../space/coopSkinDrafts",
  )).shared();
  const types = {
    saveRequest: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.SaveRequest`),
    saveResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.SaveResponse`),
    updateRequest: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.UpdateRequest`),
    updateResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.UpdateResponse`),
    deleteRequest: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.DeleteRequest`),
    getAllSavedResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetAllSavedResponse`),
    getRequest: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetRequest`),
    getResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetResponse`),
    getSharedRequest: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetSharedRequest`),
    getSharedResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetSharedResponse`),
    capacityResponse: SKIN_DRAFT_PROTO_ROOT.lookupType(`${DRAFT_API}.GetSaveCapacityResponse`),
  };

  function payloadOf(requestEnvelope) {
    return (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
      Buffer.alloc(0);
  }

  function decode(type, requestEnvelope) {
    return type.decode(payloadOf(requestEnvelope));
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

  // Save and Update share every field but the id, so they share the refusal mapping too.
  function refusalFor(status, responseTypeName) {
    const refusals = {
      UUID_REQUIRED: [3, "a draft id is required"],
      NOT_FOUND: [5, "no such draft"],
      CAPACITY_REACHED: [9, "no draft capacity left"],
      WRITE_FAILED: [13, "the draft could not be stored"],
      UUID_FAILED: [13, "a draft id could not be assigned"],
      NO_CHARACTER: [7, "no character in this session"],
    };
    const refusal = refusals[status] || [13, `draft request failed: ${status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "third-party-skin-drafts",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${DRAFT_API}.GetSaveCapacityRequest`) {
        return ok(`${DRAFT_API}.GetSaveCapacityResponse`, types.capacityResponse, {
          capacity: drafts.capacity(),
        });
      }

      if (requestTypeName === `${DRAFT_API}.GetAllSavedRequest`) {
        return ok(`${DRAFT_API}.GetAllSavedResponse`, types.getAllSavedResponse, {
          drafts: drafts.list(activeCharacterID).map((draft) => ({
            id: draftIdentifier(draft),
            attributes: draftAttributes(draft),
          })),
        });
      }

      if (requestTypeName === `${DRAFT_API}.GetRequest`) {
        const decoded = decode(types.getRequest, requestEnvelope);
        const draft = drafts.get(activeCharacterID, decoded && decoded.draft && decoded.draft.uuid);
        if (!draft) return error(5, "no such draft", `${DRAFT_API}.GetResponse`);
        return ok(`${DRAFT_API}.GetResponse`, types.getResponse, {
          draft: draftAttributes(draft),
        });
      }

      if (requestTypeName === `${DRAFT_API}.GetSharedRequest`) {
        const decoded = decode(types.getSharedRequest, requestEnvelope);
        const characterID = Number(
          (decoded && decoded.character && decoded.character.sequential) || activeCharacterID,
        );
        const draft = drafts.get(characterID, decoded && decoded.draft && decoded.draft.uuid);
        if (!draft) return error(5, "no such draft", `${DRAFT_API}.GetSharedResponse`);
        return ok(`${DRAFT_API}.GetSharedResponse`, types.getSharedResponse, {
          draft: draftAttributes(draft),
        });
      }

      if (requestTypeName === `${DRAFT_API}.SaveRequest`) {
        const payload = payloadOf(requestEnvelope);
        const decoded = decode(types.saveRequest, requestEnvelope);
        const result = drafts.create(activeCharacterID, {
          name: decoded && decoded.name,
          lineName: decoded && decoded.line_name,
          layout: rawLayoutField(payload, 3),
          configurations: decodeConfigurations(
            decoded && decoded.editor_configurations,
            64,
          ),
        });
        if (result.status !== "SAVED") {
          return refusalFor(result.status, `${DRAFT_API}.SaveResponse`);
        }
        return ok(`${DRAFT_API}.SaveResponse`, types.saveResponse, {
          id: draftIdentifier(result.draft),
          attributes: draftAttributes(result.draft),
        });
      }

      if (requestTypeName === `${DRAFT_API}.UpdateRequest`) {
        const payload = payloadOf(requestEnvelope);
        const decoded = decode(types.updateRequest, requestEnvelope);
        const result = drafts.update(activeCharacterID, {
          uuid: decoded && decoded.id && decoded.id.uuid,
          name: decoded && decoded.name,
          lineName: decoded && decoded.line_name,
          layout: rawLayoutField(payload, 4),
          configurations: decodeConfigurations(
            decoded && decoded.editor_configurations,
            64,
          ),
        });
        if (result.status !== "UPDATED") {
          return refusalFor(result.status, `${DRAFT_API}.UpdateResponse`);
        }
        return ok(`${DRAFT_API}.UpdateResponse`, types.updateResponse, {
          id: draftIdentifier(result.draft),
          attributes: draftAttributes(result.draft),
        });
      }

      const decoded = decode(types.deleteRequest, requestEnvelope);
      const result = drafts.remove(activeCharacterID, decoded && decoded.id && decoded.id.uuid);
      if (result.status !== "DELETED") {
        return refusalFor(result.status, `${DRAFT_API}.DeleteResponse`);
      }
      return ok(`${DRAFT_API}.DeleteResponse`);
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SKIN_DRAFT_PROTO_ROOT,
  createThirdPartySkinDraftGatewayService,
  draftAttributes,
  draftIdentifier,
  rawLayoutField,
};
