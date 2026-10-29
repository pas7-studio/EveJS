"use strict";

const protobuf = require("protobufjs");

function normalizeUint(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeProtoNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value);
}

function normalizeScore(score) {
  if (!score || typeof score !== "object") {
    return null;
  }
  const factionID = normalizeUint(
    score.factionID ?? score.factionId ?? score.faction_id ??
      (score.faction && score.faction.sequential),
    0,
  );
  if (factionID <= 0) {
    return null;
  }
  return {
    faction: { sequential: factionID },
    contribution: normalizeUint(score.contribution, 0),
    floor: normalizeUint(score.floor ?? score.terrain, 0),
  };
}

function getScoreEntriesFromSource(source, solarSystemID) {
  if (!source || typeof source !== "object") {
    return [];
  }

  const rawScores =
    source instanceof Map
      ? source.get(solarSystemID) || source.get(String(solarSystemID))
      : source[solarSystemID] || source[String(solarSystemID)];

  if (!rawScores) {
    return [];
  }

  if (Array.isArray(rawScores)) {
    return rawScores.map(normalizeScore).filter(Boolean);
  }

  if (rawScores instanceof Map) {
    return [...rawScores.entries()]
      .map(([factionID, score]) => normalizeScore({
        factionID,
        ...(score && typeof score === "object" ? score : { contribution: score }),
      }))
      .filter(Boolean);
  }

  if (typeof rawScores === "object") {
    return Object.entries(rawScores)
      .map(([factionID, score]) => normalizeScore({
        factionID,
        ...(score && typeof score === "object" ? score : { contribution: score }),
      }))
      .filter(Boolean);
  }

  return [];
}

function buildSolarSystemScoresPayload(solarSystemID, scores = []) {
  return {
    solar_system: { sequential: normalizeUint(solarSystemID, 0) },
    scores: scores.map(normalizeScore).filter(Boolean),
  };
}

function buildEncodedPayload(messageType, payload) {
  return Buffer.from(messageType.encode(messageType.create(payload)).finish());
}

