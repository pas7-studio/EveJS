"use strict";
// Short-lived read cache over the native NPC store.
//
// Why: `nativeNpcStore.getNativeEntity(id)` / `listNativeCargo(...)` re-read and
// deep-clone the WHOLE collection on every call, so a caller that walks pairs or
// fleets paid one full clone per entity. A live V8 profile of the running server
// put 23% of wall time in coopWarCombatAuthority.evaluatePair -> getNativeEntity,
// 5.5% in coopHaulCargoAdoption -> listNativeCargo and 3.4% in
// coopNativeMiningFleetDurable.check -> getNativeEntity.
//
// What is cached is identity/facts that do not change inside a tick (entityID,
// corporationID, systemID, cargo rows), never HP, position or a combat verdict:
// those still come from the caller and from the live controller. The TTL bounds
// staleness to one think interval.
//
// Invalidation: a write that matters (spawn, death, cargo move) must call
// `invalidate()`; the TTL alone is the backstop.
const DEFAULT_TTL_MS = Number(process.env.EVEJS_COOP_NATIVE_CACHE_TTL_MS || 200);

function createCache({ listNativeEntities, listNativeCargo, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  let entityIndex = null;
  let entityAt = 0;
  let cargoIndex = null;
  let cargoAt = 0;
  let flatCargo = [];
  const stats = { entityBuilds: 0, cargoBuilds: 0, entityHits: 0, entityMisses: 0, cargoHits: 0, cargoMisses: 0 };

  function invalidate() {
    entityIndex = null;
    cargoIndex = null;
    flatCargo = [];
    entityAt = 0;
    cargoAt = 0;
  }

  function allCargoRows() {
    cargoAll();
    return flatCargo;
  }

  function entities() {
    if (!entityIndex || now() - entityAt > ttlMs) {
      const rows = typeof listNativeEntities === "function" ? listNativeEntities() : [];
      entityIndex = new Map();
      for (const row of rows || []) {
        // `listNativeEntities()` publishes the id as `entityID`; only the
        // per-entity read uses `itemID`. Indexing on `itemID` alone made every
        // lookup a miss, so `evaluatePair` answered NATIVE_STORE_IDENTITY_MISMATCH
        // for every war pair and no hostile engagement was ever authorised.
        const id = Number(row && (row.itemID ?? row.entityID));
        if (id > 0) entityIndex.set(id, row);
      }
      entityAt = now();
      stats.entityBuilds += 1;
    }
    return entityIndex;
  }

  function entityByID(id) {
    const key = Number(id);
    if (!(key > 0)) return null;
    const hit = entities().get(key) || null;
    if (hit) stats.entityHits += 1;
    else stats.entityMisses += 1;
    return hit;
  }

  function cargoAll() {
    if (!cargoIndex || now() - cargoAt > ttlMs) {
      const rows = typeof listNativeCargo === "function" ? listNativeCargo() : [];
      cargoIndex = new Map();
      flatCargo = Array.isArray(rows) ? rows : [];
      for (const row of flatCargo) {
        const owner = Number(row && (row.entityID ?? row.shipID ?? row.ownerID));
        if (!(owner > 0)) continue;
        if (!cargoIndex.has(owner)) cargoIndex.set(owner, []);
        cargoIndex.get(owner).push(row);
      }
      cargoAt = now();
      stats.cargoBuilds += 1;
    }
    return cargoIndex;
  }

  function cargoForEntity(id) {
    const key = Number(id);
    if (!(key > 0)) return [];
    const hit = cargoAll().get(key);
    if (hit) stats.cargoHits += 1;
    else stats.cargoMisses += 1;
    return hit || [];
  }

  function snapshot() {
    return { ...stats, ttlMs, entityCount: entityIndex ? entityIndex.size : 0, cargoOwners: cargoIndex ? cargoIndex.size : 0 };
  }

  return Object.freeze({ entityByID, cargoForEntity, allCargoRows, invalidate, snapshot });
}

let singleton = null;
function nativeCache() {
  if (!singleton) {
    const store = require("./npc/nativeNpcStore");
    singleton = createCache({
      listNativeEntities: () => store.listNativeEntities(),
      listNativeCargo: () => (typeof store.listNativeCargo === "function" ? store.listNativeCargo() : []),
    });
  }
  return singleton;
}

module.exports = { createCache, nativeCache };
