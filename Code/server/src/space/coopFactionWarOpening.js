"use strict";
// Opening wars from the real world.
//
// Owner model (2026-10-27): a war is global and multi-front. A front is the place
// where two factions' sectors actually touch, so one faction pair can fight on
// several borders at once. Nothing here invents a faction pair, a border or a
// fleet: the inputs are the real identity links (which native ship sits where),
// the real corporation -> faction table, the real reciprocal gate graph and the
// paper treasury. Every record is written by coopFactionWarCore.transition, so a
// war cannot exist without its native proofs.
//
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const { territoriesFromPresence, buildFronts } = require("./coopFactionWarFronts" + siblingSuffix);
const { planOpeningCampaign } = require("./coopFactionWarBootstrap" + siblingSuffix);
const core = require("./coopFactionWarCore" + siblingSuffix);
const paper = require("./coopFactionWarTreasury" + siblingSuffix);

const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const MAX_LINKS = 5000;
const LIVE_CAMPAIGN_STATES = new Set(["PREPARING", "ASSAULT"]);

const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});

// A campaign waiting for its assault deployment proof holds its target system in
// CONTESTED. If that proof never comes - a defender with no navy, a fleet that is
// never deployed - nothing can open that border again: `liveCampaignFor` keeps
// answering for the stalled campaign and every other front is refused with
// TARGET_ALREADY_CONTESTED. MEASURED 2026-10-28: one PREPARING campaign on 30045344
// starved the whole frontier for hours and the client's war map showed no front at
// all. Expiry invents nothing: it drops a claim that never produced evidence and
// releases the territory only when no other live campaign holds it.
const STALL_ENV = "EVEJS_COOP_WAR_OPENING_STALL_MS";
const DEFAULT_STALL_MS = 45 * 60 * 1000;
function stallMs() {
  const configured = num(process.env[STALL_ENV]);
  return configured > 0 ? configured : DEFAULT_STALL_MS;
}

// Targets whose stale claim was just released, so a reopen attempt is not repeated on
// every tick: MEASURED on the live world, an opened campaign that did not survive to the
// next tick was re-planned every 30 seconds and the world published "war opened" forever.
// In memory on purpose - it is a pacing guard, not world state.
const recentlyExpired = new Map();

function coolingDown(targetSystemID, nowMs, ttlMs = stallMs(), state = null) {
  const target = num(targetSystemID);
  const at = num(recentlyExpired.get(target));
  if (at) {
    if (num(nowMs) - at < num(ttlMs)) return true;
    recentlyExpired.delete(target);
  }
  // The map above dies with the process, so the durable record is consulted too: a
  // target whose only campaign is EXPIRED moments ago must not be re-planned on the
  // very next tick, or the world reopens (and announces) the same front forever.
  for (const campaign of Object.values((state && state.campaigns) || {})) {
    if (!campaign || num(campaign.targetSystemID) !== target) continue;
    if (campaign.state !== "EXPIRED") continue;
    const expiredAt = num(campaign.expiredAt);
    if (expiredAt && num(nowMs) - expiredAt < num(ttlMs)) return true;
  }
  return false;
}

function expireStalledCampaigns(state, { nowMs = Date.now(), ttlMs = stallMs() } = {}) {
  const campaignIDs = [];
  if (!state || !state.campaigns || !(num(ttlMs) > 0)) return { campaignIDs };
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  for (const campaign of Object.values(state.campaigns)) {
    if (!campaign || campaign.state !== "PREPARING") continue;
    // An assault already proved itself; a campaign with evidence is never expired.
    if (Array.isArray(campaign.objectiveEvidence) && campaign.objectiveEvidence.length) continue;
    const startedAt = num(campaign.startedAt);
    if (!pos(startedAt) || at - startedAt < num(ttlMs)) continue;
    campaign.state = "EXPIRED";
    campaign.revision = num(campaign.revision) + 1;
    campaign.expiredAt = at;
    campaign.expiredReason = "NO_ASSAULT_DEPLOYMENT_PROOF";
    campaignIDs.push(campaign.campaignID);
    recentlyExpired.set(num(campaign.targetSystemID), at);
    const target = state.territories && state.territories[String(campaign.targetSystemID)];
    // Only release the claim when this was the last live campaign on it.
    const stillContested = liveCampaignFor(state, campaign.targetSystemID);
    if (target && target.state === "CONTESTED" && !stillContested) {
      state.territories[String(campaign.targetSystemID)] = {
        ...target,
        state: "SECURE",
        revision: num(target.revision) + 1,
        changedAt: at,
      };
    }
  }
  return { campaignIDs };
}