// eve_public/faction/activity/admin.proto, from the client's own descriptor:
//   Increment/SetContributionScoreRequest{target_system=1, target_faction=2,
//   adjustment=3 int32 | override=3 uint32} and empty responses. Declared in a
//   private root because the shared local gateway root does not carry them, and a
//   missing eager lookupType() throws at require time.
const FACTION_ADMIN_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        solarsystem: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
          },
        },
        faction: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
            activity: {
              nested: {
                admin: {
                  nested: {
                    IncrementContributionScoreRequest: {
                      fields: {
                        target_system: { type: "eve_public.solarsystem.Identifier", id: 1 },
                        target_faction: { type: "eve_public.faction.Identifier", id: 2 },
                        adjustment: { type: "int32", id: 3 },
                      },
                    },
                    SetContributionScoreRequest: {
                      fields: {
                        target_system: { type: "eve_public.solarsystem.Identifier", id: 1 },
                        target_faction: { type: "eve_public.faction.Identifier", id: 2 },
                        override: { type: "uint32", id: 3 },
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

const ADMIN_TYPES = Object.freeze({
  "eve_public.faction.activity.admin.IncrementContributionScoreRequest": {
    responseTypeName:
      "eve_public.faction.activity.admin.IncrementContributionScoreResponse",
    mode: "increment",
  },
  "eve_public.faction.activity.admin.SetContributionScoreRequest": {
    responseTypeName:
      "eve_public.faction.activity.admin.SetContributionScoreResponse",
    mode: "override",
  },
});

function buildError(statusCode, message, responseTypeName) {
  return {
    statusCode,
    statusMessage: message,
    responseTypeName,
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

function createFwAdvantageGatewayService(context = {}) {
  const protoRoot = context.protoRoot;
  const scoreSource = context.fwAdvantageScoresBySolarSystemID || null;
  const getSolarSystemScoresRequest = protoRoot.lookupType(
    "eve_public.faction.activity.GetSolarSystemScoresRequest",
  );
  const getSolarSystemScoresResponse = protoRoot.lookupType(
    "eve_public.faction.activity.GetSolarSystemScoresResponse",
  );

  function getSystemID(requestEnvelope) {
    const request = getSolarSystemScoresRequest.decode(
      requestEnvelope.payload.value || Buffer.alloc(0),
    );
    return normalizeProtoNumber(request?.solar_system?.sequential);
  }

  // The admin knobs write the score the advantages panel and the victory-point
  // bar both read. They are refused unless the (system, faction) pair really is
  // part of the running advantage war: storing an adjustment for a pair nobody
  // reads would be a silent no-op, which is exactly the state this replaced.
  function warAdvantageSnapshot() {
    try {
      return require("../../../space/coopWarAdvantage").shared().snapshot();
    } catch (_error) {
      return null;
    }
  }

  function factionActivityAdmin() {
    return require("../../../space/coopFactionActivityAdmin").shared();
  }

  function handleAdminRequest(adminType, requestTypeName, requestEnvelope) {
    let request;
    try {
      request = FACTION_ADMIN_PROTO_ROOT
        .lookupType(requestTypeName)
        .decode(requestEnvelope.payload.value || Buffer.alloc(0));
    } catch (error) {
      return buildError(13, `admin request could not be decoded: ${
        error && error.message ? error.message : error}`, adminType.responseTypeName);
    }
    const systemID = normalizeUint(
      normalizeProtoNumber(request?.target_system?.sequential),
      0,
    );
    const factionID = normalizeUint(
      normalizeProtoNumber(request?.target_faction?.sequential),
      0,
    );
    const refuse = (message) =>
      buildError(3, message, adminType.responseTypeName);

    if (!systemID) {
      return refuse("target_system is required");
    }
    if (!factionID) {
      return refuse("target_faction is required");
    }
    const view = warAdvantageSnapshot();
    if (!view || view.status !== "OBSERVED") {
      return refuse(
        `advantage war is not running (${(view && view.status) || "UNAVAILABLE"})`,
      );
    }
    const entry = view.systems[String(systemID)];
    if (!entry) {
      return refuse(`solar system ${systemID} is not part of the advantage war`);
    }
    if (!entry.scores.some((score) => Number(score.factionID) === factionID)) {
      return refuse(
        `faction ${factionID} has no score in solar system ${systemID}`,
      );
    }

    try {
      const admin = factionActivityAdmin();
      const derived = Number(
        (entry.scores.find((score) => Number(score.factionID) === factionID) || {})
          .contribution || 0,
      );
      const result = adminType.mode === "increment"
        ? admin.increment({
          systemID,
          factionID,
          adjustment: Number(request.adjustment) || 0,
          derived,
        })
        : admin.setOverride({
          systemID,
          factionID,
          override: normalizeUint(request.override, 0),
        });
      if (!result || result.status !== "APPLIED") {
        return refuse(`adjustment was not applied (${(result && result.status) || "UNKNOWN"})`);
      }
    } catch (error) {
      return buildError(
        13,
        `adjustment failed: ${error && error.message ? error.message : error}`,
        adminType.responseTypeName,
      );
    }

    // Both admin responses are empty messages: a 200 with a zero-length payload
    // is the complete answer.
    return {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: adminType.responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "fw-advantage",
    handledRequestTypes: [
      "eve_public.faction.activity.GetSolarSystemScoresRequest",
      ...Object.keys(ADMIN_TYPES),
    ],
    handleRequest(requestTypeName, requestEnvelope) {
      const adminType = ADMIN_TYPES[requestTypeName];
      if (adminType) {
        return handleAdminRequest(adminType, requestTypeName, requestEnvelope);
      }

      if (requestTypeName !== "eve_public.faction.activity.GetSolarSystemScoresRequest") {
        return null;
      }

      const solarSystemID = normalizeUint(getSystemID(requestEnvelope), 0);
      if (process.env.EVEJS_COOP_WAR_ADVANTAGE === "1") { try { const scores = require("../../../space/coopWarAdvantage").shared().scoresFor(solarSystemID); if (scores.length) return { statusCode: 200, statusMessage: "", responseTypeName: "eve_public.faction.activity.GetSolarSystemScoresResponse", responsePayloadBuffer: buildEncodedPayload(getSolarSystemScoresResponse, buildSolarSystemScoresPayload(solarSystemID, scores)) }; } catch (error) { /* fall through to the stock empty answer */ } }
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: "eve_public.faction.activity.GetSolarSystemScoresResponse",
        responsePayloadBuffer: buildEncodedPayload(
          getSolarSystemScoresResponse,
          buildSolarSystemScoresPayload(
            solarSystemID,
            getScoreEntriesFromSource(scoreSource, solarSystemID),
          ),
        ),
      };
    },
  };
}

module.exports = {
  ADMIN_TYPES,
  FACTION_ADMIN_PROTO_ROOT,
  buildSolarSystemScoresPayload,
  createFwAdvantageGatewayService,
  normalizeScore,
};
