"use strict";
// FW-005B: a faction war chest funded ONLY from real earned income.
//
// Why it exists: `coopWarTreasury` moves ISK out of a real native corporation
// wallet, but every NPC corporation wallet in this world is empty, so a reserve
// could only be satisfied by inventing ISK. The one real ISK an NPC really owns
// is its durable earned balance in the native market ledger (every cent of it
// was paid by a real seeded-market fill, `NPC_LEDGER_ONLY_NOT_EVEJS_PLAYER_WALLET`).
//
// This module moves that value, and nothing else:
//   pilot earned balance  ->  faction corporation wallet  ->  war escrow (HELD)
//   war escrow (HELD)     ->  pilot earned balance        (bounty payout)
//
// Total ISK is conserved on every leg, every debit is keyed by a durable event
// id so a replay cannot pay twice, and a wallet credit is only written after the
// source balance really went down. A crash between the two leaves a PREPARED
// journal that `recover()` finishes from the recorded numbers.
const fs = require("node:fs");
const path = require("node:path");
const { isWarPilotID } = require("./coopWarPilotID" + (typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs"));

const TABLE = "corporationRuntime";
const CORP_PREFIX = "corporations\u001f";
const WAR_KEY = "coop-faction-war\u001fstate-v1";
// Distinct from the treasury's own 8e15 range so a chest credit can never
// collide with an escrow journal entry.
const JOURNAL_BASE = 7500000000000000;
const MAX_SOURCES = 32;

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const nonneg = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const key = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value) &&
  !["__proto__", "constructor", "prototype"].includes(value);
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const cents = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const exact = value * 100, rounded = Math.round(exact);
  return nonneg(rounded) && Math.abs(exact - rounded) <= 0.000001 ? rounded : null;
};
const isk = (value) => value / 100;
// FW-058 (review): the chest journal had a hard 2048-entry ceiling that made
// `validateJournal` THROW - the whole chest became unusable and every later war
// would answer WAR_CHEST_JOURNAL_INVALID, not "full". Compaction keeps replay
// safety: an event that was pruned is still recognised (DUPLICATE, and deliberately
// with no entry, so nothing can be debited twice) and a different event under the
// same id is still a conflict. A PREPARED entry is never pruned: `recover()` owns it.
const MAX_ENTRIES = 1024;
const MAX_ARCHIVE = 20000;
const crypto = require("node:crypto");
const signatureHash = (value) => crypto.createHash("sha256")
  .update(String(value)).digest("hex").slice(0, 32);
// A replay is decided by IDENTITY, never by the amount: the levy plan is computed
// again from live balances, so a replayed event may plan different cents - and must
// still be recognised as already done instead of debiting a pilot twice.
const sameChestIdentity = (archived, request) =>
  Number(archived?.factionID) === Number(request.factionID) &&
  Number(archived?.corporationID) === Number(request.corporationID) &&
  String(archived?.warID || "") === String(request.warID || "") &&
  String(archived?.campaignID || "") === String(request.campaignID || "");
const emptyJournal = () => ({version: 1, entries: {}, nextJournalID: JOURNAL_BASE});

function validateJournal(state) {
  if (!state || state.version !== 1 || !state.entries ||
      typeof state.entries !== "object" || Array.isArray(state.entries) ||
      !nonneg(state.nextJournalID) || state.nextJournalID < JOURNAL_BASE ||
      Object.keys(state.entries).length > MAX_ENTRIES ||
      (state.archive !== undefined && (typeof state.archive !== "object" ||
        Array.isArray(state.archive) || Object.keys(state.archive).length > MAX_ARCHIVE)))
    throw Error("WAR_CHEST_JOURNAL_INVALID");
  for (const [id, entry] of Object.entries(state.entries)) {
    if (!key(id) || entry?.journalID !== id || !pos(entry.corporationID) ||
        !pos(entry.factionID) || !key(entry.warID) || !key(entry.campaignID) ||
        !["PREPARED", "COMMITTED", "ABORTED"].includes(entry.phase) ||
        !Array.isArray(entry.sources) || !entry.sources.length ||
        entry.sources.length > MAX_SOURCES || !pos(entry.totalCents))
      throw Error("WAR_CHEST_JOURNAL_CORRUPT");
    for (const source of entry.sources) {
      if (!/^coop-pilot-[0-9]{3,}$/.test(String(source?.pilotID)) ||
          !pos(source.takeCents) || !nonneg(source.beforeCents))
        throw Error("WAR_CHEST_SOURCE_CORRUPT");
    }
  }
  return state;
}

