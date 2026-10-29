"use strict";
// eve_public.cosmetic.market.transaction.api.*: the record of a market purchase.
//
// The purchase itself already moves the ISK and the copies; this call is what lets the client show
// what happened. Both sides keep their own copy of the row (space/coopSkinListings writes it into
// the buyer's and the seller's record), so each of them asks for it as themselves.
//
// `Attributes.status` is the client's own enum: 0 unspecified, 1 initiated, 2 failed, 3 successful.
// Only successful transactions exist here, because a purchase that failed leaves no row at all.
const path = require("path");
const protobuf = require("protobufjs");

const { encodePayload, getActiveCharacterID } = require("./gatewayServiceHelpers");

const TRANSACTION_API = "eve_public.cosmetic.market.transaction.api";
const TRANSACTION = "eve_public.cosmetic.market.transaction";
const STATUS_SUCCESSFUL = 3;

const TRANSACTION_PROTO_ROOT = protobuf.Root.fromJSON({
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
        cosmetic: {
          nested: {
            market: {
              nested: {
                transaction: {
                  nested: {
                    Identifier: { fields: { uuid: { type: "bytes", id: 1 } } },
                    Attributes: {
                      fields: {
                        last_updated: { type: "google.protobuf.Timestamp", id: 1 },
                        status: {
                          type: "eve_public.cosmetic.market.transaction.Attributes.Status",
                          id: 2,
                        },
                      },
                      nested: {
                        Status: {
                          values: {
                            STATUS_CODE_UNSPECIFIED: 0,
                            INITIATED: 1,
                            FAILED: 2,
                            SUCCESSFUL: 3,
                          },
                        },
                      },
                    },
                    api: {
                      nested: {
                        GetAllRequest: { fields: {} },
                        GetAllResponse: {
                          fields: {
                            transactions: {
                              rule: "repeated",
                              type: "eve_public.cosmetic.market.transaction.Identifier",
                              id: 1,
                            },
                          },
                        },
                        GetRequest: {
                          fields: {
                            transaction: {
                              type: "eve_public.cosmetic.market.transaction.Identifier",
                              id: 1,
                            },
                          },
                        },
                        GetResponse: {
                          fields: {
                            status: {
                              type: "eve_public.cosmetic.market.transaction.Attributes",
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
});

// Spelled out: the contract register scans for these literal names.
const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.market.transaction.api.GetRequest",
  "eve_public.cosmetic.market.transaction.api.GetAllRequest",
]);

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  if (value <= 0) return undefined;
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function createMarketTransactionGatewayService(context = {}) {
  const listings = context.skinListings || require(path.join(
    __dirname,
    "../../../space/coopSkinListings",
  )).shared();
  const types = {
    getRequest: TRANSACTION_PROTO_ROOT.lookupType(`${TRANSACTION_API}.GetRequest`),
    getResponse: TRANSACTION_PROTO_ROOT.lookupType(`${TRANSACTION_API}.GetResponse`),
    getAllResponse: TRANSACTION_PROTO_ROOT.lookupType(`${TRANSACTION_API}.GetAllResponse`),
  };

  function decode(type, requestEnvelope) {
    return type.decode(
      (requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value) ||
        Buffer.alloc(0),
    );
  }

  return {
    name: "market-transactions",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }
      const activeCharacterID = Number(getActiveCharacterID(requestEnvelope) || 0);

      if (requestTypeName === `${TRANSACTION_API}.GetAllRequest`) {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: `${TRANSACTION_API}.GetAllResponse`,
          responsePayloadBuffer: encodePayload(types.getAllResponse, {
            transactions: listings.transactionRows(activeCharacterID).map((row) => ({
              uuid: Buffer.from(String(row.uuid || ""), "hex"),
            })),
          }),
        };
      }

      const decoded = decode(types.getRequest, requestEnvelope);
      const row = listings.transaction(
        activeCharacterID,
        decoded && decoded.transaction && decoded.transaction.uuid,
      );
      if (!row) {
        return {
          statusCode: 5,
          statusMessage: "no such transaction",
          responseTypeName: `${TRANSACTION_API}.GetResponse`,
          responsePayloadBuffer: Buffer.alloc(0),
        };
      }
      const payload = {
        status: {
          status: Number(row.status) || STATUS_SUCCESSFUL,
        },
      };
      const updated = timestampOf(row.updatedMs);
      if (updated) payload.status.last_updated = updated;
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: `${TRANSACTION_API}.GetResponse`,
        responsePayloadBuffer: encodePayload(types.getResponse, payload),
      };
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  STATUS_SUCCESSFUL,
  TRANSACTION_PROTO_ROOT,
  createMarketTransactionGatewayService,
};