// A gate is a proof only when it is reciprocal: one-way and unresolved gates are
// not a route a fleet can cross.
function gateBetween(fromSystemID, toSystemID, getStargatesForSystem, getGate) {
  if (!pos(fromSystemID) || !pos(toSystemID) || fromSystemID === toSystemID) return null;
  if (typeof getStargatesForSystem !== "function") return null;
  for (const gate of getStargatesForSystem(fromSystemID) || []) {
    const gateID = num(gate && gate.itemID);
    const destinationGateID = num(gate && gate.destinationID);
    if (!pos(gateID) || !pos(destinationGateID)) continue;
    if (num(gate && gate.destinationSolarSystemID) !== toSystemID) continue;
    const back = typeof getGate === "function" ? getGate(destinationGateID) : null;
    if (typeof getGate === "function" &&
      (!back || num(back.destinationID) !== gateID || num(back.solarSystemID) !== toSystemID)) continue;
    return {
      fromGateID: gateID,
      toGateID: destinationGateID,
      fromSystemID,
      toSystemID,
      reciprocal: Boolean(back),
    };
  }
  return null;
}

// Which faction really sits in which system, from the identity links plus the
// real corporation -> faction table. A link whose native record disagrees about
// the system is in flight and owns nothing yet.
function collectPresence({ links, systemIDs, getNativeEntity, getFactionForCorporation, maxLinks = MAX_LINKS } = {}) {
  if (!Array.isArray(links) || links.length > maxLinks) return { status: "INVALID_LINKS", pilots: [], skipped: 0 };
  if (typeof getNativeEntity !== "function" || typeof getFactionForCorporation !== "function")
    return { status: "NATIVE_AUTHORITIES_REQUIRED", pilots: [], skipped: 0 };
  const allowed = Array.isArray(systemIDs) && systemIDs.length
    ? new Set(systemIDs.map(Number).filter(pos))
    : null;
  const pilots = [];
  let skipped = 0;
  for (const link of links) {
    const systemID = num(link && link.systemID);
    const entityID = num(link && link.entityID);
    if (!pos(systemID) || !pos(entityID) || (allowed && !allowed.has(systemID))) { skipped++; continue; }
    let native = null, faction = 0;
    try {
      native = getNativeEntity(entityID);
      if (native && pos(native.systemID) && num(native.systemID) !== systemID) { skipped++; continue; }
      faction = num(getFactionForCorporation(native && native.corporationID));
    } catch (_error) { skipped++; continue; }
    if (!pos(faction)) { skipped++; continue; }
    pilots.push({
      pilotID: link.pilotID,
      entityID,
      systemID,
      factionID: String(faction),
      corporationID: num(native && native.corporationID),
      role: String(link.role || ""),
    });
  }
  return { status: "PRESENCE", pilots, skipped };
}

// Registered military control is authoritative; live presence only fills the
// systems that no campaign has decided yet. A capture must not be undone by
// counting the ships that happen to be passing through.
function territoriesForFronts({ state, presence, minShips = 1 } = {}) {
  const observed = territoriesFromPresence({ pilots: presence && presence.pilots, minShips });
  const territories = Object.assign({}, observed);
  let registeredCount = 0;
  const registered = state && state.territories;
  if (registered && typeof registered === "object") {
    for (const [key, record] of Object.entries(registered)) {
      const systemID = num(key);
      const owner = num(record && record.militaryControllerFactionID);
      if (!pos(systemID) || !pos(owner)) continue;
      territories[String(systemID)] = String(owner);
      registeredCount++;
    }
  }
  return { territories, observedCount: Object.keys(observed).length, registeredCount };
}

