"use strict";
// Pure decision core for NPC courier dispatch. No wallet, inventory, contract
// or scene mutation happens here - this module only answers "may this NPC even
// consider this contract, with which hull, along which legs, and on which legs
// may a hostile NPC be offered a real attack order".
//
// Design and the phase gates: docs/NPC_COURIER_CONTRACTS.md
// Nothing here is evidence that an NPC has ever carried a contract.
const COURIER_CONTRACT_TYPE = "courier";
// The live contractRuntime record has no contractType field at all: it stores
// the numeric type, where 3 is courier. Both shapes must be recognised or a
// real contract is refused as "not a courier contract".
const COURIER_CONTRACT_TYPE_ID = 3;
function isCourierContract(contract) {
  if (!contract || typeof contract !== "object") return false;
  if (String(contract.contractType || "").toLowerCase() === COURIER_CONTRACT_TYPE) return true;
  return Number(contract.type) === COURIER_CONTRACT_TYPE_ID;
}
const OUTSTANDING_STATUS = "outstanding";
// The live contractRuntime stores numeric status (0 = outstanding) while the
// client-facing shape uses strings, so both must be accepted.
const LEGAL_STATUSES = Object.freeze(["outstanding", "0"]);

const DEFAULT_POLICY = Object.freeze({
  sameSystemOnly: true,
  minReward: 0,
  maxVolumeM3: 0,
  requireZeroCollateral: true,
  maxRouteLegs: 8,
});

const DEFAULT_PIRACY_POLICY = Object.freeze({
  enabled: false,
  chancePerLeg: 0.25,
  minVolumeM3: 0,
});

function status(name, extra) {
  return Object.assign({ status: name }, extra || {});
}

