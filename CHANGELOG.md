# Changelog

All notable changes to this fork. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers are semver; minor bumps imply additive changes, patch bumps imply bug fixes, and major bumps would imply a break in the public Lua / FiveM export surface (none so far — the fork is strictly backward-compatible with upstream).

## [3.3.0] — 2026-04-23

Landing release for the four post-3.2.1 improvement phases: hot-path instrumentation, pool/transaction contention characterisation, parent↔worker channel measurement, and two opt-in correctness flags for the long-standing BIGINT / DATE defects. Every behavioural change is either zero-cost-when-off instrumentation or a convar-gated opt-in; pre-existing 3.2.x deployments see byte-for-byte identical behaviour on upgrade.

### Added

- **Public: `mysql_bigint_as_string` convar.** Default `false` preserves the pinned lossy `Number` coercion for `BIGINT` and `insertId`. When `true`, values in the `Number.MAX_SAFE_INTEGER` safe range stay as `number`; values outside come through as decimal strings (exact digits, no precision loss). Takes effect at worker init — flips the pool's `bigIntAsNumber` / `insertIdAsNumber`, so flipping the convar requires a resource restart. Covers both signed and unsigned BIGINT. See [compat-matrix §4.1 / §4.3 / §4.1.1](docs/compat-matrix.md).
- **Public: `mysql_date_as_utc` convar.** Default `false` preserves the historical local-timezone parse for `DATE`. When `true`, DATE columns parse as midnight UTC regardless of the FXServer host's timezone — DST-immune, 24-hour deltas always. Only affects `DATE`; `DATETIME` / `TIMESTAMP` / `TIME` / `YEAR` are unchanged. Takes effect at the next `typeCast` invocation; no pool rebuild needed. See [compat-matrix §5 / §5.1](docs/compat-matrix.md).
- **Operator-visible: one-shot startup banner when a correctness flag is on.** The worker prints a single green line listing the active opt-in flags (`mysql_bit_full_integer`, `mysql_bigint_as_string`, `mysql_date_as_utc`) whenever one or more is enabled. Silent under defaults so existing deployments see no new console output.
- **Internal: `OXMYSQL_PERF_TRACE=1` hot-path instrumentation.** A zero-cost-when-disabled `perf` module in `src/worker/utils/perf.ts` records per-phase `count / sum / max` for pool acquire, query execution, response shaping, transaction begin / batch / commit, and the parent↔worker channel spans. Disabled mode adds one conditional and one property read per instrumented site — measured zero effect on the vitest suite runtime. Aggregates are queryable via the new `perfSnapshot` / `perfReset` worker actions (bench-only; not on the FiveM export surface).
- **Internal: two benchmark harnesses.** `bench/hotpath.ts` drives representative workloads through the worker's raw code paths and sweeps pool sizes (`--connectionLimits`, `--concurrencies`); `bench/channel.ts` spawns a real `worker_threads` Worker and measures postMessage round-trip latency. Usage in [docs/performance-tuning.md](docs/performance-tuning.md); `bun run bench` and `bun run bench:channel`.
- **Internal: `docs/performance-tuning.md`.** Evidence-based operator guidance for pool sizing (with a measured connection-limit × concurrency matrix for the transaction scenario) and a parent↔worker channel characterisation showing the ~300 µs per-round-trip scheduling floor is below the worthwhile-to-optimise threshold.
- **Internal: CI smoke matrix.** A new `smoke` job in `.github/workflows/test.yml` runs `tests/smoke.test.ts` (shape-invariant sanity assertions) under four release-blessed modes — defaults, `OXMYSQL_PERF_TRACE=1`, `mysql_bigint_as_string=1`, `mysql_date_as_utc=1` — so unexpected interactions surface before the full suite. The existing `test` job remains the release gate.
- **Internal: 10 new regression tests.** `tests/22-bigint-as-string.test.ts` (6 tests, cluster 22, pool-reinit) covers safe-range number, over-range signed / negative string, NULL, and the insertId equivalents. `tests/06-dates.test.ts` gains a flag-on describe block (4 tests) covering DATE midnight UTC ms, DST-straddling 24h delta, NULL, and the "DATETIME is unaffected" guarantee. Total suite: 167/167 on MariaDB 11.
- **Internal: `tests/smoke.test.ts`.** 7 tests asserting flag-invariant properties (SELECT 1 = 1, INSERT+SELECT round-trip, prepared SELECT, DATE round-trip finite, 2x-insert transaction commits both rows, NULL preservation, BIGINT > 2^53 behaves per the current flag state).