// A faction pays for an operation from what it really holds. This is a PAPER
// budget by owner decision: no market order, no cargo, and the paper nature is
// part of the result so it can never be mistaken for a native settlement.
function paperFunding({ heldSystemIDs = [], balanceISK = 0, rates = {} } = {}) {
  const funding = paper.fundOperation({ balanceISK, heldSystemIDs, rates });
  return Object.assign({ heldSystemIDs: heldSystemIDs.length }, funding);
}

// Owner decision 2026-10-27: the bounty escrow is an economic layer, not a
// precondition for a real battle. EVEJS_COOP_WAR_REQUIRE_FUNDING=0 allows an
// opening with an explicitly labelled PAPER_UNFUNDED_EXPLICIT supply: no ISK is
// reserved, no bounty can ever be paid, and every opening event carries the
// label. Default is 1 (strict).
function fundingRequired(env = process.env) {
  return String(env.EVEJS_COOP_WAR_REQUIRE_FUNDING ?? "1") !== "0";
}

function supplyFor({ funding, env = process.env } = {}) {
  const base = funding && typeof funding === "object" ? funding : { status: "REFUSED_UNFUNDED" };
  if (!fundingRequired(env) && base.status !== "FUNDED")
    return Object.assign({}, base, {
      status: "PAPER_UNFUNDED_EXPLICIT", paper: true,
      reason: "WAR_FUNDING_NOT_REQUIRED_BY_OPERATOR",
    });
  return base;
}

// Per-system faction counts, including the systems that are contested. A tie is
// the real reason a front cannot exist, so it has to be visible instead of
// looking like a broken feature.
function presenceSummary({ pilots = [], minShips = 1 } = {}) {
  const counts = new Map();
  for (const pilot of Array.isArray(pilots) ? pilots : []) {
    const systemID = num(pilot && pilot.systemID);
    const factionID = String((pilot && pilot.factionID) || "");
    if (!pos(systemID) || !factionID) continue;
    if (!counts.has(systemID)) counts.set(systemID, new Map());
    const per = counts.get(systemID);
    per.set(factionID, (per.get(factionID) || 0) + 1);
  }
  const threshold = Math.max(1, Math.trunc(num(minShips) || 1));
  const systems = {}, contested = [];
  for (const [systemID, per] of counts) {
    const ranked = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [topFaction, topShips] = ranked[0];
    const runnerUp = ranked[1] ? ranked[1][1] : 0;
    const entry = { factions: ranked.map(([factionID, ships]) => ({ factionID, ships })), owner: null, reason: "" };
    if (topShips < threshold) entry.reason = "BELOW_MIN_SHIPS";
    else if (topShips === runnerUp) entry.reason = "TIE_CONTESTED";
    else entry.owner = topFaction;
    systems[systemID] = entry;
    if (!entry.owner) contested.push(systemID);
  }
  return { systems, contested };
}

// One war per faction pair. Several campaigns may run under the same war on
// different borders - that is what "multi-front" means here.
function activeWarFor(state, leftFactionID, rightFactionID) {
  const low = Math.min(num(leftFactionID), num(rightFactionID));
  const high = Math.max(num(leftFactionID), num(rightFactionID));
  for (const war of Object.values((state && state.wars) || {})) {
    if (!war || war.state !== "ACTIVE") continue;
    const pair = [num(war.attackerFactionID), num(war.defenderFactionID)].sort((a, b) => a - b);
    if (pair[0] === low && pair[1] === high) return war;
  }
  return null;
}