// Pure: which real earned balances may fund this faction's chest, and how much.
// Only a pilot that the faction really commands contributes, and never more
// than the balance that is actually on the ledger right now.
function planLevy({factionID, pilots = [], ledger = {}, needCents = 0} = {}) {
  const want = Number(factionID);
  if (!pos(want)) return {status: "REFUSED", reason: "INVALID_FACTION"};
  const need = nonneg(Number(needCents)) ? Number(needCents) : 0;
  if (!need) return {status: "REFUSED", reason: "INVALID_NEED"};
  const balances = (ledger && ledger.pilots) || {};
  const sources = [];
  let total = 0;
  const seen = new Set();
  for (const pilot of Array.isArray(pilots) ? pilots : []) {
    const pilotID = String(pilot?.pilotID || "");
    if (!/^coop-pilot-[0-9]{3,}$/.test(pilotID) || seen.has(pilotID)) continue;
    if (Number(pilot?.factionID) !== want) continue;
    seen.add(pilotID);
    const row = balances[pilotID];
    const available = cents(row?.balance);
    if (available === null || available <= 0) continue;
    const take = Math.min(available, need - total);
    if (take <= 0) break;
    sources.push({pilotID, systemID: Number(pilot.systemID) || 0,
      beforeCents: available, takeCents: take});
    total += take;
    if (total >= need) break;
  }
  if (!sources.length)
    return {status: "REFUSED", reason: "NO_REAL_FACTION_INCOME",
      factionID: want, needCents: need, pilots: pilots.length};
  if (total < need)
    return {status: "REFUSED", reason: "INSUFFICIENT_REAL_INCOME",
      factionID: want, needCents: need, totalCents: total, sources};
  return {status: "FUNDED", factionID: want, needCents: need,
    totalCents: total, sources};
}

