"use strict";
// Fronts are DERIVED, never hand-placed.
//
// Owner definition (2026-10-27): every faction owns sectors, and a front is the
// intersection of two factions' sectors - two adjacent systems (adjacency from
// the real gate graph) whose owners differ. That border is the active combat
// zone. Move control of one system and the front moves by itself.
const num = (value) => Number(value) || 0;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// Two shapes are real: the presence map (`systemID -> faction`) and the
// authoritative war-state record (`militaryControllerFactionID`). Reading both
// keeps a front derived from the state after a capture, instead of silently
// forgetting every registered system.
function ownerOf(territories, systemID) {
  const value = territories && territories[systemID];
  const owner = typeof value === "object" && value
    ? (value.factionID !== undefined ? value.factionID : value.militaryControllerFactionID)
    : value;
  if (typeof owner === "number") return Number.isSafeInteger(owner) && owner > 0 ? String(owner) : null;
  return typeof owner === "string" && owner ? owner : null;
}

// One border edge per real reciprocal gate pair between two owners.
// FW-112: a front must never run out.
//
// MEASURED on the play stack 2026-10-30 after the first real capture: 30003837 became
// OCCUPIED by 500004, and the frontier answered NO_FRONT 137 times in one hour with an EMPTY
// skip list - the five registered systems simply had no adjacent pair owned by two different
// factions any more, so the war machine had nothing left to fight over and would have stayed
// silent for ever. A faction that has taken its whole border must be able to push into the
// next system, and the SDE already says who owns it. fallbackOwner fills ONLY the owner of a
// neighbouring system nobody has registered yet; a registered controller always wins, and an
// edge built this way is marked expanded so it can never be mistaken for an old border.
function borderEdges({ territories = {}, getStargatesForSystem, getGate,
 fallbackOwner = null } = {}) {
  if (typeof getStargatesForSystem !== "function") return [];
  const edges = new Map();
  for (const key of Object.keys(territories || {})) {
    const systemID = num(key);
    if (!positive(systemID)) continue;
    const owner = ownerOf(territories, systemID);
    if (!owner) continue;
    for (const gate of getStargatesForSystem(systemID) || []) {
      const gateID = num(gate && gate.itemID);
      const destinationGateID = num(gate && gate.destinationID);
      if (!positive(gateID) || !positive(destinationGateID)) continue;
      const back = typeof getGate === "function" ? getGate(destinationGateID) : null;
      if (back && (num(back.destinationID) !== gateID || num(back.solarSystemID) !== num(gate.destinationSolarSystemID || back.solarSystemID))) continue;
      const other = num(gate && gate.destinationSolarSystemID) || num(back && back.solarSystemID);
      if (!positive(other) || other === systemID) continue;
      const registeredOwner = ownerOf(territories, other);
      let otherOwner = registeredOwner;
      if (!otherOwner && typeof fallbackOwner === "function") {
       try {
        const raw = fallbackOwner(other);
        const candidate = Number(typeof raw === "object" && raw
         ? (raw.factionID !== undefined ? raw.factionID : raw.militaryControllerFactionID)
         : raw);
        if (Number.isSafeInteger(candidate) && candidate > 0)
         otherOwner = String(candidate);
       } catch (_error) { otherOwner = null; }
      }
      if (!otherOwner || otherOwner === owner) continue;
      const [a, b] = systemID < other ? [systemID, other] : [other, systemID];
      const key2 = a + ":" + b;
      if (edges.has(key2)) continue;
      edges.set(key2, {
        fromSystemID: systemID,
        toSystemID: other,
        fromOwner: owner,
        toOwner: otherOwner,
        gateID: gateID,
        reciprocalGateID: destinationGateID,
        expanded: !registeredOwner,
      });
    }
  }
  return [...edges.values()];
}

// Groups border edges by faction pair. Each group is one front: the line where
// those two factions actually touch, with the systems that hold it.
function buildFronts(options = {}) {
  const edges = borderEdges(options);
  const fronts = new Map();
  for (const edge of edges) {
    const pair = [edge.fromOwner, edge.toOwner].sort();
    const key = pair.join("|");
    if (!fronts.has(key)) {
      fronts.set(key, {
        frontID: "front:" + pair.join("-"),
        factions: pair,
        edges: [],
        systems: new Set(),
        gates: new Set(),
      });
    }
    const front = fronts.get(key);
    front.edges.push(edge);
    front.systems.add(edge.fromSystemID);
    front.systems.add(edge.toSystemID);
    front.gates.add(edge.gateID);
  }
  return [...fronts.values()]
    .map((front) => ({
      frontID: front.frontID,
      factions: front.factions,
      edgeCount: front.edges.length,
      systemIDs: [...front.systems].sort((a, b) => a - b),
      gateIDs: [...front.gates].sort((a, b) => a - b),
      edges: front.edges.slice().sort((a, b) => a.fromSystemID - b.fromSystemID || a.toSystemID - b.toSystemID),
    }))
    .sort((a, b) => b.edgeCount - a.edgeCount || a.frontID.localeCompare(b.frontID));
}

// Systems that touch enemy space: the candidate places for a front operation.
function contestedSystemIDs(options = {}) {
  const ids = new Set();
  for (const edge of borderEdges(options)) {
    ids.add(edge.fromSystemID);
    ids.add(edge.toSystemID);
  }
  return [...ids].sort((a, b) => a - b);
}

// Territory from real presence: a faction holds a system when its own ships are
// actually there. This is the missing input for the front builder - no invented
// ownership map, only what the world really contains.
function territoriesFromPresence({ pilots = [], minShips = 1 } = {}) {
  const counts = new Map();
  for (const pilot of Array.isArray(pilots) ? pilots : []) {
    const systemID = num(pilot && pilot.systemID);
    const factionID = String((pilot && pilot.factionID) || "");
    if (!positive(systemID) || !factionID) continue;
    if (!counts.has(systemID)) counts.set(systemID, new Map());
    const perFaction = counts.get(systemID);
    perFaction.set(factionID, (perFaction.get(factionID) || 0) + 1);
  }
  const threshold = Math.max(1, Math.trunc(num(minShips) || 1));
  const territories = {};
  for (const [systemID, perFaction] of counts) {
    const ranked = [...perFaction.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [factionID, ships] = ranked[0];
    const runnerUp = ranked[1] ? ranked[1][1] : 0;
    // A tie is contested, not owned: never hand a system to a coin flip.
    if (ships < threshold || ships === runnerUp) continue;
    territories[systemID] = factionID;
  }
  return territories;
}

module.exports = { borderEdges, buildFronts, contestedSystemIDs, ownerOf, territoriesFromPresence };