function liveCampaignFor(state, targetSystemID) {
  return Object.values((state && state.campaigns) || {})
    .find((campaign) => campaign && num(campaign.targetSystemID) === num(targetSystemID) &&
      LIVE_CAMPAIGN_STATES.has(campaign.state)) || null;
}

function buildProofs({ plan, presence, territories, getStargatesForSystem, getGate, minShips, funding }) {
  const pilots = (presence && presence.pilots) || [];
  const countIn = (systemID, factionID) => pilots
    .filter((pilot) => pilot.systemID === Number(systemID) && pilot.factionID === String(factionID)).length;
  const sourceSystemID = plan.campaign.sourceSystemID;
  const targetSystemID = plan.campaign.targetSystemID;
  return {
    // Both sides must really be present on their own side of the border.
    declaration: ({ attackerFactionID, defenderFactionID }) =>
      countIn(sourceSystemID, attackerFactionID) >= minShips &&
      countIn(targetSystemID, defenderFactionID) >= minShips,
    // The system is owned by this faction in the map the front was derived from.
    territory: ({ systemID, ownerFactionID }) => territories[String(systemID)] === String(ownerFactionID),
    // A real reciprocal stargate connects the two systems.
    adjacency: ({ sourceSystemID: from, targetSystemID: to }) =>
      gateBetween(from, to, getStargatesForSystem, getGate) !== null,
    // Paper treasury can pay for the opening operation. An explicitly
    // operator-approved unfunded paper supply is labelled as such.
    supply: () => funding.paper === true &&
      (funding.status === "FUNDED" || funding.status === "PAPER_UNFUNDED_EXPLICIT"),
  };
}

