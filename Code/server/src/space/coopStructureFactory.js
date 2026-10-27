"use strict";
// Server-side structure factory for the co-op world.
//
// Why this exists: the pinned EveJS exposes structure deployment only as client
// RPCs (Handle_Anchor / Handle_Deploy ...). There is no server-side "deploy a
// structure for an NPC faction" API, so the war layer had no honest way to put a
// real objective into a system.
//
// This module is the missing seam, and it stays deliberately thin:
//   plan()   validates an intent and produces the normalized record, or refuses
//            with an explicit reason. It never touches the store.
//   deploy() hands that record to the REAL native writer
//            (structureState.createStructure -> persistStructures ->
//            writeTable("structures", ...), which applies
//            normalizeStructureDescription and invalidates the structure cache,
//            then notifies the live scene listeners).
//   verify() reads the deployed row back through the native reader
//            (structureState.listStructuresForSystem, the same call
//            worldData.getStructuresForSystem uses).
//
// Nothing is invented: an unknown typeID, a non-numeric faction, a corporation
// that does not belong to that faction, or an invalid position is a refusal, not
// a best guess.
//
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";

// structureConstants.STRUCTURE_STATE.SHIELD_VULNERABLE - fully online, attackable.
// A war objective must be capturable, so it is created in that state rather than
// in UNANCHORED (which is invisible and not a target).
const SHIELD_VULNERABLE = 110;
const FULL_POWER = 1;
const DEFAULT_FACTORY_TAG = "coopStructureFactory";

const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function refuse(reason, extra) {
  return Object.assign({ status: "REFUSED", reason }, extra || {});
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every((entry) => Number.isFinite(entry))) return null;
  return { x, y, z };
}

// Real native authorities, resolved lazily so a unit test can inject them and a
// server without the structure service fails loudly instead of writing junk.
function defaultStructureState() {
  return require("../services/structure/structureState");
}

function defaultFactionState() {
  return require("../services/faction/factionState");
}

function resolveTypeResolver(deps) {
  if (typeof deps.resolveStructureType === "function") return deps.resolveStructureType;
  return (typeID) => {
    const state = deps.structureState || defaultStructureState();
    return typeof state.getStructureTypeByID === "function"
      ? state.getStructureTypeByID(typeID)
      : null;
  };
}

function resolveFactionResolver(deps) {
  if (typeof deps.factionForCorporation === "function") return deps.factionForCorporation;
  return (corporationID) => {
    const factions = deps.factionState || defaultFactionState();
    return typeof factions.getFactionIDForCorporation === "function"
      ? factions.getFactionIDForCorporation(corporationID)
      : 0;
  };
}

// plan({systemID,typeID,factionID,position,name,ownerCorpID,description,nowMs})
//   -> {status:"PLANNED", factionID, typeName, record}
//   -> {status:"REFUSED", reason, ...}
function plan(input = {}, deps = {}) {
  const source = input && typeof input === "object" ? input : {};

  const systemID = Number(source.systemID);
  if (!pos(systemID)) return refuse("SYSTEM_ID_REQUIRED", { systemID: source.systemID });

  const typeID = Number(source.typeID);
  if (!pos(typeID)) return refuse("TYPE_ID_REQUIRED", { typeID: source.typeID });

  // A faction is a real numeric faction ID, and a JSON string is not one:
  // "500014", null or "Caldari" is refused instead of silently coerced.
  const factionID = source.factionID;
  if (typeof factionID !== "number" || !Number.isSafeInteger(factionID) || !pos(factionID)) {
    return refuse("INVALID_FACTION", { factionID: source.factionID });
  }

  const ownerCorpID = Number(source.ownerCorpID);
  if (!pos(ownerCorpID)) {
    return refuse("OWNER_CORPORATION_REQUIRED", { ownerCorpID: source.ownerCorpID });
  }

  const position = normalizePosition(source.position);
  if (!position) return refuse("INVALID_POSITION", { position: source.position });

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return refuse("NAME_REQUIRED", { name: source.name });

  const typeRecord = resolveTypeResolver(deps)(typeID);
  if (!typeRecord || !pos(Number(typeRecord.typeID))) {
    return refuse("UNKNOWN_TYPE_ID", { typeID });
  }

  // The structure's owner must really belong to the faction the caller claims,
  // otherwise a "Caldari" objective could be owned by a Gallente corporation.
  let corporationFactionID = 0;
  try {
    corporationFactionID = num(resolveFactionResolver(deps)(ownerCorpID));
  } catch (_error) {
    return refuse("FACTION_RESOLVER_UNAVAILABLE", { ownerCorpID });
  }
  if (!pos(corporationFactionID)) {
    return refuse("UNKNOWN_CORPORATION_FACTION", { ownerCorpID });
  }
  if (corporationFactionID !== factionID) {
    return refuse("CORPORATION_FACTION_MISMATCH", {
      ownerCorpID,
      factionID,
      corporationFactionID,
    });
  }

  const nowMs = Number.isFinite(Number(source.nowMs)) && Number(source.nowMs) > 0
    ? Math.trunc(Number(source.nowMs))
    : Date.now();
  const description = typeof source.description === "string" && source.description.trim()
    ? source.description
    : `Co-op objective held by faction ${factionID}`;

  return {
    status: "PLANNED",
    factionID,
    ownerCorpID,
    typeName: String(typeRecord.name || `Structure ${typeID}`),
    record: {
      typeID,
      solarSystemID: systemID,
      ownerCorpID,
      ownerID: ownerCorpID,
      allianceID: null,
      name,
      itemName: name,
      description,
      position,
      rotation: [0, 0, 0],
      state: SHIELD_VULNERABLE,
      stateStartedAt: nowMs,
      stateEndsAt: null,
      upkeepState: FULL_POWER,
      hasQuantumCore: true,
      quantumCoreItemTypeID: pos(Number(typeRecord.defaultQuantumCoreTypeID))
        ? Number(typeRecord.defaultQuantumCoreTypeID)
        : null,
      // normalizeStructureRecord keeps devFlags verbatim; it is the only place a
      // row can carry the co-op provenance without inventing new native fields.
      devFlags: {
        coop: {
          factory: DEFAULT_FACTORY_TAG,
          factionID,
          plannedAt: nowMs,
        },
      },
    },
  };
}

