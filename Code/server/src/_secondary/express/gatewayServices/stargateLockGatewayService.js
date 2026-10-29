"use strict";
// eve_public.stargate.lock.api.admin.{Apply,Delete,GetAll}: real stargate restrictions.
//
// space/coopStargateLocks owns the persisted locks and space/runtime.startStargateJump
// refuses a jump through a locked gate, so this is enforcement, not decoration. The
// admin calls below are what the client's own admin UI sends.
//
// The public eve_public.stargate.lock.api.GetRequest is deliberately NOT handled: its
// response is a single `gate` and the request carries no fields at all, so answering it
// would mean guessing which gate the player is standing at (the gateway never sees the
// scene). The jump path knows the gate exactly, and refuses there; see docs/CLIENT_GAPS.md.
const path = require("path");
const protobuf = require("protobufjs");

const { encodePayload } = require("./gatewayServiceHelpers");

const LOCK_PROTO_ROOT = protobuf.Root.fromJSON(
{
  "nested": {
    "google": {
      "nested": {
        "protobuf": {
          "nested": {
            "Timestamp": {
              "fields": {
                "seconds": {
                  "type": "int64",
                  "id": 1
                },
                "nanos": {
                  "type": "int32",
                  "id": 2
                }
              }
            }
          }
        }
      }
    },
    "eve_public": {
      "nested": {
        "character": {
          "nested": {
            "Identifier": {
              "fields": {
                "sequential": {
                  "type": "uint32",
                  "id": 1
                }
              }
            }
          }
        },
        "solarsystem": {
          "nested": {
            "Identifier": {
              "fields": {
                "sequential": {
                  "type": "uint64",
                  "id": 1
                }
              }
            }
          }
        },
        "stargate": {
          "nested": {
            "Identifier": {
              "fields": {
                "sequential": {
                  "type": "uint64",
                  "id": 1
                }
              }
            },
            "lock": {
              "nested": {
                "api": {
                  "nested": {
                    "admin": {
                      "nested": {
                        "LockDetail": {
                          "fields": {
                            "solarsystem": {
                              "type": "eve_public.solarsystem.Identifier",
                              "id": 1
                            },
                            "gate": {
                              "type": "eve_public.stargate.Identifier",
                              "id": 2
                            },
                            "expiry": {
                              "type": "google.protobuf.Timestamp",
                              "id": 3
                            }
                          }
                        },
                        "ApplyRequest": {
                          "fields": {
                            "character": {
                              "type": "eve_public.character.Identifier",
                              "id": 1
                            },
                            "solarsystem": {
                              "type": "eve_public.solarsystem.Identifier",
                              "id": 2
                            },
                            "gate": {
                              "type": "eve_public.stargate.Identifier",
                              "id": 3
                            },
                            "expiry": {
                              "type": "google.protobuf.Timestamp",
                              "id": 4
                            }
                          }
                        },
                        "ApplyResponse": {},
                        "DeleteRequest": {
                          "fields": {
                            "character": {
                              "type": "eve_public.character.Identifier",
                              "id": 1
                            },
                            "solarsystem": {
                              "type": "eve_public.solarsystem.Identifier",
                              "id": 2
                            }
                          }
                        },
                        "DeleteResponse": {},
                        "GetAllRequest": {
                          "fields": {
                            "character": {
                              "type": "eve_public.character.Identifier",
                              "id": 1
                            }
                          }
                        },
                        "GetAllResponse": {
                          "fields": {
                            "locks": {
                              "rule": "repeated",
                              "type": "LockDetail",
                              "id": 1
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
},
);

const ADMIN_PATH = "eve_public.stargate.lock.api.admin";

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.stargate.lock.api.admin.ApplyRequest",
  "eve_public.stargate.lock.api.admin.DeleteRequest",
  "eve_public.stargate.lock.api.admin.GetAllRequest",
]);

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function timestampOf(ms) {
  const value = Math.max(0, Math.trunc(Number(ms) || 0));
  return { seconds: Math.floor(value / 1000), nanos: (value % 1000) * 1e6 };
}

function msOf(timestamp) {
  if (!timestamp) return 0;
  const seconds = Number(timestamp.seconds) || 0;
  const nanos = Number(timestamp.nanos) || 0;
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

function buildLockDetail(lock) {
  return {
    solarsystem: { sequential: lock.systemID },
    gate: { sequential: lock.gateID },
    expiry: timestampOf(lock.expiresAtMs),
  };
}

function createStargateLockGatewayService(context = {}) {
  const locks = context.stargateLocks || require(path.join(
    __dirname,
    "../../../space/coopStargateLocks",
  )).shared();
  const types = {
    applyRequest: LOCK_PROTO_ROOT.lookupType(`${ADMIN_PATH}.ApplyRequest`),
    deleteRequest: LOCK_PROTO_ROOT.lookupType(`${ADMIN_PATH}.DeleteRequest`),
    getAllRequest: LOCK_PROTO_ROOT.lookupType(`${ADMIN_PATH}.GetAllRequest`),
    getAllResponse: LOCK_PROTO_ROOT.lookupType(`${ADMIN_PATH}.GetAllResponse`),
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
    name: "stargate-locks",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (requestTypeName === "eve_public.stargate.lock.api.admin.ApplyRequest") {
        const request = decode(types.applyRequest, requestEnvelope);
        const result = locks.apply({
          systemID: positive(request?.solarsystem?.sequential),
          gateID: positive(request?.gate?.sequential),
          expiresAtMs: msOf(request && request.expiry),
          byCharacterID: positive(request?.character?.sequential),
        });
        if (result.status === "APPLIED") {
          return {
            statusCode: 200,
            statusMessage: "",
            responseTypeName: "eve_public.stargate.lock.api.admin.ApplyResponse",
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        const refusal = {
          DISABLED: "stargate locks are disabled",
          SYSTEM_REQUIRED: "solarsystem is required",
          GATE_REQUIRED: "gate is required",
          EXPIRY_REQUIRED: "expiry is required",
          ALREADY_EXPIRED: "expiry is in the past",
          TOO_MANY_LOCKS: "too many locks are already active",
          WRITE_FAILED: "the lock could not be stored",
        }[result.status] || result.status;
        return error(9, refusal, "eve_public.stargate.lock.api.admin.ApplyResponse");
      }

      if (requestTypeName === "eve_public.stargate.lock.api.admin.DeleteRequest") {
        const request = decode(types.deleteRequest, requestEnvelope);
        const result = locks.deleteForSystem(positive(request?.solarsystem?.sequential));
        if (result.status === "DELETED") {
          return {
            statusCode: 200,
            statusMessage: "",
            responseTypeName: "eve_public.stargate.lock.api.admin.DeleteResponse",
            responsePayloadBuffer: Buffer.alloc(0),
          };
        }
        const refusal = {
          DISABLED: "stargate locks are disabled",
          SYSTEM_REQUIRED: "solarsystem is required",
          NOT_FOUND: "that solar system has no lock",
          WRITE_FAILED: "the lock could not be removed",
        }[result.status] || result.status;
        return error(5, refusal, "eve_public.stargate.lock.api.admin.DeleteResponse");
      }

      // Only GetAll reaches here: anything else must fall through to the next service.
      if (requestTypeName !== "eve_public.stargate.lock.api.admin.GetAllRequest") {
        return null;
      }
      const list = locks.list();
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: "eve_public.stargate.lock.api.admin.GetAllResponse",
        responsePayloadBuffer: encodePayload(types.getAllResponse, {
          locks: list.map(buildLockDetail),
        }),
      };
    },
  };
}

module.exports = {
  ADMIN_PATH,
  HANDLED_REQUEST_TYPES,
  LOCK_PROTO_ROOT,
  buildLockDetail,
  createStargateLockGatewayService,
  msOf,
  timestampOf,
};
