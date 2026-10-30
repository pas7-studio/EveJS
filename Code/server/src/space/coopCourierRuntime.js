"use strict";
// Live courier dispatch: a seeded courier CHARACTER accepts a real native
// courier contract, flies it with native undock/warp/dock and completes it.
//
// Nothing is invented here. Every mutation is a stock native call:
//   - accept/complete go through contractRuntimeState (the same functions a
//     client uses), with an identity object that is never registered as a
//     session,
//   - the flight uses transitions.undockSession/dockSession and space.warpToPoint,
//   - arrival is only confirmed by the real scene: the ship entity must be
//     inside station docking range of the destination station position.
//
// Fail-closed rules:
//   - one accept attempt per contract per process; an ambiguous native result
//     is never retried,
//   - a flight advances only on a confirmed OK for the same step token,
//   - a contract is completed only when its package item is physically at the
//     destination station.
// The same file is loaded as .cjs in the repo and as .js inside the server.
const EXT = (typeof __filename === "string" && __filename.endsWith(".js")) ? "" : ".cjs";
const { evaluateContract } = require("./coopCourierDispatch" + EXT);
const flightCore = require("./coopCourierFlight" + EXT);
const driver = require("./coopCourierFlightDriver" + EXT);
// Shared identity object for this courier, owned by the generic motion module.
const motion = require("./coopNativeAgentMotion" + EXT);
// Legs, resume and the delivery history are generic to any player-like NPC.
const living = require("./coopLivingAgentRuntime" + EXT);
const bridge = require("./coopCourierNativeAccept" + EXT);
const notices = require("./coopCourierNotices" + EXT);
// Real native stargate hops for a cross-system delivery.
const gateHop = require("./coopCourierGateHop" + EXT);
const nodeFs = require("node:fs");
// Notice ledger lives on the persistent data volume: a restart or a container
// recreate must never mail the same courier message twice.
const NOTICE_FILE = process.env.EVEJS_COOP_COURIER_NOTICE_FILE || "/var/lib/evejs/coop-courier-notices.json";
// Delivery history per contract: when the courier really departed and what
// really went wrong. Kept on the data volume so a restart cannot erase the run
// the owner is later told about.
const FLIGHT_HISTORY_FILE = process.env.EVEJS_COOP_COURIER_HISTORY_FILE || "/var/lib/evejs/coop-courier-history.json";
// The flight itself (step, target station, ship entity) is persisted too: after a
// restart the courier must continue from where it physically is, not fly back to
// the origin and start the leg again.
const FLIGHT_FILE = process.env.EVEJS_COOP_COURIER_FLIGHT_FILE || "/var/lib/evejs/coop-courier-flights.json";
const FLIGHT_STEPS = Object.freeze(["undock", "warp", "arrive", "dock", "done"]);
// A native undock or a stargate jump detaches the ship from the source scene for
// a moment. A hull that is really gone must stay gone this long before it is
// docked back, otherwise a normal native transition looks like a lost ship.
const SCENE_ENTITY_GRACE_MS = 90000;

// Collateral is insurance, not a refusal reason: a courier takes a contract when
// it actually holds the ISK. requireZeroCollateral stays the pure-core default
// so unit tests keep covering both policies.
const LIVE_POLICY = Object.freeze({ sameSystemOnly: true, requireZeroCollateral: false, maxRouteLegs: 8 });
// Stock station docking range.
const DOCKING_RANGE_M = 2500;

