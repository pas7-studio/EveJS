"use strict";
// Persistent, expiring evidence from one named NPC's physically witnessed grid.
// Never records hidden player cargo, private sessions or inferred coordinates.
const fs = require("node:fs");
const path = require("node:path");
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const named = value => typeof value === "string" && /^coop-pilot-[0-9]{3,}$/.test(value);
const vector = p => !!p && ["x", "y", "z"].every(k => Number.isFinite(p[k]));
const copy = x => JSON.parse(JSON.stringify(x));
function createIntelLedger({file, clock = () => Date.now(), ttlMs = 90000,
  maxEntries = 1000, observeCooldownMs = 15000} = {}) {
  if (!file || typeof clock !== "function" || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 15000 || ttlMs > 3600000 || !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 || maxEntries > 10000 || !Number.isSafeInteger(observeCooldownMs) ||
      observeCooldownMs < 0 || observeCooldownMs >= ttlMs) throw Error("INVALID_NPC_INTEL_OPTIONS");
  let state = {version: 1, sightings: {}};
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved?.version !== 1 || !saved.sightings || Array.isArray(saved.sightings) ||
        typeof saved.sightings !== "object") throw Error("INVALID_NPC_INTEL_STATE");
    state = saved;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const persist = next => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = file + ".tmp-" + process.pid;
    try {
      const fd = fs.openSync(temp, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      state = next;
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  const keyFor = (pilotID, targetID) => pilotID + ":" + targetID;
  function recall({pilotID, targetID, systemID} = {}) {
    if (!named(pilotID) || !positive(targetID) || !positive(systemID)) return null;
    const row = state.sightings[keyFor(pilotID, targetID)];
    const age = clock() - Number(row?.at);
    if (!row || row.systemID !== Number(systemID) || !Number.isFinite(age) ||
        age < 0 || age > ttlMs || !vector(row.position)) return null;
    return {...copy(row), ageMs: age, confidence: Math.max(0, 0.95 - 0.35 * age / ttlMs)};
  }
  function observe({pilotID, targetID, systemID, targetRole, position,
    distanceMeters, source = "native-grid"} = {}) {
    const now = clock();
    if (!named(pilotID) || !positive(targetID) || !positive(systemID) ||
        !["miner", "hauler"].includes(targetRole) || !vector(position) ||
        source !== "native-grid" || !Number.isFinite(distanceMeters) ||
        distanceMeters < 0 || distanceMeters > 200000 ||
        !Number.isSafeInteger(now) || now < 0) return {status: "INVALID_WITNESS"};
    const key = keyFor(pilotID, Number(targetID));
    const prior = state.sightings[key];
    if (prior && now >= prior.at && now - prior.at < observeCooldownMs &&
        prior.systemID === Number(systemID) && prior.targetRole === targetRole)
      return {status: "ALREADY_OBSERVED"};
    const sightings = {};
    for (const [id, row] of Object.entries(state.sightings)) {
      if (id === key) continue;
      if (!Number.isSafeInteger(row?.at) || now < row.at || now - row.at > ttlMs) continue;
      sightings[id] = row;
    }
    sightings[key] = {pilotID, targetID: Number(targetID), systemID: Number(systemID),
      targetRole, source, at: now, position: {x: position.x, y: position.y, z: position.z}};
    const ids = Object.keys(sightings).sort((a, b) => sightings[a].at - sightings[b].at || a.localeCompare(b));
    for (const id of ids.slice(0, Math.max(0, ids.length - maxEntries))) delete sightings[id];
    persist({version: 1, sightings});
    return {status: "OBSERVED"};
  }
  return {observe, recall, snapshot: () => copy(state)};
}
module.exports = {createIntelLedger};
