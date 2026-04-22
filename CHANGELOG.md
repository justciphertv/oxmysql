# Changelog

All notable changes to this fork. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers are semver; minor bumps imply additive changes, patch bumps imply bug fixes, and major bumps would imply a break in the public Lua / FiveM export surface (none so far — the fork is strictly backward-compatible with upstream).

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
