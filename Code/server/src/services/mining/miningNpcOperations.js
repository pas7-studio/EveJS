const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const npcService = require(path.join(__dirname, "../../space/npc"));
const nativeNpcStore = require(path.join(__dirname, "../../space/npc/nativeNpcStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "../../space/npc/npcWarpOrigins"));
const {
  resolveNpcSpawnGroup,
} = require(path.join(__dirname, "../../space/npc/npcData"));
const {
  getEffectTypeRecord,
  isModuleOnline,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getNpcFittedModuleItems,
} = require(path.join(__dirname, "../../space/npc/npcEquipment"));
const {
  ensureSceneMiningState,
  getMineableState,
  isMineableStaticEntity,
} = require("./miningRuntimeState");
const {
  resolveAggressorStandingProfile,
} = require("./miningNpcStandings");

const MAX_MINING_NPC_COMMAND_SPAWN_COUNT = 25;
const DEFAULT_MINING_FLEET_QUERY = "npc_mining_ops_highsec";
const DEFAULT_MINING_FLEET_QUERY_BY_BAND = Object.freeze({
  highsec: "npc_mining_ops_highsec",
  lowsec: "npc_mining_ops_lowsec",
  nullsec: "npc_mining_ops_nullsec",
});
const DEFAULT_MINING_RESPONSE_QUERY = "npc_laser_hostiles";
const DEFAULT_MINING_HAULER_QUERY = "npc_mining_hauler_highsec";
const DEFAULT_MINING_HAULER_QUERY_BY_BAND = Object.freeze({
  highsec: "npc_mining_hauler_highsec",
  lowsec: "npc_mining_hauler_lowsec",
  nullsec: "npc_mining_hauler_nullsec",
});
const DEFAULT_MINING_FLEET_COUNT = 1;
const DEFAULT_MINING_RESPONSE_COUNT = 8;
const DEFAULT_MINING_HAULER_COUNT = 1;
const DEFAULT_MINING_WARP_INGRESS_DURATION_MS = 2_500;
const DEFAULT_MINING_WARP_LANDING_RADIUS_METERS = 2_500;
const DEFAULT_MINING_FLEET_SPREAD_METERS = 1_500;
const DEFAULT_MINING_HAUL_THRESHOLD_RATIO = 0.85;
const DEFAULT_MINING_HAULER_UNLOAD_DURATION_MS = 8_000;
const DEFAULT_MINING_HAULER_INITIAL_DELAY_MS = 5_400_000;
const DEFAULT_MINING_HAULER_REPEAT_DELAY_MS = 1_800_000;
const DEFAULT_MINING_MINER_CARGO_CAPACITY_M3 = 35_000;
const DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3 = 65_000;
const DEFAULT_MINING_AGGRESSION_MEMORY_MS = 180_000;
const DEFAULT_MINING_RESPONSE_COOLDOWN_MS = 60_000;
const DEFAULT_MINING_RESPONSE_RETREAT_DELAY_MS = 120_000;
const MINING_NPC_CARGO_CAPACITY_M3_BY_TYPE_ID = Object.freeze({
  32880: 5_000, // Venture
  17480: 12_000, // Procurer
  17478: 10_000, // Retriever
  17476: 7_000, // Covetor
  22546: 10_000, // Skiff
  22548: 35_000, // Mackinaw
  22544: 8_000, // Hulk
});

const miningFleetStateByID = new Map();
const startupSceneSeedSet = new Set();
let nextMiningFleetID = 1;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function distance(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function getSurfaceDistance(left, right) {
  return Math.max(
    0,
    distance(left && left.position, right && right.position) -
      toFiniteNumber(left && left.radius, 0) -
      toFiniteNumber(right && right.radius, 0),
  );
}

function buildFleetReferencePosition(scene, fleetRecord) {
  const sampledPositions = [];
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs)
    ? fleetRecord.minerEntityIDs
    : []) {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    if (
      !entity ||
      !entity.position ||
      entity.mode === "WARP" ||
      entity.pendingWarp
    ) {
      continue;
    }
    sampledPositions.push(entity.position);
  }

  if (sampledPositions.length > 0) {
    const totals = sampledPositions.reduce((sum, position) => ({
      x: sum.x + toFiniteNumber(position && position.x, 0),
      y: sum.y + toFiniteNumber(position && position.y, 0),
      z: sum.z + toFiniteNumber(position && position.z, 0),
    }), { x: 0, y: 0, z: 0 });
    return {
      x: totals.x / sampledPositions.length,
      y: totals.y / sampledPositions.length,
      z: totals.z / sampledPositions.length,
    };
  }

  const preferredTarget =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(normalizePositiveInteger(fleetRecord && fleetRecord.targetShipID, 0))
      : null;
  return (
    (preferredTarget && preferredTarget.position) ||
    (
      fleetRecord &&
      fleetRecord.originAnchor &&
      fleetRecord.originAnchor.position
    ) ||
    { x: 0, y: 0, z: 0 }
  );
}

function resolveActiveMineableTarget(scene, entityID) {
  const normalizedEntityID = normalizePositiveInteger(entityID, 0);
  if (!scene || normalizedEntityID <= 0) {
    return null;
  }
  const entity = typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(normalizedEntityID)
    : null;
  const mineableState = getMineableState(scene, normalizedEntityID);
  if (!entity || !mineableState || toInt(mineableState.remainingQuantity, 0) <= 0) {
    return null;
  }
  return entity;
}

function buildFleetMineableClaimCounts(scene, currentFleetRecord) {
  const claimCounts = new Map();
  const fleets = getMiningFleetsForSystem(scene && scene.systemID);
  for (const fleetRecord of fleets) {
    if (
      !fleetRecord ||
      (currentFleetRecord && toInt(fleetRecord.fleetID, 0) === toInt(currentFleetRecord.fleetID, 0))
    ) {
      continue;
    }
    const claimedTarget = resolveActiveMineableTarget(scene, fleetRecord.activeAsteroidID);
    if (!claimedTarget) {
      continue;
    }
    const claimedTargetID = toInt(claimedTarget.itemID, 0);
    claimCounts.set(
      claimedTargetID,
      toInt(claimCounts.get(claimedTargetID), 0) + 1,
    );
  }
  return claimCounts;
}

function resolveFleetMineableStaticEntities(scene, fleetRecord = null, referenceEntity = null) {
  if (!scene) {
    return [];
  }

  const getByBubbleID =
    typeof scene.getBubbleScopedStaticEntitiesForBubbleID === "function"
      ? scene.getBubbleScopedStaticEntitiesForBubbleID.bind(scene)
      : null;
  const getByPosition =
    typeof scene.getBubbleScopedStaticEntitiesForPosition === "function"
      ? scene.getBubbleScopedStaticEntitiesForPosition.bind(scene)
      : null;
  const bubbleCandidateIDs = [];
  const pushBubbleID = (bubbleID) => {
    const normalizedBubbleID = toInt(bubbleID, 0);
    if (normalizedBubbleID > 0 && !bubbleCandidateIDs.includes(normalizedBubbleID)) {
      bubbleCandidateIDs.push(normalizedBubbleID);
    }
  };

  const activeTarget = resolveActiveMineableTarget(scene, fleetRecord && fleetRecord.activeAsteroidID);
  pushBubbleID(activeTarget && activeTarget.bubbleID);
  const targetShipEntity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(toInt(fleetRecord && fleetRecord.targetShipID, 0))
      : null;
  pushBubbleID(targetShipEntity && targetShipEntity.bubbleID);
  pushBubbleID(referenceEntity && referenceEntity.bubbleID);
  for (const minerEntityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const minerEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(minerEntityID)
        : null;
    pushBubbleID(minerEntity && minerEntity.bubbleID);
  }

  if (getByBubbleID) {
    for (const bubbleID of bubbleCandidateIDs) {
      const entities = getByBubbleID(bubbleID);
      if (Array.isArray(entities) && entities.length > 0) {
        return entities;
      }
    }
  }

  if (getByPosition) {
    const positionCandidates = [
      activeTarget && activeTarget.position,
      fleetRecord && fleetRecord.originAnchor && fleetRecord.originAnchor.position,
      targetShipEntity && targetShipEntity.position,
      referenceEntity && referenceEntity.position,
    ];
    for (const position of positionCandidates) {
      if (!position) {
        continue;
      }
      const entities = getByPosition(position);
      if (Array.isArray(entities) && entities.length > 0) {
        return entities;
      }
    }
  }

  return [...(scene.staticEntities || [])];
}

function resolveAvailableMineableTargetEntries(scene, fleetRecord = null, referenceEntity = null) {
  ensureSceneMiningState(scene);
  return resolveFleetMineableStaticEntities(scene, fleetRecord, referenceEntity)
    .filter((entity) => isMineableStaticEntity(entity))
    .map((entity) => ({
      entity,
      state: getMineableState(scene, entity.itemID),
    }))
    .filter((entry) => entry.state && toInt(entry.state.remainingQuantity, 0) > 0);
}

function getFleetMinerAssignmentMap(fleetRecord) {
  if (!fleetRecord || typeof fleetRecord !== "object") {
    return {};
  }
  if (
    !fleetRecord.assignedAsteroidIDsByMinerID ||
    typeof fleetRecord.assignedAsteroidIDsByMinerID !== "object"
  ) {
    fleetRecord.assignedAsteroidIDsByMinerID = {};
  }
  return fleetRecord.assignedAsteroidIDsByMinerID;
}

function pruneFleetMinerAssignments(scene, fleetRecord) {
  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  const validMinerIDs = new Set(
    (Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
      .map((entityID) => toInt(entityID, 0))
      .filter((entityID) => entityID > 0),
  );
  for (const [minerEntityID, assignedAsteroidID] of Object.entries(assignmentMap)) {
    const normalizedMinerEntityID = toInt(minerEntityID, 0);
    if (!validMinerIDs.has(normalizedMinerEntityID)) {
      delete assignmentMap[minerEntityID];
      continue;
    }
    if (!resolveActiveMineableTarget(scene, assignedAsteroidID)) {
      delete assignmentMap[minerEntityID];
    }
  }
  return assignmentMap;
}

function buildAssignedMineableClaimCounts(scene, currentFleetRecord, excludedMinerEntityID = 0) {
  const claimCounts = new Map();
  const normalizedExcludedMinerEntityID = normalizePositiveInteger(excludedMinerEntityID, 0);
  for (const fleetRecord of getMiningFleetsForSystem(scene && scene.systemID)) {
    if (
      !fleetRecord ||
      toInt(fleetRecord.fleetID, 0) === toInt(currentFleetRecord && currentFleetRecord.fleetID, 0)
    ) {
      continue;
    }
    const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
    for (const [minerEntityID, assignedAsteroidID] of Object.entries(assignmentMap)) {
      if (toInt(minerEntityID, 0) === normalizedExcludedMinerEntityID) {
        continue;
      }
      const targetEntity = resolveActiveMineableTarget(scene, assignedAsteroidID);
      if (!targetEntity) {
        continue;
      }
      const targetID = toInt(targetEntity.itemID, 0);
      claimCounts.set(targetID, toInt(claimCounts.get(targetID), 0) + 1);
    }
  }
  return claimCounts;
}

function getMineableClaimPenaltyMeters() {
  return Math.max(
    0,
    toFiniteNumber(
      config.miningNpcFleetTargetClaimPenaltyMeters,
      7_500,
    ),
  );
}

function scoreMineableTargetEntry(entry, referencePosition, claimCounts) {
  const targetID = toInt(entry && entry.entity && entry.entity.itemID, 0);
  const claimCount = claimCounts instanceof Map ? toInt(claimCounts.get(targetID), 0) : 0;
  const distanceMeters = distance(entry && entry.entity && entry.entity.position, referencePosition);
  return (
    distanceMeters +
    (claimCount * getMineableClaimPenaltyMeters())
  );
}

function buildMineableTargetSelectionSnapshots(
  scene,
  minerEntity,
  candidates,
  referencePosition,
  claimCounts,
) {
  const preferredDistanceMeters = Math.max(
    0,
    getEntityTargetLockRangeMeters(scene, minerEntity),
  );
  return candidates.map((entry) => {
    const targetID = toInt(entry && entry.entity && entry.entity.itemID, 0);
    const claimCount = claimCounts instanceof Map ? toInt(claimCounts.get(targetID), 0) : 0;
    const distanceMeters = distance(entry && entry.entity && entry.entity.position, referencePosition);
    return {
      entry,
      targetID,
      claimCount,
      distanceMeters,
      localPreferred:
        preferredDistanceMeters <= 0 ||
        distanceMeters <= preferredDistanceMeters,
      score: scoreMineableTargetEntry(entry, referencePosition, claimCounts),
    };
  });
}

function compareMineableTargetSelectionSnapshots(left, right) {
  const scoreDelta = toFiniteNumber(left && left.score, 0) - toFiniteNumber(right && right.score, 0);
  if (Math.abs(scoreDelta) > 0.000001) {
    return scoreDelta;
  }

  const quantityDelta =
    toInt(right && right.entry && right.entry.state && right.entry.state.remainingQuantity, 0) -
    toInt(left && left.entry && left.entry.state && left.entry.state.remainingQuantity, 0);
  if (quantityDelta !== 0) {
    return quantityDelta;
  }

  return toInt(left && left.targetID, 0) - toInt(right && right.targetID, 0);
}

function isMiningSnapshotCompatibleWithEntry(snapshot, entry, hooks = {}) {
  if (!snapshot || !entry || !entry.state) {
    return false;
  }
  if (typeof hooks.isMiningSnapshotCompatibleWithState === "function") {
    return hooks.isMiningSnapshotCompatibleWithState(snapshot, entry.state) === true;
  }
  if (snapshot.family === "gas") {
    return entry.state.yieldKind === "gas";
  }
  if (snapshot.family === "ice") {
    return entry.state.yieldKind === "ice";
  }
  return entry.state.yieldKind === "ore";
}

function chooseMineableTargetForMiner(
  scene,
  fleetRecord,
  minerEntity,
  availableTargetEntries,
  claimCounts,
  miningSnapshot = null,
  hooks = {},
) {
  if (!scene || !fleetRecord || !minerEntity) {
    return null;
  }

  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  const candidates = Array.isArray(availableTargetEntries)
    ? (
      miningSnapshot
        ? availableTargetEntries.filter((entry) => isMiningSnapshotCompatibleWithEntry(miningSnapshot, entry, hooks))
        : availableTargetEntries
    )
    : [];
  if (candidates.length <= 0) {
    delete assignmentMap[toInt(minerEntity.itemID, 0)];
    return null;
  }

  const referencePosition = minerEntity.position || buildFleetReferencePosition(scene, fleetRecord);
  const selectionSnapshots = buildMineableTargetSelectionSnapshots(
    scene,
    minerEntity,
    candidates,
    referencePosition,
    claimCounts,
  );
  const currentAssignedTarget = resolveActiveMineableTarget(
    scene,
    assignmentMap[toInt(minerEntity.itemID, 0)],
  );
  const currentSelection = currentAssignedTarget
    ? selectionSnapshots.find((snapshot) => snapshot.targetID === toInt(currentAssignedTarget.itemID, 0)) || null
    : null;

  const preferredLocalUnclaimed = selectionSnapshots
    .filter((snapshot) => snapshot.localPreferred === true && snapshot.claimCount <= 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const preferredLocalClaimed = selectionSnapshots
    .filter((snapshot) => snapshot.localPreferred === true && snapshot.claimCount > 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const fallbackGlobalUnclaimed = selectionSnapshots
    .filter((snapshot) => snapshot.claimCount <= 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const fallbackGlobalClaimed = selectionSnapshots
    .filter((snapshot) => snapshot.claimCount > 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const bestSelection =
    preferredLocalUnclaimed ||
    preferredLocalClaimed ||
    fallbackGlobalUnclaimed ||
    fallbackGlobalClaimed ||
    null;

  if (currentSelection && bestSelection) {
    const keepCurrentAssignment =
      currentSelection.localPreferred === true ||
      compareMineableTargetSelectionSnapshots(currentSelection, bestSelection) <= 0;
    if (keepCurrentAssignment) {
      if (claimCounts instanceof Map) {
        claimCounts.set(
          currentSelection.targetID,
          toInt(claimCounts.get(currentSelection.targetID), 0) + 1,
        );
      }
      return currentAssignedTarget;
    }
  }

  const chosenEntry = bestSelection && bestSelection.entry ? bestSelection.entry : null;
  if (!chosenEntry || !chosenEntry.entity) {
    return null;
  }

  const chosenTargetID = toInt(chosenEntry.entity.itemID, 0);
  assignmentMap[toInt(minerEntity.itemID, 0)] = chosenTargetID;
  if (claimCounts instanceof Map) {
    claimCounts.set(chosenTargetID, toInt(claimCounts.get(chosenTargetID), 0) + 1);
  }
  return chosenEntry.entity;
}

function getEntityTargetLockRangeMeters(scene, entity) {
  if (!scene || !entity || typeof scene.getEntityTargetingStats !== "function") {
    return 0;
  }
  const targetingStats = scene.getEntityTargetingStats(entity);
  return Math.max(0, toFiniteNumber(targetingStats && targetingStats.maxTargetRange, 0));
}

function getMiningEngagementRangeMeters(scene, entity, primarySnapshot, rangeBufferMeters) {
  const miningRangeMeters = Math.max(
    0,
    toFiniteNumber(primarySnapshot && primarySnapshot.maxRangeMeters, 0) - Math.max(0, toFiniteNumber(rangeBufferMeters, 0)),
  );
  const lockRangeMeters = Math.max(
    0,
    getEntityTargetLockRangeMeters(scene, entity) - Math.max(0, toFiniteNumber(rangeBufferMeters, 0)),
  );
  if (lockRangeMeters <= 0) {
    return miningRangeMeters;
  }
  if (miningRangeMeters <= 0) {
    return lockRangeMeters;
  }
  return Math.min(miningRangeMeters, lockRangeMeters);
}

function chooseFleetMineableTarget(scene, fleetRecord, hooks = {}) {
  ensureSceneMiningState(scene);

  const currentTarget = resolveActiveMineableTarget(scene, fleetRecord && fleetRecord.activeAsteroidID);
  if (currentTarget) {
    return currentTarget;
  }

  const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
  const assignmentCounts = new Map();
  for (const assignedAsteroidID of Object.values(assignmentMap)) {
    const assignedTarget = resolveActiveMineableTarget(scene, assignedAsteroidID);
    if (!assignedTarget) {
      continue;
    }
    const assignedTargetID = toInt(assignedTarget.itemID, 0);
    assignmentCounts.set(
      assignedTargetID,
      toInt(assignmentCounts.get(assignedTargetID), 0) + 1,
    );
  }
  const assignedPrimaryTargetID = [...assignmentCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  if (assignedPrimaryTargetID && assignedPrimaryTargetID[0] > 0) {
    const assignedPrimaryTarget = resolveActiveMineableTarget(scene, assignedPrimaryTargetID[0]);
    if (assignedPrimaryTarget) {
      return assignedPrimaryTarget;
    }
  }

  const candidates = resolveAvailableMineableTargetEntries(scene, fleetRecord);
  if (candidates.length <= 0) {
    return typeof hooks.chooseMineableTargetForFleet === "function"
      ? hooks.chooseMineableTargetForFleet(scene, fleetRecord)
      : null;
  }

  const claimCounts = buildFleetMineableClaimCounts(scene, fleetRecord);
  const referencePosition = buildFleetReferencePosition(scene, fleetRecord);
  candidates.sort((left, right) => {
    const leftClaims = toInt(claimCounts.get(toInt(left && left.entity && left.entity.itemID, 0)), 0);
    const rightClaims = toInt(claimCounts.get(toInt(right && right.entity && right.entity.itemID, 0)), 0);
    if (leftClaims !== rightClaims) {
      return leftClaims - rightClaims;
    }

    const distanceDelta =
      distance(left && left.entity && left.entity.position, referencePosition) -
      distance(right && right.entity && right.entity.position, referencePosition);
    if (Math.abs(distanceDelta) > 0.000001) {
      return distanceDelta;
    }

    const quantityDelta =
      toInt(right && right.state && right.state.remainingQuantity, 0) -
      toInt(left && left.state && left.state.remainingQuantity, 0);
    if (quantityDelta !== 0) {
      return quantityDelta;
    }

    return toInt(left && left.entity && left.entity.itemID, 0) -
      toInt(right && right.entity && right.entity.itemID, 0);
  });

  return candidates[0] ? candidates[0].entity : null;
}

function clearStaleMineableTargetLocks(scene, entity, targetEntityID, hooks = {}) {
  if (!scene || !entity) {
    return 0;
  }

  const normalizedTargetID = normalizePositiveInteger(targetEntityID, 0);
  const getTargets =
    typeof hooks.getTargetsForEntity === "function"
      ? hooks.getTargetsForEntity
      : (runtimeScene, runtimeEntity) => (
        runtimeScene && typeof runtimeScene.getTargetsForEntity === "function"
          ? runtimeScene.getTargetsForEntity(runtimeEntity)
          : []
      );
  const lockedTargetIDs = Array.isArray(getTargets(scene, entity))
    ? getTargets(scene, entity)
    : [];

  let clearedCount = 0;
  for (const lockedTargetID of lockedTargetIDs) {
    const normalizedLockedTargetID = normalizePositiveInteger(lockedTargetID, 0);
    if (
      normalizedLockedTargetID <= 0 ||
      normalizedLockedTargetID === normalizedTargetID
    ) {
      continue;
    }
    const lockedTargetEntity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(normalizedLockedTargetID)
        : null;
    if (
      !isMineableStaticEntity(lockedTargetEntity) &&
      !getMineableState(scene, normalizedLockedTargetID)
    ) {
      continue;
    }
    if (
      typeof scene.removeLockedTarget === "function" &&
      scene.removeLockedTarget(entity, normalizedLockedTargetID, {
        notifySelf: false,
        notifyTarget: false,
        reason: null,
      })
    ) {
      clearedCount += 1;
    }
  }

  if (
    typeof scene.getSortedPendingTargetLocks === "function" &&
    typeof scene.cancelPendingTargetLock === "function"
  ) {
    for (const pendingLock of scene.getSortedPendingTargetLocks(entity) || []) {
      const pendingTargetID = normalizePositiveInteger(pendingLock && pendingLock.targetID, 0);
      if (
        pendingTargetID <= 0 ||
        pendingTargetID === normalizedTargetID
      ) {
        continue;
      }
      const pendingTargetEntity =
        typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(pendingTargetID)
          : null;
      if (
        !isMineableStaticEntity(pendingTargetEntity) &&
        !getMineableState(scene, pendingTargetID)
      ) {
        continue;
      }
      if (scene.cancelPendingTargetLock(entity, pendingTargetID, {
        notifySelf: false,
      })) {
        clearedCount += 1;
      }
    }
  }

  return clearedCount;
}

function syncMiningTargetLock(scene, entity, targetEntity, now, hooks = {}) {
  if (!scene || !entity || !targetEntity) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  clearStaleMineableTargetLocks(scene, entity, targetEntity.itemID, hooks);

  const getTargets =
    typeof hooks.getTargetsForEntity === "function"
      ? hooks.getTargetsForEntity
      : (runtimeScene, runtimeEntity) => (
        runtimeScene && typeof runtimeScene.getTargetsForEntity === "function"
          ? runtimeScene.getTargetsForEntity(runtimeEntity)
          : []
      );
  const normalizedTargetID = toInt(targetEntity.itemID, 0);
  const lockedTargets = Array.isArray(getTargets(scene, entity)) ? getTargets(scene, entity) : [];
  if (lockedTargets.includes(normalizedTargetID)) {
    return {
      success: true,
      data: {
        pending: false,
        targets: lockedTargets,
      },
    };
  }

  if (typeof scene.finalizeTargetLock !== "function") {
    return {
      success: false,
      errorMsg: "TARGET_LOCK_UNSUPPORTED",
    };
  }

  let lockResult = scene.finalizeTargetLock(entity, targetEntity, {
    nowMs: now,
  });
  if (
    (!lockResult || lockResult.success !== true) &&
    lockResult &&
    lockResult.errorMsg === "TARGET_LOCK_LIMIT_REACHED"
  ) {
    clearStaleMineableTargetLocks(scene, entity, 0, hooks);
    lockResult = scene.finalizeTargetLock(entity, targetEntity, {
      nowMs: now,
    });
  }

  return lockResult || {
    success: false,
    errorMsg: "TARGET_LOCK_FAILED",
  };
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function parseAmount(value) {
  const text = String(value || "")
    .trim()
    .replace(/,/g, "")
    .replace(/_/g, "");
  if (!text) {
    return null;
  }

  const match = /^(-?\d+(?:\.\d+)?)([kmbt])?$/i.exec(text);
  if (!match) {
    return null;
  }

  const baseValue = Number(match[1]);
  if (!Number.isFinite(baseValue)) {
    return null;
  }

  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  const suffix = String(match[2] || "").toLowerCase();
  return baseValue * (multiplier[suffix] || 1);
}

function parseNpcSpawnArguments(argumentText, defaultAmount = 1) {
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      success: true,
      amount: defaultAmount,
      query: "",
    };
  }

  const parts = trimmed.split(/\s+/);
  let amount = defaultAmount;
  let amountIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const parsed = parseAmount(parts[index]);
    if (parsed === null) {
      continue;
    }
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_AMOUNT",
      };
    }
    amount = parsed;
    amountIndex = index;
    break;
  }

  return {
    success: true,
    amount,
    query: amountIndex >= 0
      ? parts.filter((_, index) => index !== amountIndex).join(" ").trim()
      : trimmed,
  };
}

function buildMiningWarpLandingPoint(center, index = 0, total = 1, radiusMeters = DEFAULT_MINING_FLEET_SPREAD_METERS) {
  const divisor = Math.max(1, toInt(total, 1));
  const angle = ((Math.PI * 2) / divisor) * Math.max(0, index);
  const resolvedRadius = Math.max(0, toFiniteNumber(radiusMeters, DEFAULT_MINING_FLEET_SPREAD_METERS));
  return {
    x: toFiniteNumber(center && center.x, 0) + (Math.cos(angle) * resolvedRadius),
    y: toFiniteNumber(center && center.y, 0),
    z: toFiniteNumber(center && center.z, 0) + (Math.sin(angle) * resolvedRadius),
  };
}

function buildOffgridOriginAnchor(scene, target) {
  return findSafeWarpOriginAnchor(scene, target, {
    clearanceMeters: Math.max(
      ONE_AU_IN_METERS,
      toFiniteNumber(config.miningNpcWarpOriginClearanceMeters, ONE_AU_IN_METERS),
    ),
    minDistanceMeters: toFiniteNumber(
      config.miningNpcWarpOriginMinDistanceMeters,
      ONE_AU_IN_METERS * 2,
    ),
    maxDistanceMeters: toFiniteNumber(
      config.miningNpcWarpOriginMaxDistanceMeters,
      ONE_AU_IN_METERS * 4,
    ),
    stepMeters: toFiniteNumber(
      config.miningNpcWarpOriginStepMeters,
      ONE_AU_IN_METERS / 2,
    ),
  });
}

function parseSystemIdList(value) {
  return [...new Set(
    String(value || "")
      .split(/[,\s]+/u)
      .map((entry) => toInt(entry, 0))
      .filter((entry) => entry > 0),
  )];
}

function getSecurityBandForSystemID(systemID) {
  const systemRecord = worldData.getSolarSystemByID(
    normalizePositiveInteger(systemID, 0),
  );
  const securityStatus = toFiniteNumber(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
    0,
  );
  if (securityStatus >= 0.45) {
    return "highsec";
  }
  if (securityStatus >= 0) {
    return "lowsec";
  }
  return "nullsec";
}

function getSecurityBandForScene(scene, fallbackSystemID = 0) {
  const systemID = normalizePositiveInteger(
    scene && scene.systemID,
    normalizePositiveInteger(fallbackSystemID, 0),
  );
  return getSecurityBandForSystemID(systemID);
}

function resolveConfiguredBandQuery(scene, explicitQuery, options = {}) {
  const trimmedExplicitQuery = String(explicitQuery || "").trim();
  if (trimmedExplicitQuery) {
    return trimmedExplicitQuery;
  }

  const configValue = String(
    options.configValue ||
    "",
  ).trim();
  if (configValue) {
    return configValue;
  }

  const securityBand = getSecurityBandForScene(scene, options.systemID);
  const bandConfigValues = options.bandConfigValues && typeof options.bandConfigValues === "object"
    ? options.bandConfigValues
    : {};
  const bandDefaultValues = options.bandDefaultValues && typeof options.bandDefaultValues === "object"
    ? options.bandDefaultValues
    : {};
  const configuredBandValue = String(bandConfigValues[securityBand] || "").trim();
  if (configuredBandValue) {
    return configuredBandValue;
  }

  return String(
    bandDefaultValues[securityBand] ||
    options.fallbackQuery ||
    "",
  ).trim();
}

function buildSpawnTarget(scene, session = null) {
  const shipID = normalizePositiveInteger(session && session._space && session._space.shipID, 0);
  if (shipID) {
    const shipEntity = scene.getEntityByID(shipID);
    if (shipEntity && shipEntity.position) {
      return shipEntity;
    }
  }

  const asteroidEntity = (Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [])
    .find((entity) => entity && entity.kind === "asteroid" && entity.position);
  if (asteroidEntity) {
    return asteroidEntity;
  }

  return {
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: 0,
  };
}

function applyPassiveMiningFleetOverrides(entityID, options = {}) {
  npcService.setBehaviorOverrides(entityID, {
    autoAggro: false,
    autoActivateWeapons: false,
    autoAggroTargetClasses: [],
    targetPreference: "none",
    movementMode: String(options.movementMode || "orbit"),
    orbitDistanceMeters: Math.max(
      100,
      toFiniteNumber(options.orbitDistanceMeters, 1_200),
    ),
    followRangeMeters: Math.max(
      100,
      toFiniteNumber(options.followRangeMeters, 800),
    ),
    idleAnchorOrbit: options.idleAnchorOrbit === true,
    idleAnchorOrbitDistanceMeters: Math.max(
      100,
      toFiniteNumber(options.idleAnchorOrbitDistanceMeters, 1_200),
    ),
    returnToHomeWhenIdle: options.returnToHomeWhenIdle === true,
    leashRangeMeters: Math.max(0, toFiniteNumber(options.leashRangeMeters, 0)),
  });
  const controller = npcService.getControllerByEntityID(entityID);
  if (options.clearCombatPreference !== false) {
    if (controller) {
      controller.preferredTargetID = 0;
      controller.currentTargetID = 0;
      controller.lastAggressorID = 0;
    }
  }
  if (options.issueStopOrder !== false) {
    npcService.issueManualOrder(entityID, {
      type: "stop",
    });
  } else {
    if (controller) {
      controller.manualOrder = null;
      controller.nextThinkAtMs = Number.MAX_SAFE_INTEGER;
    }
  }
}

function getNormalizedManualOrderSignature(order) {
  if (!order || typeof order !== "object") {
    return null;
  }
  return {
    type: String(order.type || "").trim().toLowerCase() || null,
    targetID: normalizePositiveInteger(order.targetID, 0),
    movementMode: String(order.movementMode || "").trim().toLowerCase() || null,
    orbitDistanceMeters: Math.max(0, toFiniteNumber(order.orbitDistanceMeters, 0)),
    followRangeMeters: Math.max(0, toFiniteNumber(order.followRangeMeters, 0)),
    allowWeapons:
      order.allowWeapons === undefined || order.allowWeapons === null
        ? null
        : order.allowWeapons === true,
    keepLock:
      order.keepLock === undefined || order.keepLock === null
        ? null
        : order.keepLock === true,
  };
}

function areManualOrdersEquivalent(leftOrder, rightOrder) {
  const leftSignature = getNormalizedManualOrderSignature(leftOrder);
  const rightSignature = getNormalizedManualOrderSignature(rightOrder);
  if (!leftSignature && !rightSignature) {
    return true;
  }
  if (!leftSignature || !rightSignature) {
    return false;
  }
  return (
    leftSignature.type === rightSignature.type &&
    leftSignature.targetID === rightSignature.targetID &&
    leftSignature.movementMode === rightSignature.movementMode &&
    Math.abs(leftSignature.orbitDistanceMeters - rightSignature.orbitDistanceMeters) < 1 &&
    Math.abs(leftSignature.followRangeMeters - rightSignature.followRangeMeters) < 1 &&
    leftSignature.allowWeapons === rightSignature.allowWeapons &&
    leftSignature.keepLock === rightSignature.keepLock
  );
}

function syncFleetManualOrder(entityID, desiredOrder) {
  const controller = npcService.getControllerByEntityID(entityID);
  if (!controller) {
    return false;
  }
  if (areManualOrdersEquivalent(controller.manualOrder, desiredOrder)) {
    return false;
  }
  npcService.issueManualOrder(entityID, desiredOrder || null);
  npcService.wakeNpcController(entityID, 0);
  return true;
}

function clearFleetManualOrders(entityIDs = []) {
  let changedCount = 0;
  for (const entityID of Array.isArray(entityIDs) ? entityIDs : []) {
    if (syncFleetManualOrder(entityID, null)) {
      changedCount += 1;
    }
  }
  return changedCount;
}

function buildMiningMovementOrder(targetEntityID, movementMode, distanceMeters) {
  const normalizedTargetID = normalizePositiveInteger(targetEntityID, 0);
  if (!normalizedTargetID) {
    return null;
  }
  const normalizedMovementMode = String(movementMode || "orbit").trim().toLowerCase();
  return {
    type: normalizedMovementMode === "follow" ? "follow" : "orbit",
    targetID: normalizedTargetID,
    movementMode: normalizedMovementMode === "follow" ? "follow" : "orbit",
    orbitDistanceMeters:
      normalizedMovementMode === "follow"
        ? 0
        : Math.max(0, toFiniteNumber(distanceMeters, 0)),
    followRangeMeters:
      normalizedMovementMode === "follow"
        ? Math.max(0, toFiniteNumber(distanceMeters, 0))
        : 0,
    allowWeapons: false,
    keepLock: true,
  };
}

// Measured 2026-10-27 on the work stack (admin bridge mining_fleet_diagnose):
//  - miners reported mode GOTO with targetPoint ~1.0e16 m from the system origin;
//  - the hull itself sat 2.5 AU out and only 54 km from its nearest belt;
//  - miner -> rock distance GREW (45 765 m -> 49 487 m in 29 s of wallclock);
//  - the hauler followed its miner, closed to 4 km, and the gap reopened every cycle.
// `1.0e16` is not a computed destination: it is what the native speed command writes
// (movement/commands/movementStopSpeedCommands.js: targetPoint = position + direction *
// 1.0e16) when a positive speed fraction is applied to a hull in mode STOP. Such a hull
// flies straight forever in whatever direction it happened to face. Stopping it is the
// only order that can be honoured, and it makes the next orbit/follow meaningful.
function stopRunawayFullThrottle(scene, entity, reason) {
  if (!scene || !entity) return false;
  const target = entity.targetPoint;
  const position = entity.position;
  if (
    !target ||
    !position ||
    !Number.isFinite(Number(target.x)) ||
    !Number.isFinite(Number(position.x))
  ) {
    return false;
  }
  const gap = Math.hypot(
    Number(target.x) - Number(position.x),
    Number(target.y) - Number(position.y),
    Number(target.z) - Number(position.z),
  );
  // Only a GOTO hull can be flying the sentinel line: a fresh orbit or follow also sets a
  // positive speed fraction, and stopping on that would kill the order issued just before
  // (measured: 56 "parked" miners that all stayed in mode STOP).
  if (String(entity.mode || "").toUpperCase() !== "GOTO") return false;
  if (!(gap > 1e9)) return false;
  let accepted = false;
  try {
    const npcRuntime = require("../../space/npc/npcRuntime");
    if (typeof npcRuntime.stop === "function") {
      const result = npcRuntime.stop(entity.itemID, { reason: "coop-runaway-" + reason });
      accepted = result === true || Boolean(result && result.success === true);
    } else if (typeof scene.stopShipEntity === "function") {
      accepted = scene.stopShipEntity(entity) === true;
    }
  } catch (_coopStopError) { /* an unstoppable hull must still receive its new order */ }
  try {
    require("../../space/coopMiningTrace").note("RUNAWAY_ORDER_STOPPED", {
      fleetID: 0,
      systemID: toInt(scene.systemID, 0),
      shipID: toInt(entity.itemID, 0),
      reason,
      targetGapMeters: Math.round(gap),
      speedFraction: toFiniteNumber(entity.speedFraction, 0),
      accepted,
    });
  } catch (_coopStopNote) { /* telemetry must never break movement */ }
  return accepted;
}

// While a fleet is hauling, loaded or returning, this function's caller returns before the
// per-miner loop - so the miners never receive another order. Combined with the runaway
// straight line above, they simply flew away from the belt and the hauler could not reach
// them. Park them where they are: mining resumes from a known position, and the hauler
// only has to close a distance that is not growing.
function parkFleetMiners(scene, fleetRecord, reason) {
  if (!scene || !fleetRecord) return 0;
  let parked = 0;
  for (const minerEntityID of Array.isArray(fleetRecord.minerEntityIDs)
    ? fleetRecord.minerEntityIDs
    : []) {
    const entity = scene.getEntityByID ? scene.getEntityByID(minerEntityID) : null;
    if (!entity || entity.mode === "WARP" || entity.pendingWarp || entity.warpState) {
      continue;
    }
    // Measured 2026-10-27: parking the miners where they happened to drift left them
    // 3.1-6.4 km from their own rock while the hauler waited 750 m from it, so the
    // 2 500 m transfer range was never met. The meeting point is the rock: send each
    // miner back to the fleet's asteroid at its normal orbit distance.
    const rockID = toInt(fleetRecord.activeAsteroidID, 0);
    if (!(rockID > 0)) continue;
    const alreadyOrbitingRock =
      String(entity.mode || "").toUpperCase() === "ORBIT" &&
      toInt(entity.targetEntityID, 0) === rockID;
    if (alreadyOrbitingRock) continue;
    // A runaway straight line must be killed first, or no orbit order can win. This only
    // touches a GOTO hull, so it cannot stop the orbit issued below.
    stopRunawayFullThrottle(scene, entity, reason);
    try {
      const npcService = require("../../space/npc/npcService");
      if (typeof npcService.issueManualOrder !== "function") continue;
      // Measured 2026-10-27: the identical manual orbit order stuck on the hauler but not
      // on a miner, and the only other thing done to the hauler was rewriting its
      // behaviour overrides first. A fleet spawned with issueStopOrder:false also parks its
      // controller on nextThinkAtMs = MAX_SAFE_INTEGER, so it needs the same reset before an
      // order can be flown. Profile stays "orbit": this only re-asserts it.
      applyPassiveMiningFleetOverrides(minerEntityID, {
        movementMode: "orbit",
        orbitDistanceMeters: 800,
        followRangeMeters: 800,
        idleAnchorOrbit: false,
        issueStopOrder: false,
        clearCombatPreference: false,
      });
      const ordered = npcService.issueManualOrder(minerEntityID, {
        type: "orbit", targetID: rockID, orbitDistanceMeters: 800,
        allowWeapons: false,
      });
      if (ordered && ordered.success === true) parked += 1;
    } catch (_coopMinerReturnError) { /* never block the haul */ }
  }
  if (parked > 0) {
    try {
      require("../../space/coopRuntimeProbe").observe("living-mining-miners-parked", null,
        { spaceState: { systemID: toInt(scene.systemID, 0) } },
        { fleetID: toInt(fleetRecord.fleetID, 0), reason, parked });
    } catch (_coopParkNote) { /* telemetry must never break movement */ }
  }
  return parked;
}

function syncMiningApproachOrder(scene, entity, targetEntity, orbitDistanceMeters) {
  if (!scene || !entity || !targetEntity) {
    return false;
  }

  // A hull that is still flying a native straight-line full-throttle order cannot be
  // re-aimed sensibly: stop it once so the approach below starts from a clean state.
  stopRunawayFullThrottle(scene, entity, "mining-approach");

  const normalizedOrbitDistance = Math.max(0, toFiniteNumber(orbitDistanceMeters, 0));
  const surfaceDistanceMeters = getSurfaceDistance(entity, targetEntity);
  const sameTarget =
    toInt(entity.targetEntityID, 0) === toInt(targetEntity.itemID, 0);
  const followRangeMatchesOrbit =
    Math.abs(toFiniteNumber(entity.followRange, 0) - normalizedOrbitDistance) <= 1;
  const currentlyFollowingOrbitBand =
    entity.mode === "FOLLOW" &&
    sameTarget &&
    followRangeMatchesOrbit;
  const orbitReacquireDistanceMeters =
    normalizedOrbitDistance + Math.max(5_000, normalizedOrbitDistance * 0.5);
  const orbitSettleDistanceMeters =
    normalizedOrbitDistance + Math.max(1_000, normalizedOrbitDistance * 0.2);
  const desiredMovementMode =
    surfaceDistanceMeters > orbitReacquireDistanceMeters ||
    (
      currentlyFollowingOrbitBand &&
      surfaceDistanceMeters > orbitSettleDistanceMeters
    )
      ? "follow"
      : "orbit";

  if (desiredMovementMode === "follow") {
    return scene.followShipEntity(
      entity,
      targetEntity.itemID,
      normalizedOrbitDistance,
      {
        queueHistorySafeContract: true,
        suppressFreshAcquireReplay: true,
      },
    );
  }

  return scene.orbitShipEntity(
    entity,
    targetEntity.itemID,
    normalizedOrbitDistance,
    {
      queueHistorySafeContract: true,
      suppressFreshAcquireReplay: true,
    },
  );
}

function getNpcOreCargoItems(entity) {
  return (Array.isArray(entity && entity.nativeCargoItems) ? entity.nativeCargoItems : [])
    .filter((entry) => toInt(entry && entry.moduleID, 0) <= 0);
}

function getNpcOreCargoVolume(entity) {
  return getNpcOreCargoItems(entity).reduce((sum, entry) => {
    const quantity = Math.max(0, toInt(entry && (entry.quantity ?? entry.stacksize), 0));
    require("../../space/coopCargoVolume").ensure(entry);
    const volume = Math.max(0, toFiniteNumber(entry && entry.volume, 0));
    return sum + (quantity * volume);
  }, 0);
}

function getNpcOreCargoSummary(entity) {
  const entries = getNpcOreCargoItems(entity);
  return {
    usedVolumeM3: getNpcOreCargoVolume(entity),
    stackCount: entries.length,
    quantity: entries.reduce(
      (sum, entry) => sum + Math.max(0, toInt(entry && entry.quantity, 0)),
      0,
    ),
  };
}

function getNpcCargoCapacityM3(entity, fallbackCapacityM3) {
  const itemType = resolveItemByTypeID(toInt(entity && entity.typeID, 0)) || null;
  const explicitHullCapacity = Math.max(
    0,
    toFiniteNumber(
      MINING_NPC_CARGO_CAPACITY_M3_BY_TYPE_ID[toInt(entity && entity.typeID, 0)],
      0,
    ),
  );
  if (explicitHullCapacity > 0) {
    return explicitHullCapacity;
  }
  const configuredCapacity = toFiniteNumber(fallbackCapacityM3, 0);
  if (configuredCapacity > 0) {
    return configuredCapacity;
  }
  const itemTypeCapacity = toFiniteNumber(itemType && itemType.capacity, 0);
  return itemTypeCapacity > 0 ? itemTypeCapacity : 0;
}

function getFleetCargoState(scene, fleetRecord) {
  const minerEntities = (Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const haulerEntities = (Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : [])
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const minerCapacityPerHull = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcMinerCargoCapacityM3,
      DEFAULT_MINING_MINER_CARGO_CAPACITY_M3,
    ),
  );
  const haulerCapacityPerHull = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcHaulerCargoCapacityM3,
      DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
    ),
  );

  const minerUsedVolumeM3 = minerEntities.reduce(
    (sum, entity) => sum + getNpcOreCargoVolume(entity),
    0,
  );
  const minerCapacityM3 = minerEntities.reduce(
    (sum, entity) => sum + getNpcCargoCapacityM3(entity, minerCapacityPerHull),
    0,
  );
  const haulerCapacityM3 = haulerEntities.reduce(
    (sum, entity) => sum + getNpcCargoCapacityM3(entity, haulerCapacityPerHull),
    0,
  );

  return {
    minerUsedVolumeM3,
    minerCapacityM3,
    haulerCapacityM3,
    minerFillRatio:
      minerCapacityM3 > 0
        ? minerUsedVolumeM3 / minerCapacityM3
        : 0,
  };
}