function createWarChestFunding({gameStore, verifyCorporation, adjustEarned,
  journalFile = "/var/lib/evejs/coop-war-chest-journal.json",
  readWarState = () => null, clock = () => Date.now(), env = process.env,
  fsApi = fs} = {}) {
  if (typeof gameStore?.coopAtomicNativeRows?.transact !== "function" ||
      typeof verifyCorporation !== "function" || typeof adjustEarned !== "function" ||
      typeof readWarState !== "function" || typeof clock !== "function" ||
      typeof journalFile !== "string" || !journalFile)
    throw Error("WAR_CHEST_AUTHORITIES_REQUIRED");
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_WAR_TREASURY === "1" && env.EVEJS_COOP_NATIVE_ATOMIC_ROWS === "1";
  let busy = false;

  function readJournal() {
    try {
      return validateJournal(JSON.parse(fsApi.readFileSync(journalFile, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return emptyJournal();
      throw error;
    }
  }
  function writeJournal(state) {
    fsApi.mkdirSync(path.dirname(journalFile), {recursive: true});
    const temp = journalFile + ".tmp-" + process.pid;
    const fd = fsApi.openSync(temp, "wx", 0o600);
    try {
      fsApi.writeFileSync(fd, JSON.stringify(state));
      fsApi.fsyncSync(fd);
    } finally { fsApi.closeSync(fd); }
    fsApi.renameSync(temp, journalFile);
  }

  // The real native corporation wallet row. It exists for every seeded NPC
  // corporation, but its balance is only real once a levy really funded it.
  // A read-only pre-flight, so a bad wallet never debits a real balance first.
  function walletVerified(entry) {
    try {
      return gameStore.coopAtomicNativeRows.transact([TABLE], (tx) => {
        const corp = tx.get(TABLE, CORP_PREFIX + entry.corporationID);
        const division = corp?.wallet?.divisions?.["1000"];
        const balance = cents(division?.balance);
        let corporationOK = false;
        try {
          corporationOK = verifyCorporation({corporationID: entry.corporationID,
            factionID: entry.factionID, warID: entry.warID}, corp, tx) === true;
        } catch (_error) { corporationOK = false; }
        return corporationOK && Boolean(corp) &&
          (corp.corporationID === undefined ||
            corp.corporationID === entry.corporationID) &&
          balance !== null && Array.isArray(division.journal) &&
          Array.isArray(division.transactions);
      }) === true;
    } catch (_error) { return false; }
  }
  function walletCredit(entry, at) {
    return gameStore.coopAtomicNativeRows.transact([TABLE], (tx) => {
      const corpKey = CORP_PREFIX + entry.corporationID;
      const corp = tx.get(TABLE, corpKey);
      const division = corp?.wallet?.divisions?.["1000"];
      const balance = cents(division?.balance);
      let corporationOK = false;
      try {
        corporationOK = verifyCorporation({corporationID: entry.corporationID,
          factionID: entry.factionID, warID: entry.warID}, corp, tx) === true;
      } catch (_error) { corporationOK = false; }
      if (!corporationOK || !corp ||
          (corp.corporationID !== undefined &&
            corp.corporationID !== entry.corporationID) ||
          balance === null || !Array.isArray(division.journal) ||
          !Array.isArray(division.transactions))
        return {status: "BLOCKED", reason: "NATIVE_CORPORATION_WALLET_UNVERIFIED"};
      const entries = [], next = [];
      for (const [index, source] of entry.sources.entries()) {
        const transactionID = entry.transactionIDs[index];
        if (!pos(transactionID))
          return {status: "BLOCKED", reason: "WAR_CHEST_JOURNAL_COLLISION"};
        if (division.journal.some((row) => row?.transactionID === transactionID) ||
            division.transactions.some((row) => row?.transactionID === transactionID))
          continue;
        entries.push({transactionID, source});
        next.push({...source, transactionID});
      }
      if (!entries.length) return {status: "ALREADY_CREDITED"};
      let running = balance;
      const transfers = [];
      for (const {transactionID, source} of entries) {
        running += source.takeCents;
        transfers.push({
          transactionID,
          transactionDate: String(BigInt(at) * 10000n + 116444736000000000n),
          referenceID: transactionID, entryTypeID: 0, accountKey: 1000,
          currency: 1, sortValue: 1, ownerID1: entry.corporationID,
          ownerID2: entry.corporationID,
          description: "Coop faction war chest levy " + source.pilotID + " " +
            entry.campaignID,
          amount: isk(source.takeCents),
          balance: isk(running),
        });
      }
      const updated = {...corp, wallet: {...corp.wallet, divisions: {
        ...corp.wallet.divisions,
        "1000": {...division, balance: isk(running),
          journal: [...division.journal, ...transfers].slice(-100),
          transactions: [...division.transactions, ...transfers].slice(-2000)}}}};
      tx.put(TABLE, corpKey, updated);
      return {status: "CREDITED", walletBeforeCents: balance,
        walletAfterCents: running, transactionIDs: next.map((row) => row.transactionID)};
    });
  }

  function apply(entry) {
    const at = pos(Number(entry.at)) ? Number(entry.at) : clock();
    if (!pos(at)) throw Error("WAR_CHEST_CLOCK_UNSAFE");
    const debited = [];
    for (const source of entry.sources) {
      const result = adjustEarned({
        pilotID: source.pilotID, cents: -source.takeCents,
        eventID: entry.journalID + ":levy:" + source.pilotID,
        reason: "war chest levy " + entry.campaignID,
      });
      if (result.status !== "APPLIED" && result.status !== "DUPLICATE") {
        // Nothing is credited while a source cannot pay: the chest must never
        // hold ISK that no real balance gave up.
        return {status: "BLOCKED", reason: "WAR_CHEST_SOURCE_UNPAID:" +
          String(result.status || result.reason || "UNKNOWN"), debited};
      }
      debited.push({pilotID: source.pilotID, receipt: result.receipt || null});
    }
    const credit = (() => {
      try { return walletCredit(entry, at); }
      catch (error) {
        return {status: "BLOCKED", reason: "WAR_CHEST_CREDIT_THROW:" +
          String((error && error.message) || error).slice(0, 80)};
      }
    })();
    if (credit.status !== "CREDITED" && credit.status !== "ALREADY_CREDITED")
      return {status: "BLOCKED", reason: String(credit.reason || credit.status), debited};
    return {status: "COMMITTED", debited, credit};
  }

  function commitEntry(state, entry, result) {
    state.entries[entry.journalID] = {...entry, phase: "COMMITTED",
      walletBeforeCents: Number(result?.credit?.walletBeforeCents) || 0,
      walletAfterCents: Number(result?.credit?.walletAfterCents) || 0};
    writeJournal(state);
  }

  // Collects real earned ISK from the faction's own pilots into its native
  // corporation wallet. The caller then reserves the bounty from that wallet.
  function fund({factionID, corporationID, warID, campaignID, needCents,
    pilots = [], ledger = {}, eventID} = {}) {
    if (!enabled()) return {status: "DISABLED"};
    if (busy) return {status: "BLOCKED", reason: "WAR_CHEST_REENTRANT"};
    if (!pos(corporationID) || !key(warID) || !key(campaignID) || !key(eventID))
      return {status: "BLOCKED", reason: "INVALID_WAR_CHEST_IDENTITY"};
    let war = null;
    try { war = (readWarState() || {}).wars?.[warID] || null; } catch (_error) { war = null; }
    if (!war || (Number(war.attackerFactionID) !== Number(factionID) &&
        Number(war.defenderFactionID) !== Number(factionID)))
      return {status: "BLOCKED", reason: "WAR_CHEST_NOT_A_WAR_PARTY"};
    busy = true;
    try {
      const journalID = "chest:" + eventID;
      const state = readJournal();
      const prior = own(state.entries, journalID) ? state.entries[journalID] : null;
      // FW-058: a compacted event is still decided, never re-executed. The archive
      // keeps only what is needed to answer "did this already happen?".
      if (!prior && own(state.archive || {}, journalID)) {
        const archived = state.archive[journalID];
        return sameChestIdentity(archived, { factionID, corporationID, warID, campaignID })
          ? {status: "DUPLICATE", entry: null, archived: true}
          : {status: "BLOCKED", reason: "WAR_CHEST_EVENT_CONFLICT", archived: true};
      }
      if (prior) {
        if (prior.factionID !== Number(factionID) || prior.corporationID !== Number(corporationID))
          return {status: "BLOCKED", reason: "WAR_CHEST_EVENT_CONFLICT"};
        if (prior.phase === "COMMITTED")
          return {status: "DUPLICATE", entry: prior};
        const finished = apply(prior);
        if (finished.status !== "COMMITTED")
          return {status: "BLOCKED", reason: finished.reason, entry: prior};
        commitEntry(state, prior, finished);
        return {status: "APPLIED", entry: state.entries[journalID], receipt: finished};
      }
      // Room for a new entry: only terminal (COMMITTED/ABORTED) rows are compacted,
      // oldest first, and a PREPARED levy is left to `recover()`.
      if (Object.keys(state.entries).length >= MAX_ENTRIES) {
        if (!state.archive || typeof state.archive !== "object") state.archive = {};
        const terminal = Object.values(state.entries)
          .filter((row) => row && row.phase !== "PREPARED")
          .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
        for (const row of terminal) {
          if (Object.keys(state.entries).length < MAX_ENTRIES) break;
          if (Object.keys(state.archive).length >= MAX_ARCHIVE) break;
          state.archive[row.journalID] = {factionID: row.factionID,
            corporationID: row.corporationID, warID: row.warID,
            campaignID: row.campaignID, at: Number(row.at) || 0};
          delete state.entries[row.journalID];
        }
        if (Object.keys(state.entries).length >= MAX_ENTRIES)
          return {status: "BLOCKED", reason: "WAR_CHEST_JOURNAL_FULL"};
      }
      const plan = planLevy({factionID, pilots, ledger, needCents});
      if (plan.status !== "FUNDED") return {status: "BLOCKED", reason: plan.reason, plan};
      const at = clock();
      if (!pos(at)) throw Error("WAR_CHEST_CLOCK_UNSAFE");
      const transactionIDs = plan.sources.map((_source, index) =>
        state.nextJournalID + index);
      if (state.nextJournalID + plan.sources.length >= Number.MAX_SAFE_INTEGER - 1)
        return {status: "BLOCKED", reason: "WAR_CHEST_JOURNAL_EXHAUSTED"};
      const entry = {journalID, phase: "PREPARED", at,
        factionID: Number(factionID), corporationID: Number(corporationID),
        warID, campaignID, totalCents: plan.totalCents,
        sources: plan.sources.map((source) => ({...source})), transactionIDs};
      // A chest that cannot be credited must never debit a pilot's real balance.
      if (!walletVerified(entry))
        return {status: "BLOCKED", reason: "NATIVE_CORPORATION_WALLET_UNVERIFIED"};
      state.entries[journalID] = entry;
      state.nextJournalID += plan.sources.length;
      writeJournal(state);
      const finished = apply(entry);
      if (finished.status !== "COMMITTED")
        return {status: "BLOCKED", reason: finished.reason, entry};
      commitEntry(state, entry, finished);
      return {status: "APPLIED", entry: state.entries[journalID], receipt: finished};
    } finally { busy = false; }
  }

  // Pays a real bounty from an already escrowed amount into the pilot's real
  // earned balance. Exactly once per payout id.
  function creditPilot({pilotID, cents: amount, eventID, reason = ""} = {}) {
    if (!enabled()) return {status: "DISABLED"};
    // FW-057: the escrow may be released to an NPC pilot or to a real player.
    if (!isWarPilotID(pilotID) || !pos(amount) || !key(eventID))
      return {status: "BLOCKED", reason: "INVALID_WAR_BOUNTY_CREDIT"};
    return adjustEarned({pilotID, cents: amount, eventID, reason});
  }

  // A PREPARED journal is a levy that may have debited its sources but never
  // credited the chest. Finish it from the recorded numbers; never re-plan.
  function recover() {
    if (!enabled()) return {status: "DISABLED"};
    if (busy) return {status: "BLOCKED", reason: "WAR_CHEST_REENTRANT"};
    busy = true;
    try {
      const state = readJournal();
      const pending = Object.values(state.entries).filter((entry) =>
        entry.phase === "PREPARED");
      const recovered = [];
      for (const entry of pending) {
        const finished = apply(entry);
        if (finished.status !== "COMMITTED") {
          recovered.push({journalID: entry.journalID, status: "BLOCKED",
            reason: finished.reason});
          continue;
        }
        commitEntry(state, entry, finished);
        recovered.push({journalID: entry.journalID, status: "COMMITTED"});
      }
      return {status: recovered.length ? "RECOVERED" : "CLEAN",
        pending: pending.length, recovered};
    } finally { busy = false; }
  }

  function snapshot() {
    if (!enabled()) return {status: "DISABLED"};
    const state = readJournal();
    return {status: "OK", entries: Object.values(state.entries).length,
      committed: Object.values(state.entries).filter((entry) =>
        entry.phase === "COMMITTED").map((entry) => ({journalID: entry.journalID,
          factionID: entry.factionID, corporationID: entry.corporationID,
          warID: entry.warID, campaignID: entry.campaignID,
          totalCents: entry.totalCents, walletAfterCents: entry.walletAfterCents,
          sources: entry.sources.map((source) => source.pilotID)}))};
  }

  return Object.freeze({fund, creditPilot, recover, snapshot, planLevy});
}

module.exports = {TABLE, CORP_PREFIX, JOURNAL_BASE, planLevy,
  validateJournal, createWarChestFunding};