// Turns the real inputs into one opening per open border, or refuses with the
// first missing fact. A border that already has a live campaign is not reopened.
function planWars({
  state, presence, getStargatesForSystem, getGate,
  nowMs, minShips = 1, balanceISK = 0, maxOpenings = 4,
  navyCapability = null,
} = {}) {
  if (!state || typeof state !== "object") return refuse("NO_WAR_STATE");
  const { territories, observedCount, registeredCount } =
    territoriesForFronts({ state, presence, minShips });
  const summary = presenceSummary({ pilots: presence && presence.pilots, minShips });
  if (!Object.keys(territories).length)
    return refuse("NO_TERRITORY_FROM_PRESENCE", { territories, observedCount, registeredCount, summary });
  if (typeof getStargatesForSystem !== "function") return refuse("NO_GATE_AUTHORITY", { territories });
  const fronts = buildFronts({ territories, getStargatesForSystem, getGate });
  if (!fronts.length)
    return refuse("NO_FRONT", { territories, observedCount, registeredCount, summary });
  const limit = Math.max(1, Math.min(8, Math.trunc(num(maxOpenings) || 1)));
  const openings = [], skipped = [];
  // FW-027: orientation of each war planned in THIS tick, so two borders of the
  // same faction pair never disagree with the single war record.
  const plannedWarOrientation = new Map();
  for (const front of fronts) {
    for (const edge of front.edges) {
      if (openings.length >= limit) break;
      let attackerFactionID = num(edge && edge.fromOwner);
      let defenderFactionID = num(edge && edge.toOwner);
      let sourceSystemID = num(edge && edge.fromSystemID);
      let targetSystemID = num(edge && edge.toSystemID);
      if (!pos(attackerFactionID) || !pos(defenderFactionID) || attackerFactionID === defenderFactionID) {
        skipped.push({ edge, reason: "NOT_TWO_REAL_FACTIONS" });
        continue;
      }
      if (!pos(sourceSystemID) || !pos(targetSystemID)) {
        skipped.push({ edge, reason: "INVALID_EDGE" });
        continue;
      }
      // FW-036 (dynamic decision): a campaign needs two sides that can really
      // shoot, because capture-by-force needs a defending wreck and a defender
      // with no navy can never produce one. Opening such a border squats the
      // target forever and starves every other front (measured: an ORE party
      // blocked the whole frontier). An unknown capability is never a yes.
      if (typeof navyCapability === "function") {
        let navy = null;
        try {
          navy = navyCapability({ attackerFactionID, defenderFactionID });
        } catch (_error) { navy = null; }
        if (!navy || navy.open !== true) {
          skipped.push({ edge, reason: String((navy && navy.reason) || "NO_NAVY_CAPABILITY:UNKNOWN") });
          continue;
        }
      }
      // A front is one gate pair, not one direction. The derived edge keeps the
      // orientation of whichever system the territory map listed first, so when
      // that side's target already carries a live campaign the pair looked
      // permanently blocked even though the other side was free. Attack across
      // the same real gate from the other end instead of freezing the front.
      //
      // The mirror is only for a DIFFERENT war squatting on that system. When
      // the live campaign belongs to this very faction pair, the border is
      // already being fought and must not be reopened from the far side - that
      // would let one war ping-pong its own front every tick.
      let workingEdge = edge;
      const blocking = liveCampaignFor(state, targetSystemID);
      if (blocking) {
        const blockingWar = (state && state.wars && state.wars[blocking.warID]) || null;
        const samePair = Boolean(blockingWar) &&
          [num(blockingWar.attackerFactionID), num(blockingWar.defenderFactionID)]
            .sort((a, b) => a - b).join("|") ===
          [attackerFactionID, defenderFactionID].sort((a, b) => a - b).join("|");
        if (samePair || liveCampaignFor(state, sourceSystemID)) {
          skipped.push({ edge, reason: "TARGET_ALREADY_CONTESTED" });
          continue;
        }
        workingEdge = {
          fromSystemID: targetSystemID,
          toSystemID: sourceSystemID,
          fromOwner: defenderFactionID,
          toOwner: attackerFactionID,
          gateID: edge.reciprocalGateID,
          reciprocalGateID: edge.gateID,
        };
        attackerFactionID = defenderFactionID;
        defenderFactionID = num(edge.fromOwner);
        sourceSystemID = workingEdge.fromSystemID;
        targetSystemID = workingEdge.toSystemID;
      }
      const war = activeWarFor(state, attackerFactionID, defenderFactionID);
      const warID = war ? war.warID
        : "war:" + Math.min(attackerFactionID, defenderFactionID) + "-" +
          Math.max(attackerFactionID, defenderFactionID);
      // FW-027: there is exactly ONE war per faction pair, so every campaign of
      // that pair must use the SAME orientation the war record carries. A second
      // border of the same pair in one tick is flipped to the war's orientation
      // instead of being denied by the core as CAMPAIGN_PREREQUISITES_NOT_MET.
      const known = war
        ? { attackerFactionID: num(war.attackerFactionID), defenderFactionID: num(war.defenderFactionID) }
        : plannedWarOrientation.get(warID) || null;
      let plannedEdge = workingEdge;
      let plannedTarget = targetSystemID;
      if (known && known.attackerFactionID === defenderFactionID &&
        known.defenderFactionID === attackerFactionID) {
        plannedEdge = {
          ...workingEdge,
          fromSystemID: targetSystemID, toSystemID: sourceSystemID,
          fromOwner: defenderFactionID, toOwner: attackerFactionID,
        };
        plannedTarget = sourceSystemID;
        if (liveCampaignFor(state, plannedTarget)) {
          skipped.push({ edge, reason: "TARGET_ALREADY_CONTESTED" });
          continue;
        }
      }
      if (!known) {
        plannedWarOrientation.set(warID, { attackerFactionID, defenderFactionID });
      }
      // A border released a moment ago is not re-planned on the very next tick.
      if (coolingDown(plannedTarget, nowMs, stallMs(), state)) {
        skipped.push({ edge, reason: "TARGET_RECENTLY_EXPIRED" });
        continue;
      }
      const plan = planOpeningCampaign({
        fronts: [{ frontID: front.frontID, edgeCount: 1, edges: [plannedEdge] }],
        nowMs,
        warID,
        campaignID: warID + ":campaign:" + plannedTarget,
      });
      if (plan.status !== "PLANNED") { skipped.push({ edge, reason: plan.reason }); continue; }
      const held = Object.keys(territories)
        .filter((key) => territories[key] === String(plan.war.attackerFactionID));
      const funding = paperFunding({ heldSystemIDs: held, balanceISK });
      const supply = supplyFor({ funding });
      const requireFunding = fundingRequired();
      if (requireFunding && supply.status !== "FUNDED") {
        skipped.push({ edge, reason: "SUPPLY_UNFUNDED:" + supply.status });
        continue;
      }
      const proofs = buildProofs({
        plan, presence, territories, getStargatesForSystem, getGate, minShips, funding: supply,
      });
      openings.push({ plan, proofs, funding: supply, edge, existingWar: Boolean(war), frontID: front.frontID });
    }
  }
  if (!openings.length)
    return refuse("NO_OPENABLE_FRONT", { territories, fronts, skipped, observedCount, registeredCount, summary });
  return { status: "READY", openings, territories, fronts, skipped, summary, observedCount, registeredCount };
}

