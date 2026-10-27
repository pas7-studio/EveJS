# EveJS — pas7-studio continuation

This repository is **not** the upstream emulator. It is
[`pas7-studio/EveJS`](https://github.com/pas7-studio/EveJS), a diverged
continuation of [`gameboys84/EveJS`](https://github.com/gameboys84/EveJS).

- **Fork point:** `c3ea396` (`update Issue:001 for more information`), the last
  upstream commit we pinned to.
- **Our mainline:** branch `coop/pas7std`.
- **Divergence:** the co-op layer (mining, hauling, market, combat, war,
  missions, durability) plus ten native fixes. This is no longer a patch
  series on top of upstream — it is the engine we run.
- **Governance, tests, doctrine, evidence:** live in the companion repository
  [`pas7-studio/evejs-coop-universe`](https://github.com/pas7-studio/evejs-coop-universe).
  Every behavioural claim must be backed by evidence recorded there.

## Why we stopped being a patch set

Upstream is inactive, so "one atomic patch per fix, rebased onto a moving pin"
turned into a second, invisible copy of the server: hundreds of files existed
only as uncommitted working-tree edits. Taking over the fork makes the same
changes reviewable, bisectable and stable. Atomic patches are still kept in the
co-op repository, but only as **proposals** anyone can send upstream — never as
the way we ship our own code.

## Running it

```bash
cd Code
docker build -t evejs-local .
docker compose up -d                 # owner play stack: 443/5222/26000-26002/40110
```

Agents never disturb that stack: they use `compose.coop-probe.yaml` with the
`evejs-agents` project (ports `28443/25222/28000-28002/41110`, volumes
`evejs-agents-*`). See the co-op repository's `docs/TWO_STACKS_PLAY_AND_WORK.md`.

Everything stays local and loopback-bound. This fork contains no CCP client
binaries, no authentication workarounds and no redistributable game assets;
`LICENSE` is unchanged from upstream.
