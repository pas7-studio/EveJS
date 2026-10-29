"use strict";
// eve_public.cosmetic.market.api: the fee and tax quotes the skin market window asks for before
// anything is listed or bought.
//
// All four answers come from one policy module (space/coopSkinMarketFees), so the window cannot
// quote a broker fee in one place and a different one in another. Rates are fractions in nanos
// (10 000 000 = 1 %) and the buyer fee is loyalty points per item, which is what the client's
// message carries.
const path = require("path");
const protobuf = require("protobufjs");

const { encodePayload } = require("./gatewayServiceHelpers");

const MARKET = "eve_public.cosmetic.market.api";

const SKIN_MARKET_FEES_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
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
        loyaltypoints: {
          nested: {
            Currency: { fields: { amount: { type: "uint64", id: 1 } } },
          },
        },
        cosmetic: {
          nested: {
            market: {
              nested: {
                skin: {
                  nested: {
                    listing: {
                      nested: {
                        ListingTarget: {
                          fields: {
                            public: { type: "bool", id: 1 },
                          },
                        },
                      },
                    },
                  },
                },
                BrokerFee: {
                  fields: {
                    duration: { type: "google.protobuf.Duration", id: 1 },
                    fee: { type: "eve_public.isk.Currency", id: 2 },
                  },
                },
                TaxRate: {
                  fields: {
                    units: { type: "sint64", id: 1 },
                    nanos: { type: "sint32", id: 2 },
                  },
                },
                BuyerFee: {
                  fields: {
                    loyalty_points: { type: "eve_public.loyaltypoints.Currency", id: 1 },
                  },
                },
                api: {
                  nested: {
                    GetBrokerFeesRequest: {
                      fields: {
                        target: {
                          type: "eve_public.cosmetic.market.skin.listing.ListingTarget",
                          id: 1,
                        },
                      },
                    },
                    GetBrokerFeesResponse: {
                      fields: {
                        broker_fees: {
                          rule: "repeated",
                          type: "eve_public.cosmetic.market.BrokerFee",
                          id: 1,
                        },
                        broker_fees_per_duration: {
                          rule: "repeated",
                          type: "eve_public.cosmetic.market.api.GetBrokerFeesResponse.FeePerDuration",
                          id: 2,
                        },
                      },
                      nested: {
                        FeePerDuration: {
                          fields: {
                            duration: { type: "google.protobuf.Duration", id: 1 },
                            broker_fee: { type: "eve_public.cosmetic.market.BrokerFee", id: 2 },
                          },
                        },
                      },
                    },
                    GetTaxRateRequest: {
                      fields: {
                        target: {
                          type: "eve_public.cosmetic.market.skin.listing.ListingTarget",
                          id: 1,
                        },
                      },
                    },
                    GetTaxRateResponse: {
                      fields: {
                        tax_rate: { type: "eve_public.cosmetic.market.TaxRate", id: 1 },
                      },
                    },
                    GetBuyerFeeRequest: {
                      fields: {
                        target: {
                          type: "eve_public.cosmetic.market.skin.listing.ListingTarget",
                          id: 1,
                        },
                        skin: {
                          type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                          id: 2,
                        },
                      },
                    },
                    GetBuyerFeeResponse: {
                      fields: {
                        buyer_fee: { type: "eve_public.cosmetic.market.BuyerFee", id: 1 },
                      },
                    },
                    GetBuyerFeesDefinitionRequest: { fields: {} },
                    GetBuyerFeesDefinitionResponse: {
                      fields: {
                        buyer_fees_version: { type: "string", id: 2 },
                        buyer_fees: {
                          rule: "repeated",
                          type: "eve_public.cosmetic.market.api.GetBuyerFeesDefinitionResponse.FeePerTier",
                          id: 1,
                        },
                      },
                      nested: {
                        FeePerTier: {
                          fields: {
                            skin_tier: {
                              type: "eve_public.cosmetic.ship.skin.thirdparty.Tier",
                              id: 1,
                            },
                            default_fee: {
                              type: "eve_public.cosmetic.market.BuyerFee",
                              id: 2,
                            },
                            branded_fee: {
                              type: "eve_public.cosmetic.market.BuyerFee",
                              id: 3,
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
                        Tier: { fields: { level: { type: "uint32", id: 1 } } },
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
  "eve_public.cosmetic.market.api.GetBrokerFeesRequest",
  "eve_public.cosmetic.market.api.GetTaxRateRequest",
  "eve_public.cosmetic.market.api.GetBuyerFeeRequest",
  "eve_public.cosmetic.market.api.GetBuyerFeesDefinitionRequest",
]);

function durationOf(seconds) {
  return { seconds: Math.max(0, Math.trunc(Number(seconds) || 0)) };
}

function createSkinMarketFeesGatewayService(context = {}) {
  const fees = context.skinMarketFees || require(path.join(
    __dirname,
    "../../../space/coopSkinMarketFees",
  ));
  const types = {
    brokerFeesResponse: SKIN_MARKET_FEES_PROTO_ROOT.lookupType(
      `${MARKET}.GetBrokerFeesResponse`,
    ),
    taxRateResponse: SKIN_MARKET_FEES_PROTO_ROOT.lookupType(`${MARKET}.GetTaxRateResponse`),
    buyerFeeResponse: SKIN_MARKET_FEES_PROTO_ROOT.lookupType(`${MARKET}.GetBuyerFeeResponse`),
    buyerFeesDefinitionResponse: SKIN_MARKET_FEES_PROTO_ROOT.lookupType(
      `${MARKET}.GetBuyerFeesDefinitionResponse`,
    ),
  };

  function ok(responseTypeName, type, payload) {
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName,
      responsePayloadBuffer: encodePayload(type, payload || {}),
    };
  }

  return {
    name: "skin-market-fees",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName) {
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }

      if (requestTypeName === `${MARKET}.GetBrokerFeesRequest`) {
        const rows = fees.brokerFees();
        return ok(`${MARKET}.GetBrokerFeesResponse`, types.brokerFeesResponse, {
          broker_fees: rows.map((row) => ({
            duration: durationOf(row.durationSeconds),
            fee: { units: 0, nanos: row.nanos },
          })),
          broker_fees_per_duration: rows.map((row) => ({
            duration: durationOf(row.durationSeconds),
            broker_fee: { duration: durationOf(row.durationSeconds), fee: { units: 0, nanos: row.nanos } },
          })),
        });
      }

      if (requestTypeName === `${MARKET}.GetTaxRateRequest`) {
        const rate = fees.taxRate();
        return ok(`${MARKET}.GetTaxRateResponse`, types.taxRateResponse, {
          tax_rate: { units: rate.units, nanos: rate.nanos },
        });
      }

      if (requestTypeName === `${MARKET}.GetBuyerFeeRequest`) {
        const quote = fees.buyerFee();
        return ok(`${MARKET}.GetBuyerFeeResponse`, types.buyerFeeResponse, {
          buyer_fee: { loyalty_points: { amount: quote.loyaltyPoints } },
        });
      }

      const definition = fees.buyerFeesDefinition();
      return ok(`${MARKET}.GetBuyerFeesDefinitionResponse`, types.buyerFeesDefinitionResponse, {
        buyer_fees_version: definition.version,
        buyer_fees: definition.tiers.map((row) => ({
          skin_tier: { level: row.tier },
          default_fee: { loyalty_points: { amount: row.defaultFee } },
          branded_fee: { loyalty_points: { amount: row.brandedFee } },
        })),
      });
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SKIN_MARKET_FEES_PROTO_ROOT,
  createSkinMarketFeesGatewayService,
};
