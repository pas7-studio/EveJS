"use strict";
// Pure derivation of a mineable objective for mission dungeons that declare their ore but no rocks.
//
// Why this exists: ORE-style mission sites (client-dungeon:13338 "ORE Phased Field Operation Site", the
// target of the native mission "The Missing Pilot") carry only resourceComposition.oreTypeIDs. Their
// static template has no populationHints.miningRocks and no objectiveQuantity, and their siteFamily is
// "combat", so dungeonUniverseSiteService materialized an empty pocket: no asteroid, no objective, and
// therefore no way for the client to ever show the mission Complete button.
//
// The working mining missions (client-dungeon:2449 "Starting Simple") already carry exactly this shape:
//   populationHints.miningRocks = [{ typeID, count, quantity }]
//   populationHints.objectiveQuantity = total ore the site yields
// buildMiningRockEntities() spawns kind:"asteroid" entities from it, miningRuntimeState tracks each rock,
// and processMiningObjective() marks the dungeon objective satisfied once that much ore is extracted.
// This module produces the same shape from the declared ore, and nothing else: no ISK, no NPC, no
// second objective system.
//
// No game store, no scene, no session: pure input -> output, so it can be unit tested in isolation.

// Mirrors the shipped mining missions: one asteroid per declared ore type, carrying the whole
// objective quantity (client-dungeon:2449 = 1 rock of 20000, 2450/2451 = 3600, 2454 = 1800).
// This site's own objective is cover mining ("go uncover as an ORE miner"), not a hauling job, so the
// quantity stays small: one rock per ore, 500 m3 each (1000 m3 for a two-ore ORE site) - a few Venture
// cycles, not a barge run.
const DERIVED_ROCK_COUNT_PER_ORE = 1;
const DERIVED_ROCK_QUANTITY = 500;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {{resourceComposition?: {oreTypeIDs?: number[]}}} template
 * @returns {{miningRocks: Array<{typeID:number,count:number,quantity:number,source:string}>, objectiveQuantity:number}}
 */
function deriveMiningObjectiveFromResources(template) {
  const composition =
    template && template.resourceComposition && typeof template.resourceComposition === "object"
      ? template.resourceComposition
      : {};
  const oreTypeIDs = normalizeArray(composition.oreTypeIDs)
    .map((value) => toInt(value, 0))
    .filter((value) => value > 0);
  if (oreTypeIDs.length <= 0) {
    return { miningRocks: [], objectiveQuantity: 0 };
  }
  const miningRocks = oreTypeIDs.map((oreTypeID) => ({
    typeID: oreTypeID,
    count: DERIVED_ROCK_COUNT_PER_ORE,
    quantity: DERIVED_ROCK_QUANTITY,
    source: "mission_resource_composition",
  }));
  return {
    miningRocks,
    objectiveQuantity: miningRocks.reduce((sum, rock) => sum + (rock.count * rock.quantity), 0),
  };
}

// A site whose hints declare an ore objective is finished by mining, never by
// clearing its defenders. The destroyed-target path used to satisfy the objective
// when a site's NPCs disappeared (including when a restart pruned them), so a
// mining mission could be handed in without a single cycle of ore.
function declaresMiningObjective(hints) {
  const quantity = Number(hints && hints.objectiveQuantity);
  return Number.isFinite(quantity) && quantity > 0;
}

module.exports = {
  DERIVED_ROCK_COUNT_PER_ORE,
  DERIVED_ROCK_QUANTITY,
  declaresMiningObjective,
  deriveMiningObjectiveFromResources,
};
