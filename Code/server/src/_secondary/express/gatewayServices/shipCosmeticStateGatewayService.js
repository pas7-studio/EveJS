"use strict";
// eve_public.cosmetic.ship.api.{Get,GetAllInBubble}: which third-party SKIN is on which ship.
//
// `cosmetics/client/messengers/cosmetics/ship/shipSkinStateRequestMessenger.pyj` asks these two
// questions whenever the SKIN UI needs to draw a ship: Get for one ship instance, GetAllInBubble
// for the ships the character can currently see. The answer is the applied-skin record that
// space/coopThirdPartySkins keeps - the same row the Apply/Unapply calls write - so the window can
// never show a skin that was never applied, and a ship with no row answers NOT_FOUND (which the
// client's own messenger turns into "no skin").
//
// GetAllInBubble is answered from the live scene (space/runtime.getSceneForSession), not from the
// whole applied table: a skin on a ship in another system is not in this bubble.
//
// The state message is encoded by hand. Its `layout` field is a `Layout` message that this build
// does not model (the design tree carries nested configuration messages), and the bytes are the
// ones the client itself sent when the design was saved - space/coopThirdPartySkins stores them
// base64. Embedding them verbatim is the only way to hand them back unchanged; re-encoding a
// partly decoded tree would drop the fields we do not model.
const path = require("path");

const { getActiveCharacterID } = require("./gatewayServiceHelpers");
const { rawLayoutField } = require("./thirdPartySkinDraftGatewayService");

const SHIP_API = "eve_public.cosmetic.ship.api";

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.cosmetic.ship.api.GetRequest",
  "eve_public.cosmetic.ship.api.GetAllInBubbleRequest",
]);