// deploy() is the only mutating call. It writes through the native structure
// writer so caches, scene listeners and the on-disk row stay consistent.
function deploy(input = {}, deps = {}) {
  const planned = plan(input, deps);
  if (planned.status !== "PLANNED") return planned;

  let store = deps.structureState;
  if (!store) {
    try {
      store = defaultStructureState();
    } catch (error) {
      return { status: "FAILED", reason: "STRUCTURE_WRITER_UNAVAILABLE", errorMsg: String(error && error.message) };
    }
  }
  if (!store || typeof store.createStructure !== "function") {
    return { status: "FAILED", reason: "STRUCTURE_WRITER_UNAVAILABLE" };
  }

  const result = store.createStructure(planned.record, { emitLive: true });
  if (!result || result.success !== true) {
    return {
      status: "FAILED",
      reason: "CREATE_STRUCTURE_FAILED",
      errorMsg: String((result && result.errorMsg) || "UNKNOWN"),
    };
  }
  const row = result.data || {};
  return {
    status: "DEPLOYED",
    structureID: num(row.structureID),
    systemID: num(row.solarSystemID),
    typeID: num(row.typeID),
    factionID: planned.factionID,
    record: row,
  };
}

function structuresInSystem(systemID, deps = {}) {
  const store = deps.structureState || defaultStructureState();
  if (typeof store.listStructuresForSystem !== "function") return null;
  const rows = store.listStructuresForSystem(Number(systemID));
  return Array.isArray(rows) ? rows : null;
}

// verify() reads the row back from the native reader: this is what
// worldData.getStructuresForSystem() returns to the scene and the client.
function verify({ systemID, structureID } = {}, deps = {}) {
  if (!pos(Number(systemID)) || !pos(Number(structureID))) {
    return refuse("SYSTEM_AND_STRUCTURE_IDS_REQUIRED", { systemID, structureID });
  }
  let rows = null;
  try {
    rows = structuresInSystem(systemID, deps);
  } catch (error) {
    return { status: "UNKNOWN", reason: "STRUCTURE_READER_FAILED", errorMsg: String(error && error.message) };
  }
  if (!rows) return { status: "UNKNOWN", reason: "STRUCTURE_READER_UNAVAILABLE" };
  const row = rows.find((entry) => num(entry && entry.structureID) === Number(structureID)) || null;
  if (!row) return { status: "MISSING", systemID: Number(systemID), structureID: Number(structureID) };
  return {
    status: "PRESENT",
    systemID: Number(systemID),
    structureID: Number(structureID),
    typeID: num(row.typeID),
    ownerCorpID: num(row.ownerCorpID || row.ownerID),
    name: String(row.name || row.itemName || ""),
    state: num(row.state),
    factionID: num(row.devFlags && row.devFlags.coop && row.devFlags.coop.factionID),
  };
}

module.exports = {
  SHIELD_VULNERABLE,
  FULL_POWER,
  DEFAULT_FACTORY_TAG,
  plan,
  deploy,
  verify,
  structuresInSystem,
};