function getFleetEntityIDs(fleetRecord, options = {}) {
  const includeResponse = options.includeResponse === true;
  return [
    ...(Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
    ...(includeResponse && Array.isArray(fleetRecord && fleetRecord.responseEntityIDs)
      ? fleetRecord.responseEntityIDs
      : []),
  ]
    .map((entityID) => normalizePositiveInteger(entityID, null))
    .filter(Boolean);
}

function getFleetEntities(scene, fleetRecord, options = {}) {
  if (!scene) {
    return [];
  }
  return getFleetEntityIDs(fleetRecord, options)
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
}

function resolveFleetRepresentativeNpcEntity(scene, fleetRecord) {
  return getFleetEntities(scene, fleetRecord)
    .find((entity) => entity && entity.kind === "ship") || null;
}

function getAggressionMemoryMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcAggressionMemoryMs,
      DEFAULT_MINING_AGGRESSION_MEMORY_MS,
    ),
  );
}

function getResponseCooldownMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcResponseCooldownMs,
      DEFAULT_MINING_RESPONSE_COOLDOWN_MS,
    ),
  );
}

function getResponseRetreatDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcResponseRetreatDelayMs,
      DEFAULT_MINING_RESPONSE_RETREAT_DELAY_MS,
    ),
  );
}

function getHaulerInitialDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcHaulerInitialDelayMs,
      DEFAULT_MINING_HAULER_INITIAL_DELAY_MS,
    ),
  );
}

function getHaulerRepeatDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcHaulerRepeatDelayMs,
      DEFAULT_MINING_HAULER_REPEAT_DELAY_MS,
    ),
  );
}

function resolveMiningFleetQuery(scene, explicitQuery = "", systemID = 0) {
  return resolveConfiguredBandQuery(scene, explicitQuery, {
    systemID,
    configValue: config.miningNpcFleetProfileOrPool,
    bandConfigValues: {
      highsec: config.miningNpcFleetHighSecProfileOrPool,
      lowsec: config.miningNpcFleetLowSecProfileOrPool,
      nullsec: config.miningNpcFleetNullSecProfileOrPool,
    },
    bandDefaultValues: DEFAULT_MINING_FLEET_QUERY_BY_BAND,
    fallbackQuery: DEFAULT_MINING_FLEET_QUERY,
  });
}

function resolveMiningHaulerQuery(scene, explicitQuery = "", systemID = 0) {
  return resolveConfiguredBandQuery(scene, explicitQuery, {
    systemID,
    configValue: config.miningNpcHaulerProfileOrPool,
    bandConfigValues: {
      highsec: config.miningNpcHaulerHighSecProfileOrPool,
      lowsec: config.miningNpcHaulerLowSecProfileOrPool,
      nullsec: config.miningNpcHaulerNullSecProfileOrPool,
    },
    bandDefaultValues: DEFAULT_MINING_HAULER_QUERY_BY_BAND,
    fallbackQuery: DEFAULT_MINING_HAULER_QUERY,
  });
}

function getStandingResponseConfig(standingClass) {
  switch (String(standingClass || "neutral").trim().toLowerCase()) {
    case "friendly":
      return {
        profileQuery: String(config.miningNpcFriendlyResponseProfileOrPool || "").trim(),
        amount: Math.max(0, toInt(config.miningNpcFriendlyResponseCount, 0)),
      };
    case "hostile":
      return {
        profileQuery: String(
          config.miningNpcHostileResponseProfileOrPool ||
          config.miningNpcResponseProfileOrPool ||
          DEFAULT_MINING_RESPONSE_QUERY,
        ).trim(),
        amount: Math.max(
          0,
          toInt(
            config.miningNpcHostileResponseCount,
            config.miningNpcResponseDefaultCount || DEFAULT_MINING_RESPONSE_COUNT,
          ),
        ),
      };
    default:
      return {
        profileQuery: String(
          config.miningNpcNeutralResponseProfileOrPool ||
          config.miningNpcResponseProfileOrPool ||
          DEFAULT_MINING_RESPONSE_QUERY,
        ).trim(),
        amount: Math.max(
          0,
          toInt(
            config.miningNpcNeutralResponseCount,
            config.miningNpcResponseDefaultCount || DEFAULT_MINING_RESPONSE_COUNT,
          ),
        ),
      };
  }
}

function resolveResponsePlan(scene, fleetRecord, aggressorEntity, options = {}) {
  const amountOverride = normalizePositiveInteger(options.amount, null);
  const queryOverride = String(options.profileQuery || "").trim();
  const representativeNpcEntity = resolveFleetRepresentativeNpcEntity(scene, fleetRecord);
  const standingProfile =
    config.miningNpcStandingsEnabled === true && representativeNpcEntity && aggressorEntity
      ? resolveAggressorStandingProfile(aggressorEntity, representativeNpcEntity)
      : {
        characterID: 0,
        standing: 0,
        matchedOwnerID: 0,
        matchedSourceID: 0,
        ownerIDs: [],
        thresholds: null,
        standingClass: "neutral",
      };
  const configuredResponse = getStandingResponseConfig(standingProfile.standingClass);
  const resolvedAmount = Math.max(
    0,
    amountOverride !== null ? amountOverride : configuredResponse.amount,
  );
  const resolvedQuery = queryOverride || configuredResponse.profileQuery;
  return {
    amount: resolvedAmount,
    profileQuery: resolvedQuery,
    standingProfile,
  };
}

