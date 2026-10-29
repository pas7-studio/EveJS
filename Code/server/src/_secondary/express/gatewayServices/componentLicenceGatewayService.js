"use strict";
// eve_public...thirdparty.component.license.*: the component half of the SKIN designer.
//
// A design uses coating/pattern components; a character may hold a finite licence for a
// component (a capacity that is spent down) or an infinite one (free to use). GetOwned lists
// both, the finite/infinite Get calls answer whatever the admin Grant created, and the admin
// Revoke calls are the only way a licence disappears. Revoking something that is not there is
// NOT_FOUND rather than a silent success.
//
// GetOwned used to be answered by the compatibility service with an empty list; it now reads
// the real rows, because an empty list and "you own nothing" must not be the same answer when
// rows exist.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const ROOT_PACKAGE = "eve_public.cosmetic.ship.skin.thirdparty.component";
const FINITE = `${ROOT_PACKAGE}.license.finite.api`;
const INFINITE = `${ROOT_PACKAGE}.license.infinite.api`;
const OWNED = `${ROOT_PACKAGE}.license.api`;

const COMPONENT_LICENCE_PROTO_ROOT = protobuf.Root.fromJSON({
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
        inventory: {
          nested: {
            genericitem: {
              nested: {
                Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
              },
            },
          },
        },
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
                        component: {
                          nested: {
                            coating: {
                              nested: {
                                Identifier: {
                                  fields: { sequential: { type: "uint64", id: 1 } },
                                },
                              },
                            },
                            Identifier: {
                              fields: {
                                coating: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.coating.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            license: {
                              nested: {
                                item: {
                                  nested: {
                                    Identifier: {
                                      fields: {
                                        item: {
                                          type: "eve_public.inventory.genericitem.Identifier",
                                          id: 1,
                                        },
                                      },
                                    },
                                    api: {
                                      nested: {
                                        ConsumeRequest: {
                                          fields: {
                                            item: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.item.Identifier",
                                              id: 1,
                                            },
                                            quantity: { type: "int32", id: 2 },
                                          },
                                        },
                                        ConsumeResponse: { fields: {} },
                                      },
                                    },
                                  },
                                },
                                finite: {
                                  nested: {
                                    Identifier: {
                                      fields: {
                                        character: { type: "eve_public.character.Identifier", id: 1 },
                                        component: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.component.Identifier",
                                          id: 2,
                                        },
                                      },
                                    },
                                    Attributes: {
                                      fields: {
                                        first_acquired: {
                                          type: "google.protobuf.Timestamp",
                                          id: 1,
                                        },
                                        capacity: { type: "uint64", id: 2 },
                                      },
                                    },
                                    api: {
                                      nested: {
                                        GetRequest: {
                                          fields: {
                                            license: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.Identifier",
                                              id: 1,
                                            },
                                          },
                                        },
                                        GetResponse: {
                                          fields: {
                                            license: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.Attributes",
                                              id: 1,
                                            },
                                          },
                                        },
                                        admin: {
                                          nested: {
                                            GrantRequest: {
                                              fields: {
                                                component: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.Identifier",
                                                  id: 1,
                                                },
                                                capacity: { type: "uint64", id: 2 },
                                              },
                                            },
                                            GrantResponse: {
                                              fields: {
                                                license: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.Identifier",
                                                  id: 1,
                                                },
                                              },
                                            },
                                            RevokeRequest: {
                                              fields: {
                                                license: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.Identifier",
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
                                infinite: {
                                  nested: {
                                    Identifier: {
                                      fields: {
                                        character: { type: "eve_public.character.Identifier", id: 1 },
                                        component: {
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.component.Identifier",
                                          id: 2,
                                        },
                                      },
                                    },
                                    Attributes: {
                                      fields: {
                                        first_acquired: {
                                          type: "google.protobuf.Timestamp",
                                          id: 1,
                                        },
                                        free: { type: "bool", id: 2 },
                                      },
                                    },
                                    api: {
                                      nested: {
                                        GetRequest: {
                                          fields: {
                                            license: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.Identifier",
                                              id: 1,
                                            },
                                          },
                                        },
                                        GetResponse: {
                                          fields: {
                                            license: {
                                              type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.Attributes",
                                              id: 1,
                                            },
                                          },
                                        },
                                        admin: {
                                          nested: {
                                            GrantRequest: {
                                              fields: {
                                                component: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.Identifier",
                                                  id: 1,
                                                },
                                              },
                                            },
                                            GrantResponse: {
                                              fields: {
                                                license: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.Identifier",
                                                  id: 1,
                                                },
                                              },
                                            },
                                            RevokeRequest: {
                                              fields: {
                                                license: {
                                                  type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.Identifier",
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
                                api: {
                                  nested: {
                                    GetOwnedRequest: { fields: {} },
                                    GetOwnedResponse: {
                                      fields: {
                                        finite: {
                                          rule: "repeated",
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.Identifier",
                                          id: 1,
                                        },
                                        infinite: {
                                          rule: "repeated",
                                          type: "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.Identifier",
                                          id: 2,
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
      },
    },
  },
});

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.api.GetOwnedRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.api.GetRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.api.admin.GrantRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.finite.api.admin.RevokeRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.api.GetRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.api.admin.GrantRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.infinite.api.admin.RevokeRequest",
  "eve_public.cosmetic.ship.skin.thirdparty.component.license.item.api.ConsumeRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function componentOf(message) {
  return Number(message && message.coating && message.coating.sequential) || 0;
}

function finiteIdentifier(characterID, component) {
  return {
    character: { sequential: Number(characterID) || 0 },
    component: { coating: { sequential: Number(component) || 0 } },
  };
}

function infiniteIdentifier(characterID, component) {
  return finiteIdentifier(characterID, component);
}

function finiteAttributes(row) {
  return {
    first_acquired: timestampOf(row.firstAcquiredMs),
    capacity: Math.max(0, Number(row.capacity) || 0),
  };
}

function infiniteAttributes(row) {
  return {
    first_acquired: timestampOf(row.firstAcquiredMs),
    free: row.free !== false,
  };
}

function createComponentLicenceGatewayService(context = {}) {
  const licences = context.componentLicences || require(path.join(
    __dirname,
    "../../../space/coopComponentLicences",
  )).shared();
  const types = {
    ownedResponse: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${OWNED}.GetOwnedResponse`),
    finiteGetRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${FINITE}.GetRequest`),
    finiteGetResponse: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${FINITE}.GetResponse`),
    finiteGrantRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${FINITE}.admin.GrantRequest`),
    finiteGrantResponse: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${FINITE}.admin.GrantResponse`),
    finiteRevokeRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${FINITE}.admin.RevokeRequest`),
    infiniteGetRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${INFINITE}.GetRequest`),
    infiniteGetResponse: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${INFINITE}.GetResponse`),
    infiniteGrantRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(`${INFINITE}.admin.GrantRequest`),
    infiniteGrantResponse: COMPONENT_LICENCE_PROTO_ROOT.lookupType(
      `${INFINITE}.admin.GrantResponse`,
    ),
    infiniteRevokeRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(
      `${INFINITE}.admin.RevokeRequest`,
    ),
    consumeRequest: COMPONENT_LICENCE_PROTO_ROOT.lookupType(
      `${ROOT_PACKAGE}.license.item.api.ConsumeRequest`,
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

  function grantRefusal(status, responseTypeName) {
    const refusals = {
      COMPONENT_REQUIRED: [3, "a component is required"],
      CAPACITY_REQUIRED: [3, "capacity must be greater than zero"],
      NO_CHARACTER: [7, "no character in this session"],
      WRITE_FAILED: [13, "the licence could not be stored"],
    };
    const refusal = refusals[status] || [13, `licence request failed: ${status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "skins-component-licences",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${OWNED}.GetOwnedRequest`) {
        const owned = licences.list(activeCharacterID);
        return ok(`${OWNED}.GetOwnedResponse`, types.ownedResponse, {
          finite: owned.finite.map((row) => finiteIdentifier(activeCharacterID, row.component)),
          infinite: owned.infinite.map((row) => infiniteIdentifier(activeCharacterID, row.component)),
        });
      }

      if (requestTypeName === `${FINITE}.GetRequest`) {
        const decoded = decode(types.finiteGetRequest, requestEnvelope);
        const requested = decoded && decoded.license;
        const characterID = Number(
          (requested && requested.character && requested.character.sequential) || activeCharacterID,
        );
        if (characterID !== activeCharacterID) {
          return error(5, "no such component licence for this character", `${FINITE}.GetResponse`);
        }
        const row = licences.finite(activeCharacterID, componentOf(requested && requested.component));
        if (!row) return error(5, "no such component licence", `${FINITE}.GetResponse`);
        return ok(`${FINITE}.GetResponse`, types.finiteGetResponse, {
          license: finiteAttributes(row),
        });
      }

      if (requestTypeName === `${INFINITE}.GetRequest`) {
        const decoded = decode(types.infiniteGetRequest, requestEnvelope);
        const requested = decoded && decoded.license;
        const characterID = Number(
          (requested && requested.character && requested.character.sequential) || activeCharacterID,
        );
        if (characterID !== activeCharacterID) {
          return error(5, "no such component licence for this character", `${INFINITE}.GetResponse`);
        }
        const row = licences.infinite(activeCharacterID, componentOf(requested && requested.component));
        if (!row) return error(5, "no such component licence", `${INFINITE}.GetResponse`);
        return ok(`${INFINITE}.GetResponse`, types.infiniteGetResponse, {
          license: infiniteAttributes(row),
        });
      }

      if (requestTypeName === `${FINITE}.admin.GrantRequest`) {
        const decoded = decode(types.finiteGrantRequest, requestEnvelope);
        const result = licences.grantFinite(activeCharacterID, {
          component: componentOf(decoded && decoded.component),
          capacity: Number(decoded && decoded.capacity) || 0,
        });
        if (result.status !== "GRANTED") {
          return grantRefusal(result.status, `${FINITE}.admin.GrantResponse`);
        }
        return ok(`${FINITE}.admin.GrantResponse`, types.finiteGrantResponse, {
          license: finiteIdentifier(activeCharacterID, result.licence.component),
        });
      }

      if (requestTypeName === `${INFINITE}.admin.GrantRequest`) {
        const decoded = decode(types.infiniteGrantRequest, requestEnvelope);
        const result = licences.grantInfinite(activeCharacterID, {
          component: componentOf(decoded && decoded.component),
        });
        if (result.status !== "GRANTED") {
          return grantRefusal(result.status, `${INFINITE}.admin.GrantResponse`);
        }
        return ok(`${INFINITE}.admin.GrantResponse`, types.infiniteGrantResponse, {
          license: infiniteIdentifier(activeCharacterID, result.licence.component),
        });
      }

      if (requestTypeName === `${ROOT_PACKAGE}.license.item.api.ConsumeRequest`) {
        const decoded = decode(types.consumeRequest, requestEnvelope);
        const result = licences.consumeItem(activeCharacterID, {
          itemID: Number(decoded && decoded.item && decoded.item.item && decoded.item.item.sequential) || 0,
          quantity: Number(decoded && decoded.quantity) || 0,
        });
        if (result.status === "CONSUMED") {
          return ok(`${ROOT_PACKAGE}.license.item.api.ConsumeResponse`);
        }
        const responseTypeName = `${ROOT_PACKAGE}.license.item.api.ConsumeResponse`;
        const refusals = {
          ITEM_REQUIRED: [3, "an item is required"],
          QUANTITY_REQUIRED: [3, "quantity must be greater than zero"],
          ITEM_NOT_FOUND: [5, "no such item"],
          ITEM_NOT_OWNED: [7, "that item belongs to somebody else"],
          NOT_A_LICENCE_ITEM: [9, "that item is not a component licence"],
          NOT_ENOUGH_ITEMS: [9, "there are not enough of that item"],
          ITEM_LOOKUP_FAILED: [13, "the item could not be read"],
          CONSUME_FAILED: [13, `the item could not be consumed: ${result.reason || ""}`.trim()],
        };
        const refusal = refusals[result.status] || [13, `consume failed: ${result.status}`];
        return error(refusal[0], refusal[1], responseTypeName);
      }

      const infinite = requestTypeName === `${INFINITE}.admin.RevokeRequest`;
      const decoded = decode(
        infinite ? types.infiniteRevokeRequest : types.finiteRevokeRequest,
        requestEnvelope,
      );
      const result = licences.revoke(activeCharacterID, {
        component: componentOf(decoded && decoded.license && decoded.license.component),
        kind: infinite ? "infinite" : "finite",
      });
      if (result.status === "REVOKED") {
        return ok(infinite ? `${INFINITE}.admin.RevokeResponse` : `${FINITE}.admin.RevokeResponse`);
      }
      const responseTypeName = infinite
        ? `${INFINITE}.admin.RevokeResponse`
        : `${FINITE}.admin.RevokeResponse`;
      if (result.status === "NOT_FOUND") {
        return error(5, "no such component licence", responseTypeName);
      }
      return error(13, `revoke failed: ${result.status}`, responseTypeName);
    },
  };
}

module.exports = {
  COMPONENT_LICENCE_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  createComponentLicenceGatewayService,
  finiteAttributes,
  infiniteAttributes,
};
