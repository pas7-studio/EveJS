"use strict";
// eve_public.cosmetic.ship.skin.thirdparty.license.api: the licence half of the SKIN
// designer. GetOwned / Get / Activate read and move real rows owned by space/coopThirdPartySkins,
// and the admin Grant / Revoke calls are the only way a row appears or disappears.
//
// Applying a licence to a ship (Apply/Unapply) and the drafts / sequencing jobs are the next
// steps and are NOT answered here, so they keep their honest default until then - a licence
// that cannot yet be worn is better than an appearance that silently does nothing.
//
// A missing licence is NOT_FOUND; an empty GetOwned is an empty list, which is the truth for
// a character who has never been granted one.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const SKIN_LICENSE_PROTO_ROOT = protobuf.Root.fromJSON({
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
                        license: {
                          nested: {
                            Identifier: {
                              fields: {
                                character: {
                                  type: "eve_public.character.Identifier",
                                  id: 1,
                                },
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                                  id: 2,
                                },
                              },
                            },
                            Attributes: {
                              fields: {
                                activated: { type: "bool", id: 1 },
                                unactivated: { type: "uint64", id: 2 },
                                escrowed: { type: "uint64", id: 3 },
                                first_acquired: {
                                  type: "google.protobuf.Timestamp",
                                  id: 4,
                                },
                              },
                            },
                            api: {
                              nested: {
                                GetOwnedRequest: { fields: {} },
                                GetOwnedResponse: {
                                  fields: {
                                    licenses: {
                                      rule: "repeated",
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                                      id: 1,
                                    },
                                  },
                                },
                                GetRequest: {
                                  fields: {
                                    license: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                                      id: 1,
                                    },
                                  },
                                },
                                GetResponse: {
                                  fields: {
                                    license: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.license.Attributes",
                                      id: 1,
                                    },
                                  },
                                },
                                ActivateRequest: {
                                  fields: {
                                    license: {
                                      type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                                      id: 1,
                                    },
                                  },
                                },
                                ActivateResponse: { fields: {} },
                                admin: {
                                  nested: {
                                    GrantRequest: {
                                      fields: {
                                        skin: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                                          id: 1,
                                        },
                                        unactivated: { type: "uint64", id: 2 },
                                      },
                                    },
                                    GrantResponse: {
                                      fields: {
                                        license: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                                          id: 1,
                                        },
                                      },
                                    },
                                    RevokeRequest: {
                                      fields: {
                                        license: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
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
        },
      },
    },
  },
});

const API = "eve_public.cosmetic.ship.skin.thirdparty.license.api";

// Spelled out rather than built from the package prefix: the contract register scans the
// tree for these literal names, and a built string is invisible to it.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.skin.thirdparty.license.api.GetOwnedRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.license.api.GetRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.license.api.ActivateRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.license.api.admin.GrantRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.license.api.admin.RevokeRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function licenseIdentifier(characterID, skinHex) {
  return {
    character: { sequential: Number(characterID) || 0 },
    skin: { hex: String(skinHex || "") },
  };
}

function buildAttributes(row) {
  return {
    activated: row.activated === true,
    unactivated: Math.max(0, Number(row.unactivated) || 0),
    escrowed: Math.max(0, Number(row.escrowed) || 0),
    first_acquired: timestampOf(row.firstAcquiredMs),
  };
}

function createThirdPartySkinGatewayService(context = {}) {
  const skins = context.thirdPartySkins || require(path.join(
    __dirname,
    "../../../space/coopThirdPartySkins",
  )).shared();
  const types = {
    getOwnedResponse: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.GetOwnedResponse`),
    getRequest: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.GetRequest`),
    getResponse: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.GetResponse`),
    activateRequest: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.ActivateRequest`),
    grantRequest: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.admin.GrantRequest`),
    grantResponse: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.admin.GrantResponse`),
    revokeRequest: SKIN_LICENSE_PROTO_ROOT.lookupType(`${API}.admin.RevokeRequest`),
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

  return {
    name: "third-party-skins",
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
        return ok(`${API}.GetOwnedResponse`, types.getOwnedResponse, {
          licenses: skins.list(activeCharacterID)
            .map((row) => licenseIdentifier(activeCharacterID, row.skin)),
        });
      }

      if (requestTypeName === `${API}.GetRequest`) {
        const decoded = decode(types.getRequest, requestEnvelope);
        const requested = decoded && decoded.license;
        // The licence addressed is this character's own; another character's licence is
        // never answered, even by id.
        const characterID = Number(
          (requested && requested.character && requested.character.sequential) ||
            activeCharacterID,
        );
        if (characterID !== activeCharacterID) {
          return error(5, "no such skin licence for this character", `${API}.GetResponse`);
        }
        const row = skins.get(activeCharacterID, requested && requested.skin && requested.skin.hex);
        if (!row) {
          return error(5, "no such skin licence for this character", `${API}.GetResponse`);
        }
        return ok(`${API}.GetResponse`, types.getResponse, {
          license: buildAttributes(row),
        });
      }

      if (requestTypeName === `${API}.ActivateRequest`) {
        const decoded = decode(types.activateRequest, requestEnvelope);
        const result = skins.activate(
          activeCharacterID,
          decoded && decoded.license && decoded.license.skin && decoded.license.skin.hex,
        );
        if (result.status === "ACTIVATED") {
          return ok(`${API}.ActivateResponse`);
        }
        const responseTypeName = `${API}.ActivateResponse`;
        if (result.status === "NOT_FOUND") return error(5, "no such skin licence", responseTypeName);
        if (result.status === "ALREADY_ACTIVATED") {
          return error(9, "this licence is already activated", responseTypeName);
        }
        if (result.status === "NOTHING_TO_ACTIVATE") {
          return error(9, "there is no unactivated copy to activate", responseTypeName);
        }
        return error(13, `activation failed: ${result.status}`, responseTypeName);
      }

      if (requestTypeName === `${API}.admin.GrantRequest`) {
        const decoded = decode(types.grantRequest, requestEnvelope);
        const result = skins.grant(activeCharacterID, {
          skin: decoded && decoded.skin && decoded.skin.hex,
          unactivated: Number(decoded && decoded.unactivated) || 0,
        });
        if (result.status === "GRANTED") {
          return ok(`${API}.admin.GrantResponse`, types.grantResponse, {
            license: licenseIdentifier(activeCharacterID, result.licence.skin),
          });
        }
        const responseTypeName = `${API}.admin.GrantResponse`;
        if (result.status === "SKIN_REQUIRED") return error(3, "skin is required", responseTypeName);
        if (result.status === "COUNT_REQUIRED") {
          return error(3, "unactivated count is required", responseTypeName);
        }
        return error(13, `grant failed: ${result.status}`, responseTypeName);
      }

      const decoded = decode(types.revokeRequest, requestEnvelope);
      const result = skins.revoke(
        activeCharacterID,
        decoded && decoded.license && decoded.license.skin && decoded.license.skin.hex,
      );
      if (result.status === "REVOKED") {
        return ok(`${API}.admin.RevokeResponse`);
      }
      return error(result.status === "NOT_FOUND" ? 5 : 13,
        `revoke failed: ${result.status}`, `${API}.admin.RevokeResponse`);
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SKIN_LICENSE_PROTO_ROOT,
  buildAttributes,
  createThirdPartySkinGatewayService,
  licenseIdentifier,
};
