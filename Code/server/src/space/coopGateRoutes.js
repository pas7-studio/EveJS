"use strict";
// FW-108: how many gates away is the market that actually buys this cargo?
//
// Why it exists: MEASURED on the play stack 2026-10-30 - combat loot (typeID 17470, 1230) is
// quoted by exactly one station in the sampled galaxy (Jita 60003760), while the front's whole
// region 10000048 quotes neither type. `coopNativeGateTravel.tick` already accepts a multi-hop
// `route[]`, but NOTHING in the server builds a route - there is no BFS anywhere - so every
// consumer could only ever move one hop between two named systems.
//
// This module answers one question and nothing else: the shortest gate route between two solar
// systems, given an adjacency function. It reads no store, moves no ship, spawns nothing and
// never guesses a gate: an unreachable pair says UNREACHABLE.
function shortestGateRoute({ fromSystemID, toSystemID, neighbours, maxHops = 32 } = {}) {
  const from = Number(fromSystemID) || 0;
  const to = Number(toSystemID) || 0;
  if (!(from > 0) || !(to > 0)) return { status: "INVALID_SYSTEM" };
  if (typeof neighbours !== "function") return { status: "NO_GATE_GRAPH" };
  if (from === to) return { status: "ROUTE", hops: 0, route: [from] };
  const limit = Math.max(1, Math.min(64, Number(maxHops) || 32));
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    if (path.length > limit) continue;
    let next = [];
    try { next = neighbours(path[path.length - 1]) || []; } catch (_error) { next = []; }
    // Deterministic: the same world always answers the same route, so a replayed
    // decision never moves a hull somewhere else.
    const ordered = [...new Set(next.map((id) => Number(id)).filter((id) => id > 0))]
      .sort((left, right) => left - right);
    for (const id of ordered) {
      if (seen.has(id)) continue;
      const route = [...path, id];
      if (id === to) return { status: "ROUTE", hops: route.length - 1, route };
      seen.add(id);
      queue.push(route);
    }
  }
  return { status: "UNREACHABLE", fromSystemID: from, toSystemID: to };
}

module.exports = { shortestGateRoute };
