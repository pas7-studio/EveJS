"use strict";
// ALIFE-1 "news": turn already-observed native events into a short, rate-limited
// in-client digest. It never invents, predicts or replays an event: it only
// summarises the same records that were already written to coop-events.jsonl.
const WATCH = new Map([
  ["living-native-market-trade", { kind: "trade", label: "ринкова угода" }],
  ["living-npc-station-delivered", { kind: "delivery", label: "руда на станції" }],
  ["alife-native-delivery-settled", { kind: "native-settlement", label: "складський receipt" }],
  ["living-hauler-loaded", { kind: "haul", label: "завантажено hauler" }],
  ["living-native-mining-startup-slot", { kind: "fleet", label: "старт майнінг-флоту" }],
  ["living-pirate-raid", { kind: "raid", label: "рейд піратів" }],
  ["living-native-combat-damage", { kind: "combat", label: "бій" }],
  ["alife-blocker", { kind: "blocker", label: "блокер" }],
  ["alife-economy-intent", {kind:"economy-intent",label:"намір NPC"}],
  ["alife-economy-blocker", {kind:"blocker",label:"блокер NPC-економіки"}],
]);

const SYSTEM_NAMES = new Map([
  [30000142, "Jita"],
  [30000144, "Perimeter"],
  [30000145, "New Caldari"],
  [30100032, "Manifest"],
]);

function systemLabel(systemID) {
  const name = SYSTEM_NAMES.get(Number(systemID));
  return name ? `${name} (${systemID})` : String(systemID);
}

function trim(text, limit) {
  const value = String(text == null ? "" : text);
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + "…";
}

// A digest line is only worth sending when it reports a real quantity. The
// raid/combat emitters publish their attempt even when nothing happened
// (0 pirates, 0 HP), which produced "[ALIFE] ... 0 пірат(ів) ... 0 HP" noise.
const MEANINGFUL_FIELD = Object.freeze({
  raid: "pirates",
  combat: "damage",
  haul: "cargoQuantity",
  delivery: "oreQuantity",
});

function isMeaningful(kind, item) {
  if(kind==="native-settlement")return item?.status==="NATIVE_FULL_MANIFEST_WITNESSED"&&
   item.proof==="WAREHOUSE_COMMITTED_AND_NATIVE_ITEMSTORE_VERIFIED"&&
   item.nativeMutation===false&&item.iskCredited===false&&item.paidReward===false&&
   Number.isSafeInteger(item.stacks)&&item.stacks>0&&
   Number.isSafeInteger(item.quantity)&&item.quantity>0&&
   Array.isArray(item.cargoIDs)&&item.cargoIDs.length===item.stacks&&
   typeof item.eventID==="string"&&
   item.eventID==="alife-native-delivery:"+item.manifestID;
  const field = MEANINGFUL_FIELD[kind];
  if (!field) return true;
  return Number(item && item[field]) > 0;
}

function describe(item) {
  const kind = item.kind;
  if (kind === "trade") {
    const side = item.side === "buy" ? "купівля" : "продаж";
    const price = Number(item.price);
    return `${side} ${trim(item.typeID || "?", 12)} x${Number(item.quantity) || 1}` +
      (Number.isFinite(price) ? ` @${price}` : "");
  }
  if (kind === "delivery") return `склад: ${Number(item.stacks) || 0} стек(ів), ${Number(item.oreQuantity) || 0} м³`;
  if (kind === "native-settlement")
    return `підтверджено склад: ${item.stacks} стек(ів), ${item.quantity} од. (флот ${item.fleetID})`;
  if (kind === "haul") return `hauler ${Number(item.haulerID) || "?"} взяв ${Number(item.cargoQuantity) || 0} м³`;
  if (kind === "fleet") return `флот ${Number(item.fleetSlot) || 1}: ${Number(item.miners) || 0} мінер(ів)`;
  if (kind === "raid") return `${Number(item.pirates) || 0} пірат(ів) на полюванні`;
  if (kind === "combat") return `пошкодження ${Math.round(Number(item.damage) || 0)} HP`;
  if (kind === "economy-intent") return `NPC ${trim(item.pilotID || "?", 20)} планує ${trim(item.stage || "?", 18)} (ще не виконано)`;
  // `module` names the failing stage; the pilot is optional context. The old
  // template used `${a, b}` (comma operator) and printed only the pilot, so
  // every blocker line read "NPC: <reason>" and the stage was lost.
  if (kind === "blocker") {
    const stage = `${item.module || "?"}`;
    const pilot = item.pilotID ? ` (${trim(item.pilotID, 20)})` : "";
    return `${stage}${pilot}: ${item.reason || item.status || "?"}`;
  }
  return "";
}

function createNews({ clock = () => Date.now(), windowMs = 300000, maxItems = 6, maxAgeMs = 900000 } = {}) {
  if (typeof clock !== "function") throw Error("invalid alife news clock");
  if (!Number.isSafeInteger(windowMs) || windowMs < 60000) throw Error("invalid alife news window");
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 20) throw Error("invalid alife news limit");
  const pending = new Map();
  const lastSent = new Map();

  function record(event, extra = {}) {
    const spec = WATCH.get(String(event || ""));
    if (!spec) return false;
    const systemID = Number(extra.systemID || extra.spaceState?.systemID || 0);
    if (!Number.isSafeInteger(systemID) || systemID <= 0) return false;
    const list = pending.get(systemID) || [];
    if (!isMeaningful(spec.kind, extra)) return false;
    const line = describe({ kind: spec.kind, ...extra });
    if (!line) return false;
    list.push({ at: clock(), kind: spec.kind, line });
    if (list.length > 50) list.splice(0, list.length - 50);
    pending.set(systemID, list);
    return true;
  }

  function digest(systemID, now = clock()) {
    const id = Number(systemID);
    const list = (pending.get(id) || []).filter((item) => now - item.at <= maxAgeMs);
    if (!list.length) return null;
    const last = lastSent.get(id) || 0;
    if (now - last < windowMs) return null;
    const seen = new Set();
    const lines = [];
    for (const item of list.slice(-maxItems * 2)) {
      const key = item.kind + "|" + item.line;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(item.line);
      if (lines.length >= maxItems) break;
    }
    if (!lines.length) return null;
    const text = `[ALIFE] ${systemLabel(id)}: ${lines.join(" • ")}`;
    return { systemID: id, text: trim(text, 240), items: lines.length, windowMs };
  }

  function markSent(systemID, now = clock()) {
    const id = Number(systemID);
    lastSent.set(id, now);
    pending.delete(id);
  }

  return { record, digest, markSent, pendingFor: (systemID) => (pending.get(Number(systemID)) || []).length };
}

module.exports = { createNews, systemLabel, describe, isMeaningful, WATCH, SYSTEM_NAMES };
