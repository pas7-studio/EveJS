"use strict";
// FW-005C: pay a real war bounty out of a HELD escrow.
//
// A bounty can only leave a chest that really exists: the reservation must be
// HELD, the campaign must be the one the reservation was taken for, and the
// event that releases it must be a real native result (a strictly proven kill or
// a recorded casualty of that campaign). The value then moves from the escrow
// into the pilot's real earned balance - never from thin air.
const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
// FW-057: same predicate as the merit ledger - a player who really killed earns too.
const { isWarPilotID } = require("./coopWarPilotID" + (typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs"));
const pilotOf = (value) => (isWarPilotID(value) ? value : "");
const key = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);

const TREASURY_KEY = "coop-faction-war\u001ftreasury-v1";
const CASUALTY_KEY = "coop-faction-war\u001fcasualties-v1";

// Which faction does this pilot really belong to, from the identity links and
// the real corporation -> faction table? No guess, no default.
function factionOfPilot({pilotID, links = [], getNativeEntity, getFactionForCorporation}) {
  const id = pilotOf(pilotID);
  if (!id || typeof getNativeEntity !== "function" ||
      typeof getFactionForCorporation !== "function") return 0;
  for (const link of Array.isArray(links) ? links : []) {
    if (link?.pilotID !== id) continue;
    try {
      const native = getNativeEntity(num(link.entityID));
      if (!pos(native?.corporationID)) continue;
      const faction = num(getFactionForCorporation(native.corporationID));
      if (pos(faction)) return faction;
    } catch (_error) { /* one bad link never decides a faction */ }
  }
  return 0;
}

// FW-104: a kill the merit ledger accepts must know its faction and its campaign.
// MEASURED on the play stack 2026-10-30 22:33:15.180Z: coop-pilot-013 earned merit for a
// real warship kill and the bounty was refused with BOUNTY_PILOT_FACTION_UNKNOWN because
// its identity link no longer resolved a live native corporation - the same hull was
// released as a confirmed wreck three seconds later. The war fleet registry already holds
// that pilot's proven faction and campaign (both verified at ASSIGN), so it is the honest
// fallback: no guessed hull, and a released identity no longer makes a real kill unpayable.
function createWarBounty({gameStore, treasury, chest, readWarState, readLinks,
  getNativeEntity, getFactionForCorporation, readCasualties = () => null,
  readCampaignForEntity = null, readFleet = () => null,
  emit = null, clock = () => Date.now(), env = process.env} = {}) {
  if (typeof treasury?.execute !== "function" ||
      typeof chest?.creditPilot !== "function" ||
      typeof readWarState !== "function" || typeof readLinks !== "function" ||
      typeof getNativeEntity !== "function" ||
      typeof getFactionForCorporation !== "function")
    throw Error("WAR_BOUNTY_AUTHORITIES_REQUIRED");
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_WAR_TREASURY === "1" && env.EVEJS_COOP_NATIVE_ATOMIC_ROWS === "1";
  let busy = false;

  // The campaign a real casualty really belongs to. A caller-supplied campaign
  // is only accepted when the durable casualty row agrees.
  // FW-078: the casualty ledger is written by the WAR phase, but the bounty is decided
  // inside the native destruction callback - so at that moment the wreck has no casualty
  // row yet and the payer answered NO_REAL_CAMPAIGN_FOR_EVENT. Measured 14:47:30Z: a real
  // attributed kill (merit PROMOTED for coop-pilot-007) could not be paid, and the same
  // wreck only appeared in the ledger seconds later.
  // The war FLEET registry is the authority that bound that exact hull to that exact
  // campaign, so it answers immediately. The casualty row still wins when it exists.
  function campaignFor({wreckID, campaignID, victimEntityID}) {
    let casualty = null;
    try {
      const row = readCasualties();
      casualty = row?.byWreck?.[String(num(wreckID))] || null;
    } catch (_error) { casualty = null; }
    if (key(campaignID)) {
      if (casualty && String(casualty.campaignID) !== String(campaignID)) return null;
      return String(campaignID);
    }
    if (casualty && key(casualty.campaignID)) return String(casualty.campaignID);
    // No ledger row yet: ask which campaign the victim's own hull was mobilised for.
    try {
      const bound = typeof readCampaignForEntity === "function"
        ? readCampaignForEntity(num(victimEntityID)) : null;
      if (bound && key(bound.campaignID)) return String(bound.campaignID);
    } catch (_error) { /* a missing registry answer is simply no campaign */ }
    return null;
  }

  function reservationFor({campaignID, factionID}) {
    let reservations = {};
    try { reservations = treasury.snapshot()?.reservations || {}; }
    catch (_error) { reservations = {}; }
    return Object.values(reservations).find((row) =>
      row?.campaignID === campaignID && Number(row.factionID) === Number(factionID) &&
      row.status === "HELD") || null;
  }
  // FW-090: a replay of a kill that was already paid must SAY so. Measured: the second
  // call answered NO_HELD_ESCROW_FOR_FACTION, which reads like "this war has no money"
  // although the money went out on the first call - exactly the ambiguity that cost a day.
  function alreadyPaidFor({campaignID, factionID, proofID, pilotID}) {
    let reservations = {};
    try { reservations = treasury.snapshot()?.reservations || {}; }
    catch (_error) { reservations = {}; }
    return Object.values(reservations).find((row) =>
      row?.campaignID === campaignID && Number(row.factionID) === Number(factionID) &&
      row.status === "PAID" && String(row.payoutProofID || "") === String(proofID || "") &&
      String(row.paidToPilotID || "") === String(pilotID || "")) || null;
  }

  // kind is the real merit event that pays; the escrow authorizer below decides
  // whether this exact event may release value.
  function pay({pilotID, kind, wreckID = 0, campaignID = "", proofID = "",
    victimPilotID = "", victimEntityID = 0} = {}) {
    if (!enabled()) return {status: "DISABLED"};
    if (busy) return {status: "BLOCKED", reason: "WAR_BOUNTY_REENTRANT"};
    const pilot = pilotOf(pilotID);
    if (!pilot) return {status: "BLOCKED", reason: "INVALID_BOUNTY_PILOT"};
    // The pilot's own registry row proves which faction and campaign it was mobilised
    // for, even after its identity link was released with the confirmed wreck.
    let ownRow = null;
    try {
      const rows = readFleet()?.ships || {};
      ownRow = Object.values(rows).find((row) => row && String(row.pilotID) === pilot) || null;
    } catch (_error) { ownRow = null; }
    const campaign = campaignFor({wreckID, campaignID, victimEntityID}) ||
      String((ownRow && ownRow.campaignID) || "");
    if (!campaign) return {status: "BLOCKED", reason: "NO_REAL_CAMPAIGN_FOR_EVENT"};
    let warState = null;
    try { warState = readWarState(); } catch (_error) { warState = null; }
    const record = warState?.campaigns?.[campaign];
    if (!record) return {status: "BLOCKED", reason: "WAR_CAMPAIGN_NOT_PERSISTED"};
    let links = [];
    try { links = readLinks() || []; } catch (_error) { links = []; }
    let factionID = factionOfPilot({pilotID: pilot, links,
      getNativeEntity, getFactionForCorporation});
    if (!pos(factionID) && ownRow) factionID = num(ownRow.factionID);
    if (!pos(factionID)) return {status: "BLOCKED", reason: "BOUNTY_PILOT_FACTION_UNKNOWN"};
    const reservation = reservationFor({campaignID: campaign, factionID});
    if (!reservation) {
      const proofAlreadyPaid = key(proofID) ? proofID : String(kind || "event") + ":" + campaign;
      const settled = alreadyPaidFor({campaignID: campaign, factionID,
        proofID: proofAlreadyPaid, pilotID: pilot});
      if (settled) return {status: "ALREADY_PAID", pilotID: pilot, factionID,
        campaignID: campaign, amountCents: Number(settled.cents) || 0,
        reservationID: settled.reservationID, proofID: proofAlreadyPaid,
        evidence: "THIS_EXACT_KILL_WAS_ALREADY_SETTLED"};
      return {status: "BLOCKED", reason: "NO_HELD_ESCROW_FOR_FACTION",
        pilotID: pilot, factionID, campaignID: campaign};
    }
    busy = true;
    try {
      const proof = key(proofID) ? proofID : String(kind || "event") + ":" + campaign;
      const paid = treasury.execute({type: "PAYOUT",
        eventID: "fw:bounty:" + campaign + ":" + proof,
        reservationID: reservation.reservationID,
        corporationID: reservation.corporationID, proofID: proof, pilotID: pilot});
      if (paid.status !== "APPLIED" && paid.status !== "DUPLICATE")
        return {status: "BLOCKED", reason: String(paid.reason || paid.status),
          pilotID: pilot, factionID, campaignID: campaign};
      const receipt = paid.receipt || {};
      const credited = chest.creditPilot({pilotID: pilot,
        cents: Number(receipt.amountCents) || 0,
        eventID: "war-bounty:" + campaign + ":" + proof,
        reason: "war bounty " + String(kind || "") + " " + campaign});
      const status = credited.status === "APPLIED" ? "PAID" :
        credited.status === "DUPLICATE" ? "ALREADY_PAID" : "ESCROW_RELEASED_NOT_CREDITED";
      const detail = {status, pilotID: pilot, factionID,
        campaignID: campaign, kind: String(kind || ""),
        amountCents: Number(receipt.amountCents) || 0,
        escrowJournalID: Number(receipt.escrowJournalID) || 0,
        reservationID: reservation.reservationID, proofID: proof,
        wreckID: num(wreckID) || 0,
        creditStatus: String(credited.status || ""),
        earnedBefore: Number(credited.receipt?.before) || 0,
        earnedAfter: Number(credited.receipt?.after) || 0,
        evidence: "HELD_NATIVE_ESCROW_TO_REAL_EARNED_BALANCE"};
      if (typeof emit === "function") {
        try { emit("living-native-war-bounty", detail); } catch (_error) { /* probe */ }
      }
      return detail;
    } finally { busy = false; }
  }

  return Object.freeze({pay});
}

module.exports = {TREASURY_KEY, CASUALTY_KEY, factionOfPilot, createWarBounty};
