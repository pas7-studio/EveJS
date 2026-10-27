"use strict";
// Session-less bridge that lets a seeded courier CHARACTER act on a native
// courier contract. The upstream API is acceptContract(contractID, session,
// acceptForCorp) and completeContract(contractID, targetStatus, session); both
// resolve the actor from the session object, and nothing else about a client is
// required:
//   - getSessionCharacterID reads characterID/charid,
//   - getSessionCorporationID reads corporationID/corpid,
//   - syncInventoryChangesToSession returns early when session.sendNotification
//     is not a function, so no client update is attempted and nothing throws.
//
// This module never invents ISK or items: it calls the native functions with a
// real character's identity, so the wallet escrow, the package transfer and the
// completion checks are the stock ones.
//
// Everything is fail-closed: a chain is only started when planSettlement says it
// can be finished, and an ambiguous error is reported, never retried.
// Loaded as .cjs in the repo and as .js inside the server.
const EXT = (typeof __filename === "string" && __filename.endsWith(".js")) ? "" : ".cjs";
const { planSettlement, isCourierContract } = require("./coopCourierDispatch" + EXT);

// Mirrors contractRuntimeState.CONTRACT_STATUS: OUTSTANDING 0, IN_PROGRESS 1,
// FINISHED 4 (5 is CANCELLED - getting this wrong would cancel the contract).
const FINISHED = 4;
const OUTSTANDING = 0;
const IN_PROGRESS = 1;

function buildNpcSession(character) {
  // The stored record has no characterID field; the ID is the row key.
  const characterID = Number(character && (character.characterID || character.id)) || 0;
  if (!character || !(characterID > 0) || !(Number(character.accountId) > 0)) {
    return null;
  }
  return {
    // Identity only. No sendNotification on purpose: an NPC has no client.
    charid: characterID,
    characterID,
    userid: Number(character.accountId),
    corpid: Number(character.corporationID) || 0,
    corporationID: Number(character.corporationID) || 0,
    allianceid: Number(character.allianceID) || 0,
    isNpcCourier: true,
    // No client to notify; the native contract calls only need identity.
    sendSessionChange() { return undefined; },
  };
}

function refusal(reason, extra) {
  // Extra fields must never be able to overwrite the status: passing
  // {status: live.status} used to replace "REFUSED" with the contract status.
  return Object.assign({}, extra || {}, { status: "REFUSED", reason });
}

// runtime: { acceptContract, completeContract, getContractRecord }
function accept({ contract, identity, packageLocationID, packageOwnerID, runtime }) {
  if (!runtime || typeof runtime.acceptContract !== "function" || typeof runtime.getContractRecord !== "function") {
    return refusal("runtime does not expose acceptContract/getContractRecord");
  }
  const plan = planSettlement(contract, identity, packageLocationID, { packageOwnerID, allowIssuerHeldPackage: true });
  if (plan.status !== "ACCEPT_THEN_FLY") {
    return refusal("settlement chain not startable", { plan: plan.status });
  }
  const session = buildNpcSession(identity.character);
  if (!session) return refusal("courier character is not a usable identity");
  const live = runtime.getContractRecord(contract.contractID);
  if (!live) return refusal("contract not found in the live runtime");
  if (!isCourierContract(live)) return refusal("not a courier contract", { type: live.type, contractType: live.contractType });
  if (Number(live.status) !== OUTSTANDING) return refusal("contract is no longer outstanding", { status: live.status });
  if (Number(live.acceptorID) !== 0) return refusal("contract already has an acceptor", { acceptorID: live.acceptorID });
  try {
    const accepted = runtime.acceptContract(contract.contractID, session, false);
    if (!accepted) return { status: "AMBIGUOUS", reason: "acceptContract returned no record" };
    return {
      status: "ACCEPTED",
      contractID: contract.contractID,
      characterID: session.charid,
      next: ["fly", "complete"],
    };
  } catch (error) {
    // Never retry: the mutation may already be applied.
    return { status: "AMBIGUOUS", reason: String(error && error.message || error) };
  }
}

// Completion is only legal once the real package sits at the destination
// station, which is what the flight has to achieve.
function complete({ contract, identity, packageLocationID, runtime }) {
  if (!runtime || typeof runtime.completeContract !== "function" || typeof runtime.getContractRecord !== "function") {
    return refusal("runtime does not expose completeContract/getContractRecord");
  }
  const plan = planSettlement(contract, identity, packageLocationID);
  if (plan.status !== "SETTLE_NOW") {
    return refusal("package is not at the destination", { plan: plan.status });
  }
  const session = buildNpcSession(identity.character);
  if (!session) return refusal("courier character is not a usable identity");
  const live = runtime.getContractRecord(contract.contractID);
  if (!live) return refusal("contract not found in the live runtime");
  if (!isCourierContract(live)) return refusal("not a courier contract", { type: live.type, contractType: live.contractType });
  if (Number(live.status) !== IN_PROGRESS) {
    return refusal("contract is not in progress", { status: live.status });
  }
  if (Number(live.acceptorID) !== session.charid) {
    return refusal("this courier is not the acceptor", { acceptorID: live.acceptorID });
  }
  try {
    const done = runtime.completeContract(contract.contractID, FINISHED, session);
    if (!done) return { status: "AMBIGUOUS", reason: "completeContract returned false" };
    return { status: "COMPLETED", contractID: contract.contractID, characterID: session.charid };
  } catch (error) {
    return { status: "AMBIGUOUS", reason: String(error && error.message || error) };
  }
}

module.exports = { buildNpcSession, accept, complete };
