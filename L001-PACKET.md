# L-001 packet — journal read failure must not become successful recovery

Engine worktree: `O:\tmp\m002\fix` (read-only for the test author), SHA `4eb031c`.
Tests worktree: `O:\tmp\m002\tests`. Test command (cmd, not PowerShell):

    set EVEJS_FORK_ROOT=O:\tmp\m002\fix && cd /d O:\tmp\m002\tests && node --test tests/coop-native-wreck-transfer-journal-failclosed.test.mjs

## Exact source excerpts (from `Code/server/src/space/coopNativeWreckTransferGuard.js`)

    function pending() {
      try {
        return Object.values(read().entries).filter((entry) => entry.phase !== "SETTLED");
      } catch (error) {
        return [];
      }
    }

    function recover({ getWreckItem, listDestination, undoItems, restoreWreckItem } = {}) {
      if (typeof getWreckItem !== "function" || ...) {
        return { ok: false, errorMsg: "WRECK_TRANSFER_GUARD_RECOVERY_INCOMPLETE", resolved: [], blocked: [] };
      }
      const resolved = [];
      const blocked = [];
      const entries = pending();          // <- an unreadable journal becomes []
      for (const record of entries) { ... }
      return { ok: blocked.length === 0, resolved, blocked };   // <- ok:true with nothing done
    }

The canonical journal is `<filePath>.sqlite` (SQLite, opened by
`Code/server/src/space/coopNativeWreckTransferJournal.js`). `filePath()` comes from
`EVEJS_COOP_WRECK_TRANSFER_GUARD_FILE`. The `.json` file at `filePath` is only an operator mirror and
is **not** the canonical journal — corrupting it is not the case under test.

## Required behaviour (acceptance for the implementer)

1. An unreadable canonical journal must never be reported as an empty pending set.
2. `recover()` on an unreadable journal must not return `ok: true` and must not claim resolved/blocked
   success; the failure must be explicit (a thrown error carrying `WRECK_TRANSFER_GUARD_UNREADABLE`, or
   `{ok:false, errorMsg:"WRECK_TRANSFER_GUARD_UNREADABLE", ...}` — either is acceptable).
3. A readable but empty journal still recovers successfully (`ok:true`, `resolved:[]`, `blocked:[]`).
4. No recovery action may run against a journal that could not be read.

## Test fixture (reuse, do not invent)

`tests/coop-native-wreck-loot-crash.test.mjs` and `tests/coop-native-wreck-transfer-journal.test.mjs`
already contain the attested disposable gameStore fixture. Reuse that block; the store itself is not
what is being tested here.
