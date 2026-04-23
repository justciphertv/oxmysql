# 3.3.0 landing plan

The four post-3.2.1 phases ship on branches that stack in order. This
document captures the integration order into `main`, the merge strategy
per branch, and the gating checks that must pass before each merge. It
is a release aid only — nothing in here is executable code.

## Branch graph

```
main (origin/main, tip: 32b41b0 chore: bump version to v3.0.1)
  │
  └── 89e6cc6  (Phase 0 baseline — 3.2.1 cleanup, already on main history)
       │
       └── 9ec1047  perf/instrumentation       (Phase 1)
            │
            └── a1e0821  perf/transaction-under-load   (Phase 2)
                 │
                 └── 1f2028b  perf/channel-overhead     (Phase 3)
                      │
                      └── c1c916f  compat/numeric-date-semantics   (Phase 4)
                           │
                           └── HEAD   release/3.3.0-landing        (Phase 5, this branch)
```

Each phase branch was pushed to origin and reviewed independently:

| Phase | Branch | Tip commit | Scope |
|------:|--------|-----------|-------|
| 1 | `perf/instrumentation` | `9ec1047` | Zero-cost `perf.ts` module + `bench/hotpath.ts` harness + rawQuery/rawExecute/rawTransaction instrumentation. |
| 2 | `perf/transaction-under-load` | `a1e0821` | Pool-contention characterisation, `docs/performance-tuning.md`, fixture `connectionLimit` 4→10, `resetPool` / `reinitHarness`, duplicate-timer drop. |
| 3 | `perf/channel-overhead` | `1f2028b` | Worker-handler instrumentation + `sendResponse` timer; `noop` / `perfSnapshot` / `perfReset` actions; `bench/channel.ts`; channel-overhead section in `docs/performance-tuning.md`. |
| 4 | `compat/numeric-date-semantics` | `c1c916f` | `mysql_bigint_as_string` + `mysql_date_as_utc` convars; flag-on tests; MIGRATION / README / compat-matrix updates. |
| 5 | `release/3.3.0-landing` | HEAD | Startup banner for correctness flags, smoke test, CI matrix, version bump, CHANGELOG, this doc. |

## Integration strategy

Recommend a **single squash-merge of `release/3.3.0-landing` into `main`** rather than merging each phase branch in turn. Rationale:

1. **Every intermediate branch passed the suite green** — the chain is linearly stacked and each branch's tip is the parent of the next. No cherry-picking or rebase-conflict resolution is needed.
2. **The five branches together land a coherent 3.3.0 release**, not five independent features. Bisection within the release is low-value because the flag-gates mean every behavioural change is off-by-default; a regression appears only when a flag is on, and the flag-on tests live in the same commit as the flag itself.
3. **`main` currently tracks upstream CommunityOx at `32b41b0`**, not the fork's 3.2.x release line. Squashing from the Phase 5 tip gives `main` a clean 3.3.0 commit that operators can point at for upgrade reference without having to traverse a five-commit arc.
4. **The phase branches are preserved on origin** for archaeology. `git log release/3.3.0-landing` shows the full arc; `git log main` shows the release.

Alternative — if the maintainer prefers a four-commit arc on `main` — is to **fast-forward merge each branch tip in order** (no squash). This preserves the per-phase commits but does not change content. Never use a multi-branch merge-commit strategy here; the branches are strictly linear.

## Pre-merge gating

Before merging `release/3.3.0-landing` → `main`:

- [ ] CI `test` job green on the branch tip (full 167-test suite).
- [ ] CI `smoke` matrix green on all four modes (`defaults`, `perf-trace`, `bigint-as-string`, `date-as-utc`).
- [ ] `bun run bench -- --connectionLimits=10 --concurrencies=16 --iterations=200` completes without crashing (smoke-level bench sanity).
- [ ] `bun run bench:channel -- --iterations=200` completes without crashing.
- [ ] `CHANGELOG.md` top entry is `[3.3.0]` with today's date.
- [ ] `package.json` version is `3.3.0`.
- [ ] `fxmanifest.lua` version is `3.3.0`.
- [ ] `MIGRATION.md` §1 / §2 reference the new convars (not "on the roadmap").
- [ ] `README.md` convar table lists both `mysql_bigint_as_string` and `mysql_date_as_utc`.
- [ ] `docs/compat-matrix.md` has no remaining `[PHASE-4]` markers in §4.1 / §4.3 / §5.

## Post-merge steps

1. **Tag the release:** `git tag -a v3.3.0 -m "3.3.0" <merge-commit>` on the tip of `main`.
2. **Push the tag:** triggers `release.yml`, which builds the zip and cuts a GitHub release.
3. **Archive the five feature branches:** they can remain on origin for reference or be deleted once the release is tagged — either is fine. No work depends on them after the tag.
4. **Spot-check the zip** has `version '3.3.0'` in its extracted `fxmanifest.lua` and that the banner line prints the correct build stamp when a test deployment starts.
5. **Announce** — one post pointing at the 3.3.0 CHANGELOG entry and the two new convars. Operators running at significant concurrency should also be pointed at `docs/performance-tuning.md`.

## Roll-back strategy

If a post-release regression surfaces:

1. **Flag-gated path:** instruct operators to unset the convar (`set mysql_bigint_as_string false` / `set mysql_date_as_utc false`) and restart the resource. Default-off means every 3.2.x deployment is one convar-flip away from identical pre-3.3.0 behaviour.
2. **Non-flag-gated regression** (instrumentation, bench, docs): unlikely to affect runtime correctness, but if one slips through, revert the squash merge commit on `main`, tag a `3.3.1` with the revert, and cut a new release. The five feature branches remain intact for a forward-fix.

## Out of scope

- Merging any of the phase branches independently to `main` without the CHANGELOG / version bump / smoke CI — these are not release-ready on their own.
- Rebasing the phase branches onto the current `main`. They already target the correct parent (`main` → `perf/instrumentation` → ... → this branch), so no rebase is needed.
- Cherry-picking individual commits from a phase branch into `main`. Each phase's tests assume the infrastructure from earlier phases (e.g. cluster 22 uses `reinitHarness` from Phase 2; the channel bench uses `perf.ts` from Phase 1).
