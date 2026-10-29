"use strict";
// eve_public.solarsystem.api.Get and eve_public.station.api.Get: the client's basic
// "what is this place" call.
//
// Both had no handler, so anything that asked for a system or station name got an empty
// message. The data is already loaded by the server for the scene: space/worldData holds
// the real static rows (name, security, station name), so this service only translates.
//
// A missing id is NOT_FOUND: inventing a name would be worse than saying "unknown".
const path = require("path");
const protobuf = require("protobufjs");

const { encodePayload } = require("./gatewayServiceHelpers");

const ENTITY_PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    eve_public: {
      nested: {
        securitystatus: {
          nested: {
            Value: {
              fields: {
                units: { type: "sint64", id: 1 },
                nanos: { type: "sint32", id: 2 },
              },
            },
          },
        },
        solarsystem: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
            Attributes: {
              fields: {
                name: { type: "string", id: 1 },
                security: { type: "eve_public.securitystatus.Value", id: 2 },
              },
            },
            api: {
              nested: {
                GetRequest: {
                  fields: { solar_system: { type: "eve_public.solarsystem.Identifier", id: 1 } },
                },
                GetResponse: {
                  fields: { solar_system: { type: "eve_public.solarsystem.Attributes", id: 1 } },
                },
              },
            },
          },
        },
        station: {
          nested: {
            Identifier: { fields: { sequential: { type: "uint64", id: 1 } } },
            Attributes: { fields: { name: { type: "string", id: 1 } } },
            api: {
              nested: {
                GetRequest: {
                  fields: { station: { type: "eve_public.station.Identifier", id: 1 } },
                },
                GetResponse: {
                  fields: { station: { type: "eve_public.station.Attributes", id: 1 } },
                },
              },
            },
          },
        },
      },
    },
  },
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.solarsystem.api.GetRequest",
  "eve_public.station.api.GetRequest",
]);

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

// The client renders security as units + nanos; 0.949 becomes units 0, nanos 949000000.
function securityValue(security) {
  const value = Number(security);
  if (!Number.isFinite(value)) {
    return { units: 0, nanos: 0 };
  }
  // `|| 0` normalises -0: a negative security below one starts at units 0, not -0.
  const units = Math.trunc(value) || 0;
  return { units, nanos: Math.round((value - units) * 1e9) };
}

function buildSolarSystemPayload(system) {
  return {
    name: String(system.solarSystemName || ""),
    security: securityValue(system.security),
  };
}

function createEntityLookupGatewayService(context = {}) {
  const worldData = context.worldData || require(path.join(__dirname, "../../../space/worldData"));
  const structures = context.structures || ((stationID) => {
    try {
      return require(path.join(__dirname, "../../../services/structure/structureState"))
        .getStructureByID(stationID) || null;
    } catch (_error) {
      return null;
    }
  });

  const types = {
    solarSystemRequest: ENTITY_PROTO_ROOT.lookupType("eve_public.solarsystem.api.GetRequest"),
    solarSystemResponse: ENTITY_PROTO_ROOT.lookupType("eve_public.solarsystem.api.GetResponse"),
    stationRequest: ENTITY_PROTO_ROOT.lookupType("eve_public.station.api.GetRequest"),
    stationResponse: ENTITY_PROTO_ROOT.lookupType("eve_public.station.api.GetResponse"),
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
    name: "entity-lookup",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (requestTypeName === "eve_public.solarsystem.api.GetRequest") {
        const solarSystemID = positive(
          decode(types.solarSystemRequest, requestEnvelope)?.solar_system?.sequential,
        );
        const system = solarSystemID ? worldData.getSolarSystemByID(solarSystemID) : null;
        if (!system) {
          return error(5, "solar system not found", "eve_public.solarsystem.api.GetResponse");
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.solarsystem.api.GetResponse",
          responsePayloadBuffer: encodePayload(types.solarSystemResponse, {
            solar_system: buildSolarSystemPayload(system),
          }),
        };
      }

      if (requestTypeName === "eve_public.station.api.GetRequest") {
        const stationID = positive(
          decode(types.stationRequest, requestEnvelope)?.station?.sequential,
        );
        if (!stationID) {
          return error(3, "station is required", "eve_public.station.api.GetResponse");
        }
        const station = worldData.getStationByID(stationID) || structures(stationID);
        const name = station
          ? String(station.stationName || station.itemName || station.name || "")
          : "";
        if (!name) {
          return error(5, "station not found", "eve_public.station.api.GetResponse");
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.station.api.GetResponse",
          responsePayloadBuffer: encodePayload(types.stationResponse, {
            station: { name },
          }),
        };
      }

      return null;
    },
  };
}

module.exports = {
  ENTITY_PROTO_ROOT,
  HANDLED_REQUEST_TYPES,
  buildSolarSystemPayload,
  createEntityLookupGatewayService,
  securityValue,
};