function getLatestFleetAggression(scene, fleetRecord, now = Date.now()) {
  const aggressionMemoryMs = getAggressionMemoryMs();
  let latestAggression = null;
  for (const entityID of getFleetEntityIDs(fleetRecord)) {
    const controller = npcService.getControllerByEntityID(entityID);
    if (!controller) {
      continue;
    }
    const lastAggressedAtMs = Math.max(
      0,
      toInt(controller.lastAggressedAtMs, 0),
    );
    const lastAggressorID = normalizePositiveInteger(controller.lastAggressorID, 0);
    if (
      lastAggressedAtMs <= 0 ||
      lastAggressorID <= 0 ||
      (
        aggressionMemoryMs > 0 &&
        now - lastAggressedAtMs > aggressionMemoryMs
      )
    ) {
      continue;
    }
    const aggressorEntity = scene && scene.getEntityByID(lastAggressorID);
    if (!aggressorEntity) {
      continue;
    }
    if (!latestAggression || lastAggressedAtMs > latestAggression.lastAggressedAtMs) {
      latestAggression = {
        aggressorEntity,
        aggressorEntityID: lastAggressorID,
        lastAggressedAtMs,
        controllerEntityID: entityID,
      };
    }
  }
  return latestAggression;
}

function ensureNpcCargoStoreEntry(entity, cargoItem) {
  if (!entity || !cargoItem || toInt(cargoItem.itemID, 0) <= 0) {
    return;
  }
  return nativeNpcStore.upsertNativeCargo({
    cargoID: toInt(cargoItem.itemID, 0),
    entityID: toInt(entity.itemID, 0),
    ownerID: toInt(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID, 0),
    moduleID: 0,
    typeID: toInt(cargoItem.typeID, 0),
    groupID: toInt(cargoItem.groupID, 0),
    categoryID: toInt(cargoItem.categoryID, 0),
    itemName: String(cargoItem.itemName || ""),
    quantity: Math.max(0, toInt(cargoItem.quantity, 0)),
    singleton: false,
    transient: entity.transient === true,
  }, {
    transient: entity.transient === true,
  });
}

// COOP_ALIFE_MINING_STRICT_CARGO_V1
function coopAppendNpcMiningCargoStrict(entity, typeID, quantity) {
  const good = x => Number.isSafeInteger(x) && x > 0;
  const fail = (reason, uncertain = false) => {
    if (uncertain && entity && typeof entity === "object")
      entity.coopMiningCargoNeedsOperatorRepair = reason;
    if (entity && entity.coopMiningCargoLastError !== reason) {
      entity.coopMiningCargoLastError = reason;
      console.warn("[CoopNativeMiningCargo] " + reason);
      try {require("../../space/coopRuntimeProbe").observe(
        "living-native-mining-cargo-integrity-blocked",null,
        {spaceState:{systemID:Number(entity.systemID)||0}},
        {status:"BLOCKED",reason,
         entityID:Number(entity.itemID)||0,
         operatorRepairRequired:uncertain,nativeMutation:false,
         cargoCredited:false,iskCredited:false});
      } catch (_) {} // Telemetry cannot authorize or alter native custody.
    }
    return false;
  };
  if (!entity || entity.coopMiningCargoNeedsOperatorRepair) return false;
  const shipID=Number(entity.itemID);
  const ownerID=Number(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID);
  const oreTypeID=Number(typeID),amount=Number(quantity);
  if (![shipID,ownerID,oreTypeID,amount].every(good) ||
      amount > 1000000000 ||
      (entity.nativeCargoItems!=null && !Array.isArray(entity.nativeCargoItems)))
    return fail("NATIVE_MINING_CARGO_IDENTITY_INVALID");
  const localCargo=Array.isArray(entity.nativeCargoItems)?entity.nativeCargoItems:[];
  const matches=localCargo.filter(c =>
    Number(c?.typeID)===oreTypeID && Number(c?.moduleID||0)===0);
  if (matches.length>1) return fail("NATIVE_MINING_CARGO_DUPLICATE_LOCAL",true);
  const previous=matches[0]||null;
  if (previous && (!good(Number(previous.itemID)) ||
      Number(previous.ownerID)!==ownerID ||
      Number(previous.locationID)!==shipID ||
      !good(Number(previous.quantity))))
    return fail("NATIVE_MINING_CARGO_LOCAL_UNVERIFIED",true);
  let originalRows;
  try {originalRows=nativeNpcStore.listNativeCargoForEntity(shipID);}
  catch (_) {return fail("NATIVE_MINING_CARGO_READ_UNKNOWN",true);}
  if (!Array.isArray(originalRows))
    return fail("NATIVE_MINING_CARGO_READ_INVALID",true);
  if (previous) {
    const matchesByID=originalRows.filter(c=>Number(c?.cargoID)===Number(previous.itemID));
    if (matchesByID.length!==1 ||
        Number(matchesByID[0].entityID)!==shipID ||
        Number(matchesByID[0].ownerID)!==ownerID ||
        Number(matchesByID[0].typeID)!==oreTypeID ||
        Number(matchesByID[0].quantity)!==Number(previous.quantity))
      return fail("NATIVE_MINING_CARGO_SOURCE_CONFLICT",true);
  }
  // Durable replay fence: if the local ship lost its stack but the
  // native store still owns it, a new cargoID would silently duplicate ore.
  if (!previous && originalRows.some(c=>Number(c?.typeID)===oreTypeID &&
      Number(c?.moduleID||0)===0))
    return fail("NATIVE_MINING_CARGO_STORE_ALREADY_HAS_TYPE",true);
  let cargoID=previous?Number(previous.itemID):null;
  if (!cargoID) {
    let allocated;
    try {allocated=nativeNpcStore.allocateCargoID({transient:entity.transient===true});}
    catch (_) {return fail("NATIVE_MINING_CARGO_ID_ALLOCATE_UNKNOWN",true);}
    if (!allocated?.success || !good(Number(allocated.data)))
      return fail("NATIVE_MINING_CARGO_ID_ALLOCATE_FAILED");
    cargoID=Number(allocated.data);
    if (originalRows.some(c=>Number(c?.cargoID)===cargoID))
      return fail("NATIVE_MINING_CARGO_ID_COLLISION",true);
  }
  const newQuantity=(previous?Number(previous.quantity):0)+amount;
  if (!Number.isSafeInteger(newQuantity) || newQuantity>1000000000)
    return fail("NATIVE_MINING_CARGO_QUANTITY_OVERFLOW");
  const typeRecord=resolveItemByTypeID(oreTypeID)||{};
  const candidate=previous?{...previous,quantity:newQuantity,stacksize:newQuantity}:{
    itemID:cargoID,ownerID,locationID:shipID,moduleID:0,typeID:oreTypeID,
    groupID:toInt(typeRecord.groupID,0),categoryID:toInt(typeRecord.categoryID,0),
    quantity:newQuantity,stacksize:newQuantity,singleton:0,flagID:5,
    itemName:String(typeRecord.name||("type "+oreTypeID)),
    volume:Math.max(0,toFiniteNumber(typeRecord.volume,0))
  };
  let written;
  try {written=ensureNpcCargoStoreEntry(entity,candidate);}
  catch (_) {return fail("NATIVE_MINING_CARGO_WRITE_UNKNOWN",true);}
  if (!written?.success)
    return fail("NATIVE_MINING_CARGO_WRITE_UNCONFIRMED",true);
  let confirmed;
  try {
    const rows=nativeNpcStore.listNativeCargoForEntity(shipID);
    confirmed=Array.isArray(rows)&&rows.filter(c=>
      Number(c?.cargoID)===cargoID&&Number(c?.entityID)===shipID&&
      Number(c?.ownerID)===ownerID&&Number(c?.typeID)===oreTypeID&&
      Number(c?.quantity)===newQuantity).length===1;
  } catch (_) {confirmed=false;}
  if (!confirmed)return fail("NATIVE_MINING_CARGO_READBACK_UNKNOWN",true);
  if (previous){previous.quantity=newQuantity;previous.stacksize=newQuantity;}
  else if(Array.isArray(entity.nativeCargoItems))entity.nativeCargoItems.push(candidate);
  else entity.nativeCargoItems=[candidate];
  return true;
}

function appendNpcMiningCargo(entity, typeID, quantity) {
  if (process.env.EVEJS_COOP_NATIVE_MINING_CARGO_INTEGRITY === "1")
    return coopAppendNpcMiningCargoStrict(entity, typeID, quantity);
  const numericTypeID = toInt(typeID, 0);
  const numericQuantity = Math.max(0, toInt(quantity, 0));
  if (!entity || numericTypeID <= 0 || numericQuantity <= 0) {
    return;
  }
  if (!Array.isArray(entity.nativeCargoItems)) {
    entity.nativeCargoItems = [];
  }

  const typeRecord = resolveItemByTypeID(numericTypeID) || {};
  const existingEntry = entity.nativeCargoItems.find((entry) => (
    toInt(entry && entry.typeID, 0) === numericTypeID &&
    toInt(entry && entry.moduleID, 0) <= 0
  )) || null;
  if (existingEntry) {
    existingEntry.quantity = toInt(existingEntry.quantity, 0) + numericQuantity;
    existingEntry.stacksize = existingEntry.quantity;
    ensureNpcCargoStoreEntry(entity, existingEntry);
    return;
  }

  const cargoIDResult = nativeNpcStore.allocateCargoID({
    transient: entity.transient === true,
  });
  const nextCargoID = cargoIDResult && cargoIDResult.success && cargoIDResult.data
    ? cargoIDResult.data
    : -(entity.nativeCargoItems.length + 1);
  const cargoItem = {
    itemID: nextCargoID,
    ownerID: toInt(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID, 0),
    locationID: toInt(entity.itemID, 0),
    moduleID: 0,
    typeID: numericTypeID,
    groupID: toInt(typeRecord.groupID, 0),
    categoryID: toInt(typeRecord.categoryID, 0),
    quantity: numericQuantity,
    stacksize: numericQuantity,
    singleton: 0,
    flagID: 5,
    itemName: String(typeRecord.name || `type ${numericTypeID}`),
    volume: Math.max(0, toFiniteNumber(typeRecord.volume, 0)),
  };
  entity.nativeCargoItems.push(cargoItem);
  ensureNpcCargoStoreEntry(entity, cargoItem);
}

function clearNpcMiningCargo(entity) {
  if (!entity || !Array.isArray(entity.nativeCargoItems)) {
    return 0;
  }

  let removedVolumeM3 = 0;
  const retainedCargoItems = [];
  for (const cargoItem of entity.nativeCargoItems) {
    if (toInt(cargoItem && cargoItem.moduleID, 0) > 0) {
      retainedCargoItems.push(cargoItem);
      continue;
    }
    removedVolumeM3 +=
      Math.max(0, toInt(cargoItem && cargoItem.quantity, 0)) *
      Math.max(0, toFiniteNumber(cargoItem && cargoItem.volume, 0));
    if (toInt(cargoItem && cargoItem.itemID, 0) > 0) {
      nativeNpcStore.removeNativeCargo(cargoItem.itemID);
    }
  }
  entity.nativeCargoItems = retainedCargoItems;
  return removedVolumeM3;
}