// Applies every planned opening through the authoritative core, reusing an
// already declared war for the same faction pair.
function applyOpenings({ state, plan, nowMs, reserveBounty, persistState } = {}) {
  if (!plan || plan.status !== "READY") return refuse("PLAN_NOT_READY");
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  let current = state;
  const applied = [], warIDs = [], campaignIDs = [], fundings = [], skipped = [];
  const step = (command, proofs) => {
    const result = core.transition(current, command, { now: at, proofs });
    if (result.status !== "APPLIED" && result.status !== "DUPLICATE")
      throw Object.assign(Error("WAR_OPENING_BLOCKED:" + result.reason), { reason: result.reason });
    current = result.state || current;
    applied.push(Object.assign({ type: command.type }, result.receipt || {}));
  };
  try {
    for (const opening of plan.openings) {
      const { war, campaign } = opening.plan;
      const proofs = opening.proofs;
      // FW-027: two borders of the same pair can name the SAME target system
      // (e.g. a hub that touches both sides). The core refuses a second live
      // campaign on one target, and one bad edge must not discard the borders
      // that did open, so it is skipped here instead of aborting the batch.
      if (Object.values(current.campaigns || {}).some((existing) =>
        Number(existing && existing.targetSystemID) === Number(campaign.targetSystemID) &&
        ["PREPARING", "ASSAULT"].includes(String(existing && existing.state)))) {
        continue;
      }
      if (!current.wars[war.warID]) {
        step({
          type: "DECLARE_WAR", eventID: "open:" + war.warID + ":declare", warID: war.warID,
          attackerFactionID: war.attackerFactionID, defenderFactionID: war.defenderFactionID,
        }, proofs);
      }
      for (const [systemID, ownerFactionID] of [
        [campaign.sourceSystemID, war.attackerFactionID],
        [campaign.targetSystemID, war.defenderFactionID],
      ]) {
        if (current.territories[String(systemID)]) continue;
        step({
          type: "REGISTER_TERRITORY", eventID: "open:" + war.warID + ":territory:" + systemID,
          systemID, ownerFactionID,
        }, proofs);
      }
      let supplyReservationID = "paper-supply:" + campaign.campaignID;
      let stepProofs = proofs, realReservation = null;
      // FW-005B: a campaign is only funded by real escrow, and the reservation is
      // taken BEFORE the campaign exists (the treasury refuses an existing one).
      // FW-024: when the operator explicitly waives funding
      // (EVEJS_COOP_WAR_REQUIRE_FUNDING=0) no escrow is reserved, nothing can be
      // paid from it, and the opening records PAPER_UNFUNDED_EXPLICIT.
      if (typeof reserveBounty === "function" && fundingRequired()) {
        const reserved = reserveBounty({
          war: current.wars[war.warID], campaign, warID: war.warID,
          campaignID: campaign.campaignID, state: current,
          persist: () => { if (typeof persistState === "function") persistState(current); },
        });
        if (reserved.status !== "RESERVED") {
          // FW-037: one border nobody can pay for must not abort the whole batch.
          // Measured on the work stack: the frontier refused every opening with
          // SUPPLY_UNFUNDED and threw the plan away, so a single broke faction
          // pair could stop every other border from opening in the same tick.
          // The refusal is recorded per border instead, exactly like the
          // mobiliser already reports a starved campaign without hiding others.
          skipped.push({
            edge: { sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID },
            campaignID: campaign.campaignID,
            warID: war.warID,
            reason: "SUPPLY_UNFUNDED:" + String(reserved.reason || "UNKNOWN").slice(0, 160),
          });
          continue;
        }
        supplyReservationID = reserved.reservationID;
        realReservation = reserved;
        fundings.push(Object.assign({ status: "FUNDED", paper: false, escrow: true },
          reserved));
        // The supply proof is now the real HELD escrow this faction funded.
        stepProofs = Object.assign({}, proofs, { supply: () => true });
      }
      step({
        type: "START_CAMPAIGN", eventID: "open:" + campaign.campaignID + ":start",
        campaignID: campaign.campaignID, warID: war.warID,
        sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID,
        supplyReservationID,
      }, stepProofs);
      if (!warIDs.includes(war.warID)) warIDs.push(war.warID);
      campaignIDs.push(campaign.campaignID);
      if (!realReservation) fundings.push(opening.funding);
    }
    // OPENED must mean "something was really opened". Measured: a batch where
    // every border was skipped for funding still answered OPENED with zero
    // campaigns, so the runtime published a success event with empty lists and the
    // real refusal disappeared for an hour. Nothing opened = a refusal, with the
    // per-border reasons attached.
    if (!campaignIDs.length)
      return refuse("NO_FUNDED_FRONT", { state: current, applied, fundings, skipped });
    return { status: "OPENED", state: current, warIDs, campaignIDs, applied, fundings, skipped };
  } catch (error) {
    return refuse(error.reason || String((error && error.message) || error), { state: current, applied });
  }
}

