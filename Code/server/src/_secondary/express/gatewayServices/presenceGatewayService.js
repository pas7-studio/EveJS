"use strict";
// eve_public.presence.api: "which corporation / alliance / faction does this
// character belong to" (request carries eve_public.character.Identifier, the
// response carries exactly one membership).
//
// The client asks these three questions from the corporation / alliance /
// faction info panels and the chat member lists. Stock answered nothing, so the
// window showed an empty membership. The answer here is the membership the
// server already holds, in this order and nothing else:
//
//   1. the LIVE session (sessionRegistry), because it is the record of the
//      character as it is connected right now;
//   2. the durable character record (gameStore "characters");
//   3. the corporation record, for a character whose own record carries no
//      alliance or no faction.
//
// An unknown character is a NOT_FOUND, never an invented zero membership: the
// client cannot represent "no corporation" at all, so a guess would be a lie.
//
// The messages are declared here because the shared local gateway root does not
// carry eve_public.presence.api.* and an eager lookupType() on a missing type
// throws at require time (that took the gateway down once). Field numbers and
// types come from the client's own eve_public/presence/api/request.proto
// descriptor: GetAllianceResponse/GetFactionResponse use a `membership` oneof,
// so exactly one branch is always set.
const path = require("path");
const protobuf = require("protobufjs");

const {
  encodePayload,
  getActiveCharacterID,
} = require("./gatewayServiceHelpers");

const PRESENCE_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        character: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        corporation: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint32", id: 1 } } },
          },
        },
        alliance: {
          nested: {
            Identifier: { fields: { sequential: { type: "int32", id: 1 } } },
          },
        },
        faction: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
          },
        },
        presence: {
          nested: {
            api: {
              nested: {
                GetCorporationRequest: {
                  fields: { character: { type: "eve_public.character.Identifier", id: 1 } },
                },
                GetCorporationResponse: {
                  fields: { corporation: { type: "eve_public.corporation.Identifier", id: 1 } },
                },
                GetAllianceRequest: {
                  fields: { character: { type: "eve_public.character.Identifier", id: 1 } },
                },
                GetAllianceResponse: {
                  fields: {
                    no_alliance: { type: "bool", id: 1 },
                    alliance: { type: "eve_public.alliance.Identifier", id: 2 },
                  },
                },
                GetFactionRequest: {
                  fields: { character: { type: "eve_public.character.Identifier", id: 1 } },
                },
                GetFactionResponse: {
                  fields: {
                    no_faction: { type: "bool", id: 1 },
                    faction: { type: "eve_public.faction.Identifier", id: 2 },
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

const TYPES = Object.freeze({
  "eve_public.presence.api.GetCorporationRequest": {
    response: "eve_public.presence.api.GetCorporationResponse",
    kind: "corporation",
  },
  "eve_public.presence.api.GetAllianceRequest": {
    response: "eve_public.presence.api.GetAllianceResponse",
    kind: "alliance",
  },
  "eve_public.presence.api.GetFactionRequest": {
    response: "eve_public.presence.api.GetFactionResponse",
    kind: "faction",
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze(Object.keys(TYPES));

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function buildError(statusCode, message, responseTypeName) {
  return {
    statusCode,
    statusMessage: message,
    responseTypeName,
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

// Default membership source: live session -> durable character record ->
// corporation record. Every step is a real record; nothing is derived.
function createMembershipLookup({ sessions, characters, corporations } = {}) {
  const registry = sessions || require(path.join(
    __dirname,
    "../../../services/chat/sessionRegistry",
  ));
  const readCharacters = characters || (() => {
    const database = require(path.join(__dirname, "../../../gameStore"));
    const read = database.read("characters", "/");
    return read && read.success && read.data && typeof read.data === "object"
      ? read.data
      : {};
  });
  const readCorporation = corporations || ((corporationID) => {
    try {
      return require(path.join(
        __dirname,
        "../../../services/corporation/corporationState",
      )).getCorporationRecord(corporationID) || null;
    } catch (_error) {
      return null;
    }
  });

  function liveSession(characterID) {
    if (typeof registry.findSessionByCharacterID === "function") {
      return registry.findSessionByCharacterID(characterID) || null;
    }
    return null;
  }

  return function lookup(characterID) {
    const id = positive(characterID);
    if (!id) {
      return null;
    }
    const session = liveSession(id);
    let record = null;
    try {
      const all = readCharacters() || {};
      record = all[String(id)] || all[id] || null;
    } catch (_error) {
      record = null;
    }
    if (!session && !record) {
      return null;
    }

    const corporationID = positive(
      (session && session.corporationID) || (record && record.corporationID),
    );
    let allianceID = positive(
      (session && session.allianceID) || (record && record.allianceID),
    );
    let factionID = positive(
      (session && session.factionID) || (record && record.factionID),
    );

    if ((!allianceID || !factionID) && corporationID) {
      const corporation = readCorporation(corporationID);
      if (corporation) {
        if (!allianceID) {
          allianceID = positive(corporation.allianceID);
        }
        if (!factionID) {
          factionID = positive(corporation.factionID);
        }
      }
    }

    return { characterID: id, corporationID, allianceID, factionID };
  };
}

function buildMembershipPayload(kind, membership) {
  if (kind === "corporation") {
    return { corporation: { sequential: membership.corporationID } };
  }
  if (kind === "alliance") {
    return membership.allianceID
      ? { alliance: { sequential: membership.allianceID } }
      : { no_alliance: true };
  }
  return membership.factionID
    ? { faction: { sequential: membership.factionID } }
    : { no_faction: true };
}

function createPresenceGatewayService(context = {}) {
  const lookup = context.presenceLookup || createMembershipLookup();
  const requestTypes = {};
  for (const [requestType, descriptor] of Object.entries(TYPES)) {
    requestTypes[requestType] = {
      request: PRESENCE_PROTO_ROOT.lookupType(requestType),
      response: PRESENCE_PROTO_ROOT.lookupType(descriptor.response),
      kind: descriptor.kind,
    };
  }

  return {
    name: "presence",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      const entry = requestTypes[requestTypeName];
      if (!entry) {
        return null;
      }

      const payload = (requestEnvelope && requestEnvelope.payload &&
        requestEnvelope.payload.value) || Buffer.alloc(0);
      let requested = 0;
      try {
        requested = positive(entry.request.decode(payload)?.character?.sequential);
      } catch (_error) {
        requested = 0;
      }
      if (!requested && typeof getActiveCharacterID === "function") {
        requested = positive(getActiveCharacterID(requestEnvelope));
      }

      const membership = requested ? lookup(requested) : null;
      if (!membership) {
        return buildError(5, "character membership not found", TYPES[requestTypeName].response);
      }
      // A character without a corporation is a broken durable record: the game
      // gives every character one, so refuse instead of answering zero.
      if (entry.kind === "corporation" && !membership.corporationID) {
        return buildError(5, "character has no corporation", TYPES[requestTypeName].response);
      }

      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: TYPES[requestTypeName].response,
        responsePayloadBuffer: encodePayload(
          entry.response,
          buildMembershipPayload(entry.kind, membership),
        ),
      };
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  PRESENCE_PROTO_ROOT,
  TYPES,
  buildMembershipPayload,
  createMembershipLookup,
  createPresenceGatewayService,
};
