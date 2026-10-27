"use strict";
// Messages a courier pilot sends to the contract issuer. Pure text: nothing
// here sends anything, so the wording can be reviewed before it reaches a
// player. Delivery (in-game mail or a private chat line) is wired by the
// courier phase once the overlay can be installed again.
//
// Kinds:
//   accepted    - took the contract, package secured
//   departing   - undocked, on the way
//   delivered   - arrived, package handed over
//   failed      - courier lost the cargo (collateral goes to the issuer)
//   counter     - terms rejected, with a concrete price instead
const KINDS = Object.freeze(["accepted", "departing", "delivered", "failed", "counter"]);

function isk(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0 ISK";
  return Math.round(numeric).toLocaleString("en-US") + " ISK";
}

function pilotName(context) {
  return String(context && context.pilotName || "Courier");
}

function contractRef(context) {
  return String(context && context.contractID || "");
}

// A delivery report is only worth reading if it is concrete: how long the run
// actually took and what really happened on the way. Nothing here invents an
// incident; an empty list is reported as a clean run.
const INCIDENT_WORDS = Object.freeze({
  rewarp: "warp re-issue",
  "warp-failed": "warp failure",
  "dock-failed": "dock failure",
  "undock-failed": "undock failure",
  "origin-return": "return to origin",
  "station-repair": "station record repair",
  "cargo-load": "cargo load",
  "handover-failed": "hand-over failure",
  "settle-failed": "settlement retry",
});

function durationText(ms) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return "an unknown time";
  const minutes = Math.max(1, Math.round(total / 60000));
  if (minutes < 60) return minutes + (minutes === 1 ? " minute" : " minutes");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = hours + (hours === 1 ? " hour" : " hours");
  return rest ? hourText + " " + rest + (rest === 1 ? " minute" : " minutes") : hourText;
}

function incidentsText(list) {
  const incidents = Array.isArray(list) ? list : [];
  if (!incidents.length) return "No incidents on the way: no warp failures, no returns, no lost time.";
  const counts = new Map();
  for (const row of incidents) {
    const kind = String(row && row.kind || "incident");
    const word = INCIDENT_WORDS[kind] || kind;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([word, count]) =>
    count === 1 ? word : count + " " + word + "s");
  return "Incidents on the way: " + parts.join(", ") + ".";
}

function buildNotice(kind, context) {
  if (!KINDS.includes(kind)) {
    return { status: "NO_NOTICE", reason: "unknown kind: " + kind };
  }
  const ctx = context || {};
  const name = pilotName(ctx);
  const id = contractRef(ctx);
  const volume = Number(ctx.volumeM3) || 0;
  const from = String(ctx.fromStationName || "origin");
  const to = String(ctx.toStationName || "destination");

  if (kind === "accepted") {
    return {
      status: "NOTICE",
      kind,
      subject: `Contract ${id} accepted`,
      body:
        `${name} here. I have accepted your contract ${id} and secured the sealed package ` +
        `(${Math.round(volume).toLocaleString("en-US")} m3) at ${from}. ` +
        `I will depart for ${to} and message you when I am under way.`,
    };
  }
  if (kind === "departing") {
    return {
      status: "NOTICE",
      kind,
      subject: `Contract ${id}: under way`,
      body:
        `${name} here. Undocked from ${from} with your package on board and warping to ${to}. ` +
        `Estimated arrival ${String(ctx.etaText || "shortly")}. ` +
        `If anything goes wrong you will hear it from me, not from the wreck.`,
    };
  }
  if (kind === "delivered") {
    const departed = String(ctx.departedClockText || "");
    return {
      status: "NOTICE",
      kind,
      subject: `Contract ${id} delivered`,
      body:
        `${name} here. Package delivered at ${to} after ${durationText(ctx.durationMs)}` +
        `${departed ? " in flight (departed " + from + " at " + departed + ")" : ""}. ` +
        `${incidentsText(ctx.incidents)} ` +
        `Thank you for the ${isk(ctx.reward)}.`,
    };
  }
  if (kind === "failed") {
    return {
      status: "NOTICE",
      kind,
      subject: `Contract ${id}: I lost it`,
      body:
        `${name} here. I was attacked on the way to ${to} and the ship did not survive. ` +
        `The package is gone. Your collateral of ${isk(ctx.collateral)} is yours again, ` +
        `and I am not asking for the ${isk(ctx.reward)}.`,
    };
  }
  // counter
  const offered = Number(ctx.reward) || 0;
  const wanted = Number(ctx.quoteIsk) || 0;
  return {
    status: "NOTICE",
    kind,
    subject: `Contract ${id}: not at this price`,
    body:
      `${name} here. ${Math.round(volume).toLocaleString("en-US")} m3 from ${from} to ${to} ` +
      `for ${isk(offered)} does not cover the fuel and the risk of carrying ` +
      `${isk(ctx.collateral)} of collateral. ` +
      `I can do it for ${isk(wanted)}. Raise the reward to that and I will take it; ` +
      `keep it as it is and I will leave it for someone else.`,
    counterOfferIsk: wanted,
    minimumAcceptableIsk: wanted,
  };
}

// A courier only refuses on price when the reward is below what the published
// quote says the job is worth; otherwise it takes the work.
function negotiate(contract, quote) {
  const reward = Number(contract && contract.reward) || 0;
  const wanted = Number(quote && quote.totalIsk) || 0;
  if (!(wanted > 0)) return { status: "NO_NEGOTIATION", reason: "no quote" };
  if (reward >= wanted) return { status: "ACCEPTABLE", reward, wanted };
  return {
    status: "COUNTER_OFFER",
    reward,
    wanted,
    shortfallIsk: wanted - reward,
    notice: buildNotice("counter", {
      contractID: contract.contractID,
      volumeM3: contract.volume,
      reward,
      quoteIsk: wanted,
      collateral: contract.collateral,
      pilotName: quote.pilotName,
    }),
  };
}

module.exports = { KINDS, buildNotice, negotiate, durationText, incidentsText };