// Single-opening convenience used by the assault tests and by callers that only
// care about the first front.
function applyOpening({ state, plan, nowMs, reserveBounty, persistState } = {}) {
  if (!plan || plan.status !== "READY" || !Array.isArray(plan.openings) || plan.openings.length !== 1)
    return refuse("PLAN_NOT_READY");
  const result = applyOpenings({ state, plan, nowMs, reserveBounty, persistState });
  if (result.status !== "OPENED") return result;
  return Object.assign({}, result, {
    warID: result.warIDs[0],
    campaignID: result.campaignIDs[0],
    funding: result.fundings[0],
  });
}

function createWarOpening({
  readLinks, getNativeEntity, getFactionForCorporation,
  getStargatesForSystem, getGate, readWarState, writeWarState,
  reserveBounty = null,
  // FW-027: a real war fleet is presence too. A formation of real armed native
  // hulls that the fleet roster proves in a system holds that system exactly the
  // same way a linked pilot does - the ships really exist, are really there, and
  // their corporation really resolves to a faction. Without the authority the
  // behaviour is unchanged.
  fleetPresence = null,
  // FW-036: which factions can really field a navy. Without this authority the
  // planner behaves exactly as before (no capability gate).
  navyCapability = null,
  minShips = 1, balanceISK = 0, maxOpenings = 4,
  now = () => Date.now(), maxLinks = MAX_LINKS,
} = {}) {
  const required = [readLinks, getNativeEntity, getFactionForCorporation,
    getStargatesForSystem, readWarState, writeWarState];
  if (required.some((fn) => typeof fn !== "function")) throw Error("WAR_OPENING_AUTHORITIES_REQUIRED");
  if (fleetPresence !== null && typeof fleetPresence !== "function") {
    throw Error("WAR_OPENING_AUTHORITIES_REQUIRED");
  }
  let busy = false;
  function tick({ systemIDs = [] } = {}) {
    if (busy) return { status: "BUSY" };
    if (!Array.isArray(systemIDs) || systemIDs.length > 20) return { status: "INVALID_SYSTEMS" };
    busy = true;
    try {
      let state, links;
      try {
        state = readWarState();
        links = readLinks();
      } catch (_error) { return { status: "NATIVE_AUTHORITIES_UNAVAILABLE" }; }
      if (!state) return { status: "NO_WAR_STATE" };
      try { core.validateState(state); } catch (_error) { return { status: "INVALID_WAR_STATE" }; }
      // Release borders whose campaign never produced an assault proof, before the
      // planner asks which targets are already contested.
      let expiredCampaignIDs = [];
      try {
        const expiry = expireStalledCampaigns(state, { nowMs: num(now()) });
        if (expiry.campaignIDs.length) {
          core.validateState(state);
          writeWarState(state);
          expiredCampaignIDs = expiry.campaignIDs;
        }
      } catch (_error) { expiredCampaignIDs = []; }
      const presence = collectPresence({ links, systemIDs, getNativeEntity, getFactionForCorporation, maxLinks });
      if (presence.status !== "PRESENCE") return { status: presence.status };
      let fleetShips = 0;
      if (typeof fleetPresence === "function") {
        let extra = [];
        try {
          extra = fleetPresence({ systemIDs }) || [];
        } catch (_error) {
          extra = [];
        }
        const seen = new Set(presence.pilots.map((pilot) => Number(pilot.entityID)));
        for (const ship of Array.isArray(extra) ? extra : []) {
          const entityID = num(ship && ship.entityID);
          const systemID = num(ship && ship.systemID);
          const factionID = String((ship && ship.factionID) || "");
          if (!pos(entityID) || !pos(systemID) || !factionID || seen.has(entityID)) continue;
          seen.add(entityID);
          presence.pilots.push({
            pilotID: String((ship && ship.pilotID) || ("coop-fleet-ship-" + entityID)),
            entityID,
            systemID,
            factionID,
            corporationID: num(ship && ship.corporationID),
            role: String((ship && ship.role) || "patrol"),
            source: "FLEET_ROSTER",
          });
          fleetShips += 1;
        }
      }
      const plan = planWars({
        state, presence, getStargatesForSystem, getGate,
        nowMs: num(now()), minShips, balanceISK, maxOpenings,
        navyCapability: typeof navyCapability === "function" ? navyCapability : null,
      });
      if (plan.status !== "READY")
        return { status: "NO_OPENING", reason: plan.reason || "PLAN_REFUSED", plan,
          expiredCampaignIDs };
      const opened = applyOpenings({ state, plan, nowMs: num(now()),
        reserveBounty, persistState: writeWarState });
      if (opened.status !== "OPENED") return opened;
      writeWarState(opened.state);
      return {
        status: "OPENED", warIDs: opened.warIDs, campaignIDs: opened.campaignIDs,
        applied: opened.applied, fundings: opened.fundings,
        presence: { pilots: presence.pilots.length, skipped: presence.skipped, fleetShips },
        expiredCampaignIDs,
        territories: plan.territories, fronts: plan.fronts.length,
        // A border refused for funding is named here instead of vanishing.
        skipped: plan.skipped.concat(Array.isArray(opened.skipped) ? opened.skipped : []),
      };
    } finally { busy = false; }
  }
  return Object.freeze({ tick });
}

module.exports = {
  gateBetween, collectPresence, territoriesForFronts, paperFunding, presenceSummary,
  fundingRequired, supplyFor,
  activeWarFor, liveCampaignFor, buildProofs, planWars, applyOpenings, applyOpening,
  expireStalledCampaigns, stallMs, coolingDown,
  createWarOpening,
};