### Changed

- **Phase 2 — transaction code kept as-is, pool tuning documented.** The Phase 2 connection-limit sweep showed pool contention dominates transaction latency at `concurrency > connectionLimit` (~13 ms of queue wait per op at `connectionLimit=4, concurrency=16`) and collapses to ~25 µs when sized correctly. The measured transaction floor (~8.3 ms = three serial MariaDB round-trips) cannot be reduced without a connector-level protocol change. No transaction-code refactor was applied; guidance lives in [docs/performance-tuning.md](docs/performance-tuning.md) instead.
- **Fixture `connectionLimit` bumped from 4 to 10** ([tests/helpers/env.ts](tests/helpers/env.ts:26)) to match the mariadb connector's production default. The pre-bump `4` made Phase 1 pool-wait numbers look pessimistic vs any realistic deployment. All 157 pre-bump tests continue to pass.
- **`resetPool()` / `reinitHarness()` introduced** for bench/test pool-options sweeps. The production `pool?.end()` path in `onResourceStop` is unchanged.
- **`rawTransaction` duplicate timer removed.** The `rawTransaction:getConnection` phase measured the same span as `getConnection:pool.getConnection` within timing noise (~5 µs). Dropped to keep perf reports uncluttered.

### Fixed

- **`BIGINT` / `insertId` precision above 2^53 (opt-in).** With `mysql_bigint_as_string = true`, the previously-silent truncation at the IEEE-754 safe boundary no longer occurs — values are either preserved exactly as `number` (safe range) or as decimal string (over range). Default-off preserves the pinned 3.1.0 / 3.2.x behaviour.
- **DST-visible delta on adjacent DATE rows (opt-in).** With `mysql_date_as_utc = true`, `DATE` arithmetic is flat 24-hour regardless of the process timezone. Default-off preserves the pinned 3.1.0 / 3.2.x behaviour.
- **mariadb field-type name for BIGINT.** The typeCast branch uses `'BIGINT'` (mariadb's name), not `'LONGLONG'` (the mysql2 name). An in-code comment records this to prevent the same mistake on future connector upgrades.

### Housekeeping

- `src/worker/utils/events.ts` — `sendResponse` is conditionally instrumented with `channel:worker.postResponse` (zero cost when `OXMYSQL_PERF_TRACE` is unset).
- `src/worker/worker.ts` — handler span recorded as `channel:worker.handler`; three diagnostic actions (`noop`, `perfSnapshot`, `perfReset`) added for bench use. They are not exposed through any FiveM export.
- `docs/compat-matrix.md` — `[PHASE-4]` markers on §4.1 / §4.3 / §5 replaced with `[PINNED by tests/…]` references; new §4.1.1 and §5.1 tables document flag-off vs flag-on contracts side-by-side.
- `MIGRATION.md` §1 / §2 — now point at the opt-in fixes instead of describing them as roadmap items.

### Pinned defects (still deliberate under defaults)

With the BIGINT and DATE opt-ins landed, the only remaining pinned defects under defaults are the BIT trio covered by `mysql_bit_full_integer` (3.2.0+). Every pinned defect in the 3.1.0 / 3.2.0 entries either shipped a fix or has an active opt-in.

### Migration

No manual migration required. All four convars (`mysql_start_transaction_propagate_errors`, `mysql_bit_full_integer`, `mysql_bigint_as_string`, `mysql_date_as_utc`) default to the historical behaviour. Operators who want the correctness fixes should review [MIGRATION.md](MIGRATION.md) §1 and §2 — both carry the exact convar snippets and flip-time semantics. Operators who want perf telemetry should review [docs/performance-tuning.md](docs/performance-tuning.md) and set `OXMYSQL_PERF_TRACE=1` in the environment.

---

## [3.2.1] — 2026-04-22

Post-3.2.0 review pass + release-workflow hardening. Zero consumer-facing behaviour changes; every line in this release is either documentation, robustness, or CI infrastructure.

### Fixed

- **`Symbol.dispose` on `MySql` no longer fire-and-forgets `commit()`.** The sync dispose hook previously started a `commit()` promise and then called `release()` immediately, which could race the commit against the next pool borrower and — separately — was unsafe semantics for an unexpected-exit path (committing a partial transaction of unknown state). Dispose now treats any still-open transaction at dispose time as tainted and destroys the connection instead of releasing it. Unreachable under current rawTransaction / startTransaction flows; the safety net now has correct semantics.
- **`oxmysql:fetchResource` NUI handler no longer throws on a missing resource name + non-empty search term.** Hoisted the `logStorage[data.resource]` lookup ahead of the filter branch; a missing bucket short-circuits cleanly instead of calling `.filter()` on `undefined`. Ace-gated handler; the previous symptom was one console error per bad request.
- **`oxmysql_debug` command robust against a malformed `mysql_debug` convar.** Operators who had previously run `set mysql_debug "true"` (or any non-array JSON) would crash `oxmysql_debug add` at `arr.push`. The command now decodes the convar inside a try/catch with an `string[]` shape check, falls back to an empty list with a visible diagnostic on parse or shape failure, and validates the `<resource>` argument on both `add` and `remove`.

### Changed

- **Release workflow migrated off the deprecated `marvinpinto/action-automatic-releases@v1.2.1`** to `softprops/action-gh-release@v2`. Node 20 is scheduled for removal from GitHub Actions runners mid-2026; the replacement runs on Node 24. `fail_on_unmatched_files: true` added so a missing `oxmysql.zip` surfaces as a failed workflow run rather than an empty release.
- **`pre-release.yml` retired.** The manual-dispatch workflow still carried the default-branch-checkout + commit-back + tag-move recipe that corrupted `main` when the `v3.2.0` tag was first pushed. `beta.yml` now covers every prerelease path with the hardened post-incident recipe, triggered automatically on `v*.*.*-*` tag pushes.
- **README refresh** for the `3.2.0` surface area: current-version status line, expanded convar table (`mysql_start_transaction_propagate_errors`, `mysql_bit_full_integer`), the banner's second pool-options line, a new Events section with Lua handler snippets for `oxmysql:error` / `oxmysql:ready`, a Branches section mapping `main` / `mariadb-patch` / `beta` to their roles, and a link to `SECURITY.md`.
- **`IsPlayerAceAllowed` call in the NUI handler uses `String(source)`** instead of a `source as unknown as string` double-cast. Typed-bridge cleanup only; no runtime behaviour change.

### Housekeeping

- `tests/18-graceful-shutdown.test.ts` — runtime complement to the source-level shutdown checks was attempted but deferred; vitest module-graph semantics around pool.ts's `export let pool` live binding prevent `vi.spyOn` from intercepting the `await pool?.end()` call inside the worker. The source-level tests still pin the ordering contract. Rationale captured in-file for a future pass.

### Workflow / security notes

- The `v3.2.0` tag on origin now points at commit `f56c049`, which is where the first release was meant to be before the destructive upstream-inherited workflow rewrote it. `main` was reset back to the pre-fork baseline (`32b41b0`) as part of the cleanup; it remains untouched by the fork's release line.

---

## [3.2.0] — 2026-04-21

This release closes every High- and Medium-severity audit item opened in Phase 1 that was deferred out of 3.1.0, plus every Phase-6 post-audit finding. All consumer-facing behaviour changes land either unconditionally as correctness fixes (no consumer was getting the right answer before) or behind a convar flag defaulting to `false` (the 3.1.0 pinned behaviour is preserved on upgrade). No public Lua / FiveM export signatures, return shapes, or alias maps have narrowed; every pre-3.2.0 consumer continues to work unchanged.

The compatibility spec in [`docs/compat-matrix.md`](docs/compat-matrix.md) has been updated section-by-section to reflect the new contracts; every behavioural change cross-references a regression test.

### Added

- **Public: `mysql_fetch` alias in the `mysql-async` export surface.** `single → mysql_fetch` was shipped by the original `mysql-async` package for a long time and some legacy resources still reference it. Additive; consumers that never used it are unaffected.
- **Public: `insert`, `update`, `single` aliases on the `ghmattimysql` export surface.** Restores the full upstream-ghmattimysql export set. Additive.
- **Public: `mysql_start_transaction_propagate_errors` convar.** Default `false` preserves the 3.1.0 behaviour (commit / rollback errors in `MySQL.startTransaction` are swallowed; the function returns a boolean). When `true`, a failed `beginTransaction` / commit / rollback throws an `Error` containing the invoking resource, phase, and worker-reported reason. **Scope:** affects only `MySQL.startTransaction` / `endTransaction`. `MySQL.transaction` and every other API are unchanged.
- **Public: `mysql_bit_full_integer` convar.** Default `false` preserves 3.1.0 BIT semantics. When `true`, `BIT(n > 1)` decodes as the full big-endian integer (prefers `number` up to `Number.MAX_SAFE_INTEGER`, falls back to `bigint` beyond) and `BIT(1) NULL` returns `null` instead of `false`. BIT(1) non-null still returns `boolean` under both flag states.
- **Internal: port-validation diagnostics on `mysql_connection_string`.** Malformed or out-of-range ports in URI form (`mysql://user@host:abc/db`, `…:70000/db`, `…:0/db`) now print a yellow warning to the FXServer console. Effective pool behaviour unchanged (mariadb still defaults to 3306); misconfiguration is just visible now.
- **Internal: startup sanity check for the `named-placeholders` patch.** The worker exits with code 1 and emits `oxmysql:error` with `phase: 'init'` if the patched `@`-prefix / missing-key-as-null contract is not active. `named-placeholders` is now pinned to exact `1.1.3` so `patch-package` cannot silently no-op on a minor bump.
- **Internal: 37 new regression tests across clusters 15–21** covering worker lifecycle, connection-string parsing, init telemetry, graceful shutdown, DIAG cache, and the named-placeholders patch contract. Total suite: 157/157 on MariaDB 11.
- **`SECURITY.md`** describing the fork's trust boundary (unsafe-worker permission grant, `mysql_logger_service` JS load, `mysql_debug` log buffers) and the private security-advisory report channel.
- **Cross-runner `postinstall`** via `scripts/postinstall.js` — `npm install` / `pnpm install` no longer fail at the postinstall step because the Bun binary is missing from PATH. Bun remains the documented recommended contributor toolchain.
- **Fork-identity-refreshed issue templates** with build-stamp capture and a compatibility-impact checklist.

### Changed

- **H10 — `executeType` is now case-insensitive and tolerates leading whitespace.** `MySQL.prepare('insert into …', [[…]], true)` returns a numeric `insertId` like the uppercase form. Consumers writing lowercase DML through `prepare` were getting garbage from the SELECT-unpack path under 3.1.0; this fix aligns with compat-matrix §6.2 and is not reachable as a regression for any currently-correct caller.
- **M1 — `MySQL.startTransaction` 30s timeout race is closed.** An `AbortController` on the parent side + a `closed` flag / `waitUntilIdle()` on the worker side together guarantee that:
  - no new `queryFn` starts on a torn-down connection;
  - no `endTransaction` commit / rollback runs while an in-flight query is on the same connection;
  - a query response that lands after the timeout is discarded and the caller sees the abort error.
  Unconditional correctness fix (no flag).
- **M12 — `typeCast` uses a top-level `import` instead of a lazy `require`.** Uniform module-loading style; survives a future switch to native ESM emission.
- **M13 — `case 'shutdown':` in the worker dispatch uses an explicit unreachable `return`** after `process.exit(0)` so a future case appended below it cannot fall through.
- **M14 — Worker `initialize` is idempotent.** A second `initialize` message after pool is set re-applies the mutable config fields (isolation level, named placeholders, BIT flag, debug) but does not re-enter the retry loop. A second message while a retry loop is still running is ignored with a visible console warning.
- **H1 — `readConfig` no longer polls.** `AddConvarChangeListener('mysql_*', …)` replaces the 1-second `setInterval`. Worker traffic on config drops from ~86k messages/day to near-zero. A 1s poll remains as a fallback for FXServer artifacts that predate the native — never triggered on the `/server:12913+` the manifest declares.
- **O4 — `diag_enabled` cached on the config/update path.** The per-call IIFE in `typeCast` is replaced by a single property read against a cached boolean that `updateConfig` recomputes on any convar change.
- **O5 — `fxmanifest.lua` written after esbuild succeeds.** A failed build no longer leaves a version-bumped manifest next to stale bundles.

### Fixed

- **M2 (flag-gated) — commit / rollback errors in `endTransaction` propagate** when `mysql_start_transaction_propagate_errors = true`. The worker always returns `{ result: true } | { error: string }`; the parent side dispatches via `sendToWorker` (request-response) under flag-on and `emitToWorker` (fire-and-forget, 3.1.0-identical) under flag-off. A failed commit / rollback destroys the tainted connection rather than returning it to the pool.
- **M5 — `parseUri` port is no longer silently `NaN`.** Invalid or out-of-range ports are now `undefined` (so mariadb uses its 3306 default cleanly) with a console warning.
- **H11 / M7 — incomplete `mysql-async` / `ghmattimysql` alias maps.** Restored in the Added section above.
- **L3 — `named-placeholders` patch status is verified.** Exact version pin + startup sanity check prevents silent regressions on dependency updates.
- **O1 — `WorkerChannel.handleExit` drain is robust to callback errors.** A throw from one pending entry's `onSynthesizedError` callback no longer prevents the remaining pending entries from settling.
- **M9 — Bun coupling in `postinstall`.** Cross-runner script; Bun retained as recommended, npm / pnpm / yarn no longer fail.

### Pinned defects (carried forward from 3.1.0 — all closed in this release)

Every pinned defect from the 3.1.0 entry below is either fixed unconditionally, fixed behind a convar, or has a clear cross-reference. The current list of deliberate pinned behaviours under the defaults is shorter:

- `BIGINT` / `insertId` above 2^53 precision loss (`bigIntAsNumber` / `insertIdAsNumber` pool options). Opt-out path remains on the roadmap but is not scheduled for a `3.x`.
- `DATE` column local-timezone parsing. Run with `TZ=UTC` for DST-safe arithmetic; documented in [MIGRATION.md](MIGRATION.md) §2.

### Housekeeping

- `lib/package.json` — dead `prepublish: tsc` script removed.
- `tests/fixtures/schema.sql` — `t_uids` now carries an inline header comment explaining the `TRUNCATE` / `AUTO_INCREMENT` reseed requirement that bit us in Phase 4.
- Inherited issue templates rewritten for the fork identity.
- `3.1.0` entry dated.

### Migration

No manual migration required. `convar` defaults preserve 3.1.0 behaviour. Operators who want the opt-in improvements should review the two new convars and the existing `mysql_request_timeout_ms` / `mysql_init_retry_ms` flags from 3.1.0 — see [MIGRATION.md](MIGRATION.md) §2 and §3.

---

## [3.1.0] — 2026-04-21 — first formal fork release

This version consolidates every change that distinguishes this fork from the CommunityOx `3.0.1` baseline. All previous in-development builds (`b905fcc`, `62ea5ad`, `086a6b9`, `eaca0d4`, `8b22286`, `0d4e2ab`, `cc40a4f`) are pre-releases rolled up here.

### Added

- **Compatibility spec.** Normative behavior document at [`docs/compat-matrix.md`](docs/compat-matrix.md) pinning the exact shape of every public export, placeholder handling, numeric coercion (BIGINT / DECIMAL / BIT / insertId), date-time handling, transaction semantics, and alias maps.
- **Regression harness.** 120 vitest tests across 18 clusters running against a disposable MariaDB 11 container (see [`docs/testing.md`](docs/testing.md)). Covers worker internals directly — no parallel shaping logic.
- **CI workflow.** `.github/workflows/test.yml` runs the suite on every PR and non-main push.
- **Build stamp.** The "Database server connection established" banner now includes `[oxmysql-mariadb-patch <git-short-hash>]` and a second line listing the pool options that were actually applied. Makes deployment drift diagnosable in seconds rather than rounds.
- **Graceful shutdown.** `onResourceStop` handler flushes `pool.end()` and exits cleanly. Stops orphan MariaDB sessions between hot-restarts.
- **Worker-exit observability.** The worker process dying no longer hangs every pending query. Exit is logged, an `oxmysql:error` event with `phase: 'worker-exit'` fires, and all in-flight requests resolve with `{ error }` payloads.
- **Worker-dispatch safety.** The `parentPort` message handler body is wrapped in try/catch. A malformed payload or unexpected throw in any action arm is now a per-request `{ error }` response plus a console diagnostic, not a worker crash.
- **Init retry telemetry.** Every failed `createConnectionPool` attempt prints a visible retry line and fires an `oxmysql:error` event with `phase: 'init'`, `attempt`, `retryIntervalMs`. On success after multiple attempts, an `oxmysql:ready` event fires.
- **Two new convars:**
  - `mysql_request_timeout_ms` — opt-in per-request timeout (default `0` = disabled, preserves the pinned §10.3 contract).
  - `mysql_init_retry_ms` — tunable connection retry interval (default `30000`, clamped `>= 1000` worker-side).
- **Exposed convars in fxmanifest.** Every consumer convar (`mysql_ui`, `mysql_slow_query_warning`, `mysql_log_size`, `mysql_versioncheck`, `mysql_transaction_isolation_level`, `mysql_logger_service`) now appears in the `convar_category` block so txAdmin surfaces them.

### Changed

- **JSON columns return as strings.** Three independent defenses layered into the code:
  - Pool options: `jsonStrings: true`, `autoJsonMap: false`.
  - `typeCast` BLOB/TEXT branch classifies "is binary" by collation id 63 (the canonical `binary` collation), not by the MySQL column-level `BINARY` flag (`0x80`). The old flag check matched JSON columns (stored internally as `utf8mb4_bin`) and spread their bytes into a `number[]` array — Lua then saw them as tables, breaking `json.decode`.
  - Explicit `case 'JSON'` in `typeCast` covers the MySQL 8 / MariaDB 10.5+ `FieldType.JSON` path where `autoJsonMap` is ignored.
- **Early queries wait for the pool.** The fast path in `rawQuery` and `rawExecute` now calls `awaitPool()` before any `pool!.query` / `pool!.batch`. Previously, resources that fired schema migrations at load (qbx_core, ox_doorlock) hit a null-dereference crash when they dispatched before the first handshake completed. Documented in compat-matrix §10.3.
- **`startTransaction` experimental warning once.** Previously printed on every invocation; now prints once per process lifetime.
- **Error surface for worker issues** now flows through `oxmysql:error` events with a `phase` field (`'init'`, `'worker'`, `'worker-exit'`, `'timeout'`) rather than silent logs only.
- **Metadata repointed.** `package.json`, `lib/package.json`, and the update-checker URL all target `justciphertv/oxmysql` instead of upstream. Update-check still runs (disable with `set mysql_versioncheck 0`).
- **Release workflow hardened.** Removed the inherited `github.actor_id != 210085057` gate and the `npm publish --access public` step (the fork does not own `@communityox` on npm).

### Fixed

- **Null-pool fast-path race.** `rawQuery` / `rawExecute` dereferenced `pool!` unconditionally before the first handshake; consumers hit `Cannot read properties of null (reading 'query')`. Now blocks until the pool is live.
- **JSON columns delivered as Lua tables.** Fixed via the three-layer defense above. Affected every `json.decode(row.coords)` / equivalent in consumer resources (qbx_properties, qbx_spawn, many others).
- **Tainted connection reuse after rollback failure.** When `connection.rollback()` threw, the connection was still returned to the pool. Now marked `.failed = true` and destroyed on dispose.

### Pinned known defects (not fixed in 3.1.0 — deliberate)

These are all covered by the regression suite; they behave identically to upstream oxmysql. Fixes require coordinated matrix + test + code changes and will ship in a later release.

- **H6 (`typeCast.ts`)** — `BIT(n > 1)` truncates to the first byte. `BIT(16)` with value `b'1000000000000001'` returns `128`, not `32769`.
- **H6b (`typeCast.ts`)** — `BIT(1)` NULL returns `false` (not `null`), because `column.buffer()?.[0] === 1` evaluates to `false` when `buffer()` is null.
- **H8 (`pool.ts` options)** — `BIGINT` values and `insertId` above `2^53 - 1` lose precision because `bigIntAsNumber: true` / `insertIdAsNumber: true` are set. Matches upstream's historical contract; a `BigInt`/`string` mode is a future opt-in.
- **H10 (`parseExecute.ts`)** — `executeType()` matches only uppercase `INSERT `/`UPDATE `/`DELETE `. Lowercase DML passed through `MySQL.prepare` is classified as SELECT.

### Dependencies

- Runtime: `mariadb@^3.5.2` (replaces upstream's `mysql2`), `named-placeholders@^1.1.3` (patched), `node-fetch@^3.3.2`.
- Contributor: Bun, Docker (tests only), Node 22.

### Security

No security-sensitive changes in this release. The `BINARY` collation check fix narrows the number-array return path — if your consumer code was relying on arbitrary TEXT columns arriving as `number[]`, verify before upgrading. This path is only hit for columns with collation id 63 (`binary`), which is not set by default for any standard character-set declaration.
