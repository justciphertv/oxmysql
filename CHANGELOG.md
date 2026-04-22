# Changelog

All notable changes to this fork. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers are semver; minor bumps imply additive changes, patch bumps imply bug fixes, and major bumps would imply a break in the public Lua / FiveM export surface (none so far — the fork is strictly backward-compatible with upstream).

## [3.1.0] — first formal fork release

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