function positive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function money(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function resolvePolicy(policy) {
  return Object.assign({}, DEFAULT_POLICY, policy || {});
}

// Decide whether a native courier contract record may be offered to an NPC.
// context: { walletIsk, hullCapacityM3, nowMs }
function evaluateContract(contract, policy, context) {
  const rules = resolvePolicy(policy);
  const ctx = context || {};
  if (!contract || typeof contract !== "object") {
    return status("REFUSED_NO_CONTRACT");
  }
  const contractID = Number(contract.contractID) || 0;
  if (!isCourierContract(contract)) {
    return status("REFUSED_NOT_COURIER", { contractID });
  }
  if (!LEGAL_STATUSES.includes(String(contract.status === 0 ? "0" : contract.status || "").toLowerCase())) {
    return status("REFUSED_STATUS", { contractID, contractStatus: String(contract.status || "") });
  }
  // The package must be a real item; a contract without one cannot be carried.
  if (!positive(contract.plasticWrapItemID)) {
    return status("REFUSED_NO_PACKAGE", { contractID });
  }
  const volumeM3 = Number(contract.volume);
  if (!positive(volumeM3)) {
    return status("REFUSED_NO_VOLUME", { contractID });
  }
  if (rules.maxVolumeM3 > 0 && volumeM3 > rules.maxVolumeM3) {
    return status("REFUSED_VOLUME_LIMIT", { contractID, volumeM3, limitM3: rules.maxVolumeM3 });
  }
  const reward = money(contract.reward);
  if (reward < money(rules.minReward)) {
    return status("REFUSED_LOW_REWARD", { contractID, reward, minReward: money(rules.minReward) });
  }
  const collateral = money(contract.collateral);
  if (rules.requireZeroCollateral && collateral > 0) {
    return status("REFUSED_COLLATERAL_POLICY", { contractID, collateral });
  }
  const walletIsk = money(ctx.walletIsk);
  if (collateral > walletIsk) {
    return status("REFUSED_COLLATERAL_UNFUNDED", { contractID, collateral, walletIsk });
  }
  const hullCapacityM3 = Number(ctx.hullCapacityM3) || 0;
  if (!positive(hullCapacityM3)) {
    return status("REFUSED_NO_HULL", { contractID, volumeM3 });
  }
  if (volumeM3 > hullCapacityM3) {
    return status("REFUSED_VOLUME_EXCEEDS_HULL", { contractID, volumeM3, hullCapacityM3 });
  }
  const startSystemID = Number(contract.startSolarSystemID) || 0;
  const endSystemID = Number(contract.endSolarSystemID) || 0;
  // Two unknown systems (0 and 0) are equal, which would silently look like a
  // same-system contract. Refuse instead of guessing.
  if (!positive(startSystemID) || !positive(endSystemID)) {
    return status("REFUSED_UNKNOWN_SYSTEM", { contractID, startSystemID, endSystemID });
  }
  // A same-system policy is the safe default, but it is not a law: when the
  // real native gate path is enabled (approach + transfer), a cross-system
  // delivery is exactly what the courier is supposed to fly.
  const gateTravelEnabled = process.env.EVEJS_COOP_NATIVE_GATE_APPROACH === "1" &&
    process.env.EVEJS_COOP_NATIVE_GATE_TRANSFER === "1";
  if (rules.sameSystemOnly && startSystemID !== endSystemID && !gateTravelEnabled) {
    return status("NEEDS_GATE_TRAVEL", { contractID, startSystemID, endSystemID });
  }
  return status("ELIGIBLE", {
    contractID,
    volumeM3,
    reward,
    collateral,
    startSystemID,
    endSystemID,
    hullCapacityM3,
  });
}

// Smallest real hull that physically fits the package. No partial loading.
function selectHull(volumeM3, hulls) {
  const wanted = Number(volumeM3);
  if (!positive(wanted)) {
    return status("NO_HULL_FITS", { volumeM3: 0 });
  }
  const usable = (Array.isArray(hulls) ? hulls : [])
    .filter((hull) => hull && positive(hull.capacityM3) && Number(hull.typeID) > 0)
    .sort((left, right) => Number(left.capacityM3) - Number(right.capacityM3));
  const hull = usable.find((candidate) => Number(candidate.capacityM3) >= wanted);
  if (!hull) {
    return status("NO_HULL_FITS", {
      volumeM3: wanted,
      largestCapacityM3: usable.length ? Number(usable[usable.length - 1].capacityM3) : 0,
    });
  }
  return status("HULL_SELECTED", {
    volumeM3: wanted,
    typeID: Number(hull.typeID),
    name: String(hull.name || ""),
    capacityM3: Number(hull.capacityM3),
    utilization: Math.round((wanted / Number(hull.capacityM3)) * 1000) / 10,
  });
}

// Ordered legs for one solar system. stations: { [stationID]: {stationID, solarSystemID} }
function planRoute(contract, stations, policy) {
  const rules = resolvePolicy(policy);
  if (!contract) {
    return status("NO_ROUTE", { reason: "missing contract" });
  }
  const originID = Number(contract.startStationID) || 0;
  const destinationID = Number(contract.endStationID) || 0;
  if (!positive(originID) || !positive(destinationID)) {
    return status("NO_ROUTE", { reason: "contract has no origin or destination station" });
  }
  if (originID === destinationID) {
    return status("NO_ROUTE", { reason: "origin and destination are the same station" });
  }
  const table = stations || {};
  const origin = table[originID] || table[String(originID)];
  const destination = table[destinationID] || table[String(destinationID)];
  if (!origin || !destination) {
    return status("NO_ROUTE", { reason: "unknown station", originID, destinationID });
  }
  const originSystemID = Number(origin.solarSystemID) || 0;
  const destinationSystemID = Number(destination.solarSystemID) || 0;
  if (!positive(originSystemID) || !positive(destinationSystemID)) {
    return status("NO_ROUTE", { reason: "station without solar system", originID, destinationID });
  }
  if (originSystemID !== destinationSystemID) {
    return status("NEEDS_GATE_TRAVEL", { originSystemID, destinationSystemID });
  }
  const legs = [{
    index: 1,
    fromStationID: originID,
    toStationID: destinationID,
    solarSystemID: originSystemID,
    kind: "in-system",
  }];
  if (legs.length > rules.maxRouteLegs) {
    return status("NO_ROUTE", { reason: "route exceeds maxRouteLegs" });
  }
  return status("ROUTE_PLANNED", { solarSystemID: originSystemID, legs });
}

function hashUnit(seed) {
  // Deterministic, stable across processes: FNV-1a 32-bit over the seed text.
  const text = String(seed);
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value / 0xffffffff;
}

// Which legs may receive a real attack order. This never spawns anything by
// itself: a hostile NPC group must physically exist on that scene, and the
// server must be able to give it a genuine native attack order.
function piracyOpportunity(route, policy, seed) {
  const rules = Object.assign({}, DEFAULT_PIRACY_POLICY, policy || {});
  const legs = route && Array.isArray(route.legs) ? route.legs : [];
  if (!legs.length) {
    return status("PIRACY_SKIPPED", { reason: "no route legs" });
  }
  if (rules.enabled !== true) {
    return status("PIRACY_SKIPPED", { reason: "piracy disabled" });
  }
  const chance = Math.min(Math.max(Number(rules.chancePerLeg) || 0, 0), 1);
  const rolls = legs.map((leg) => {
    const value = hashUnit(`${String(seed || "")}:${leg.index}:${leg.solarSystemID}`);
    return {
      index: leg.index,
      roll: Math.round(value * 1000) / 1000,
      mayOfferAttackOrder: value < chance,
    };
  });
  return status("PIRACY_PLANNED", {
    chancePerLeg: chance,
    legs: rolls,
    attackOrderLegs: rolls.filter((roll) => roll.mayOfferAttackOrder).map((roll) => roll.index),
  });
}

// Published courier rate. The issuer needs a number BEFORE creating the
// contract, so the formula is deliberately simple, documented and printable
// (scripts/Get-CourierRateTable.cjs). It is a service price, not a market
// clearing price, and it never moves ISK by itself.
const DEFAULT_QUOTE_POLICY = Object.freeze({
  baseIsk: 5000,
  iskPerM3: 25,
  iskPerJump: 5000,
  collateralPremiumRate: 0.015,
  hullMultiplier: Object.freeze({ industrial: 1, freighter: 1.6 }),
});

function roundIsk(value) {
  return Math.round(Number(value) / 1000) * 1000;
}

// quoteCourier({volumeM3, jumps, collateral, hullClass}) -> breakdown in ISK
function quoteCourier(request, policy) {
  const rules = Object.assign({}, DEFAULT_QUOTE_POLICY, policy || {});
  const input = request || {};
  const volumeM3 = Number(input.volumeM3);
  if (!positive(volumeM3)) {
    return status("NO_QUOTE", { reason: "volume must be positive" });
  }
  const jumps = Math.max(1, Math.trunc(Number(input.jumps) || 1));
  const collateral = money(input.collateral);
  const hullClass = String(input.hullClass || "industrial").toLowerCase();
  const hullMultiplier = Number(rules.hullMultiplier[hullClass]);
  if (!Number.isFinite(hullMultiplier) || hullMultiplier <= 0) {
    return status("NO_QUOTE", { reason: "unknown hull class: " + hullClass });
  }
  const volumeIsk = volumeM3 * Number(rules.iskPerM3);
  const distanceIsk = jumps * Number(rules.iskPerJump);
  const riskIsk = collateral * Number(rules.collateralPremiumRate);
  const subtotal = Number(rules.baseIsk) + volumeIsk + distanceIsk + riskIsk;
  return status("QUOTED", {
    hullClass,
    hullMultiplier,
    volumeM3,
    jumps,
    collateral,
    breakdown: {
      baseIsk: roundIsk(rules.baseIsk),
      volumeIsk: roundIsk(volumeIsk),
      distanceIsk: roundIsk(distanceIsk),
      riskIsk: roundIsk(riskIsk),
      hullIsk: roundIsk(subtotal * hullMultiplier) - roundIsk(subtotal),
    },
    totalIsk: roundIsk(subtotal * hullMultiplier),
  });
}

// An NPC courier is only real if it is a real character: the wallet lives in
// the character record (`balance` + `walletJournal`), the ship is a real item
// owned by that character, and both must be at the contract origin station.
// identity: { character:{characterID,accountId,stationID,balance},
//             ship:{itemID,typeID,stationID,capacityM3} }
function evaluateCourierIdentity(identity, contract, atStationID) {
  const who = identity || {};
  const character = who.character;
  const ship = who.ship;
  const contractID = Number(contract && contract.contractID) || 0;
  // The stored character record has no characterID field: the ID is the row key.
  const characterID = Number(character && (character.characterID || character.id)) || 0;
  if (!character || !(characterID > 0) || !(Number(character.accountId) > 0)) {
    return status("REFUSED_NO_CHARACTER", { contractID });
  }
  // The expected station is explicit: acceptance happens at the origin, but
  // completion happens at the DESTINATION, so a hard-coded origin check would
  // make a successful delivery impossible to settle.
  const originStationID = Number(atStationID) || Number(contract && contract.startStationID) || 0;
  if (Number(character.stationID) !== originStationID) {
    return status("REFUSED_CHARACTER_NOT_AT_ORIGIN", {
      contractID,
      characterStationID: Number(character.stationID) || 0,
      originStationID,
    });
  }
  const balance = money(character.balance);
  const collateral = money(contract && contract.collateral);
  if (balance < collateral) {
    return status("REFUSED_NO_FUNDS", { contractID, balance, collateral });
  }
  if (!ship || !(Number(ship.itemID) > 0) || !(Number(ship.typeID) > 0)) {
    return status("REFUSED_NO_SHIP", { contractID });
  }
  // The ship must belong to this courier: an item owned by somebody else is
  // not a ship we may fly, even if it sits at the right station.
  if (Number(ship.ownerID) !== characterID) {
    return status("REFUSED_SHIP_NOT_OWNED", {
      contractID,
      shipOwnerID: Number(ship.ownerID) || 0,
      characterID,
    });
  }
  // A real item row has locationID, not stationID: reading stationID alone made
  // every real ship look like it was somewhere else.
  const shipLocationID = Number(ship.locationID || ship.stationID) || 0;
  if (shipLocationID !== originStationID) {
    return status("REFUSED_SHIP_NOT_AT_ORIGIN", {
      contractID,
      shipStationID: shipLocationID,
      originStationID,
    });
  }
  // 4 is the hangar flag; an assembled or fitted ship is not a cargo hauler.
  if (ship.flagID !== undefined && Number(ship.flagID) !== 4) {
    return status("REFUSED_SHIP_NOT_IN_HANGAR", { contractID, flagID: Number(ship.flagID) });
  }
  // A real item row carries capacity, not capacityM3.
  const capacityM3 = Number(ship.capacityM3 || ship.capacity) || 0;
  const volumeM3 = Number(contract && contract.volume) || 0;
  if (capacityM3 < volumeM3) {
    return status("REFUSED_SHIP_TOO_SMALL", { contractID, capacityM3, volumeM3 });
  }
  return status("READY", {
    contractID,
    characterID,
    balance,
    shipItemID: Number(ship.itemID),
    capacityM3,
    volumeM3,
  });
}


// The settlement chain, as data. Accept escrows the courier's own ISK and moves
// the real package into its hangar; complete is only legal once that package is
// physically at the destination station. Nothing here mutates anything.
function planSettlement(contract, identity, packageLocationID, options) {
  const opts = options || {};
  const origin = Number(contract && contract.startStationID) || 0;
  const destination = Number(contract && contract.endStationID) || 0;
  const packageAt = Number(packageLocationID) || 0;
  if (packageAt === destination) {
    const atDestination = evaluateCourierIdentity(identity, contract, destination);
    if (atDestination.status !== "READY") return atDestination;
    return status("SETTLE_NOW", { contractID: atDestination.contractID, steps: ["complete"] });
  }
  const readiness = evaluateCourierIdentity(identity, contract, origin);
  if (readiness.status !== "READY") return readiness;
  if (packageAt !== origin) {
    // A real EveJS contract keeps the wrapped package in the issuer's own
    // hangar/office location until somebody accepts it, so that location is not
    // "elsewhere". Only an explicit opt-in may treat it as ready to fly.
    const issuerHeld = opts.allowIssuerHeldPackage === true &&
      Number(opts.packageOwnerID) === Number(contract && contract.issuerID) &&
      Number(contract && contract.issuerID) > 0;
    if (!issuerHeld) {
      return status("REFUSED_PACKAGE_ELSEWHERE", {
        contractID: readiness.contractID, packageAt, origin, destination,
      });
    }
  }
  return status("ACCEPT_THEN_FLY", {
    contractID: readiness.contractID,
    characterID: readiness.characterID,
    origin,
    destination,
    steps: ["accept", "fly", "complete"],
  });
}

module.exports = {
  COURIER_CONTRACT_TYPE,
  COURIER_CONTRACT_TYPE_ID,
  isCourierContract,
  DEFAULT_POLICY,
  DEFAULT_PIRACY_POLICY,
  DEFAULT_QUOTE_POLICY,
  evaluateContract,
  evaluateCourierIdentity,
  planSettlement,
  selectHull,
  planRoute,
  piracyOpportunity,
  quoteCourier,
};