function num(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function distanceM(left, right) {
  const dx = num(left.x) - num(right.x);
  const dy = num(left.y) - num(right.y);
  const dz = num(left.z) - num(right.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// deps: { contracts, gameStore, itemStore, worldData, transitions, space,
//         sceneForSystem, pilots, now, log }
function createCourierDispatch(deps = {}) {
  const contracts = deps.contracts;
  const gameStore = deps.gameStore;
  const itemStore = deps.itemStore;
  const worldData = deps.worldData;
  const transitions = deps.transitions;
  const space = deps.space;
  const sceneForSystem = deps.sceneForSystem;
  const pilots = (Array.isArray(deps.pilots) ? deps.pilots : []).map(num).filter((id) => id > 0);
  const sendMail = typeof deps.sendMail === "function" ? deps.sendMail : null;
  let sentNotices = {};
  try {
    const raw = nodeFs.readFileSync(NOTICE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") sentNotices = parsed;
  } catch (_error) {
    sentNotices = {};
  }
  function noticeAlreadySent(contractID, kind) {
    const row = sentNotices[String(contractID)];
    return Boolean(row && row[kind]);
  }
  function rememberNotice(contractID, kind) {
    sentNotices[String(contractID)] = Object.assign({}, sentNotices[String(contractID)], { [kind]: new Date().toISOString() });
    try {
      nodeFs.writeFileSync(NOTICE_FILE, JSON.stringify(sentNotices));
    } catch (_error) {
      /* the mail is already out; a lost ledger line must not throw */
    }
  }
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const flights = new Map();
  try {
    const rawFlights = nodeFs.readFileSync(FLIGHT_FILE, "utf8");
    const parsedFlights = JSON.parse(rawFlights);
    for (const [key, value] of Object.entries(parsedFlights && parsedFlights.contracts || {})) {
      if (!value || typeof value !== "object") continue;
      if (!FLIGHT_STEPS.includes(String(value.step))) continue;
      if (!(num(value.characterID) > 0) || !(num(value.destinationStationID) > 0)) continue;
      flights.set(String(num(key)), Object.assign({}, value, { reposition: false }));
    }
  } catch (_error) {
    /* no saved flight yet */
  }
  const repositions = new Map();
  const attempted = new Set();

  const historyStore = living.createHistoryStore({ file: FLIGHT_HISTORY_FILE, now });

  const legStore = living.createLegStore({ file: FLIGHT_FILE, log });
  for (const [key, value] of legStore.load()) {
    flights.set(key, Object.assign({}, value, { reposition: false }));
  }

  function saveFlights() {
    for (const [key, value] of flights) {
      if (!value || value.reposition) continue;
      legStore.put(Object.assign({}, value, { legID: String(key) }));
    }
    legStore.save();
  }

  // Records something that really happened, in the courier's own words.
  function noteIncident(contractID, kind, detail) {
    historyStore.noteIncident(String(num(contractID)), kind, detail);
  }

  function noteDeparture(contractID) {
    historyStore.noteDeparture(String(num(contractID)));
  }

  function clockText(ms) {
    const value = num(ms);
    if (!(value > 0)) return "";
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + " UTC";
  }

  // Item rows come from the same store as characters: {key,json} with the bare
  // item ID as the key. itemStore.readItems() is not used here because it needs
  // the inventory service bootstrapped, and a read must never depend on that.
  function itemRow(itemID) {
    const id = num(itemID);
    if (!(id > 0) || !gameStore || typeof gameStore.read !== "function") return null;
    try {
      let row = gameStore.read("items", String(id));
      if (row && typeof row === "object" && !Array.isArray(row) && "success" in row) {
        if (row.success !== true) return null;
        row = row.data;
      }
      if (typeof row === "string") row = JSON.parse(row);
      return row && typeof row === "object" ? row : null;
    } catch (_error) {
      return null;
    }
  }

  // EveJS's native acceptCourier leaves the package in the courier's hangar at
  // the origin station, and completion requires it at the destination station.
  // So a courier must really load it into the hull and really hand it over:
  // both are ordinary inventory moves, never a flag flip.
  const CARGO_HOLD_FLAG = 5;
  const STATION_HANGAR_FLAG = 4;

  function movePackage(wrapID, locationID, flagID) {
    if (!itemStore || typeof itemStore.moveItemToLocation !== "function") {
      return { ok: false, detail: "itemStore.moveItemToLocation is unavailable" };
    }
    try {
      const moved = itemStore.moveItemToLocation(wrapID, locationID, flagID, null);
      if (moved && moved.success === false) {
        return { ok: false, detail: String(moved.errorMsg || "item move refused") };
      }
      return { ok: true, detail: "" };
    } catch (error) {
      return { ok: false, detail: String(error && error.message || error) };
    }
  }

  // Loads the contract package from the origin hangar into the courier's cargo
  // hold, so the ship does not fly empty.
  function loadPackageIntoShip(contract, identity) {
    const wrapID = num(contract && contract.plasticWrapItemID);
    const shipID = num(identity && identity.ship && identity.ship.itemID);
    if (!(wrapID > 0) || !(shipID > 0)) return { ok: false, detail: "no package or hull" };
    const row = itemRow(wrapID);
    if (!row) return { ok: false, detail: "package " + wrapID + " not found" };
    if (num(row.locationID) === shipID) return { ok: true, detail: "already loaded" };
    if (num(row.locationID) !== num(contract.startStationID)) {
      return { ok: false, detail: "package is not at the origin station" };
    }
    return movePackage(wrapID, shipID, CARGO_HOLD_FLAG);
  }

  // Hands the package over at the destination station. completeContract only
  // accepts a package that really sits there.
  function unloadPackageAtStation(contract, identity) {
    const wrapID = num(contract && contract.plasticWrapItemID);
    const stationID = num(contract && contract.endStationID);
    const shipID = num(identity && identity.ship && identity.ship.itemID);
    if (!(wrapID > 0) || !(stationID > 0)) return { ok: false, detail: "no package or station" };
    const row = itemRow(wrapID);
    if (!row) return { ok: false, detail: "package " + wrapID + " not found" };
    if (num(row.locationID) === stationID) return { ok: true, detail: "already at destination" };
    if (shipID > 0 && num(row.locationID) !== shipID) {
      return { ok: false, detail: "package is neither in the hull nor at the destination" };
    }
    return movePackage(wrapID, stationID, STATION_HANGAR_FLAG);
  }

  // Everything the issuer now owns at the destination station.
  function itemsAtStation(ownerID, stationID) {
    const rows = [];
    const seen = new Set();
    const walk = (value, depth) => {
      if (!value || depth > 4 || rows.length > 200) return;
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
      if (typeof value !== "object") return;
      if (value.itemID !== undefined && value.typeID !== undefined) {
        const id = num(value.itemID);
        if (!seen.has(id)) {
          seen.add(id);
          if (num(value.ownerID) === num(ownerID) && num(value.locationID) === num(stationID)) rows.push(value);
        }
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    try {
      let table = gameStore.read("items");
      if (table && table.success !== false && table.data !== undefined) table = table.data;
      if (typeof table === "string") table = JSON.parse(table);
      walk(table, 0);
    } catch (_error) {
      return rows;
    }
    return rows;
  }

  // A player docked at the destination must see the delivered cargo without a
  // relog: the native completion synced inventory to the courier identity, which
  // has no client, so the issuer's live session is told here.
  function pushDeliveredInventory(contract) {
    try {
      // Injected in tests; inside the server this is the live registry, which
      // only the server process itself can see (a separate node process has its
      // own empty registry, so a probe outside the process proves nothing).
      const registry = deps.sessionRegistry || require("../services/chat/sessionRegistry");
      const issuerID = num(contract && contract.issuerID);
      const session = registry && typeof registry.findSessionByCharacterID === "function"
        ? registry.findSessionByCharacterID(issuerID)
        : null;
      if (!session) return "no live issuer session";
      const rows = itemsAtStation(issuerID, num(contract.endStationID));
      if (!rows.length) return "nothing at the destination station";
      const characterState = deps.characterState || require("../services/character/characterState");
      if (!characterState || typeof characterState.emitItemsChangedBatchForSession !== "function") {
        return "characterState cannot emit item changes";
      }
      characterState.emitItemsChangedBatchForSession(session, rows.map((row) => ({ item: row })), {
        locationContext: null,
      });
      return "sent " + rows.length + " items";
    } catch (error) {
      return "failed: " + String(error && error.message || error);
    }
  }

  function characterRow(characterID) {
    try {
      if (!gameStore || typeof gameStore.read !== "function") return null;
      // The store keeps rows as {key,json}: the key is the bare character ID and
      // the value is a JSON string. Reading "/"+id (a path-style key) silently
      // returned nothing and every pilot looked like a non-identity.
      let row = gameStore.read("characters", String(characterID));
      if (!row) row = gameStore.read("characters", "/" + characterID);
      // gameStore.read returns { success, errorMsg, data }: the row lives in data.
      if (row && typeof row === "object" && !Array.isArray(row) && "success" in row) {
        if (row.success !== true) return null;
        row = row.data;
      }
      if (typeof row === "string") row = JSON.parse(row);
      if (!row || typeof row !== "object") return null;
      // The stored record has no characterID field: the row key is the ID.
      return Object.assign({ characterID }, row, { stationID: num(row.stationID || row.locationID) });
    } catch (_error) {
      return null;
    }
  }

  function identityFor(characterID) {
    const character = characterRow(characterID);
    if (!character || !(num(character.accountId) > 0)) return null;
    const shipID = num(character.shipID);
    const row = shipID ? itemRow(shipID) : null;
    const ship = row ? Object.assign({ itemID: shipID }, row) : null;
    return { character, ship, hullCapacityM3: num(ship && ship.capacity) };
  }

  function packageLocationID(contract) {
    const row = itemRow(num(contract && contract.plasticWrapItemID));
    return row ? num(row.locationID) : 0;
  }

  function sceneFor(systemID) {
    try {
      return typeof sceneForSystem === "function" ? sceneForSystem(systemID) : null;
    } catch (_error) {
      return null;
    }
  }

  function stationPosition(stationID) {
    try {
      const station = worldData && typeof worldData.getStationByID === "function"
        ? worldData.getStationByID(stationID)
        : null;
      const position = station && station.position;
      return position && Number.isFinite(num(position.x)) ? position : null;
    } catch (_error) {
      return null;
    }
  }

  // Real arrival proof: the native ship entity is in space and inside docking
  // range of the destination station. No position, no confirmation.
  function arrivalCheck(flight) {
    const scene = sceneFor(num(flight.systemID));
    if (!scene) return { ok: false, detail: "no scene for system " + num(flight.systemID) };
    if (typeof scene.getEntityByID !== "function") return { ok: false, detail: "scene has no getEntityByID" };
    const target = stationPosition(num(flight.destinationStationID));
    if (!target) return { ok: false, detail: "no station position for " + num(flight.destinationStationID) };
    const entity = scene.getEntityByID(num(flight.entityID));
    if (!entity) return { ok: false, detail: "no ship entity " + num(flight.entityID) + " in scene" };
    if (!entity.position) return { ok: false, detail: "ship entity has no position" };
    const metres = Math.round(distanceM(entity.position, target));
    return { ok: metres <= DOCKING_RANGE_M, detail: "distance " + metres + "m warpState " + String(entity.warpState || entity.mode || "") };
  }

  function pilotFor(contract) {
    const seen = [];
    for (const pilotID of pilots) {
      const identity = identityFor(pilotID);
      if (!identity) { seen.push(pilotID + ":NO_IDENTITY"); continue; }
      const decision = evaluateContract(contract, LIVE_POLICY, {
        walletIsk: num(identity.character.balance),
        hullCapacityM3: identity.hullCapacityM3,
      });
      if (decision.status === "ELIGIBLE") {
        // A courier can only fly the pickup it can actually reach. The native
        // gate path is for the DELIVERY leg; there is no cross-system pickup
        // flight, so a hull parked in another system is not a candidate (it used
        // to be picked and then stranded in space by a cross-system reposition).
        const startSystemID = num(contract && contract.startSolarSystemID);
        const courierSystemID = num(identity.character.solarSystemID);
        if (startSystemID > 0 && courierSystemID !== startSystemID) {
          seen.push(`${pilotID}:WRONG_SYSTEM:sys${courierSystemID}`);
          continue;
        }
        return { identity, decision };
      }
      seen.push(`${pilotID}:${decision.status}:own${num(identity.ship && identity.ship.ownerID)}/cap${identity.hullCapacityM3}/sys${num(identity.character.solarSystemID)}/st${num(identity.character.stationID)}`);
    }
    log(`[CoopCourier] contract ${num(contract && contract.contractID)} pilots ${seen.join(" ")}`);
    return null;
  }

  // A real courier is only where it really is. When the best hull is docked at
  // another station in the same system, it must FLY to the contract origin
  // before it may accept - no teleport, no faked station.
  function repositionFor(contract) {
    const origin = num(contract && contract.startStationID);
    const systemID = num(contract && contract.startSolarSystemID);
    const volume = num(contract && contract.volume);
    const collateral = num(contract && contract.collateral);
    if (!(origin > 0) || !(systemID > 0)) return null;
    for (const pilotID of pilots) {
      if (repositions.has(pilotID)) continue;
      const identity = identityFor(pilotID);
      if (!identity) continue;
      const { character, ship } = identity;
      if (!ship || num(ship.ownerID) !== num(character.characterID)) continue;
      if (num(ship.capacity) < volume || num(character.balance) < collateral) continue;
      if (num(character.solarSystemID) !== systemID) continue;
      const at = num(character.stationID);
      if (!(at > 0) || at === origin) continue;
      return { identity, at };
    }
    return null;
  }

  function stationName(stationID) {
    try {
      const station = worldData && typeof worldData.getStationByID === "function" ? worldData.getStationByID(stationID) : null;
      return String(station && station.stationName || stationID);
    } catch (_error) {
      return String(stationID);
    }
  }

  // The courier messages the issuer the same way a player would: a real native
  // EVEmail from its own character. Nothing is invented - the text only carries
  // real contract, station and hull facts.
  function notify(kind, contract, identity, extra) {
    if (!contract || !identity) return null;
    const characterID = num(identity.character.characterID);
    const issuerID = num(contract.issuerID);
    const built = notices.buildNotice(kind, Object.assign({
      pilotName: String(identity.character.characterName || "Courier"),
      contractID: num(contract.contractID),
      volumeM3: num(contract.volume),
      fromStationName: stationName(num(contract.startStationID)),
      toStationName: stationName(num(contract.endStationID)),
      reward: num(contract.reward),
    }, extra || {}));
    if (built.status !== "NOTICE") return built;
    if (noticeAlreadySent(num(contract.contractID), kind)) {
      log(`[CoopCourier] notice ${kind} already sent for ${num(contract.contractID)}, not repeating`);
      return built;
    }
    if (!sendMail || !(issuerID > 0) || !(characterID > 0)) {
      log(`[CoopCourier] notice ${kind} not sent (no mail authority) for ${num(contract.contractID)}`);
      return built;
    }
    try {
      sendMail({ senderID: characterID, toCharacterIDs: [issuerID], title: built.subject, body: built.body });
      rememberNotice(num(contract.contractID), kind);
      log(`[CoopCourier] notice ${kind} mailed to ${issuerID} for ${num(contract.contractID)}`);
    } catch (error) {
      log(`[CoopCourier] notice ${kind} failed ${String(error && error.message || error)}`);
    }
    return built;
  }

  // Reposition planning that also works when the ship is already in space: the
  // flight then starts at the warp step instead of a second undock.
  function planReposition(identity, target, systemID) {
    const characterID = num(identity.character.characterID);
    const shipID = num(identity.ship && identity.ship.itemID);
    if (!(characterID > 0) || !(shipID > 0) || !(target > 0)) return null;
    const stationID = num(identity.character.stationID);
    const inSpace = !(stationID > 0);
    return {
      contractID: characterID,
      characterID,
      shipItemID: shipID,
      originStationID: inSpace ? target : stationID,
      destinationStationID: target,
      step: "undock",
      stepStartedAtMs: now(),
      entityID: 0,
      reposition: true,
      systemID: num(systemID),
      identity,
    };
  }

  // A contract that is already IN_PROGRESS with our courier as the acceptor has
  // to be flown to the destination; without this the accepted cargo would sit in
  // the hangar forever after a restart.
  function resumeInProgress() {
    if (!contracts || typeof contracts.listContractRecords !== "function") return;
    for (const record of contracts.listContractRecords() || []) {
      const contractID = num(record && record.contractID);
      if (!(contractID > 0) || flights.has(contractID) || attempted.has(contractID)) continue;
      if (num(record.type) !== 3 || num(record.status) !== 1) continue;
      const pilotID = num(record.acceptorID);
      if (!pilots.includes(pilotID)) continue;
      const identity = identityFor(pilotID);
      if (!identity) continue;
      const pkg = itemRow(num(record.plasticWrapItemID));
      if (!pkg || num(pkg.ownerID) !== pilotID) continue;
      if (num(identity.character.stationID) !== num(record.startStationID)) {
        // The character row can lag behind the real hull after a recovery. The
        // hull is the physical truth: if it sits in the origin station hangar,
        // the courier is docked there and the row is repaired, not repositioned.
        const hull = identity.ship || {};
        const hullDockedAtOrigin =
          num(hull.locationID) === num(record.startStationID) && num(hull.flagID) === 4;
        if (!hullDockedAtOrigin) {
          if (!repositions.has(pilotID)) {
            const move = planReposition(identity, num(record.startStationID), record.startSolarSystemID);
            if (move) {
              repositions.set(pilotID, move);
              log(`[CoopCourier] courier ${pilotID} returning to origin ${move.destinationStationID} for contract ${contractID}`);
            noteIncident(contractID, "origin-return", "courier was not at the origin station");
            }
          }
          continue;
        }
        const repaired = Object.assign({}, identity.character, { stationID: num(record.startStationID) });
        delete repaired.characterID;
        gameStore.write("characters", String(pilotID), repaired);
        if (typeof gameStore.flushTableSync === "function") gameStore.flushTableSync("characters");
        identity.character.stationID = num(record.startStationID);
        log(`[CoopCourier] courier ${pilotID} hull is docked at origin ${num(record.startStationID)}, station record repaired`);
        noteIncident(contractID, "station-repair", "character station record lagged behind the hull");
      }
      const planned = flightCore.createFlight({ contract: record, identity, nowMs: now() });
      if (planned.status !== "FLIGHT_PLANNED") {
        log(`[CoopCourier] contract ${contractID} resume ${planned.status} ${planned.reason || ""}`.trim());
        continue;
      }
      flights.set(contractID, Object.assign({}, planned, {
        systemID: num(record.startSolarSystemID),
        destinationSystemID: num(record.endSolarSystemID),
        identity,
      }));
      attempted.add(contractID);
      log(`[CoopCourier] contract ${contractID} resumed in progress by ${pilotID}, flying to ${num(record.endStationID)}`);
    }
  }

  function startFlights() {
    if (!contracts || typeof contracts.listContractRecords !== "function") return;
    for (const record of contracts.listContractRecords() || []) {
      const contractID = num(record && record.contractID);
      if (!(contractID > 0) || attempted.has(contractID) || flights.has(contractID)) continue;
      if (num(record.type) !== 3 || num(record.status) !== 0) continue;
      const picked = pilotFor(record);
      if (!picked) {
        const move = repositionFor(record);
        if (move) {
          const planned = flightCore.createFlight({
            contract: { contractID: num(move.identity.character.characterID), startStationID: move.at, endStationID: num(record.startStationID) },
            identity: move.identity,
            nowMs: now(),
          });
          if (planned.status === "FLIGHT_PLANNED") {
            repositions.set(num(move.identity.character.characterID), Object.assign({}, planned, {
              reposition: true,
              systemID: num(record.startSolarSystemID),
              identity: move.identity,
            }));
            log(`[CoopCourier] courier ${move.identity.character.characterID} repositioning ${move.at} -> ${num(record.startStationID)}`);
            continue;
          }
        }
        log(`[CoopCourier] contract ${contractID} no eligible courier yet`);
        continue;
      }
      // evaluateContract only judges hull and funds; the courier still has to be
      // physically docked at the origin. Fly it there first instead of refusing.
      if (num(picked.identity.character.stationID) !== num(record.startStationID)) {
        const pilotID = num(picked.identity.character.characterID);
        if (!repositions.has(pilotID)) {
          const move = planReposition(picked.identity, num(record.startStationID), record.startSolarSystemID);
          if (move) {
            repositions.set(pilotID, move);
            log(`[CoopCourier] courier ${pilotID} repositioning ${move.originStationID} -> ${move.destinationStationID} from ${move.step}`);
          } else {
            log(`[CoopCourier] contract ${contractID} reposition NO_FLIGHT`);
          }
        }
        continue;
      }
      // A hull that sits at the origin but lost its hangar flag is repaired in
      // place: an interrupted native transition is the only way that happens.
      const rawShip = itemRow(num(picked.identity.ship && picked.identity.ship.itemID));
      if (rawShip && num(rawShip.locationID) === num(record.startStationID) && num(rawShip.flagID) !== 4) {
        gameStore.write("items", String(num(picked.identity.ship.itemID)), Object.assign({}, rawShip, { flagID: 4 }));
        if (typeof gameStore.flushTableSync === "function") gameStore.flushTableSync("items");
        log(`[CoopCourier] hull ${num(picked.identity.ship.itemID)} hangar flag repaired`);
      }
      const at = packageLocationID(record);
      const accepted = bridge.accept({
        contract: record,
        identity: picked.identity,
        packageLocationID: at,
        packageOwnerID: num(itemRow(record.plasticWrapItemID)?.ownerID),
        runtime: contracts,
      });
      // Only a real accept (or a doubtful native result) is remembered: a clean
      // refusal is retried after the state it complained about has been repaired.
      if (accepted.status === "ACCEPTED" || accepted.status === "AMBIGUOUS") attempted.add(contractID);
      if (accepted.status !== "ACCEPTED") {
        log(`[CoopCourier] contract ${contractID} accept ${accepted.status} ${accepted.plan || ""} ${accepted.reason || ""}`.trim());
        continue;
      }
      const planned = flightCore.createFlight({ contract: record, identity: picked.identity, nowMs: now() });
      if (planned.status !== "FLIGHT_PLANNED") {
        log(`[CoopCourier] contract ${contractID} accepted but ${planned.status} ${planned.reason || ""}`.trim());
        continue;
      }
      const flight = Object.assign({}, planned, {
        systemID: num(record.startSolarSystemID),
        destinationSystemID: num(record.endSolarSystemID),
        identity: picked.identity,
      });
      flights.set(contractID, flight);
      log(`[CoopCourier] contract ${contractID} ACCEPTED by ${picked.identity.character.characterID}, flight planned`);
      notify("accepted", record, picked.identity);
    }
  }

  // A real station of the system the hull is actually sitting in. A dock repair
  // must never move the ship into another system: that would fake a gate jump.
  function stationInSystem(systemID, preferredID) {
    try {
      const stations = typeof worldData.getStationsForSystem === "function"
        ? worldData.getStationsForSystem(num(systemID))
        : [];
      const ids = (stations || []).map((station) => num(station && station.stationID)).filter((id) => id > 0);
      if (num(preferredID) > 0 && ids.includes(num(preferredID))) return num(preferredID);
      return ids.length ? ids[0] : 0;
    } catch (_error) {
      return 0;
    }
  }

  // A native undock that already moved the real ship leaves it in space with no
  // station. Retrying "undock" would refuse forever, so a ship that is really in
  // the scene continues from the warp step with its real entity.
  function recoverInSpace(flight) {
    // A hop that has already issued the stock stargate jump detaches the ship
    // from the source scene until the native handoff finishes. That is not a
    // lost ship, so nothing may be repaired during it.
    if (flight.hop && (flight.hop.phase === "jump" || flight.hop.phase === "verify-jump")) return flight;
    const scene = sceneFor(num(flight.systemID));
    if (!scene || typeof scene.getEntityByID !== "function") return flight;
    const shipID = num(flight.shipItemID);
    const entity = scene.getEntityByID(shipID);
    if (entity) {
      // Only the undock step needs the shortcut: every other step is already
      // flying with a live entity.
      if (flight.step !== "undock") return flight;
      return Object.assign({}, flight, {
        step: "warp",
        entityID: num(entity.entityID) || shipID,
        stepStartedAtMs: now(),
        recoveredInSpace: true,
        missingSinceMs: 0,
      });
    }
    // No live entity: the ship is a leftover from a previous process (undocked,
    // then the server restarted). Dock it back at a REAL station of its own
    // system with the stock dockSession rather than inventing a position, a warp
    // or a system change. A short grace window absorbs the normal gap between a
    // native undock/jump and the moment the scene exposes the new entity.
    const missingSince = num(flight.missingSinceMs);
    if (!(missingSince > 0)) return Object.assign({}, flight, { missingSinceMs: now() });
    if (now() - missingSince < SCENE_ENTITY_GRACE_MS) return flight;
    const identity = identityFor(num(flight.characterID));
    if (!identity || num(identity.character.stationID)) return flight;
    const dockAt = stationInSystem(num(flight.systemID), num(flight.destinationStationID));
    if (!(dockAt > 0)) return flight;
    const session = driver.buildCourierSession(identity.character, dockAt);
    if (!session || !transitions || typeof transitions.dockSession !== "function") return flight;
    try {
      const outcome = transitions.dockSession(session, dockAt);
      if (outcome && outcome.success === true) {
        return Object.assign({}, flight, { dockedFromSpace: true, dockStationID: dockAt, stepStartedAtMs: now() });
      }
      if (outcome && String(outcome.errorMsg || "") === "ALREADY_DOCKED") {
        // The native layer says docked, but the stored row lost its station when
        // the interrupted undock threw. Repair the location through the store -
        // never by pretending a flight happened.
        const id = num(identity.character.characterID);
        const row = Object.assign({}, identity.character, { stationID: dockAt });
        delete row.characterID;
        gameStore.write("characters", String(id), row);
        if (typeof gameStore.flushTableSync === "function") gameStore.flushTableSync("characters");
        // The same interrupted undock left the hull pointing at the solar system.
        // A docked ship must be in a station hangar, so repair that too.
        const shipRow = itemRow(flight.shipItemID);
        if (shipRow) {
          const fixed = Object.assign({}, shipRow, { locationID: dockAt, flagID: 4 });
          gameStore.write("items", String(num(flight.shipItemID)), fixed);
          if (typeof gameStore.flushTableSync === "function") gameStore.flushTableSync("items");
        }
        log(`[CoopCourier] courier ${id} station and hull repaired to ${dockAt} (native ALREADY_DOCKED)`);
        return Object.assign({}, flight, { dockedFromSpace: true, dockStationID: dockAt, stepStartedAtMs: now() });
      }
      log(`[CoopCourier] courier ${flight.characterID} dock-from-space refused ${String(outcome && outcome.errorMsg || "no result")}`);
    } catch (error) {
      log(`[CoopCourier] courier ${flight.characterID} dock-from-space failed ${String(error && error.message || error)}`);
    }
    return flight;
  }

  function stepFlight(contractID, flight) {
    // A flight whose hull has no live scene entity can never make progress. This
    // is not only an undock case: a server restart while the ship was flying
    // leaves it in space with no entity, and the old code re-warped forever.
    const recovering = identityFor(num(flight.characterID));
    const inSpace = recovering && !num(recovering.character.stationID);
    if (inSpace && flight.step !== "done" && flight.step !== "failed") {
      const recovered = recoverInSpace(flight);
      if (recovered.recoveredInSpace) {
        log(`[CoopCourier] courier ${flight.characterID} already in space, resuming from warp`);
        flight = recovered;
        if (flight.reposition) repositions.set(num(flight.characterID), flight);
        else flights.set(contractID, flight);
      } else if (recovered.dockedFromSpace) {
        // The ship really is in space in that system and the scene lost it. It
        // is docked back at a real station of the SAME system and the leg is
        // re-planned; no delivery is ever invented from this.
        const station = num(recovered.dockStationID);
        log(`[CoopCourier] courier ${flight.characterID} lost scene entity, docked back at real station ${station} in system ${num(flight.systemID)}`);
        if (flight.reposition) {
          repositions.delete(num(flight.characterID));
        } else {
          noteIncident(contractID, "scene-entity-lost", "docked back at station " + station);
          flights.delete(contractID);
          attempted.delete(contractID);
        }
        return;
      } else if (num(recovered.missingSinceMs) > 0 && !num(flight.missingSinceMs)) {
        // First sighting of a missing entity: remember when, and give the native
        // transition its grace window before anything is repaired.
        const stamped = Object.assign({}, flight, { missingSinceMs: num(recovered.missingSinceMs) });
        if (flight.reposition) repositions.set(num(flight.characterID), stamped);
        else flights.set(contractID, stamped);
        return;
      }
    }
    const action = flightCore.nextAction(flight, now());
    if (action.status === "FLIGHT_DONE") {
      if (flight.reposition) {
        repositions.delete(num(flight.characterID));
        log(`[CoopCourier] courier ${flight.characterID} repositioned to ${flight.destinationStationID}`);
        return;
      }
      const live = contracts.getContractRecord(contractID);
      const identity = identityFor(num(flight.characterID)) || flight.identity;
      const done = bridge.complete({
        contract: live,
        identity,
        packageLocationID: packageLocationID(live),
        runtime: contracts,
      });
      if (done.status === "COMPLETED") {
        const durationMs = historyStore.durationMs(String(contractID));
        log(`[CoopCourier] contract ${contractID} DELIVERED by ${flight.characterID} in ${notices.durationText(durationMs)}`);
        const pushed = pushDeliveredInventory(live);
        log(`[CoopCourier] contract ${contractID} issuer inventory: ${pushed}`);
        notify("delivered", live, identity, {
          durationMs,
          departedClockText: clockText(historyStore.departedAtMs(String(contractID))),
          incidents: historyStore.incidents(String(contractID)),
        });
        historyStore.forget(String(contractID));
        flights.delete(contractID);
        saveFlights();
      } else {
        log(`[CoopCourier] contract ${contractID} complete ${done.status} ${done.reason || ""}`.trim());
        noteIncident(contractID, "settle-failed", done.reason || done.status);
      }
      return;
    }
    if (action.status !== "ACTION") {
      log(`[CoopCourier] contract ${contractID} flight ${action.status} ${action.step || ""}`.trim());
      return;
    }
    const identity = identityFor(num(flight.characterID));
    if (!identity) return;
    // A courier that flies empty can never complete, so the real package is
    // loaded into the hull before the undock and handed over after the dock.
    if (flight.step === "undock" && !flight.reposition) {
      const loaded = loadPackageIntoShip(contracts.getContractRecord(contractID), identity);
      if (!loaded.ok) {
        log(`[CoopCourier] contract ${contractID} package not loaded: ${loaded.detail}`);
        noteIncident(contractID, "cargo-load", loaded.detail);
        return;
      }
      if (loaded.detail === "already loaded") log(`[CoopCourier] contract ${contractID} package already in the hull`);
    }
    const target = stationPosition(num(flight.destinationStationID));
    const arrival = flight.step === "arrive" ? arrivalCheck(flight) : { ok: false, detail: "" };
    const ctx = {
      character: identity.character,
      transitions,
      space,
      sceneForSystem: typeof deps.sceneForSystem === "function" ? deps.sceneForSystem : null,
      session: motion.agentSessionFor(identity.character),

      warpIngressMs: 30000,
      arrivalConfirmed: flight.step === "arrive" ? arrival.ok : false,
    };
    if (flight.step === "arrive" && !arrival.ok) {
      log(`[CoopCourier] courier ${flight.characterID} arrival pending: ${arrival.detail}`);
      // The first warp of a flight can be a no-op when it was issued without a
      // session. Re-issue it natively (throttled) instead of waiting forever.
      const last = num(flight.rewarpAtMs);
      if (!last || now() - last > 60000) {
        const warped = driver.warp(ctx, flight, target);
        log(`[CoopCourier] courier ${flight.characterID} re-warp ${warped.status} ${warped.reason || ""}`.trim());
        noteIncident(contractID, "rewarp", warped.reason || warped.status);
        flights.set(contractID, Object.assign({}, flight, { rewarpAtMs: now() }));
      }
      return;
    }
    // A cross-system delivery is a real gate flight: warp to the reciprocal
    // gate, native jumpSessionViaStargate, verify the same ship in the
    // destination scene, then warp to the destination station. The pure flight
    // machine only ever sees the result of that hop, and the plain warp is never
    // issued towards a station in another system.
    if (flight.step === "warp" && num(flight.destinationSystemID) > 0 &&
        num(flight.destinationSystemID) !== num(flight.systemID)) {
      const hopLabel = flight.reposition ? `courier ${flight.characterID} reposition` : `contract ${contractID}`;
      const hop = gateHop.advance({
        flight,
        ctx,
        session: ctx.session,
        transitions,
        sceneFor,
        stationPosition: target,
        nowMs: now(),
        fromSystemID: num(flight.systemID),
        toSystemID: num(flight.destinationSystemID),
        getStargatesForSystem: (id) => worldData.getStargatesForSystem(id),
        getGate: (id) => worldData.getStargateByID(id),
        dockingRangeM: DOCKING_RANGE_M,
      });
      const hopReason = String(hop.reason || hop.status);
      if (hop.status === "OK") {
        const arrived = flightCore.advanceFlight(flight, "OK", now(), flightCore.stepToken(flight));
        const moved = Object.assign({}, arrived, {
          systemID: num(hop.systemID) || num(flight.destinationSystemID),
          entityID: num(hop.entityID) || num(flight.shipItemID),
          hop: null,
          hopReason: "",
          stepStartedAtMs: now(),
        });
        if (flight.reposition) repositions.set(num(flight.characterID), moved);
        else flights.set(contractID, moved);
        log(`[CoopCourier] ${hopLabel} native gate hop verified ${num(flight.systemID)} -> ${num(moved.systemID)}, warp -> arrive`);
        return;
      }
      if (hop.status === "FAILED") {
        log(`[CoopCourier] ${hopLabel} gate hop FAILED ${hopReason}`);
        if (!flight.reposition) noteIncident(contractID, "gate-hop", hopReason);
        const failed = Object.assign({}, flight, { step: "failed", hop: null, hopReason, stepStartedAtMs: now() });
        if (flight.reposition) repositions.delete(num(flight.characterID));
        else flights.set(contractID, failed);
        return;
      }
      const progressed = hopReason !== String(flight.hopReason || "");
      // A verified jump really moved the hull: record the destination system on the flight, otherwise the
      // recovery path still thinks it is in the origin system and docks the courier back home (live run
      // 2026-10-30 21:5x: "lost scene entity, docked back ... in system 30000142" after a verified jump
      // to Perimeter).
      const verifiedSystemID = Math.max(0, num(hop.verified && hop.verified.toSystemID));
      const pending = Object.assign({}, flight, {
        hop: hop.state || flight.hop,
        hopReason,
        entityID: num(flight.entityID) || num(flight.shipItemID),
        stepStartedAtMs: progressed ? now() : num(flight.stepStartedAtMs),
      }, verifiedSystemID > 0 && verifiedSystemID !== num(flight.systemID)
        ? { systemID: verifiedSystemID, missingSinceMs: 0 }
        : {});
      if (flight.reposition) repositions.set(num(flight.characterID), pending);
      else flights.set(contractID, pending);
      if (progressed) log(`[CoopCourier] ${hopLabel} gate hop ${hopReason}`);
      return;
    }
    const observed = driver.runStep(ctx, flight, target);
    if (flight.step === "dock" && observed.status === driver.OK && !flight.reposition) {
      const handedOver = unloadPackageAtStation(contracts.getContractRecord(contractID), identity);
      log(
        handedOver.ok
          ? `[CoopCourier] contract ${contractID} package handed over at ${num(flight.destinationStationID)}`
          : `[CoopCourier] contract ${contractID} package not handed over: ${handedOver.detail}`,
      );
      if (!handedOver.ok) noteIncident(contractID, "handover-failed", handedOver.detail);
    }
    const token = flightCore.stepToken(flight);
    const next = flightCore.advanceFlight(flight, observed.status, now(), token);
    const withEntity = Object.assign({}, next, {
      entityID: num(observed.entityID) || num(flight.entityID),
      identity: flight.identity,
      systemID: flight.systemID,
    });
    if (flight.reposition) repositions.set(num(flight.characterID), withEntity);
    else flights.set(contractID, withEntity);
    const label = flight.reposition ? `courier ${flight.characterID} reposition` : `contract ${contractID}`;
    if (observed.status !== driver.OK) {
      log(`[CoopCourier] ${label} ${flight.step} ${observed.status} ${observed.reason || ""}`.trim());
      if (!flight.reposition) noteIncident(contractID, flight.step + "-failed", observed.reason || observed.status);
    } else {
      log(`[CoopCourier] ${label} ${flight.step} OK -> ${withEntity.step}`);
      if (flight.step === "undock" && !flight.reposition) {
        noteDeparture(contractID);
        notify("departing", contracts.getContractRecord(contractID), identity);
      }
    }
    // A leg that failed must not sit in memory and block the resume scan: the
    // courier is repaired to the origin, so the next tick re-plans a real leg.
    if (!flight.reposition && withEntity.step === "failed") {
      flights.delete(contractID);
      // The resume scan refuses contracts it already planned once, so clearing
      // the leg alone would strand the courier at the origin forever.
      attempted.delete(contractID);
      log(`[CoopCourier] contract ${contractID} leg failed at ${flight.step}, will re-plan from the origin`);
    }
  }

  // A restart can leave a courier hull in space with no scene entity and no
  // flight to repair it (the in-memory leg is gone). Give it the same grace
  // window, then dock it back at a real station of its own system.
  const strandedSince = new Map();
  function repairStrandedPilots() {
    const flying = new Set([...flights.values()].map((entry) => num(entry && entry.characterID)));
    for (const pilotID of pilots) {
      const id = num(pilotID);
      if (!(id > 0)) continue;
      if (flying.has(id) || repositions.has(id)) { strandedSince.delete(id); continue; }
      const identity = identityFor(id);
      if (!identity || num(identity.character.stationID)) { strandedSince.delete(id); continue; }
      const shipID = num(identity.ship && identity.ship.itemID);
      const systemID = num(identity.character.solarSystemID);
      if (!(shipID > 0) || !(systemID > 0)) continue;
      const scene = sceneFor(systemID);
      if (scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(shipID)) {
        strandedSince.delete(id);
        continue;
      }
      const since = num(strandedSince.get(id));
      if (!(since > 0)) { strandedSince.set(id, now()); continue; }
      if (now() - since < SCENE_ENTITY_GRACE_MS) continue;
      const repaired = recoverInSpace({
        characterID: id,
        shipItemID: shipID,
        systemID,
        step: "undock",
        missingSinceMs: 1,
      });
      if (repaired.dockedFromSpace) {
        strandedSince.delete(id);
        log(`[CoopCourier] courier ${id} stranded after a restart, docked back at real station ${num(repaired.dockStationID)} in system ${systemID}`);
      }
    }
  }

  function tick() {
    repairStrandedPilots();
    startFlights();
    resumeInProgress();
    for (const [contractID, flight] of [...flights]) {
      try {
        stepFlight(contractID, flight);
      } catch (error) {
        log(`[CoopCourier] contract ${contractID} step failed ${String(error && error.message || error)}`);
      }
    }
    for (const [pilotID, flight] of [...repositions]) {
      try {
        stepFlight(pilotID, flight);
      } catch (error) {
        log(`[CoopCourier] courier ${pilotID} reposition failed ${String(error && error.message || error)}`);
      }
    }
    // Persist whatever the steps changed, so a restart resumes this exact leg.
    saveFlights();
  }

  return {
    tick,
    // Exposed so the issuer-notification path can be tested without a flight.
    pushIssuerInventory: (contract) => pushDeliveredInventory(contract),
    itemsAtStation,
    flights: () => [...flights.values()],
    attempted: () => [...attempted],
    LIVE_POLICY,
    DOCKING_RANGE_M,
  };
}

module.exports = { createCourierDispatch, LIVE_POLICY, DOCKING_RANGE_M };
