# M002-A — durable journal concurrency: contract for the implementer

Read this file completely before touching code. It replaces a full read of the task brief; you still
need to read `Code/server/src/space/coopNativeWreckTransferGuard.js` (≈300 lines) once.

## 1. What the journal is

Every native wreck pickup opens a durable intent, does two independent store writes (inventory grant,
wreck-source debit), and closes the intent. The intent lives in a small journal file so that a crash
between the two writes can be resolved on the next boot.

- Journal path: `process.env.EVEJS_COOP_WRECK_TRANSFER_GUARD_FILE`, else
  `<EVEJS_GAMESTORE_DATA_DIR>/../coop-wreck-transfer-guard.json` (`filePath()`).
- Callers: `Code/server/src/space/npc/nativeNpcWreckService.js` — `begin`, `finish`,
  `recoverNativeWreckTransfers()` (which calls `recover`). Tests call all four.
- The journal is also read by `pending()` for tests and diagnostics.

## 2. What the code does today (facts, with the exact places)

- `begin(fields)` (line ≈157): acquires a per-item lock (`acquire(wreckItemID)`), then
  `read()` → add one entry → `write()`.
- `finish(id)` (≈202): `read()` → replace the entry with a `SETTLED` tombstone → `pruneSettled` →
  `write()` → `release(wreckItemID)`.
- `recover(callbacks)` (≈264): `read()` (via `pending()`), and for every pending entry it acquires the
  item lock, decides, and calls `finish(...)`.
- `read()` (≈126) reads and `JSON.parse`s the whole file; `write()` (≈142) writes a temp file,
  `fsync`s it, then `rename`s it over the journal.

## 3. The concurrency guarantee that exists, and the one that does not

Per item: `acquire(wreckItemID)` (≈64) creates `journalPath + ".lock-" + wreckItemID` with
`openSync(..., "wx")`, writes the owner pid into it, and only steals it when the owner pid is dead
(`ownerAlive`, ≈53) or when the file has no pid and is older than `EMPTY_LOCK_GRACE_MS` (5000 ms).
So **the same item cannot be picked up twice concurrently**.

Per journal file: **there is no exclusion at all**. Every mutator is read-modify-write of the whole
file, and `rename` only guarantees that a reader never sees a half-written file — it does not
guarantee that a writer does not overwrite a concurrent writer's change:

    process A: read {e1}            process B: read {e1}
    process A: write {e1, a}        process B: write {e1, b}   <- a is gone
    both callers were told ok:true

`finish` and `recover` have the same shape, so a concurrent `finish(b)` can also drop `a`.

## 4. Required invariants (all must hold under concurrent processes)

- **I1 no lost intent** — after `begin` returns `{ok:true}`, that record is durable and stays present
  until `finish`/`recover` removes or tombstones it, no matter what other processes do to other items.
- **I2 no lost settle** — a `finish(id)` that returns `{ok:true}` is durable; a concurrent mutator on a
  different id cannot resurrect or drop it.
- **I3 crash durability** — a `SIGKILL` immediately after `begin` returns leaves the record readable
  after restart.
- **I4 ownership** — two live processes never hold the same item lock; a lock owned by a live process is
  never stolen; a lock whose owner is dead is reclaimable; a lock with no pid yet is owned while young;
  a pid that is alive but is not the owner must not be treated as proof of anything else.
- **I5 recovery safety** — `recover` must not remove or rewrite a record whose item another live process
  is currently working on, and must not lose a record written concurrently with it.
- **I6 bounded growth** — the journal cannot grow without bound (settled entries are pruned; pending
  entries are capped).
- **I7 no torn reads** — a reader never observes truncated/invalid JSON, including while another process
  is writing.

