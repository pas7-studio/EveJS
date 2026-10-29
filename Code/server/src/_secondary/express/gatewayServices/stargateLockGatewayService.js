"use strict";
// eve_public.stargate.lock.api.*: real stargate restrictions.
//
// space/coopStargateLocks owns the persisted locks and space/runtime.startStargateJump
// refuses a jump through a locked gate, so this is enforcement, not decoration. The
// admin calls below are what the client's own admin UI sends.
//
// The public reads are answered from the same table, and the client tells us which system it
// is asking about: `stargate/client/gateLockMessenger.pyj` pairs the answer with its own
// `session.solarsystemid2`, and the request itself carries no field at all.
//   - GetRestrictedSystems -> every solar system with a live lock (the client uses it to mark
//     restricted systems on the map);
//   - Get -> the lock of the character's own system, but ONLY when that system has exactly one
//     live lock: the response carries a single gate, so a system with several locked gates
//     cannot be described and is refused with NOT_FOUND (which the client reads as "no lock")
//     instead of inventing one of them. When the character's system is unknown to the gateway
//     the same NOT_FOUND is the honest answer - the gateway never sees the scene.
const path = require("path");
const protobuf = require("protobufjs");

const { encodePayload, getActiveCharacterID } = require("./gatewayServiceHelpers");

const sessionRegistry = require(path.join(__dirname, "../../../services/chat/sessionRegistry"));

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
                    },
                    "GetRequest": {},
                    "GetResponse": {
                      "fields": {
                        "gate": {
                          "type": "eve_public.stargate.Identifier",
                          "id": 1
                        },
                        "expiry": {
                          "type": "google.protobuf.Timestamp",
                          "id": 2
                        }
                      }
                    },
                    "GetRestrictedSystemsRequest": {},
                    "GetRestrictedSystemsResponse": {
                      "fields": {
                        "solarsystems": {
                          "rule": "repeated",
                          "type": "eve_public.solarsystem.Identifier",
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
},
);

const ADMIN_PATH = "eve_public.stargate.lock.api.admin";
const PUBLIC_PATH = "eve_public.stargate.lock.api";

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.stargate.lock.api.admin.ApplyRequest",
  "eve_public.stargate.lock.api.admin.DeleteRequest",
  "eve_public.stargate.lock.api.admin.GetAllRequest",
  "eve_public.stargate.lock.api.GetRequest",
  "eve_public.stargate.lock.api.GetRestrictedSystemsRequest",
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
    getResponse: LOCK_PROTO_ROOT.lookupType(`${PUBLIC_PATH}.GetResponse`),
    getRestrictedSystemsResponse: LOCK_PROTO_ROOT.lookupType(
      `${PUBLIC_PATH}.GetRestrictedSystemsResponse`,
    ),
  };

  // The system the requesting character is actually in. The client's own Get handler pairs the
  // answer with `session.solarsystemid2`, so the system has to come from the live session, not
  // from the (empty) request message. No session, no system: the caller then answers NOT_FOUND.
  function sessionSystemID(characterID) {
    const id = positive(characterID);
    if (!id) return 0;
    let session = null;
    try {
      session = typeof sessionRegistry.findSessionByCharacterID === "function"
        ? sessionRegistry.findSessionByCharacterID(id)
        : null;
    } catch (_error) {
      session = null;
    }
    return positive(session && (session.solarsystemid2 || session.solarsystemid));
  }

  // Injectable so a test can state which system the character is in without a live session.
  const readSystemID = typeof context.sessionSystemID === "function"
    ? context.sessionSystemID
    : sessionSystemID;

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
      if (requestTypeName === "eve_public.stargate.lock.api.GetRestrictedSystemsRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: `${PUBLIC_PATH}.GetRestrictedSystemsResponse`,
          responsePayloadBuffer: encodePayload(types.getRestrictedSystemsResponse, {
            solarsystems: locks.lockedSystemIDs().map((systemID) => ({ sequential: systemID })),
          }),
        };
      }

      if (requestTypeName === "eve_public.stargate.lock.api.GetRequest") {
        const systemID = readSystemID(getActiveCharacterID(requestEnvelope));
        const inSystem = systemID
          ? locks.list().filter((lock) => lock.systemID === systemID)
          : [];
        // The response carries exactly one gate. One live lock in the character's system is
        // unambiguous; several are not representable, and none (or an unknown system) has no
        // lock to report. All three of the latter cases answer NOT_FOUND, which the client's
        // own messenger reads as "no lock".
        if (inSystem.length === 0) {
          return error(404, systemID
            ? "that solar system has no stargate lock"
            : "the character's current solar system is unknown to the gateway",
          `${PUBLIC_PATH}.GetResponse`);
        }
        if (inSystem.length > 1) {
          return error(404, "that solar system has several locked gates and this response carries one",
            `${PUBLIC_PATH}.GetResponse`);
        }
        const lock = inSystem[0];
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: `${PUBLIC_PATH}.GetResponse`,
          responsePayloadBuffer: encodePayload(types.getResponse, {
            gate: { sequential: lock.gateID },
            expiry: timestampOf(lock.expiresAtMs),
          }),
        };
      }

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
