"use strict";
// "Where do I enlist?" was unanswerable from the client: the Factional Warfare
// window in this build has no enlist button, and nothing pointed from the wish to
// join to the one station where a militia agent actually stands.
//
// The owner then saw a "militia centre" in Jita and reasonably asked why he was
// sent to Perimeter. The answer is in the data: Jita has no State Protectorate
// agent at all, the militia agents sit in the warzone systems. So this returns the
// REAL list of enlistment stations and marks the one the character is already at,
// instead of pretending there is a single venue or inventing a nearest one.
//
// It never invents an agent or a station: no matching agent means null.

function toPositiveInt(value) {
  const n = Math.trunc(Number(value) || 0);
  return n > 0 ? n : 0;
}

function stationLookup(stations) {
  if (stations instanceof Map) return (id) => stations.get(id) || null;
  if (Array.isArray(stations)) return (id) => stations.find((s) => toPositiveInt(s && s.stationID) === id) || null;
  if (stations && typeof stations === "object") {
    // A single station record is accepted as well as an id-keyed map.
    if (toPositiveInt(stations.stationID)) {
      const one = stations;
      return (id) => (toPositiveInt(one.stationID) === id ? one : null);
    }
    return (id) => stations[id] || null;
  }
  return () => null;
}

function buildEnlistHint({ record, faction, agents, stations } = {}) {
  const characterID = toPositiveInt(record && record.characterID);
  const factionID = toPositiveInt(faction && faction.factionID);
  const militiaCorporationID = toPositiveInt(faction && faction.militiaCorporationID);
  if (!characterID || !factionID || !militiaCorporationID) return null;

  const lookup = stationLookup(stations);
  const characterStationID = toPositiveInt(record && record.stationID);
  const characterSystemID = toPositiveInt(record && record.solarSystemID);

  const options = (Array.isArray(agents) ? agents : [])
    .map((agent) => {
      const stationID = toPositiveInt(agent && agent.stationID);
      if (!stationID) return null;
      const station = lookup(stationID);
      return {
        agentID: toPositiveInt(agent.agentID),
        agentName: String(agent.agentName || agent.name || ""),
        stationID,
        stationName: station ? String(station.stationName || "") : "",
        solarSystemID: station ? toPositiveInt(station.solarSystemID) : toPositiveInt(agent.solarSystemID),
        solarSystemName: station ? String(station.solarSystemName || "") : "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.stationID - b.stationID));
  if (!options.length) return null;

  const here = options.find((o) => o.stationID === characterStationID) || null;
  const inSystem = options.find((o) => o.solarSystemID === characterSystemID) || null;
  const chosen = here || inSystem || options[0];

  const where = chosen.stationName
    ? chosen.stationName + (chosen.solarSystemName ? " (" + chosen.solarSystemName + ")" : "")
    : "station " + chosen.stationID;

  return {
    status: here ? "ENLIST_HERE" : "ENLIST_ELSEWHERE",
    factionID,
    factionName: String(faction.name || ""),
    militiaCorporationID,
    // The chosen venue, kept at the top level for simple consumers.
    agentID: chosen.agentID,
    agentName: chosen.agentName,
    stationID: chosen.stationID,
    stationName: chosen.stationName,
    solarSystemID: chosen.solarSystemID,
    solarSystemName: chosen.solarSystemName,
    characterStationID,
    characterSystemID,
    optionCount: options.length,
    options,
    instruction: here
      ? `Talk to ${chosen.agentName || "the militia agent"} here and accept the enlistment.`
      : `Dock at ${where} and talk to ${chosen.agentName || "the militia agent"}.`,
  };
}

module.exports = { buildEnlistHint };
