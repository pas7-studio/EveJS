"use strict";
// Pure placement planner for the admin "give a whole fitting" path.
//
// Why it exists: restoring a lost ship must put every module back into the slot
// it really belongs to (high/med/low/rig), drones into the drone bay and cargo
// into the hold. The native fitting planner needs a live client session, so the
// admin bridge cannot use it while a character is offline; this module decides
// the slot flags from plain data instead.
//
// No game store, no session, no dogma lookups here: the caller resolves slot
// counts and per-type slot families, this file only allocates flags. That keeps
// the rule unit-testable outside the game loop.

const DEFAULT_DRONE_FLAG = 87;
const DEFAULT_CARGO_FLAG = 5;

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : 0;
}

function normalizeFlagList(values) {
  return (Array.isArray(values) ? values : [])
    .map(toPositiveInteger)
    .filter((flag) => flag > 0);
}

// modules: [{ typeID, count, family?, kind?, flag? }]
//   family - "high" | "med" | "low" | "rig" | "subsystem" | "service"
//   kind   - "module" | "drone" | "cargo"
//   flag   - explicit slot flag, wins over family
// slotFlags: { high: [27, 28], med: [19, 20, 21], ... } already limited to the
//   hull's real slot count by the caller.
// occupiedFlags: flags already used on the hull, so a second laser never lands
//   on the first laser's slot.
function planFit(options) {
  const opts = options || {};
  const modules = Array.isArray(opts.modules) ? opts.modules : [];
  const slotFlags = opts.slotFlags && typeof opts.slotFlags === "object" ? opts.slotFlags : {};
  const droneFlag = toPositiveInteger(opts.droneFlag) || DEFAULT_DRONE_FLAG;
  const cargoFlag = toPositiveInteger(opts.cargoFlag) || DEFAULT_CARGO_FLAG;
  const used = new Set(normalizeFlagList(opts.occupiedFlags));
  const free = {};
  for (const family of Object.keys(slotFlags)) {
    free[family] = normalizeFlagList(slotFlags[family]).filter((flag) => !used.has(flag));
  }

  const rows = [];
  for (const module of modules) {
    const typeID = toPositiveInteger(module && module.typeID);
    const count = Math.max(1, toPositiveInteger(module && module.count) || 1);
    if (!(typeID > 0)) {
      rows.push({ typeID, count, ok: false, error: "typeID is required" });
      continue;
    }
    const kind = String((module && module.kind) || "").trim().toLowerCase();
    const family = String((module && module.family) || "").trim().toLowerCase();
    const explicitFlag = toPositiveInteger(module && module.flag);

    // A pinned flag is a caller decision, not a guess: keep it even if the hull
    // already reports it as occupied (the caller may be repairing a fit).
    if (explicitFlag > 0) {
      for (let index = 0; index < count; index += 1) {
        used.add(explicitFlag);
        rows.push({ typeID, count: 1, flag: explicitFlag, family: family || null, kind: "module", ok: true });
      }
      continue;
    }
    if (kind === "drone") {
      rows.push({ typeID, count, flag: droneFlag, kind: "drone", ok: true });
      continue;
    }
    if (kind === "cargo" || !family) {
      rows.push({ typeID, count, flag: cargoFlag, kind: "cargo", ok: true });
      continue;
    }
    const available = free[family] || [];
    const placed = [];
    for (let index = 0; index < count; index += 1) {
      const flag = available.shift();
      if (!flag) {
        rows.push({
          typeID,
          count: 1,
          family,
          kind: "module",
          ok: false,
          error: "no free " + family + " slot on this hull",
        });
        break;
      }
      used.add(flag);
      placed.push(flag);
    }
    for (const flag of placed) {
      rows.push({ typeID, count: 1, flag, family, kind: "module", ok: true });
    }
  }
  return { rows, usedFlags: [...used] };
}

// Collapses planned rows into the explicit { typeID, flag, count } list the
// bridge's fit_slots action already understands, merging identical placements.
function toFitSlots(rows) {
  const merged = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.ok !== true) continue;
    const key = String(row.typeID) + "|" + String(row.flag);
    const existing = merged.get(key);
    if (existing) existing.count += Math.max(1, Number(row.count) || 1);
    else merged.set(key, { typeID: row.typeID, flag: row.flag, count: Math.max(1, Number(row.count) || 1) });
  }
  return [...merged.values()];
}

module.exports = { planFit, toFitSlots, DEFAULT_DRONE_FLAG, DEFAULT_CARGO_FLAG };
