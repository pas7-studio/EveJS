"use strict";
// eve_public.cosmetic.character.title.api.*: the title half of the character cosmetics.
//
// GetOwned / Equip / Unequip / GetEquippedForCharacter read and move real rows owned by
// space/coopCharacterTitles, and the admin Grant / Revoke calls are the only way a title
// appears or disappears for a character. Equipping a title that was never granted is refused;
// revoking the worn title also clears it, so nobody wears what they no longer own.
//
// The title catalogue itself is client content: it arrives through a definition checkpoint, and
// nothing here invents a title id out of thin air. This service answers about ownership and the
// worn slot only.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const API = "eve_public.cosmetic.character.title.api";

const TITLE_PROTO_ROOT = protobuf.Root.fromJSON({
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
            character: {
              nested: {
                title: {
                  nested: {
                    definition: {
                      nested: {
                        Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                      },
                    },
                    api: {
                      nested: {
                        GetOwnedRequest: { fields: {} },
                        GetOwnedResponse: {
                          fields: {
                            titles: {
                              rule: "repeated",
                              type: "eve_public.cosmetic.character.title.definition.Identifier",
                              id: 1,
                            },
                          },
                        },
                        EquipRequest: {
                          fields: {
                            title: {
                              type: "eve_public.cosmetic.character.title.definition.Identifier",
                              id: 1,
                            },
                          },
                        },
                        EquipResponse: { fields: {} },
                        UnequipRequest: { fields: {} },
                        UnequipResponse: { fields: {} },
                        GetEquippedForCharacterRequest: {
                          fields: {
                            character: { type: "eve_public.character.Identifier", id: 1 },
                          },
                        },
                        GetEquippedForCharacterResponse: {
                          fields: {
                            title: {
                              type: "eve_public.cosmetic.character.title.definition.Identifier",
                              id: 1,
                            },
                            no_title: { type: "bool", id: 2 },
                          },
                        },
                        SetRequest: {
                          fields: {
                            character: { type: "eve_public.character.Identifier", id: 1 },
                            title: {
                              type: "eve_public.cosmetic.character.title.definition.Identifier",
                              id: 2,
                            },
                            no_title: { type: "bool", id: 3 },
                          },
                        },
                        SetResponse: { fields: {} },
                        admin: {
                          nested: {
                            GrantRequest: {
                              fields: {
                                id: {
                                  type: "eve_public.cosmetic.character.title.definition.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            GrantResponse: { fields: {} },
                            RevokeRequest: {
                              fields: {
                                id: {
                                  type: "eve_public.cosmetic.character.title.definition.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            RevokeResponse: { fields: {} },
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

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.character.title.api.GetOwnedRequest",
  "eve_public.cosmetic.character.title.api.EquipRequest",
  "eve_public.cosmetic.character.title.api.UnequipRequest",
  "eve_public.cosmetic.character.title.api.GetEquippedForCharacterRequest",
  "eve_public.cosmetic.character.title.api.admin.GrantRequest",
  "eve_public.cosmetic.character.title.api.admin.RevokeRequest",
]);

function identifierOf(uuid) {
  return { uuid: Buffer.from(String(uuid || ""), "hex") };
}

function createCharacterTitleGatewayService(context = {}) {
  const titles = context.characterTitles || require(path.join(
    __dirname,
    "../../../space/coopCharacterTitles",
  )).shared();
  const types = {
    ownedResponse: TITLE_PROTO_ROOT.lookupType(`${API}.GetOwnedResponse`),
    equipRequest: TITLE_PROTO_ROOT.lookupType(`${API}.EquipRequest`),
    equippedRequest: TITLE_PROTO_ROOT.lookupType(`${API}.GetEquippedForCharacterRequest`),
    equippedResponse: TITLE_PROTO_ROOT.lookupType(`${API}.GetEquippedForCharacterResponse`),
    grantRequest: TITLE_PROTO_ROOT.lookupType(`${API}.admin.GrantRequest`),
    revokeRequest: TITLE_PROTO_ROOT.lookupType(`${API}.admin.RevokeRequest`),
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
      TITLE_REQUIRED: [3, "a title id is required"],
      NOT_FOUND: [5, "that character does not own this title"],
      NOT_OWNED: [9, "that character does not own this title"],
      TOO_MANY_TITLES: [9, "this character holds too many titles"],
      NO_CHARACTER: [7, "no character in this session"],
      WRITE_FAILED: [13, "the title could not be stored"],
    };
    const refusal = refusals[status] || [13, `title request failed: ${status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "character-titles",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${API}.GetOwnedRequest`) {
        return ok(`${API}.GetOwnedResponse`, types.ownedResponse, {
          titles: titles.list(activeCharacterID).map((row) => identifierOf(row.uuid)),
        });
      }

      if (requestTypeName === `${API}.EquipRequest`) {
        const decoded = decode(types.equipRequest, requestEnvelope);
        const result = titles.equip(
          activeCharacterID,
          decoded && decoded.title && decoded.title.uuid,
        );
        if (result.status === "EQUIPPED") return ok(`${API}.EquipResponse`);
        return refusalFor(result.status, `${API}.EquipResponse`);
      }

      if (requestTypeName === `${API}.UnequipRequest`) {
        const result = titles.unequip(activeCharacterID);
        if (result.status === "UNEQUIPPED") return ok(`${API}.UnequipResponse`);
        return refusalFor(result.status, `${API}.UnequipResponse`);
      }

      if (requestTypeName === `${API}.GetEquippedForCharacterRequest`) {
        const decoded = decode(types.equippedRequest, requestEnvelope);
        const characterID = Number(
          (decoded && decoded.character && decoded.character.sequential) || activeCharacterID,
        );
        const worn = titles.equipped(characterID);
        return ok(`${API}.GetEquippedForCharacterResponse`, types.equippedResponse, worn
          ? { title: identifierOf(worn), no_title: false }
          : { no_title: true });
      }

      const grant = requestTypeName === `${API}.admin.GrantRequest`;
      const decoded = decode(grant ? types.grantRequest : types.revokeRequest, requestEnvelope);
      const uuid = decoded && decoded.id && decoded.id.uuid;
      const result = grant
        ? titles.grant(activeCharacterID, uuid)
        : titles.revoke(activeCharacterID, uuid);
      const expected = grant ? "GRANTED" : "REVOKED";
      if (result.status === expected) {
        return ok(grant ? `${API}.admin.GrantResponse` : `${API}.admin.RevokeResponse`);
      }
      return refusalFor(result.status,
        grant ? `${API}.admin.GrantResponse` : `${API}.admin.RevokeResponse`);
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  TITLE_PROTO_ROOT,
  createCharacterTitleGatewayService,
};