function createMiningFleetRecord(options = {}) {
  const coopStableFleetID=process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE==="1" &&
    options.source==="startup" && Number.isSafeInteger(Number(options.coopDurableFleetID)) &&
    Number(options.coopDurableFleetID)>0 ? Number(options.coopDurableFleetID) : 0;
  const fleetID=coopStableFleetID||nextMiningFleetID++;
  if(miningFleetStateByID.has(fleetID))throw Error("ALIFE09_NATIVE_FLEET_ID_COLLISION");
  const minerEntityIDs = (Array.isArray(options.minerEntityIDs) ? options.minerEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const haulerEntityIDs = (Array.isArray(options.haulerEntityIDs) ? options.haulerEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const responseEntityIDs = (Array.isArray(options.responseEntityIDs) ? options.responseEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const createdAtMs = Math.max(0, toInt(options.createdAtMs, Date.now()));
  const fleetRecord = {
    fleetID,
    source: String(options.source || "gm"),
    startupKey: String(options.startupKey || "").trim() || null,
    createdByCharacterID: normalizePositiveInteger(options.createdByCharacterID, 0),
    systemID: normalizePositiveInteger(options.systemID, 0),
    targetShipID: normalizePositiveInteger(options.targetShipID, 0),
    minerEntityIDs,
    haulerEntityIDs,
    responseEntityIDs,
    spawnSelectionName: options.spawnSelectionName ? String(options.spawnSelectionName) : null,
    haulerSelectionName: options.haulerSelectionName ? String(options.haulerSelectionName) : null,
    responseSelectionName: options.responseSelectionName ? String(options.responseSelectionName) : null,
    originAnchor: options.originAnchor || null,
    activeAsteroidID: normalizePositiveInteger(options.activeAsteroidID, 0),
    assignedAsteroidIDsByMinerID:
      options.assignedAsteroidIDsByMinerID &&
      typeof options.assignedAsteroidIDsByMinerID === "object"
        ? { ...options.assignedAsteroidIDsByMinerID }
        : {},
    state: String(options.state || "mining"),
    createdAtMs,
    nextThinkAtMs: 0,
    haulCompleteAtMs: 0,
    haulerReturnAtMs: 0,
    haulerNextArrivalAtMs: Math.max(
      0,
      toInt(
        options.haulerNextArrivalAtMs,
        haulerEntityIDs.length > 0
          ? createdAtMs + getHaulerInitialDelayMs()
          : 0,
      ),
    ),
    resumeAtMs: 0,
    responseDespawnAtMs: 0,
    responseRetreating: options.responseRetreating === true,
    lastHauledVolumeM3: 0,
    lastHauledAtMs: 0,
    lastAggressorID: normalizePositiveInteger(options.lastAggressorID, 0),
    lastAggressedAtMs: Math.max(0, toInt(options.lastAggressedAtMs, 0)),
    lastProcessedAggressionAtMs: Math.max(0, toInt(options.lastProcessedAggressionAtMs, 0)),
    lastResponseAtMs: Math.max(0, toInt(options.lastResponseAtMs, 0)),
    responseTargetID: normalizePositiveInteger(options.responseTargetID, 0),
    responseStandingClass: String(options.responseStandingClass || "").trim() || null,
    responseStandingValue: toFiniteNumber(options.responseStandingValue, 0),
  };
  miningFleetStateByID.set(fleetRecord.fleetID, fleetRecord);
  return fleetRecord;
}

function getMiningFleetsForSystem(systemID) {
  const normalizedSystemID = normalizePositiveInteger(systemID, 0);
  const fleets = [];
  for (const fleetRecord of miningFleetStateByID.values()) {
    if (normalizePositiveInteger(fleetRecord && fleetRecord.systemID, 0) === normalizedSystemID) {
      fleets.push(fleetRecord);
    }
  }
  return fleets;
}

// A durable native NPC owns its hull through the persisted controller row, not
// through the in-memory registry: the registry is rebuilt whenever a scene is
// torn down, while the row survives. Dropping such an actor from the fleet
// silently removes a live ship and the fleet mines nothing forever. Keep it
// while the store still owns it; a destroyed NPC is removed from the store, so
// real losses still prune normally.
function isRetainedFleetActor(entityID) {
  if (npcService.getControllerByEntityID(entityID)) {
    return true;
  }
  return Boolean(nativeNpcStore.getNativeController(entityID));
}

function pruneMiningFleet(fleetRecord) {
  if (!fleetRecord) {
    return null;
  }
if (process.env.EVEJS_COOP_NATIVE_MINING_SLOT_SELFHEAL === "1") { try { require("../../space/coopNativeMiningFleetDurable").healFleetActors(fleetRecord,{npcService}); } catch (_coopHealError) { console.warn("[CoopFleetSelfHeal]",_coopHealError.message); } }
if (process.env.EVEJS_COOP_MINING_TRACE_PRUNE === "1") require("../../space/coopNativeMiningFleetDurable").noteDroppedFleetActors(fleetRecord,{npcService});
  fleetRecord.minerEntityIDs = (Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
    .filter((entityID) => isRetainedFleetActor(entityID));
  fleetRecord.haulerEntityIDs = (Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : [])
    .filter((entityID) => isRetainedFleetActor(entityID));
  fleetRecord.responseEntityIDs = (Array.isArray(fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : [])
    .filter((entityID) => npcService.getControllerByEntityID(entityID));
  if (fleetRecord.haulerEntityIDs.length <= 0) {
    fleetRecord.haulerNextArrivalAtMs = 0;
  }
  if (fleetRecord.responseEntityIDs.length <= 0) {
    fleetRecord.responseTargetID = 0;
    fleetRecord.responseDespawnAtMs = 0;
    fleetRecord.responseRetreating = false;
  }
  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  for (const minerEntityID of Object.keys(assignmentMap)) {
    if (!fleetRecord.minerEntityIDs.includes(toInt(minerEntityID, 0))) {
      delete assignmentMap[minerEntityID];
    }
  }
  if (
    fleetRecord.minerEntityIDs.length === 0 &&
    fleetRecord.haulerEntityIDs.length === 0 &&
    fleetRecord.responseEntityIDs.length === 0
  ) {
    miningFleetStateByID.delete(fleetRecord.fleetID);
    return null;
  }
  return fleetRecord;
}

function destroyFleetEntities(fleetRecord) {
  const entityIDs = [
    ...(Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []),
  ];
  let destroyedCount = 0;
  for (const entityID of entityIDs) {
    const destroyResult = npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
    if (destroyResult && destroyResult.success) {
      destroyedCount += 1;
    }
  }
  return destroyedCount;
}

function buildSpawnResultEntityIDs(spawnResult) {
  return (
    spawnResult &&
    spawnResult.data &&
    Array.isArray(spawnResult.data.spawned)
      ? spawnResult.data.spawned
        .map((entry) => normalizePositiveInteger(entry && entry.entity && entry.entity.itemID, null))
        .filter(Boolean)
      : []
  );
}

function spawnFleetWing(systemID, centerTarget, options = {}) {
  const amount = Math.max(1, toInt(options.amount, 1));
  const profileQuery = String(options.profileQuery || "").trim();
  const originAnchor = options.originAnchor || null;
  const sharedSpawnOptions = {
    transient: options.durableHauler === true || (options.coopDurableNative === true && process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE === "1") ? false : true,
    operatorKind: options.coopDurableNative === true && process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE === "1"
      ? "coop-mining-" + systemID + "-" + options.coopSlotIndex + "-" + options.coopRole : null,
    broadcast: false,
    skipInitialBehaviorTick: true,
    preferredTargetID: normalizePositiveInteger(options.preferredTargetID, 0),
    anchorDescriptor: originAnchor
      ? {
          kind: "coordinates",
          position: originAnchor.position,
          direction: originAnchor.direction,
          name: String(options.anchorName || "Mining Fleet Warp Origin"),
        }
      : null,
  };
  const groupResolution = profileQuery
    ? resolveNpcSpawnGroup(profileQuery, "")
    : {
      success: false,
    };
  let spawnResult = null;
  if (groupResolution.success && groupResolution.data) {
    const spawned = [];
    let partialFailure = null;
    for (let iteration = 0; iteration < amount; iteration += 1) {
      const groupSpawnResult = npcService.spawnNpcGroupInSystem(systemID, {
        ...sharedSpawnOptions,
        spawnGroupQuery: profileQuery,
        entityType: "npc",
      });
      if (
        !groupSpawnResult.success ||
        !groupSpawnResult.data ||
        !Array.isArray(groupSpawnResult.data.spawned) ||
        groupSpawnResult.data.spawned.length <= 0
      ) {
        if (spawned.length <= 0) {
          return groupSpawnResult;
        }
        partialFailure = {
          failedAt: iteration + 1,
          errorMsg: groupSpawnResult.errorMsg || "NPC_GROUP_SPAWN_FAILED",
        };
        break;
      }
      spawned.push(...groupSpawnResult.data.spawned);
      if (groupSpawnResult.data.partialFailure) {
        partialFailure = groupSpawnResult.data.partialFailure;
        break;
      }
    }
    spawnResult = {
      success: true,
      data: {
        selectionKind: "group",
        selectionID: groupResolution.data.spawnGroupID,
        selectionName: groupResolution.data.name || groupResolution.data.spawnGroupID,
        requestedAmount: amount,
        spawned,
        partialFailure,
      },
      suggestions: [],
    };
  } else {
    spawnResult = npcService.spawnNpcBatchInSystem(systemID, {
      ...sharedSpawnOptions,
      profileQuery,
      amount,
    });
  }
  if (!spawnResult.success || !spawnResult.data || !Array.isArray(spawnResult.data.spawned) || spawnResult.data.spawned.length <= 0) {
    return spawnResult;
  }

  if (options.warpIn !== false && centerTarget && centerTarget.position) {
    const landingRadiusMeters = Math.max(
      500,
      toFiniteNumber(
        options.landingRadiusMeters,
        DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
      ),
    );
    const warpRequests = spawnResult.data.spawned.map((entry, index, list) => ({
      entityID: normalizePositiveInteger(entry && entry.entity && entry.entity.itemID, 0),
      point: buildMiningWarpLandingPoint(
        centerTarget.position,
        index,
        list.length,
        landingRadiusMeters,
      ),
      options: {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs: Math.max(
          250,
          toFiniteNumber(
            config.miningNpcWarpIngressDurationMs,
            DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
          ),
        ),
      },
    }));
    const warpResult = npcService.runtime.warpBatchToPoints(warpRequests, {
      groupWake: true,
    });
    if (!warpResult.success) {
      return warpResult;
    }
  }

  return spawnResult;
}

function resolveSessionScene(session) {
  if (!session || !session._space) {
    return null;
  }
  const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
  return spaceRuntime.ensureScene(normalizePositiveInteger(session._space.systemID, 0));
}

function spawnMiningFleetInternal(scene, options = {}) {
  const systemID = normalizePositiveInteger(options.systemID || (scene && scene.systemID), 0);
  const centerTarget = options.centerTarget || buildSpawnTarget(scene);
  if (!systemID || !centerTarget || !centerTarget.position) {
    return {
      success: false,
      errorMsg: "SPAWN_TARGET_NOT_FOUND",
    };
  }

  const originAnchor = options.originAnchor || buildOffgridOriginAnchor(scene, centerTarget);
  const resolvedMinerQuery = resolveMiningFleetQuery(
    scene,
    options.minerQuery,
    systemID,
  );
  const minerSpawnResult = spawnFleetWing(systemID, centerTarget, {
    amount: Math.max(
      1,
      toInt(
        options.minerAmount,
        toInt(config.miningNpcFleetDefaultCount, DEFAULT_MINING_FLEET_COUNT),
      ),
    ),
    profileQuery: resolvedMinerQuery,
    coopDurableNative: options.coopDurableNative === true,
    coopSlotIndex: options.coopSlotIndex,
    coopRole: "miner",
    preferredTargetID: 0,
    originAnchor,
    warpIn: true,
    landingRadiusMeters: toFiniteNumber(
      config.miningNpcFleetLandingRadiusMeters,
      DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
    ),
  });
  if (!minerSpawnResult.success || !minerSpawnResult.data) {
    return minerSpawnResult;
  }

  const haulerAmount = Math.max(
    0,
    toInt(
      options.haulerAmount,
      toInt(config.miningNpcHaulerDefaultCount, DEFAULT_MINING_HAULER_COUNT),
    ),
  );
  let haulerSpawnResult = null;
  if (haulerAmount > 0) {
    const resolvedHaulerQuery = resolveMiningHaulerQuery(
      scene,
      options.haulerQuery,
      systemID,
    );
    haulerSpawnResult = spawnFleetWing(systemID, originAnchor, {
      amount: haulerAmount,
      profileQuery: resolvedHaulerQuery,
      coopDurableNative: options.coopDurableNative === true,
      coopSlotIndex: options.coopSlotIndex,
      coopRole: "hauler",
      preferredTargetID: 0,
      originAnchor,
      durableHauler: process.env.EVEJS_COOP_NPC_STATION_DELIVERY === "1",
      warpIn: false,
    });
    if (!haulerSpawnResult.success || !haulerSpawnResult.data) {
      const minerEntityIDs = buildSpawnResultEntityIDs(minerSpawnResult);
      for (const entityID of minerEntityIDs) {
        npcService.destroyNpcControllerByEntityID(entityID, {
          removeContents: true,
        });
      }
      return haulerSpawnResult;
    }
  }

  for (const entityID of buildSpawnResultEntityIDs(minerSpawnResult)) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 1_200,
      followRangeMeters: 800,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  }
  for (const entityID of buildSpawnResultEntityIDs(haulerSpawnResult)) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "stop",
      orbitDistanceMeters: 500,
      followRangeMeters: 500,
      idleAnchorOrbit: false,
      idleAnchorOrbitDistanceMeters: 500,
      clearCombatPreference: true,
    });
  }

  return {
    success: true,
    data: {
      originAnchor,
      minerSpawnResult,
      haulerSpawnResult,
      centerTarget,
      minerEntityIDs: buildSpawnResultEntityIDs(minerSpawnResult),
      haulerEntityIDs: buildSpawnResultEntityIDs(haulerSpawnResult),
    },
  };
}

function issueResponseOrders(responseEntityIDs = [], aggressorEntityID = 0) {
  const normalizedAggressorEntityID = normalizePositiveInteger(aggressorEntityID, 0);
  for (const entityID of Array.isArray(responseEntityIDs) ? responseEntityIDs : []) {
    npcService.setBehaviorOverrides(entityID, {
      autoAggro: true,
      autoActivateWeapons: true,
      autoAggroTargetClasses: ["player"],
      targetPreference: "preferredTargetThenNearestPlayer",
      movementMode: "orbit",
      orbitDistanceMeters: 1_800,
      followRangeMeters: 1_500,
      aggressionRangeMeters: 250_000,
      idleAnchorOrbit: false,
      returnToHomeWhenIdle: true,
      leashRangeMeters: 250_000,
    });
    if (normalizedAggressorEntityID > 0) {
      npcService.issueManualOrder(entityID, {
        type: "attack",
        targetID: normalizedAggressorEntityID,
        allowWeapons: true,
        keepLock: true,
        movementMode: "orbit",
        orbitDistanceMeters: 1_800,
      });
    }
    npcService.wakeNpcController(entityID, 0);
  }
}

function retreatResponseWingToOrigin(fleetRecord, options = {}) {
  if (!fleetRecord || !fleetRecord.originAnchor || !fleetRecord.originAnchor.position) {
    return 0;
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  let retreatedCount = 0;
  for (const entityID of Array.isArray(fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []) {
    if (!npcService.getControllerByEntityID(entityID)) {
      continue;
    }
    npcService.issueManualOrder(entityID, {
      type: "returnHome",
      allowWeapons: false,
    });
    npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
    retreatedCount += 1;
  }
  if (retreatedCount > 0) {
    fleetRecord.responseRetreating = true;
    fleetRecord.responseTargetID = 0;
    fleetRecord.responseDespawnAtMs = Math.max(
      0,
      toInt(options.nowMs, 0) + ingressDurationMs,
    );
  }
  return retreatedCount;
}

function destroyResponseWing(fleetRecord) {
  let destroyedCount = 0;
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []) {
    const destroyResult = npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
    if (destroyResult && destroyResult.success) {
      destroyedCount += 1;
    }
  }
  fleetRecord.responseEntityIDs = [];
  fleetRecord.responseTargetID = 0;
  fleetRecord.responseDespawnAtMs = 0;
  fleetRecord.responseRetreating = false;
  return destroyedCount;
}

function spawnResponseWingForFleet(scene, fleetRecord, aggressorEntity, responsePlan, options = {}) {
  if (
    !scene ||
    !fleetRecord ||
    !aggressorEntity ||
    !responsePlan ||
    responsePlan.amount <= 0 ||
    !String(responsePlan.profileQuery || "").trim()
  ) {
    return {
      success: true,
      data: {
        spawnedEntityIDs: [],
        standingProfile: responsePlan ? responsePlan.standingProfile : null,
        selectionName: null,
      },
    };
  }

  const spawnResult = spawnFleetWing(scene.systemID, aggressorEntity, {
    amount: responsePlan.amount,
    profileQuery: responsePlan.profileQuery,
    preferredTargetID: normalizePositiveInteger(aggressorEntity.itemID, 0),
    originAnchor: fleetRecord.originAnchor,
    warpIn: true,
    landingRadiusMeters: toFiniteNumber(
      config.miningNpcFleetLandingRadiusMeters,
      DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
    ),
  });
  if (!spawnResult.success || !spawnResult.data) {
    return spawnResult;
  }

  const spawnedEntityIDs = buildSpawnResultEntityIDs(spawnResult);
  issueResponseOrders(
    spawnedEntityIDs,
    normalizePositiveInteger(aggressorEntity.itemID, 0),
  );
  fleetRecord.responseEntityIDs.push(...spawnedEntityIDs);
  fleetRecord.responseSelectionName =
    spawnResult.data.selectionName ||
    String(responsePlan.profileQuery || "").trim() ||
    null;
  fleetRecord.responseTargetID = normalizePositiveInteger(aggressorEntity.itemID, 0);
  fleetRecord.responseRetreating = false;
  fleetRecord.responseStandingClass =
    responsePlan.standingProfile && responsePlan.standingProfile.standingClass
      ? responsePlan.standingProfile.standingClass
      : null;
  fleetRecord.responseStandingValue =
    responsePlan.standingProfile && Number.isFinite(responsePlan.standingProfile.standing)
      ? responsePlan.standingProfile.standing
      : 0;
  fleetRecord.lastResponseAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
  fleetRecord.responseDespawnAtMs =
    fleetRecord.lastResponseAtMs + getResponseRetreatDelayMs();
  return {
    success: true,
    data: {
      spawnedEntityIDs,
      standingProfile: responsePlan.standingProfile || null,
      selectionName: fleetRecord.responseSelectionName,
    },
  };
}

function triggerFleetAggression(scene, fleetRecord, options = {}) {
  if (!scene || !fleetRecord) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const now = Math.max(0, toInt(options.nowMs, Date.now()));
  const aggressorEntity =
    options.aggressorEntity ||
    scene.getEntityByID(normalizePositiveInteger(options.aggressorEntityID, 0)) ||
    null;
  if (!aggressorEntity) {
    return {
      success: false,
      errorMsg: "AGGRESSOR_NOT_FOUND",
    };
  }

  const aggressionEventAtMs = Math.max(
    0,
    toInt(options.aggressionEventAtMs, now),
  );
  if (
    options.force !== true &&
    aggressionEventAtMs > 0 &&
    aggressionEventAtMs <= Math.max(0, toInt(fleetRecord.lastProcessedAggressionAtMs, 0))
  ) {
    return {
      success: true,
      data: {
        noChange: true,
        standingClass: fleetRecord.responseStandingClass || null,
        retreatedCount: 0,
        responseSpawnedCount: 0,
      },
    };
  }

  const autoResumeDelayMs = Math.max(
    0,
    toInt(
      config.miningNpcFleetAutoResumeDelayMs,
      0,
    ),
  );
  if (process.env.EVEJS_COOP_PLAYER_CONSEQUENCES === "1") { try { require("../../space/coopNativeConsequences").noteMiningAggression(scene, fleetRecord, aggressorEntity, aggressionEventAtMs); } catch (_coopError) { console.warn("[CoopConsequences]", _coopError.message); } }
  const responsePlan = resolveResponsePlan(scene, fleetRecord, aggressorEntity, {
    amount: options.responseAmount,
    profileQuery: options.responseQuery,
  });
  const retreatedCount = retreatFleetToOrigin(fleetRecord, {
    state: options.panic === true ? "panic" : "aggressed",
    resumeAtMs: autoResumeDelayMs > 0 ? (now + autoResumeDelayMs) : 0,
    scene,
    hooks: options.hooks,
    reason: "aggression",
  });
  fleetRecord.lastAggressorID = normalizePositiveInteger(aggressorEntity.itemID, 0);
  fleetRecord.lastAggressedAtMs = aggressionEventAtMs || now;
  fleetRecord.lastProcessedAggressionAtMs = aggressionEventAtMs || now;
  fleetRecord.responseTargetID = normalizePositiveInteger(aggressorEntity.itemID, 0);

  let responseSpawnedCount = 0;
  let responseSelectionName = fleetRecord.responseSelectionName || null;
  const cooldownMs = getResponseCooldownMs();
  const hasDeployableResponse =
    responsePlan.amount > 0 &&
    String(responsePlan.profileQuery || "").trim().length > 0;
  const canSpawnResponse =
    hasDeployableResponse &&
    (
      fleetRecord.lastResponseAtMs <= 0 ||
      cooldownMs <= 0 ||
      now - fleetRecord.lastResponseAtMs >= cooldownMs ||
      fleetRecord.responseEntityIDs.length <= 0
    );

  if (canSpawnResponse) {
    const spawnResult = spawnResponseWingForFleet(
      scene,
      fleetRecord,
      aggressorEntity,
      responsePlan,
      { nowMs: now },
    );
    if (!spawnResult.success) {
      return spawnResult;
    }
    responseSpawnedCount = Array.isArray(spawnResult.data && spawnResult.data.spawnedEntityIDs)
      ? spawnResult.data.spawnedEntityIDs.length
      : 0;
    responseSelectionName = spawnResult.data && spawnResult.data.selectionName
      ? spawnResult.data.selectionName
      : responseSelectionName;
  } else if (fleetRecord.responseEntityIDs.length > 0) {
    issueResponseOrders(
      fleetRecord.responseEntityIDs,
      normalizePositiveInteger(aggressorEntity.itemID, 0),
    );
    fleetRecord.responseDespawnAtMs = now + getResponseRetreatDelayMs();
  }

  return {
    success: true,
    data: {
      standingClass:
        responsePlan.standingProfile && responsePlan.standingProfile.standingClass
          ? responsePlan.standingProfile.standingClass
          : null,
      standingValue:
        responsePlan.standingProfile && Number.isFinite(responsePlan.standingProfile.standing)
          ? responsePlan.standingProfile.standing
          : 0,
      retreatedCount,
      responseSpawnedCount,
      responseSelectionName,
    },
  };
}

function handleMiningFleetCommand(session, argumentText) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      message: "You must be in space before using /npcminer.",
    };
  }

  const parsedArguments = parseNpcSpawnArguments(
    argumentText,
    Math.max(1, toInt(config.miningNpcFleetDefaultCount, DEFAULT_MINING_FLEET_COUNT)),
  );
  if (!parsedArguments.success) {
    return {
      success: false,
      message: "Usage: /npcminer [amount] [profile|pool|group]",
    };
  }
  if (parsedArguments.amount > MAX_MINING_NPC_COMMAND_SPAWN_COUNT) {
    return {
      success: false,
      message: `Mining fleet spawn count must be between 1 and ${MAX_MINING_NPC_COMMAND_SPAWN_COUNT}.`,
    };
  }

  const scene = resolveSessionScene(session);
  const centerTarget = buildSpawnTarget(scene, session);
  const spawnResult = spawnMiningFleetInternal(scene, {
    systemID: session._space.systemID,
    centerTarget,
    preferredTargetID: normalizePositiveInteger(session._space.shipID, 0),
    minerAmount: parsedArguments.amount,
    minerQuery: parsedArguments.query || String(config.miningNpcFleetProfileOrPool || ""),
    haulerAmount: Math.max(0, toInt(config.miningNpcHaulerDefaultCount, DEFAULT_MINING_HAULER_COUNT)),
    haulerQuery: String(config.miningNpcHaulerProfileOrPool || ""),
  });
  if (!spawnResult.success || !spawnResult.data) {
    const suggestions = Array.isArray(spawnResult && spawnResult.suggestions)
      ? ` Suggestions: ${spawnResult.suggestions.join(", ")}`
      : "";
    return {
      success: false,
      message: `Mining fleet spawn failed: ${spawnResult.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim(),
    };
  }

  const fleetRecord = createMiningFleetRecord({
    source: "gm",
    createdByCharacterID: session.characterID,
    systemID: session._space.systemID,
    targetShipID: session._space.shipID,
    minerEntityIDs: spawnResult.data.minerEntityIDs,
    haulerEntityIDs: spawnResult.data.haulerEntityIDs,
    originAnchor: spawnResult.data.originAnchor,
    spawnSelectionName:
      spawnResult.data.minerSpawnResult &&
      spawnResult.data.minerSpawnResult.data &&
      spawnResult.data.minerSpawnResult.data.selectionName,
    haulerSelectionName:
      spawnResult.data.haulerSpawnResult &&
      spawnResult.data.haulerSpawnResult.data &&
      spawnResult.data.haulerSpawnResult.data.selectionName,
  });
  return {
    success: true,
    message: [
      `Spawned mining fleet ${fleetRecord.fleetID} with ${fleetRecord.minerEntityIDs.length} miner hull${fleetRecord.minerEntityIDs.length === 1 ? "" : "s"}.`,
      fleetRecord.haulerEntityIDs.length > 0
        ? `Attached ${fleetRecord.haulerEntityIDs.length} hauler hull${fleetRecord.haulerEntityIDs.length === 1 ? "" : "s"}.`
        : "No hauler wing was attached.",
      `Selection: ${fleetRecord.spawnSelectionName || parsedArguments.query || resolveMiningFleetQuery(scene, "", session._space.systemID)}.`,
      "The fleet is transient only and will not persist across restart.",
    ].join(" "),
  };
}

function retreatFleetToOrigin(fleetRecord, options = {}) {
  if (!fleetRecord || !fleetRecord.originAnchor || !fleetRecord.originAnchor.position) {
    return 0;
  }
  clearFleetManualOrders([
    ...(Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
  ]);
  if (options.scene && options.hooks) {
    deactivateMiningModulesForFleet(
      options.scene,
      fleetRecord,
      options.hooks,
      options.reason || "state",
    );
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  const entityIDs = [
    ...(Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
  ];
  let retreatedCount = 0;
  for (const entityID of entityIDs) {
    if (!npcService.getControllerByEntityID(entityID)) {
      continue;
    }
    if (require("../../space/coopMiningTripRetreatGuard").skip(fleetRecord, entityID)) { continue; }
    npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
    retreatedCount += 1;
  }
  if (process.env.EVEJS_COOP_MINING_RETREAT_GUARD === "1") require("../../space/coopMiningTripRetreatGuard").noteRetreatHeld(fleetRecord, options.scene, entityIDs);
  fleetRecord.state = String(options.state || "retreating");
  fleetRecord.resumeAtMs = Math.max(0, toInt(options.resumeAtMs, 0));
  fleetRecord.nextThinkAtMs = 0;
  return retreatedCount;
}

function handleMiningFleetAggroCommand(session, argumentText, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      message: "You must be in space before using /npcmineraggro.",
    };
  }

  const fleets = getMiningFleetsForSystem(session._space.systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }

  const parsedArguments = parseNpcSpawnArguments(
    argumentText,
    Math.max(1, toInt(config.miningNpcResponseDefaultCount, DEFAULT_MINING_RESPONSE_COUNT)),
  );
  if (!parsedArguments.success) {
    return {
      success: false,
      message: "Usage: /npcmineraggro [amount] [profile|pool|group]",
    };
  }
  if (parsedArguments.amount > MAX_MINING_NPC_COMMAND_SPAWN_COUNT) {
    return {
      success: false,
      message: `Mining response spawn count must be between 1 and ${MAX_MINING_NPC_COMMAND_SPAWN_COUNT}.`,
    };
  }

  const scene = resolveSessionScene(session);
  const aggressorEntity = scene && scene.getEntityByID(
    normalizePositiveInteger(session._space.shipID, 0),
  );
  if (!scene || !aggressorEntity) {
    return {
      success: false,
      message: "Unable to resolve your active ship for /npcmineraggro.",
    };
  }

  let retreatedCount = 0;
  let responseSpawnedCount = 0;
  let lastSelectionName = null;
  let lastStandingClass = null;
  for (const fleetRecord of fleets) {
    const aggressionResult = triggerFleetAggression(scene, fleetRecord, {
      aggressorEntity,
      responseAmount: parsedArguments.amount,
      responseQuery:
        parsedArguments.query ||
        String(config.miningNpcResponseProfileOrPool || DEFAULT_MINING_RESPONSE_QUERY),
      panic: options.panic === true,
      force: true,
      nowMs: Date.now(),
      aggressionEventAtMs: Date.now(),
    });
    if (!aggressionResult.success) {
      return {
        success: false,
        message: `Mining response spawn failed: ${aggressionResult.errorMsg || "UNKNOWN_ERROR"}.`,
      };
    }
    retreatedCount += Math.max(0, toInt(aggressionResult.data && aggressionResult.data.retreatedCount, 0));
    responseSpawnedCount += Math.max(
      0,
      toInt(aggressionResult.data && aggressionResult.data.responseSpawnedCount, 0),
    );
    if (aggressionResult.data && aggressionResult.data.responseSelectionName) {
      lastSelectionName = aggressionResult.data.responseSelectionName;
    }
    if (aggressionResult.data && aggressionResult.data.standingClass) {
      lastStandingClass = aggressionResult.data.standingClass;
    }
  }

  return {
    success: true,
    message: [
      `Simulated aggression against ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
      retreatedCount > 0
        ? `${retreatedCount} miner/hauler hull${retreatedCount === 1 ? "" : "s"} initiated retreat warp.`
        : "No miner retreat warp was needed.",
      responseSpawnedCount > 0
        ? `Spawned ${responseSpawnedCount} response hull${responseSpawnedCount === 1 ? "" : "s"} from ${lastSelectionName || parsedArguments.query || String(config.miningNpcResponseProfileOrPool || DEFAULT_MINING_RESPONSE_QUERY)}.`
        : "No additional response hulls were required.",
      lastStandingClass
        ? `Standing class resolved as ${lastStandingClass}.`
        : "Standing class resolution was unavailable.",
    ].join(" "),
  };
}