## 5. API contract (must not change; the service and 35 tests depend on it)

    begin(fields) -> {ok:true, id:<int>, record:{...}} | {ok:false, errorMsg:"<CODE>"}
    finish(id)    -> {ok:true, alreadyGone?:true} | {ok:false, errorMsg:"<CODE>"}
    pending()     -> [record, ...]            // pending only, never tombstones
    recover({getWreckItem, listDestination, undoItems, restoreWreckItem})
                  -> {ok:boolean, resolved:[id], blocked:[id]}
    filePath()    -> string

Error codes the service maps today: `WRECK_TRANSFER_BUSY` (item lock held → the service reports
`WRECK_TRANSFER_GUARD_UNAVAILABLE`), `ITEM_NOT_FOUND` (settled tombstone → the service reports
`ITEM_NOT_FOUND`), `WRECK_TRANSFER_GUARD_FULL`, `WRECK_TRANSFER_GUARD_INVALID`,
`WRECK_TRANSFER_GUARD_UNAVAILABLE`, `WRECK_TRANSFER_GUARD_UNREADABLE` (journal unreadable).

Record shape (unchanged): `{id, characterID, wreckID, wreckItemID, typeID, singleton,
destinationLocationID, destinationFlagID, quantityBefore, quantity, destinationBefore:[{itemID,
quantity}], phase:"PENDING"|"SETTLED", startedAt, settledAt?}`.

## 6. Architecture: repository evidence

You may pick the mechanism, but it must be justified by what the repository already contains:

- `better-sqlite3` is a runtime dependency (`Code/server/package.json`) and is already used through
  `Code/server/src/gameStore/sqliteStore.js`; the game store exposes a transactor
  (`coopAtomicNativeRows.claimTransactor`, consumed by `src/space/coopGameStoreAtomic.js`) whose
  `transact(tables, mutation)` path is **gated by `EVEJS_COOP_NATIVE_ATOMIC_ROWS=1`** and operates on
  the game database tables.
- The journal is a side file, not a game table. A dedicated SQLite file next to it (for example
  `<journal>.sqlite`, `journal_mode=WAL`, `busy_timeout`, `BEGIN IMMEDIATE` transactions, one row per
  intent) is therefore available without a new dependency and without coupling to the env-gated game
  store path. A hand-rolled cross-process mutex around the JSON file is the alternative; if you choose
  it, it must be correct for crash, stale owner and lost-update cases and you must say why it is safer
  than SQLite here.

Whatever you choose, these stay true: the same public API, the same record shape, the same error codes,
JSON-or-SQLite is an implementation detail invisible to the service, and `filePath()` keeps returning a
path the tests can inspect.

## 7. Scope

- Change only `Code/server/src/space/coopNativeWreckTransferGuard.js` and, if you need it, one new
  module in the same directory. **Do not touch** `nativeNpcWreckService.js`, `itemStore`,
  `nativeNpcStore`, or any test file.
- No new dependencies. Windows and Linux must both work. Node 22/24, CommonJS.

## 8. Acceptance (the reviewer runs these)

1. `tests/coop-native-wreck-transfer-journal.test.mjs` (written by the test owner, not by you) passes:
   concurrent begins of different items keep every intent; concurrent begin+finish keep both effects;
   `SIGKILL` right after `begin` leaves the intent; a live owner's lock is not stolen; a dead owner's
   lock is reclaimed; a fresh pid-less lock is not stolen and an old one is reclaimed; recovery skips an
   item another live process holds; the journal parses after N concurrent writers.
2. Those same tests fail on `218b72e` (the defective baseline). They are expected to be red before your
   change — that is the reproduction.
3. The 35 existing `coop-native-wreck-loot-*.test.mjs` tests stay green, and the 841-test regression set
   (wreck/custody/salvage/loot/inventory/economy/trade) stays at 0 failures.
4. No behaviour change visible to the service: same error codes, same record shape, same recovery
   decisions.

## 9. Out of scope

M002-B (transfer provenance that survives moves and sales) is a separate assignment. Do not add markers
to items, do not change how the grant is performed, and do not change recovery decisions in this task.
