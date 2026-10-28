"use strict";
// Close the world's own RPC_CALLING market journals from proof the market provides.
//
// Measured 2026-10-28: one crashed partial fill left a journal at RPC_CALLING, and every
// later sale of that pilot was refused with UNRESOLVED_MARKET_JOURNAL until an operator ran
// scripts/reconcile-npc-market-journal.cjs by hand. The proof is read-only (the market's own
// order row), so the world can close its own journal: settle what the row proves, close a
// journal without effect only on three independent proofs, and report the outcome.
//
// Extracted from coopVirtualWorldRuntime so that engine file stays inside its line ratchet;
// every authority is injected, so this module owns no world state of its own.
function createJournalBootReconciler({
  root,
  store,
  sceneForSystem,
  resolveType,
  inspectOrder,
  observe = null,
  retryMs = 300000,
  now = () => Date.now(),
} = {}) {
  if (typeof inspectOrder !== "function" || !store || typeof resolveType !== "function") {
    throw Error("JOURNAL_BOOT_RECONCILER_AUTHORITIES_REQUIRED");
  }
  let started = false;
  let lastAtMs = 0;
  const note = (event, payload) => {
    try { if (typeof observe === "function") observe(event, null, null, payload); }
    catch (_error) { /* telemetry must never stop the reconcile */ }
  };
  return function reconcile(force = false) {
    // A journal that appears while the world runs is retried at most once per retryMs: the
    // market call is cheap, but a hot loop against it is not.
    if (started && (!force || now() - lastAtMs < retryMs)) return false;
    started = true;
    lastAtMs = now();
    void (async () => {
      try {
        const result = await require("./coopNativeNpcMarketReconcile").reconcileJournals({
          root, inspectOrder, store, sceneForSystem, resolveType,
        });
        note("living-npc-market-journal-reconciled", {
          settled: result.settled.length,
          pending: result.pending.length,
          settledNoEffect: result.settled.filter((x) => x.noEffect === true).length,
          pendingReasons: result.pending.slice(0, 3).map((x) => String(x.reason || "")).join(","),
        });
      } catch (error) {
        // An unreachable market is not a proof of anything: the journal stays for the next boot.
        note("living-npc-market-journal-unreached",
          { reason: String((error && error.message) || error).slice(0, 90) });
      }
    })();
    return true;
  };
}

// The engine keeps only a call site; the wiring lives here so its line budget is not the
// price of a new authority.
function createFromEnvironment({env = process.env} = {}) {
  const marketClient = require("../services/market/marketDaemonClient").marketDaemonClient;
  const runtime = require("./runtime");
  const inventory = require("../services/inventory/itemTypeRegistry");
  return createJournalBootReconciler({
    root: env.EVEJS_COOP_NPC_MARKET_ROOT || "/var/lib/evejs/coop-native-market",
    inspectOrder: (orderID) => marketClient.call("GetOrder", { order_id: String(orderID) }),
    store: require("./npc/nativeNpcStore"),
    sceneForSystem: (systemID) => {
      try { return runtime.ensureScene(systemID, { refreshStargates: false }); }
      catch (_error) { return null; }
    },
    resolveType: (typeID) => inventory.resolveItemByTypeID(typeID),
    observe: require("./coopRuntimeProbe").observe,
  });
}

module.exports = { createJournalBootReconciler, createFromEnvironment };
