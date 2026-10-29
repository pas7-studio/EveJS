"use strict";
// eve_public.cosmetic.market.skin.listing.api.*: the skin market listings themselves.
//
// InitiateCreateListing / CancelListing / Get / GetAll / GetAllOwned and admin SetExpiration read
// and write real rows owned by space/coopSkinListings. Creating a listing moves the copies into
// escrow in the seller's licence row first, cancelling returns exactly those copies, and only the
// seller may cancel. GetAll and GetAllOwned used to be answered with an empty list by the
// compatibility service - a listing a player really created was invisible.
//
// InitiatePurchaseListing is NOT answered here: paying for a listing needs the wallet path, and a
// purchase that takes nothing must not report success.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const LISTING_API = "eve_public.cosmetic.market.skin.listing.api";
const LISTING = "eve_public.cosmetic.market.skin.listing";

const SKIN_LISTING_PROTO_ROOT = protobuf.Root.fromJSON({
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
            Duration: {
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
        isk: {
          nested: {
            Currency: {
              fields: {
                units: { type: "sint64", id: 1 },
                nanos: { type: "sint32", id: 2 },
              },
            },
          },
        },
        plex: {
          nested: {
            Currency: { fields: { total_in_cents: { type: "sint64", id: 1 } } },
          },
        },
        cosmetic: {
          nested: {
            market: {
              nested: {
                transaction: {
                  nested: {
                    Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                  },
                },
                skin: {
                  nested: {
                    listing: {
                      nested: {
                        Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                        ListingTarget: {
                          fields: {
                            public: { type: "bool", id: 1 },
                          },
                        },
                        Attributes: {
                          fields: {
                            seller: { type: "eve_public.character.Identifier", id: 2 },
                            created: { type: "google.protobuf.Timestamp", id: 3 },
                            expires: { type: "google.protobuf.Timestamp", id: 4 },
                            isk: { type: "eve_public.isk.Currency", id: 5 },
                            skin: {
                              type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                              id: 7,
                            },
                            quantity: { type: "uint32", id: 8 },
                            branded: { type: "bool", id: 10 },
                          },
                        },
                        Entry: {
                          fields: {
                            id: {
                              type: "eve_public.cosmetic.market.skin.listing.Identifier",
                              id: 1,
                            },
                            attributes: {
                              type: "eve_public.cosmetic.market.skin.listing.Attributes",
                              id: 2,
                            },
                          },
                        },
                        api: {
                          nested: {
                            GetAllRequest: { fields: {} },
                            GetAllResponse: {
                              fields: {
                                listings: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.market.skin.listing.Entry",
                                  id: 1,
                                },
                              },
                            },
                            GetAllOwnedRequest: { fields: {} },
                            GetAllOwnedResponse: {
                              fields: {
                                listings: {
                                  rule: "repeated",
                                  type: "eve_public.cosmetic.market.skin.listing.Entry",
                                  id: 1,
                                },
                              },
                            },
                            GetRequest: {
                              fields: {
                                listing: {
                                  type: "eve_public.cosmetic.market.skin.listing.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            GetResponse: {
                              fields: {
                                listing: {
                                  type: "eve_public.cosmetic.market.skin.listing.Entry",
                                  id: 1,
                                },
                              },
                            },
                            InitiateCreateListingRequest: {
                              fields: {
                                price_isk: { type: "eve_public.isk.Currency", id: 1 },
                                price_plex: { type: "eve_public.plex.Currency", id: 2 },
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.license.Identifier",
                                  id: 3,
                                },
                                duration: { type: "google.protobuf.Duration", id: 4 },
                                quantity: { type: "uint32", id: 5 },
                              },
                            },
                            InitiateCreateListingResponse: {
                              fields: {
                                transaction: {
                                  type: "eve_public.cosmetic.market.transaction.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            CancelListingRequest: {
                              fields: {
                                listing: {
                                  type: "eve_public.cosmetic.market.skin.listing.Identifier",
                                  id: 1,
                                },
                              },
                            },
                            CancelListingResponse: { fields: {} },
                            admin: {
                              nested: {
                                SetExpirationRequest: {
                                  fields: {
                                    listing: {
                                      type: "eve_public.cosmetic.market.skin.listing.Identifier",
                                      id: 1,
                                    },
                                    expires: { type: "google.protobuf.Timestamp", id: 2 },
                                  },
                                },
                                SetExpirationResponse: { fields: {} },
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
                                character: { type: "eve_public.character.Identifier", id: 1 },
                                skin: {
                                  type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
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
});

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.market.skin.listing.api.GetAllRequest",
  "eve_public.cosmetic.market.skin.listing.api.GetAllOwnedRequest",
  "eve_public.cosmetic.market.skin.listing.api.GetRequest",
  "eve_public.cosmetic.market.skin.listing.api.InitiateCreateListingRequest",
  "eve_public.cosmetic.market.skin.listing.api.CancelListingRequest",
  "eve_public.cosmetic.market.skin.listing.api.admin.SetExpirationRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function entryOf(row) {
  const attributes = {
    seller: { sequential: Math.max(0, Number(row.sellerID) || 0) },
    created: timestampOf(row.createdMs),
    isk: { units: Math.max(0, Number(row.priceUnits) || 0), nanos: Number(row.priceNanos) || 0 },
    // a licence identifier names the seller and the skin, which is what the listing sells
    skin: {
      character: { sequential: Math.max(0, Number(row.sellerID) || 0) },
      skin: { hex: String(row.skin || "") },
    },
    quantity: Math.max(0, Number(row.quantity) || 0),
    branded: false,
  };
  const expires = timestampOf(row.expiresMs);
  if (expires) attributes.expires = expires;
  return {
    id: { uuid: Buffer.from(String(row.uuid || ""), "hex") },
    attributes,
  };
}

function createSkinListingGatewayService(context = {}) {
  const listings = context.skinListings || require(path.join(
    __dirname,
    "../../../space/coopSkinListings",
  )).shared();
  const types = {
    getAllResponse: SKIN_LISTING_PROTO_ROOT.lookupType(`${LISTING_API}.GetAllResponse`),
    getAllOwnedResponse: SKIN_LISTING_PROTO_ROOT.lookupType(`${LISTING_API}.GetAllOwnedResponse`),
    getRequest: SKIN_LISTING_PROTO_ROOT.lookupType(`${LISTING_API}.GetRequest`),
    getResponse: SKIN_LISTING_PROTO_ROOT.lookupType(`${LISTING_API}.GetResponse`),
    createRequest: SKIN_LISTING_PROTO_ROOT.lookupType(
      `${LISTING_API}.InitiateCreateListingRequest`,
    ),
    createResponse: SKIN_LISTING_PROTO_ROOT.lookupType(
      `${LISTING_API}.InitiateCreateListingResponse`,
    ),
    cancelRequest: SKIN_LISTING_PROTO_ROOT.lookupType(`${LISTING_API}.CancelListingRequest`),
    expirationRequest: SKIN_LISTING_PROTO_ROOT.lookupType(
      `${LISTING_API}.admin.SetExpirationRequest`,
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
      SKIN_REQUIRED: [3, "a skin is required"],
      QUANTITY_REQUIRED: [3, "quantity must be greater than zero"],
      PRICE_REQUIRED: [3, "an ISK price is required"],
      UUID_REQUIRED: [3, "a listing id is required"],
      NOT_FOUND: [5, "no such listing"],
      NOT_YOURS: [7, "that listing belongs to somebody else"],
      NOT_ENOUGH_COPIES: [9, "there are not enough unactivated copies of that skin"],
      TOO_MANY_LISTINGS: [9, "the market holds too many listings"],
      EXPIRY_REQUIRED: [3, "an expiry is required"],
      EXPIRY_IN_PAST: [3, "that expiry is already in the past"],
      RELEASE_FAILED: [13, "the escrowed copies could not be returned"],
      NO_CHARACTER: [7, "no character in this session"],
      WRITE_FAILED: [13, "the listing could not be stored"],
      UUID_FAILED: [13, "a listing id could not be assigned"],
    };
    const refusal = refusals[status] || [13, `listing request failed: ${status}`];
    return error(refusal[0], refusal[1], responseTypeName);
  }

  return {
    name: "skin-market-listings",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${LISTING_API}.GetAllRequest`) {
        return ok(`${LISTING_API}.GetAllResponse`, types.getAllResponse, {
          listings: listings.all().map(entryOf),
        });
      }

      if (requestTypeName === `${LISTING_API}.GetAllOwnedRequest`) {
        return ok(`${LISTING_API}.GetAllOwnedResponse`, types.getAllOwnedResponse, {
          listings: listings.owned(activeCharacterID).map(entryOf),
        });
      }

      if (requestTypeName === `${LISTING_API}.GetRequest`) {
        const decoded = decode(types.getRequest, requestEnvelope);
        const row = listings.get(decoded && decoded.listing && decoded.listing.uuid);
        if (!row) return error(5, "no such listing", `${LISTING_API}.GetResponse`);
        return ok(`${LISTING_API}.GetResponse`, types.getResponse, { listing: entryOf(row) });
      }

      if (requestTypeName === `${LISTING_API}.InitiateCreateListingRequest`) {
        const decoded = decode(types.createRequest, requestEnvelope);
        const durationMs = Number(decoded && decoded.duration && decoded.duration.seconds) * 1000;
        const result = listings.create(activeCharacterID, {
          skin: decoded && decoded.skin && decoded.skin.skin && decoded.skin.skin.hex,
          quantity: Number(decoded && decoded.quantity) || 0,
          priceUnits: Number(decoded && decoded.price_isk && decoded.price_isk.units) || 0,
          priceNanos: Number(decoded && decoded.price_isk && decoded.price_isk.nanos) || 0,
          durationMs,
        });
        if (result.status !== "CREATED") {
          return refusalFor(result.status, `${LISTING_API}.InitiateCreateListingResponse`);
        }
        return ok(`${LISTING_API}.InitiateCreateListingResponse`, types.createResponse, {
          transaction: { uuid: Buffer.from(result.transaction, "hex") },
        });
      }

      if (requestTypeName === `${LISTING_API}.CancelListingRequest`) {
        const decoded = decode(types.cancelRequest, requestEnvelope);
        const result = listings.cancel(
          activeCharacterID,
          decoded && decoded.listing && decoded.listing.uuid,
        );
        if (result.status === "CANCELLED") return ok(`${LISTING_API}.CancelListingResponse`);
        return refusalFor(result.status, `${LISTING_API}.CancelListingResponse`);
      }

      const decoded = decode(types.expirationRequest, requestEnvelope);
      const result = listings.setExpiration(
        activeCharacterID,
        decoded && decoded.listing && decoded.listing.uuid,
        Number(decoded && decoded.expires && decoded.expires.seconds) * 1000,
      );
      if (result.status === "EXPIRY_SET") {
        return ok(`${LISTING_API}.admin.SetExpirationResponse`);
      }
      return refusalFor(result.status, `${LISTING_API}.admin.SetExpirationResponse`);
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SKIN_LISTING_PROTO_ROOT,
  createSkinListingGatewayService,
  entryOf,
};