function positive(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

// --- minimal protobuf writer (varint + length-delimited), so a raw sub-message can be embedded ---
function varint(value) {
  let remaining = BigInt(Math.max(0, Math.trunc(Number(value) || 0)));
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function key(fieldNumber, wireType) {
  return varint(fieldNumber * 8 + wireType);
}

function varintField(fieldNumber, value) {
  return Buffer.concat([key(fieldNumber, 0), varint(value)]);
}

function bytesField(fieldNumber, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  return Buffer.concat([key(fieldNumber, 2), varint(body.length), body]);
}

function stringField(fieldNumber, text) {
  return bytesField(fieldNumber, Buffer.from(String(text == null ? "" : text), "utf8"));
}

// eve_public.cosmetic.ship.State { character Identifier = 1, ship Identifier = 2, skin = 3 }
function encodeState({ characterID, shipID, skinHex, layoutBase64 }) {
  const character = varintField(1, positive(characterID));
  const ship = varintField(1, positive(shipID));
  const thirdParty = Buffer.concat([
    bytesField(1, stringField(1, skinHex)), // Identifier { hex } - the stored hex key
    ...(layoutBase64 ? [bytesField(2, Buffer.from(layoutBase64, "base64"))] : []),
  ]);
  // State.Skin is a oneof: thirdparty is field 2.
  const skin = bytesField(2, thirdParty);
  return Buffer.concat([bytesField(1, character), bytesField(2, ship), bytesField(3, skin)]);
}

function decodeShipID(requestEnvelope) {
  const payload = requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value;
  if (!Buffer.isBuffer(payload) || payload.length === 0) return 0;
  // GetRequest { ship = 1 { sequential = 1 } }: only a varint field inside a length-delimited field.
  try {
    let offset = 0;
    while (offset < payload.length) {
      let keyValue = 0;
      let shift = 0;
      let byte;
      do {
        if (offset >= payload.length) return 0;
        byte = payload[offset];
        offset += 1;
        keyValue += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte >= 0x80);
      const field = Math.floor(keyValue / 8);
      const wireType = keyValue % 8;
      if (field === 1 && wireType === 2) {
        let length = 0;
        let lengthShift = 0;
        do {
          if (offset >= payload.length) return 0;
          byte = payload[offset];
          offset += 1;
          length += (byte & 0x7f) * 2 ** lengthShift;
          lengthShift += 7;
        } while (byte >= 0x80);
        const inner = Buffer.from(payload.slice(offset, offset + length));
        let innerOffset = 0;
        while (innerOffset < inner.length) {
          let innerKey = 0;
          let innerShift = 0;
          do {
            if (innerOffset >= inner.length) return 0;
            byte = inner[innerOffset];
            innerOffset += 1;
            innerKey += (byte & 0x7f) * 2 ** innerShift;
            innerShift += 7;
          } while (byte >= 0x80);
          const innerField = Math.floor(innerKey / 8);
          const innerWire = innerKey % 8;
          if (innerWire === 0) {
            let value = 0;
            let valueShift = 0;
            do {
              if (innerOffset >= inner.length) return 0;
              byte = inner[innerOffset];
              innerOffset += 1;
              value += (byte & 0x7f) * 2 ** valueShift;
              valueShift += 7;
            } while (byte >= 0x80);
            if (innerField === 1) return positive(value);
            continue;
          }
          return 0;
        }
        return 0;
      }
      if (wireType === 0) {
        while (offset < payload.length && payload[offset] >= 0x80) offset += 1;
        offset += 1;
        continue;
      }
      return 0;
    }
  } catch (_error) {
    return 0;
  }
  return 0;
}

function createShipCosmeticStateGatewayService(context = {}) {
  const skins = context.thirdPartySkins || require(path.join(
    __dirname,
    "../../../space/coopThirdPartySkins",
  )).shared();
  const sessions = context.sessions || require(path.join(
    __dirname,
    "../../../services/chat/sessionRegistry",
  ));
  const sceneFor = context.sceneForSession || ((session) => {
    try {
      const runtime = require(path.join(__dirname, "../../../space/runtime"));
      return runtime && typeof runtime.getSceneForSession === "function"
        ? runtime.getSceneForSession(session)
        : null;
    } catch (_error) {
      return null;
    }
  });

  function licenceLayout(characterID, skinHex) {
    // The licence row is where the design's layout lives; a skin without one is still a real
    // skin, the client just has no components to draw for it.
    try {
      const row = typeof skins.get === "function" ? skins.get(characterID, skinHex) : null;
      return row && typeof row.layout === "string" ? row.layout : "";
    } catch (_error) {
      return "";
    }
  }

  function stateFor(characterID, shipID, skinHex) {
    return encodeState({
      characterID,
      shipID,
      skinHex,
      layoutBase64: licenceLayout(characterID, skinHex),
    });
  }

  function notFound(message, responseTypeName) {
    return {
      statusCode: 404,
      statusMessage: message,
      responseTypeName,
      responsePayloadBuffer: Buffer.alloc(0),
    };
  }

  return {
    name: "ship-cosmetic-state",
    handledRequestTypes: HANDLED_REQUEST_TYPES,
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (requestTypeName !== "eve_public.cosmetic.ship.api.GetRequest" &&
        requestTypeName !== "eve_public.cosmetic.ship.api.GetAllInBubbleRequest") {
        return null;
      }
      const characterID = positive(getActiveCharacterID(requestEnvelope));
      if (!characterID) {
        return notFound("no character in the request context", `${SHIP_API}.GetResponse`);
      }
      let applied = {};
      try {
        applied = skins.appliedFor(characterID) || {};
      } catch (_error) {
        applied = {};
      }

      if (requestTypeName === "eve_public.cosmetic.ship.api.GetRequest") {
        const shipID = decodeShipID(requestEnvelope);
        const skinHex = shipID ? applied[String(shipID)] : "";
        if (!skinHex) {
          return notFound(
            shipID ? "that ship has no SKIN applied" : "the request names no ship",
            `${SHIP_API}.GetResponse`,
          );
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: `${SHIP_API}.GetResponse`,
          // GetResponse { state = 1 }
          responsePayloadBuffer: bytesField(1, stateFor(characterID, shipID, skinHex)),
        };
      }

      // GetAllInBubble: only the ships of the character's own scene, and only the ones that
      // really carry an applied SKIN. No session or no scene means no bubble to describe.
      const states = [];
      for (const session of sessions.getSessions()) {
        if (positive(session && session.characterID) !== characterID) continue;
        const scene = sceneFor(session);
        const entities = scene && scene.dynamicEntities instanceof Map
          ? scene.dynamicEntities
          : null;
        if (!entities) continue;
        for (const [entityID, entity] of entities) {
          if (!entity || entity.kind !== "ship") continue;
          const shipID = positive(entityID);
          const skinHex = shipID ? applied[String(shipID)] : "";
          if (!skinHex) continue;
          states.push(bytesField(1, stateFor(characterID, shipID, skinHex)));
        }
      }
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: `${SHIP_API}.GetAllInBubbleResponse`,
        // GetAllInBubbleResponse { repeated State states = 1 }
        responsePayloadBuffer: states.length ? Buffer.concat(states) : Buffer.alloc(0),
      };
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  SHIP_API,
  createShipCosmeticStateGatewayService,
  decodeShipID,
  encodeState,
  rawLayoutField,
};