function handleMiningFleetClearCommand(session) {
  const systemID = normalizePositiveInteger(
    session &&
      session._space &&
      session._space.systemID,
    0,
  );
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerclear.",
    };
  }

  const fleets = getMiningFleetsForSystem(systemID);
  let destroyedCount = 0;
  for (const fleetRecord of fleets) {
    destroyedCount += destroyFleetEntities(fleetRecord);
    miningFleetStateByID.delete(fleetRecord.fleetID);
  }

  return {
    success: true,
    message: `Cleared ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"} and destroyed ${destroyedCount} associated NPC hull${destroyedCount === 1 ? "" : "s"}.`,
  };
}

function formatFleetSummary(scene, fleetRecord) {
  const cargoState = scene ? getFleetCargoState(scene, fleetRecord) : {
    minerUsedVolumeM3: 0,
    minerCapacityM3: 0,
    haulerCapacityM3: 0,
    minerFillRatio: 0,
  };
  const nextHaulerMs = Math.max(
    0,
    toInt(fleetRecord.haulerNextArrivalAtMs, 0) - Date.now(),
  );
  return [
    `fleet ${fleetRecord.fleetID}`,
    `state=${fleetRecord.state}`,
    `miners=${fleetRecord.minerEntityIDs.length}`,
    `haulers=${fleetRecord.haulerEntityIDs.length}`,
    `response=${fleetRecord.responseEntityIDs.length}`,
    fleetRecord.lastAggressorID > 0
      ? `aggressor=${fleetRecord.lastAggressorID}`
      : "aggressor=none",
    fleetRecord.responseStandingClass
      ? `standing=${fleetRecord.responseStandingClass}`
      : "standing=unknown",
    fleetRecord.haulerEntityIDs.length > 0
      ? `haulerEta=${Math.ceil(nextHaulerMs / 1000)}s`
      : "haulerEta=off",
    `cargo=${cargoState.minerUsedVolumeM3.toFixed(1)}/${cargoState.minerCapacityM3.toFixed(1)}m3`,
  ].join(", ");
}

function handleMiningFleetStatusCommand(session) {
  const systemID = normalizePositiveInteger(
    session &&
      session._space &&
      session._space.systemID,
    0,
  );
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerstatus.",
    };
  }

  const scene = resolveSessionScene(session);
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: true,
      message: "No tracked mining fleets are active in your current system.",
    };
  }

  return {
    success: true,
    message: `Tracked mining fleets in system ${systemID}: ${fleets.map((fleetRecord) => formatFleetSummary(scene, fleetRecord)).join("; ")}.`,
  };
}

function handleMiningFleetRetreatCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerretreat.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  let retreatedCount = 0;
  for (const fleetRecord of fleets) {
    retreatedCount += retreatFleetToOrigin(fleetRecord, {
      state: "retreating",
    });
  }
  return {
    success: true,
    message: `Retreated ${retreatedCount} miner/hauler hull${retreatedCount === 1 ? "" : "s"} across ${fleets.length} fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function handleMiningFleetResumeCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerresume.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  for (const fleetRecord of fleets) {
    fleetRecord.state = "mining";
    fleetRecord.resumeAtMs = 0;
    fleetRecord.nextThinkAtMs = 0;
  }
  return {
    success: true,
    message: `Resumed ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function handleMiningFleetHaulCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerhaul.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  for (const fleetRecord of fleets) {
    fleetRecord.state = "hauling";
    fleetRecord.nextThinkAtMs = 0;
    fleetRecord.haulCompleteAtMs = 0;
  }
  return {
    success: true,
    message: `Forced hauling behavior on ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function resolveStartupFleetCount() {
  return Math.max(0, toInt(config.miningNpcStartupFleetCount, 0));
}

function handleSceneCreated(scene) {
  if (!scene || config.miningNpcStartupEnabled !== true) {
    return;
  }
  const allowedSystemIDs = parseSystemIdList(config.miningNpcStartupSystemIDs);
  if (allowedSystemIDs.length > 0 && !allowedSystemIDs.includes(toInt(scene.systemID, 0))) {
    return;
  }

  // COOP_ALIFE08_DURABLE_NATIVE_MINING_STARTUP
  if (process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE === "1") {
    return require("../../space/coopNativeMiningFleetDurable").start({
      scene, fleetCount:resolveStartupFleetCount(),
      ensureState:()=>ensureSceneMiningState(scene),
      getFleets:()=>getMiningFleetsForSystem(scene.systemID),
      spawn:(slot,wing={})=>spawnMiningFleetInternal(scene,{
        systemID:scene.systemID, centerTarget:buildSpawnTarget(scene),
        preferredTargetID:0, coopDurableNative:true,coopSlotIndex:slot,
        minerAmount:wing.miners!==undefined?Math.max(0,toInt(wing.miners,0)):Math.max(1,toInt(config.miningNpcStartupFleetMinerCount,config.miningNpcFleetDefaultCount||DEFAULT_MINING_FLEET_COUNT)),
        minerQuery:String(require("../../space/coopFleetComposition").query("miner",{gameStore:require("../../gameStore")})||String(config.miningNpcStartupFleetProfileOrPool||config.miningNpcFleetProfileOrPool||"")),
        haulerAmount:wing.haulers!==undefined?Math.max(0,toInt(wing.haulers,0)):Math.max(0,toInt(config.miningNpcStartupFleetHaulerCount,config.miningNpcHaulerDefaultCount||DEFAULT_MINING_HAULER_COUNT)),
        haulerQuery:String(require("../../space/coopFleetComposition").query("hauler",{gameStore:require("../../gameStore")})||String(config.miningNpcStartupHaulerProfileOrPool||config.miningNpcHaulerProfileOrPool||"")),
      }),
      register:(slot,spawnResult)=>createMiningFleetRecord({
        coopDurableFleetID:Number(scene.systemID)*32+Number(slot),
        source:"startup",startupKey:String(scene.systemID)+":"+String(slot),
        systemID:scene.systemID,targetShipID:0,
        minerEntityIDs:spawnResult.minerEntityIDs,
        haulerEntityIDs:spawnResult.haulerEntityIDs,
        originAnchor:spawnResult.originAnchor,
      }),
    });
  }
  const startupKey = `${toInt(scene.systemID, 0)}:${resolveStartupFleetCount()}`;
  if (process.env.EVEJS_COOP_CONVOY_RENEWAL === "1") { const renewal = require("../../space/coopNativeConvoyRenewal").inspect({scene,systemID:scene.systemID,slotCount:resolveStartupFleetCount(),seeded:startupSceneSeedSet.has(startupKey),fleets:getMiningFleetsForSystem(scene.systemID)}); if (!renewal.allowed) return; if (renewal.renewal) startupSceneSeedSet.delete(startupKey); }
  if (startupSceneSeedSet.has(startupKey)) {
    return;
  }
  if (process.env.EVEJS_COOP_MINING_STARTUP_RETRY !== "1")
    startupSceneSeedSet.add(startupKey);

  const fleetCount = resolveStartupFleetCount();
  if (fleetCount <= 0) {
    return;
  }

  ensureSceneMiningState(scene);
  const centerTarget = buildSpawnTarget(scene);
  for (let index = 0; index < fleetCount; index += 1) {
    if (process.env.EVEJS_COOP_MINING_STARTUP_RETRY === "1" &&
      getMiningFleetsForSystem(scene.systemID).some(f => f.source === "startup" &&
        f.startupKey === String(scene.systemID) + ":" + String(index + 1))) continue;
    const spawnResult = spawnMiningFleetInternal(scene, {
      systemID: scene.systemID,
      centerTarget,
      preferredTargetID: 0,
      minerAmount: Math.max(1, toInt(config.miningNpcStartupFleetMinerCount, config.miningNpcFleetDefaultCount || DEFAULT_MINING_FLEET_COUNT)),
      minerQuery: String(config.miningNpcStartupFleetProfileOrPool || config.miningNpcFleetProfileOrPool || ""),
      haulerAmount: Math.max(0, toInt(config.miningNpcStartupFleetHaulerCount, config.miningNpcHaulerDefaultCount || DEFAULT_MINING_HAULER_COUNT)),
      haulerQuery: String(config.miningNpcStartupHaulerProfileOrPool || config.miningNpcHaulerProfileOrPool || ""),
    });
    if (!spawnResult.success || !spawnResult.data) {
      if (process.env.EVEJS_COOP_MINING_STARTUP_RETRY === "1")
        try { require("../../space/coopRuntimeProbe").observe("living-native-mining-startup-slot",
          null,{spaceState:{systemID:scene.systemID}},
          {status:"FAILED",fleetSlot:index+1,error:String(spawnResult.errorMsg||"NATIVE_SPAWN_FAILED").slice(0,120)}); }
        catch (_coopError) { console.warn("[CoopMiningRetry]",_coopError.message); }
      continue;
    }
    createMiningFleetRecord({
      source: "startup",
      startupKey: `${scene.systemID}:${index + 1}`,
      systemID: scene.systemID,
      targetShipID: 0,
      minerEntityIDs: spawnResult.data.minerEntityIDs,
      haulerEntityIDs: spawnResult.data.haulerEntityIDs,
      originAnchor: spawnResult.data.originAnchor,
      spawnSelectionName:
        spawnResult.data.minerSpawnResult &&
        spawnResult.data.minerSpawnResult.data &&
        spawnResult.data.minerSpawnResult.data.selectionName,
      haulerSelectionName:
        spawnResult.data.haulerSpawnResult &&
        spawnResult.data.haulerSpawnResult.data &&
        spawnResult.data.haulerSpawnResult.data.selectionName,
    });
    if (process.env.EVEJS_COOP_MINING_STARTUP_RETRY === "1")
      try { require("../../space/coopRuntimeProbe").observe("living-native-mining-startup-slot",
        null,{spaceState:{systemID:scene.systemID}},
        {status:"SEEDED",fleetSlot:index+1,
         miners:(spawnResult.data.minerEntityIDs||[]).length,
         haulers:(spawnResult.data.haulerEntityIDs||[]).length}); }
      catch (_coopError) { console.warn("[CoopMiningRetry]",_coopError.message); }
  }
  if (process.env.EVEJS_COOP_MINING_STARTUP_RETRY === "1" &&
    Array.from({length:fleetCount},(_,i)=>String(scene.systemID)+":"+String(i+1)).every(key=>
      getMiningFleetsForSystem(scene.systemID).some(f=>f.source==="startup" && f.startupKey===key)))
    startupSceneSeedSet.add(startupKey);
}

function deactivateMiningModulesForEntity(scene, entity, hooks, reason = "state") {
  if (!scene || !entity || !hooks || typeof hooks.buildNpcPseudoSession !== "function") {
    return;
  }
  const pseudoSession = hooks.buildNpcPseudoSession(entity);
  for (const moduleItem of getNpcFittedModuleItems(entity)) {
    const effectRecord =
      typeof hooks.findMiningEffectRecordForModule === "function"
        ? hooks.findMiningEffectRecordForModule(moduleItem)
        : getEffectTypeRecord(toInt(moduleItem && moduleItem.effectID, 0));
    if (!effectRecord) {
      continue;
    }
    const activeEffect = entity.activeModuleEffects instanceof Map
      ? entity.activeModuleEffects.get(toInt(moduleItem.itemID, 0))
      : null;
    if (!activeEffect) {
      continue;
    }
    scene.deactivateGenericModule(pseudoSession, moduleItem.itemID, {
      reason,
    });
  }
}

function deactivateMiningModulesForFleet(scene, fleetRecord, hooks, reason = "state") {
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const entity = scene.getEntityByID(entityID);
    if (!entity) {
      continue;
    }
    deactivateMiningModulesForEntity(scene, entity, hooks, reason);
  }
}

function startHaulCycle(scene, fleetRecord, now, hooks) {
  if (!scene || !fleetRecord || fleetRecord.haulerEntityIDs.length <= 0) {
    return false;
  }
  clearFleetManualOrders(fleetRecord.minerEntityIDs);
  deactivateMiningModulesForFleet(scene, fleetRecord, hooks, "cargo");
  const gatherTarget =
    scene.getEntityByID(toInt(fleetRecord.activeAsteroidID, 0)) ||
    scene.getEntityByID(toInt(fleetRecord.targetShipID, 0)) ||
    null;
  const gatherPoint =
    (gatherTarget && gatherTarget.position) ||
    (fleetRecord.originAnchor && fleetRecord.originAnchor.position) ||
    { x: 0, y: 0, z: 0 };
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  for (const [index, entityID] of fleetRecord.haulerEntityIDs.entries()) {
    npcService.runtime.warpToPoint(entityID, buildMiningWarpLandingPoint(
      gatherPoint,
      index,
      fleetRecord.haulerEntityIDs.length,
      Math.max(
        250,
        toFiniteNumber(config.miningNpcHaulerLandingRadiusMeters, 750),
      ),
    ), {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
  }
  fleetRecord.state = "hauling";
  fleetRecord.haulerNextArrivalAtMs = 0;
  fleetRecord.haulCompleteAtMs =
    now +
    ingressDurationMs +
    Math.max(
      500,
      toFiniteNumber(
        config.miningNpcHaulerUnloadDurationMs,
        DEFAULT_MINING_HAULER_UNLOAD_DURATION_MS,
      ),
    );
  fleetRecord.nextThinkAtMs = fleetRecord.haulCompleteAtMs;
  return true;
}

function completeHaulCycle(scene, fleetRecord, now) {
  let hauledVolumeM3 = 0;
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const entity = scene.getEntityByID(entityID);
    if (!entity) {
      continue;
    }
    hauledVolumeM3 += process.env.EVEJS_COOP_NATIVE_HAUL_CARGO === "1" ? require("../../space/coopNativeHaulCargo").transferCargo(scene, fleetRecord, entity) : clearNpcMiningCargo(entity);
  }
  if (process.env.EVEJS_COOP_NATIVE_HAUL_CARGO === "1") {
    // A haul that moved NOTHING is not a loaded fleet. The old code flipped to
    // "loaded" regardless, so a hauler still out of range sent the fleet to the
    // station with an empty hold (measured on the work stack: lastHauledVolumeM3
    // 0, living-native-haul-delivered NO_CARGO, over and over). Stay in the SAME
    // haul and let the warp finish: re-entering mining restarted the warp every
    // few seconds and the hauler never closed 99 km (measured). Only after a long
    // unproductive wait is the warp re-issued.
    if (!(hauledVolumeM3 > 0)) {
      const attempts = Number(fleetRecord.coopEmptyHaulAttempts || 0) + 1;
      fleetRecord.coopEmptyHaulAttempts = attempts;
      if (attempts >= 120) {
        fleetRecord.coopEmptyHaulAttempts = 0;
        fleetRecord.state = "mining";
        fleetRecord.nextThinkAtMs = now + 2000;
        require("../../space/coopRuntimeProbe").observe("living-haul-empty-reissue", null, { spaceState: { systemID: fleetRecord.systemID } }, { fleetID: toInt(fleetRecord.fleetID, 0), attempts });
        return;
      }
      fleetRecord.state = "hauling";
      fleetRecord.haulCompleteAtMs = now + 5000;
      fleetRecord.nextThinkAtMs = fleetRecord.haulCompleteAtMs;
      // The stock warp lands the hauler near the ASTEROID (750 m radius) while the
      // miner orbits that rock kilometres away, so the 2 500 m transfer range was
      // never reached (measured: 35 km - 130 km). Send the hauler to the miner itself.
      // Measured 2026-10-27 on the work stack: the hauler sat 24 km - 90 km from its own
      // miner, every warp answered WARP_DISTANCE_TOO_CLOSE, and the orbit fallback left
      // it drifting AWAY (57 km -> 90 km between two retries). Worse, the miners were
      // parked between two attempts and something re-accelerated them onto a straight
      // full-throttle line, so a follow order issued once every two minutes lost the race
      // every time. A warp is expensive and is re-issued RARELY (it must not restart the
      // warp it waits for), but a follow order is cheap and idempotent: issue it on EVERY
      // unproductive haul attempt, and publish which order the native call really took.
      try {
        const minerID = toInt((fleetRecord.minerEntityIDs || [])[0], 0);
        const haulerID = toInt((fleetRecord.haulerEntityIDs || [])[0], 0);
        const miner = minerID && scene.getEntityByID ? scene.getEntityByID(minerID) : null;
        if (haulerID && miner && miner.position) {
          const npcRuntime = require("../../space/npc/npcRuntime");
          const hauler = scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
          const hp = hauler && hauler.position, mp = miner.position;
          const gap = hp ? Math.round(Math.sqrt(Math.pow(Number(hp.x) - Number(mp.x), 2) + Math.pow(Number(hp.y) - Number(mp.y), 2) + Math.pow(Number(hp.z) - Number(mp.z), 2))) : null;
          const haulerWarping = Boolean(hauler && (hauler.mode === "WARP" || hauler.pendingWarp || hauler.warpState));          let approach = {status: "NO_HAULER_ENTITY", gap};
          if (hauler) {
            const rareRetry = attempts === 1 || attempts % 24 === 0;
            if (rareRetry && !haulerWarping && gap !== null && gap > 150000 && typeof npcRuntime.warpToEntity === "function") {
              const warpResult = npcRuntime.warpToEntity(haulerID, minerID, { forceImmediateStart: false, broadcastWarpStartToVisibleSessions: true });
              approach = warpResult && warpResult.success === true
                ? {status: "WARPED_TO_MINER", gap}
                : {status: "WARP_REFUSED", gap, nativeReason: String((warpResult && warpResult.errorMsg) || "").slice(0, 48)};
            }
            if (approach.status !== "WARPED_TO_MINER") {
              if (haulerWarping) {
                approach = {...approach, gap, status: "ALREADY_WARPING"};
              } else if (
                (String(hauler.mode || "").toUpperCase() === "FOLLOW" &&
                  Number(hauler.targetEntityID) === Number(minerID)) ||
                (String(hauler.mode || "").toUpperCase() === "ORBIT" &&
                  Number(hauler.targetEntityID) === toInt(fleetRecord.activeAsteroidID, 0))
              ) {
                // Re-issuing the same order every five seconds restarted the very approach it
                // was waiting for: measured, the gap oscillated around 3.3-4.9 km while the
                // transfer range is 2 500 m. Leave a correct order alone.
                approach = {...approach, gap, status: "ALREADY_APPROACHING"};
              } else {
                // Measured 2026-10-27: the hauler is spawned with behaviour profile
                // `movementMode: "stop"` (see the spawn path below), so every follow order is
                // consumed once and the hull is then re-stopped by its own loop - measured as
                // mode STOP with target 0 and a frozen 3 221 m gap while the hauler sat 750 m
                // from the rock and its miner 3-6 km away. Change the PROFILE to orbit the
                // fleet's own asteroid and give the matching order: both hulls then converge
                // on the same rock, which is inside the 2 500 m transfer range.
                const rockID = toInt(fleetRecord.activeAsteroidID, 0);
                const npcService = require("../../space/npc/npcService");
                let order = null;
                if (rockID > 0) {
                  applyPassiveMiningFleetOverrides(haulerID, {
                    movementMode: "orbit",
                    orbitDistanceMeters: 1_000,
                    followRangeMeters: 1_000,
                    idleAnchorOrbit: false,
                    issueStopOrder: false,
                    clearCombatPreference: false,
                  });
                  // Measured 2026-10-27 twice over: an orbit order around the MINER is
                  // refused (the hull reverts to STOP with target 0 and the gap freezes),
                  // while an orbit order around the fleet's ROCK is honoured (mode ORBIT,
                  // correct target). So the rock is the meeting point - and the miners are
                  // sent to that same rock below instead of being parked where they drifted.
                  order = typeof npcService.issueManualOrder === "function"
                    ? npcService.issueManualOrder(haulerID, {
                      // Both hulls orbit the same rock; with 1 000/1 200 m radii the mutual
                      // distance swept 327 m .. 5 812 m, i.e. above the 2 500 m transfer range for
                      // most of every orbit. Pull the hauler in so the whole orbit stays in range.
                      type: "orbit", targetID: rockID, orbitDistanceMeters: 400,
                      allowWeapons: false,
                    })
                    : null;
                }
                if (!order || order.success !== true) {
                  order = typeof npcService.issueManualOrder === "function"
                    ? npcService.issueManualOrder(haulerID, {
                      type: "follow", targetID: minerID, followRangeMeters: 500,
                      allowWeapons: false,
                    })
                    : (typeof npcRuntime.follow === "function"
                      ? npcRuntime.follow(haulerID, minerID, 500) : null);
                }
                approach = {...approach, gap, rockID, status: order && order.success === true ? "APPROACH_ISSUED" : "APPROACH_REFUSED", nativeReason: String((order && order.errorMsg) || approach.nativeReason || "").slice(0, 48)};
              }
            }
          }
          require("../../space/coopRuntimeProbe").observe("living-haul-approach-issued", null, { spaceState: { systemID: fleetRecord.systemID } }, { fleetID: toInt(fleetRecord.fleetID, 0), haulerID, minerID, ...approach, haulerMode: String((hauler && hauler.mode) || ""), haulerTargetID: toInt(hauler && hauler.targetEntityID, 0), haulerSpeed: toFiniteNumber(hauler && hauler.speedFraction, 0), minerMode: String((miner && miner.mode) || "") });
        }
      } catch (_coopApproachError) { console.warn("[CoopHaulApproach]", _coopApproachError.message); }
      require("../../space/coopRuntimeProbe").observe("living-haul-empty-retry", null, { spaceState: { systemID: fleetRecord.systemID } }, { fleetID: toInt(fleetRecord.fleetID, 0), attempts });
      return;
    }
    fleetRecord.coopEmptyHaulAttempts = 0;
    fleetRecord.state = "loaded";
    fleetRecord.loadedUntilMs = now + Math.max(30000, Math.min(240000, Number(process.env.EVEJS_COOP_HAULER_HOLD_MS || 120000)));
    fleetRecord.lastHauledVolumeM3 = hauledVolumeM3;
    fleetRecord.lastHauledAtMs = now;
    fleetRecord.nextThinkAtMs = fleetRecord.loadedUntilMs;
    return;
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  if (fleetRecord.originAnchor && fleetRecord.originAnchor.position) {
    for (const entityID of Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []) {
      npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs,
      });
    }
  }
  fleetRecord.lastHauledVolumeM3 = hauledVolumeM3;
  fleetRecord.lastHauledAtMs = now;
  fleetRecord.haulerNextArrivalAtMs = now + getHaulerRepeatDelayMs();
  fleetRecord.state = "haulereturn";
  fleetRecord.haulerReturnAtMs = now + ingressDurationMs;
  fleetRecord.nextThinkAtMs = fleetRecord.haulerReturnAtMs;
}

function shouldTriggerHauling(scene, fleetRecord, noAsteroidsRemain = false, now = Date.now()) {
  try{require("../../space/coopNpcRefineryTick").tick({systemID:Number(scene&&scene.systemID)||0,stationID:Number(fleetRecord&&fleetRecord.stationID)||0,fleetID:Number(fleetRecord&&fleetRecord.fleetID)||0,gameStore:require("../../gameStore"),marketRoot:process.env.EVEJS_COOP_NPC_MARKET_ROOT||process.env.EVEJS_COOP_NPC_MARKET_DIR||""});}catch(_coopRefineError){}
  if (!scene || !fleetRecord || fleetRecord.haulerEntityIDs.length <= 0) {
    return false;
  }
  if (
    toFiniteNumber(fleetRecord.haulerNextArrivalAtMs, 0) > 0 &&
    now < toFiniteNumber(fleetRecord.haulerNextArrivalAtMs, 0)
  ) {
    return false;
  }
  const cargoState = getFleetCargoState(scene, fleetRecord);
  require("../../space/coopMiningFillCap").apply(scene, fleetRecord, cargoState);
  const thresholdRatio = Math.max(
    0.01,
    Math.min(
      1,
      toFiniteNumber(
        config.miningNpcHaulThresholdRatio,
        DEFAULT_MINING_HAUL_THRESHOLD_RATIO,
      ),
    ),
  );
  if (noAsteroidsRemain && cargoState.minerUsedVolumeM3 > 0) {
    return true;
  }
  return cargoState.minerFillRatio >= thresholdRatio;
}

function tickMiningFleet(scene, fleetRecord, now, hooks) {
  if (process.env.EVEJS_COOP_HAUL_CARGO_ADOPTION === "1") { try { require("../../space/coopHaulCargoAdoption").adopt(scene, fleetRecord); } catch (_coopAdoptError) { console.warn("[CoopHaulCargoAdoption]", _coopAdoptError.message); } }
  if (!scene || !fleetRecord || !hooks) {
    return;
  }

  const thinkIntervalMs = Math.max(
    250,
    toFiniteNumber(config.miningNpcFleetThinkIntervalMs, 1_000),
  );
  if (toFiniteNumber(fleetRecord.nextThinkAtMs, 0) > now) {
    return;
  }
  fleetRecord.nextThinkAtMs = now + thinkIntervalMs;
  require("../../space/coopMiningTrace").noteTick(fleetRecord,scene,now,thinkIntervalMs);
  if (process.env.EVEJS_COOP_MINING_DEMAND_GOVERNOR === "1" && !fleetRecord.coopStationArrival && String(fleetRecord.state || "") === "mining") { try { if (require("../../space/coopMiningDemandGovernor").serverGovernor().hold(scene, fleetRecord)) { return; } } catch (_coopDemandError) { console.warn("[CoopMiningDemandGovernor]", _coopDemandError.message); } }

  const latestAggression = getLatestFleetAggression(scene, fleetRecord, now);
  if (
    latestAggression &&
    latestAggression.lastAggressedAtMs >
      Math.max(0, toInt(fleetRecord.lastProcessedAggressionAtMs, 0))
  ) {
    triggerFleetAggression(scene, fleetRecord, {
      aggressorEntity: latestAggression.aggressorEntity,
      aggressionEventAtMs: latestAggression.lastAggressedAtMs,
      nowMs: now,
      hooks,
    });
  }

  if (fleetRecord.responseEntityIDs.length > 0) {
    const activeResponseTarget = scene.getEntityByID(toInt(fleetRecord.responseTargetID, 0));
    if (activeResponseTarget && fleetRecord.responseRetreating !== true) {
      issueResponseOrders(fleetRecord.responseEntityIDs, activeResponseTarget.itemID);
    }
    if (
      fleetRecord.responseDespawnAtMs > 0 &&
      now >= fleetRecord.responseDespawnAtMs
    ) {
      if (fleetRecord.responseRetreating === true) {
        destroyResponseWing(fleetRecord);
      } else {
        retreatResponseWingToOrigin(fleetRecord, { nowMs: now });
      }
    }
  }

  if (
    (fleetRecord.state === "aggressed" || fleetRecord.state === "panic") &&
    fleetRecord.resumeAtMs > 0 &&
    now >= fleetRecord.resumeAtMs &&
    fleetRecord.responseEntityIDs.length <= 0
  ) {
    fleetRecord.state = "mining";
    fleetRecord.resumeAtMs = 0;
  }

  if (process.env.EVEJS_COOP_PLAYER_NPC_MINING_COMPANY === "1" && require("../../space/coopPlayerMiningFleetTick").beforeTick({scene,fleetRecord,now,hooks,startHaul:()=>startHaulCycle(scene,fleetRecord,now,hooks),deactivate:()=>deactivateMiningModulesForFleet(scene,fleetRecord,hooks,"player-mining-shift"),retreat:()=>retreatFleetToOrigin(fleetRecord,{state:"retreating",scene,hooks,reason:"player-mining-shift"})})===true) return;
  if (fleetRecord.state === "hauling") {
    // The state machine returns here, before the per-miner loop, so the miners would
    // otherwise keep whatever movement they had - including a full-throttle straight line
    // that carries them away from their own belt while the hauler chases them.
    parkFleetMiners(scene, fleetRecord, "hauling");
    if (now >= toFiniteNumber(fleetRecord.haulCompleteAtMs, 0)) {
      completeHaulCycle(scene, fleetRecord, now);
    }
    return;
  }
  if (fleetRecord.state === "loaded") {
    parkFleetMiners(scene, fleetRecord, "loaded");
    if (now < toFiniteNumber(fleetRecord.loadedUntilMs, 0)) return;
    const ingressMs = Math.max(250, toFiniteNumber(config.miningNpcWarpIngressDurationMs, DEFAULT_MINING_WARP_INGRESS_DURATION_MS));
    if (process.env.EVEJS_COOP_NPC_STATION_DELIVERY === "1") {
      require("../../space/coopNativeStationArrival").routeFromHaul(scene, fleetRecord, npcService.runtime, now, ingressMs);
      // A station trip is a PHYSICAL trip. Falling straight through to the
      // native return-home transition made the fleet enter "haulereturn" with
      // no active trip, where checkReturn could only report ROUTE_NOT_STARTED
      // forever: the ore was never delivered and the fleet never mined again.
      const settled = require("../../space/coopNativeStationArrival").checkReturn(scene, fleetRecord, now);
      const delivered = settled.terminal === true && (settled.status === "DELIVERED" || settled.status === "NO_CARGO");
      if (!delivered) { fleetRecord.nextThinkAtMs = now + 1000; return; }
      require("../../space/coopRuntimeProbe").observe("living-native-haul-delivered", null, { spaceState: { systemID: scene.systemID } }, { fleetID: toInt(fleetRecord.fleetID, 0), status: String((settled && settled.status) || ""), stationID: toInt(settled && settled.stationID, 0) });
      fleetRecord.haulerNextArrivalAtMs = now + getHaulerRepeatDelayMs();
      fleetRecord.state = "mining";
      fleetRecord.haulerReturnAtMs = 0;
      fleetRecord.nextThinkAtMs = now + 1000;
      return;
    } else if (fleetRecord.originAnchor && fleetRecord.originAnchor.position) {
      for (const entityID of fleetRecord.haulerEntityIDs || []) {
        npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
          forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true,
          visibilitySuppressMs: 250, ingressDurationMs: ingressMs
        });
      }
    }
    fleetRecord.haulerNextArrivalAtMs = now + getHaulerRepeatDelayMs();
    fleetRecord.state = "haulereturn";
    fleetRecord.haulerReturnAtMs = now + ingressMs;
    fleetRecord.nextThinkAtMs = fleetRecord.haulerReturnAtMs;
    return;
  }
  if (fleetRecord.state === "haulereturn") {
    if (process.env.EVEJS_COOP_NPC_STATION_DELIVERY === "1") {
      const arrival = require("../../space/coopNativeStationArrival").checkReturn(scene, fleetRecord, now);
      if (arrival.terminal === true) {
        fleetRecord.state = "mining";
        fleetRecord.haulerReturnAtMs = 0;
      } else { fleetRecord.nextThinkAtMs = now + 1000; }
    } else if (now >= toFiniteNumber(fleetRecord.haulerReturnAtMs, 0)) {
      if (process.env.EVEJS_COOP_NATIVE_HAUL_CARGO === "1" && process.env.EVEJS_COOP_NPC_STATION_DELIVERY !== "1") require("../../space/coopNativeHaulCargo").unloadCargo(scene, fleetRecord);
      fleetRecord.state = "mining";
      fleetRecord.haulerReturnAtMs = 0;
    }
    return;
  }
  if (fleetRecord.state !== "mining") {
    return;
  }

  const availableTargetEntries = resolveAvailableMineableTargetEntries(scene, fleetRecord);
  if (availableTargetEntries.length <= 0) {
    fleetRecord.activeAsteroidID = 0;
    if (shouldTriggerHauling(scene, fleetRecord, true, now) && startHaulCycle(scene, fleetRecord, now, hooks)) {
      return;
    }
    fleetRecord.state = "depleted";
    retreatFleetToOrigin(fleetRecord, {
      state: "depleted",
      scene,
      hooks,
      reason: "depleted",
    });
    return;
  }

  if (shouldTriggerHauling(scene, fleetRecord, false, now) && startHaulCycle(scene, fleetRecord, now, hooks)) {
    return;
  }

  const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
  const claimCounts = buildAssignedMineableClaimCounts(scene, fleetRecord);
  const targetAssignmentCounts = new Map();
  const rangeBufferMeters = Math.max(
    0,
    toFiniteNumber(config.miningNpcFleetMiningRangeBufferMeters, 500),
  );
  const orbitDistanceMeters = Math.max(
    500,
    toFiniteNumber(config.miningNpcFleetOrbitDistanceMeters, 1_000),
  );

  for (const minerEntityID of Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const minerEntity = scene.getEntityByID(minerEntityID);
    if (minerEntity) require("../../space/coopStuckWarpRecovery").release(minerEntity, scene);
    if (!minerEntity || minerEntity.mode === "WARP" || minerEntity.pendingWarp) {
      require("../../space/coopMiningTrace").note("MINER_NOT_IN_SCENE_OR_WARPING",{fleetID:toInt(fleetRecord&&fleetRecord.fleetID,0),systemID:toInt(scene&&scene.systemID,0),minerID:toInt(minerEntityID,0),found:Boolean(minerEntity),mode:String((minerEntity&&minerEntity.mode)||""),pendingWarp:Boolean(minerEntity&&minerEntity.pendingWarp)});
      continue;
    }

    const miningModules = getNpcFittedModuleItems(minerEntity)
      .filter((moduleItem) => isModuleOnline(moduleItem))
      .map((moduleItem) => ({
        moduleItem,
        effectRecord:
          typeof hooks.findMiningEffectRecordForModule === "function"
            ? hooks.findMiningEffectRecordForModule(moduleItem)
            : getEffectTypeRecord(toInt(moduleItem && moduleItem.effectID, 0)),
      }))
      .filter((entry) => entry.effectRecord);
    if (miningModules.length <= 0) {
      require("../../space/coopMiningTrace").note("NO_MINING_MODULE",{fleetID:toInt(fleetRecord&&fleetRecord.fleetID,0),systemID:toInt(scene&&scene.systemID,0),minerID:toInt(minerEntity.itemID,0)});
      continue;
    }

    const primarySnapshot = hooks.buildEntityMiningSnapshot(
      minerEntity,
      miningModules[0].moduleItem,
      miningModules[0].effectRecord,
    );
    if (!primarySnapshot) {
      require("../../space/coopMiningTrace").note("NO_MINING_SNAPSHOT",{fleetID:toInt(fleetRecord&&fleetRecord.fleetID,0),systemID:toInt(scene&&scene.systemID,0),minerID:toInt(minerEntity.itemID,0),moduleTypeID:toInt(miningModules[0].moduleItem&&miningModules[0].moduleItem.typeID,0)});
      continue;
    }

    const targetEntity = chooseMineableTargetForMiner(
      scene,
      fleetRecord,
      minerEntity,
      availableTargetEntries,
      claimCounts,
      primarySnapshot,
      hooks,
    );
    if (!targetEntity) {
      delete assignmentMap[toInt(minerEntity.itemID, 0)];
require("../../space/coopMiningTrace").noteNoMineableTarget(fleetRecord,scene,minerEntity,availableTargetEntries,claimCounts);
      continue;
    }
    const targetEntityID = toInt(targetEntity.itemID, 0);
    targetAssignmentCounts.set(
      targetEntityID,
      toInt(targetAssignmentCounts.get(targetEntityID), 0) + 1,
    );

    const distanceToTarget = hooks.getSurfaceDistance(minerEntity, targetEntity);
    require("../../space/coopMiningTrace").noteTargetSelected(fleetRecord,scene,minerEntity,targetEntity,miningModules,hooks);
    const engagementRangeMeters = getMiningEngagementRangeMeters(
      scene,
      minerEntity,
      primarySnapshot,
      rangeBufferMeters,
    );
      if (require("../../space/coopMiningBeltReturn").ensure(scene, fleetRecord, minerEntity, targetEntity, {orbitDistanceMeters, engagementRangeMeters, now, ingressDurationMs: Math.max(250, toFiniteNumber(config.miningNpcWarpIngressDurationMs, DEFAULT_MINING_WARP_INGRESS_DURATION_MS)), warp: (shipID, point, warpOptions) => npcService.runtime.warpToPoint(shipID, point, warpOptions)})) continue;
    if (distanceToTarget > engagementRangeMeters) {
      require("../../space/coopMiningTrace").note("TARGET_OUT_OF_RANGE",{fleetID:toInt(fleetRecord&&fleetRecord.fleetID,0),systemID:toInt(scene&&scene.systemID,0),minerID:toInt(minerEntity.itemID,0),distanceMeters:Math.round(distanceToTarget),engagementMeters:Math.round(engagementRangeMeters)});
      syncMiningApproachOrder(
        scene,
        minerEntity,
        targetEntity,
        orbitDistanceMeters,
      );
      continue;
    }

    const targetLockResult = syncMiningTargetLock(
      scene,
      minerEntity,
      targetEntity,
      now,
      hooks,
    );
    if (!targetLockResult || targetLockResult.success !== true) {
      require("../../space/coopMiningTrace").note("TARGET_LOCK_FAILED",{fleetID:toInt(fleetRecord&&fleetRecord.fleetID,0),systemID:toInt(scene&&scene.systemID,0),minerID:toInt(minerEntity.itemID,0),errorMsg:String((targetLockResult&&targetLockResult.errorMsg)||"NONE")});
      syncMiningApproachOrder(
        scene,
        minerEntity,
        targetEntity,
        orbitDistanceMeters,
      );
      continue;
    }

    syncMiningApproachOrder(
      scene,
      minerEntity,
      targetEntity,
      orbitDistanceMeters,
    );
    const pseudoSession = hooks.buildNpcPseudoSession(minerEntity);
    for (const entry of miningModules) {
      const activeEffect = minerEntity.activeModuleEffects instanceof Map
        ? minerEntity.activeModuleEffects.get(toInt(entry.moduleItem.itemID, 0))
        : null;
      if (activeEffect && toInt(activeEffect.targetID, 0) !== toInt(targetEntity.itemID, 0)) {
require("../../space/coopMiningTrace").noteTargetMismatch(fleetRecord,scene,minerEntity,entry,activeEffect,targetEntity);
        scene.deactivateGenericModule(pseudoSession, entry.moduleItem.itemID, {
          reason: "target",
        });
        continue;
      }
      if (!activeEffect) { require("../../space/coopMiningActivate").activate({scene,pseudoSession,minerEntity,entry,targetEntity,fleetRecord}); continue; }
      if (!activeEffect) {
      scene.activateGenericModule(pseudoSession, entry.moduleItem, entry.effectRecord.name, {
        targetID: targetEntity.itemID,
      });
      }
    }
  }

  const primaryTargetEntry = [...targetAssignmentCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  fleetRecord.activeAsteroidID = primaryTargetEntry ? toInt(primaryTargetEntry[0], 0) : 0;
}

function tickScene(scene, now, hooks = {}) {
  const fleets = getMiningFleetsForSystem(scene && scene.systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return;
  }
  for (const fleetRecord of fleets) {
    tickMiningFleet(scene, fleetRecord, now, hooks);
  }
}

module.exports = {
  appendNpcMiningCargo,
  clearNpcMiningCargo,
  getNpcOreCargoSummary,
  getMiningFleetsForSystem,
  pruneMiningFleet,
  handleSceneCreated,
  handleMiningFleetCommand,
  handleMiningFleetAggroCommand,
  handleMiningFleetClearCommand,
  handleMiningFleetStatusCommand,
  handleMiningFleetRetreatCommand,
  handleMiningFleetResumeCommand,
  handleMiningFleetHaulCommand,
  tickScene,
  _testing: {
    createMiningFleetRecord,
    getSecurityBandForSystemID,
    resolveMiningFleetQuery,
    resolveMiningHaulerQuery,
    resolveResponsePlan,
    shouldTriggerHauling,
    triggerFleetAggression,
    buildMiningMovementOrder,
    areManualOrdersEquivalent,
    applyPassiveMiningFleetOverrides,
    syncMiningApproachOrder,
    stopRunawayFullThrottle,
    parkFleetMiners,
    chooseFleetMineableTarget,
    chooseMineableTargetForMiner,
    syncMiningTargetLock,
    tickMiningFleet,
    clearState() {
      miningFleetStateByID.clear();
      startupSceneSeedSet.clear();
      nextMiningFleetID = 1;
    },
  },
};
