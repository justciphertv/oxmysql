# oxmysql

> A fork of [oxmysql](https://github.com/CommunityOx/oxmysql) using the [mariadb](https://www.npmjs.com/package/mariadb) connector and [worker threads](https://nodejs.org/api/worker_threads.html).
> Targets FXServer + MariaDB 10.5+ / MySQL 8+.

## Status

- Current release: **`3.2.0`**. See [`CHANGELOG.md`](CHANGELOG.md) for the full history.
- The public Lua / FiveM export surface is preserved 1:1 with upstream oxmysql. Existing resources using `MySQL.query`, `MySQL.single`, `MySQL.scalar`, `MySQL.insert`, `MySQL.update`, `MySQL.transaction`, `MySQL.startTransaction`, `MySQL.prepare`, `MySQL.rawExecute`, `MySQL.store`, the `mysql-async` aliases, and the `ghmattimysql` aliases work unchanged.
- Behaviour is pinned by a normative spec ([`docs/compat-matrix.md`](docs/compat-matrix.md)) and a 157-test vitest regression suite.

See [`MIGRATION.md`](MIGRATION.md) for the practical notes server owners need when swapping from upstream oxmysql. Short version:

- Add `add_unsafe_worker_permission oxmysql` to `server.cfg`.
- FXServer `node_version` requirement: `'22'` (set in generated `fxmanifest.lua`).
- MariaDB recommended; MySQL 8 supported.

## Install (server owners)

Download the release zip from the [releases page](https://github.com/justciphertv/oxmysql/releases), extract into `resources/` so you end up with `resources/oxmysql/`, add the worker-permission line above, restart. Confirm the version in the server console startup banner:

```
[<db version>] Database server connection established! [oxmysql-mariadb-patch <hash>]
[oxmysql-mariadb-patch <hash>] pool options applied: jsonStrings=true autoJsonMap=false bigIntAsNumber=true insertIdAsNumber=true
```

The `<hash>` is the short git commit the build was cut from. Useful when something looks off — if the hash printed doesn't match what you thought you installed, the extraction didn't take. Full deployment checklist + rollback in [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Configuration convars

The FXServer `convar_category 'OxMySQL'` lists every user-facing convar. Non-defaults:

| Convar | Default | Purpose |
|--------|---------|---------|
| `mysql_connection_string` | _(none)_ | Required. Connection URI or semicolon-delimited key=value. |
| `mysql_debug` | `false` | Boolean or JSON-array of resources. When truthy, profiler path runs and logs every query. |
| `mysql_ui` | `false` | In-game UI accessed via `/mysql` (ace `command.mysql`). |
| `mysql_slow_query_warning` | `200` | Threshold in ms for the slow-query console warning. |
| `mysql_log_size` | `100` | Per-resource query-log buffer size shown by the UI. |
| `mysql_transaction_isolation_level` | `2` (`READ COMMITTED`) | `1`=RR, `2`=RC, `3`=RU, `4`=SERIALIZABLE. |
| `mysql_logger_service` | _(none)_ | Optional `logger/<file>.js` or `@resource/path`. |
| `mysql_versioncheck` | `1` | Set `0` to suppress the GitHub release check. |
| `mysql_request_timeout_ms` | `0` *(disabled)* | **Fork-only.** When `> 0`, caps every worker request at this many milliseconds. `0` preserves the forever-pending default. |
| `mysql_init_retry_ms` | `30000` | **Fork-only.** Connection-retry interval during initial handshake. Clamped worker-side to `>= 1000`. |
| `mysql_start_transaction_propagate_errors` | `false` | **Fork-only (3.2.0+).** When `true`, `MySQL.startTransaction` throws on commit / rollback failures instead of silently returning `true`. Affects `startTransaction` / `endTransaction` only; `MySQL.transaction` is unchanged. See [compat-matrix §2.9.1](docs/compat-matrix.md). |
| `mysql_bit_full_integer` | `false` | **Fork-only (3.2.0+).** When `true`, `BIT(n > 1)` decodes as the full big-endian integer (prefers `number`, falls back to `bigint`) and `BIT(1) NULL` returns `null` instead of `false`. See [compat-matrix §4.4](docs/compat-matrix.md). |
| `mysql_bigint_as_string` | `false` | **Fork-only (3.x+).** When `true`, `BIGINT` values and `insertId` outside `Number.MAX_SAFE_INTEGER` (`2^53 - 1`) are returned as decimal strings; safe-range values stay as `number`. Flips the pool's `bigIntAsNumber` / `insertIdAsNumber` — takes effect on resource restart. See [compat-matrix §4.1 / §4.3](docs/compat-matrix.md). |
| `mysql_date_as_utc` | `false` | **Fork-only (3.x+).** When `true`, `DATE` columns parse as midnight UTC instead of midnight in the process-local timezone, giving DST-immune 24-hour deltas. `DATETIME` / `TIMESTAMP` are untouched. See [compat-matrix §5](docs/compat-matrix.md). |

## Events

The fork fires events consumers can subscribe to for monitoring:

```lua
AddEventHandler('oxmysql:error', function(data)
    -- data.phase: 'init' | 'worker' | 'worker-exit' | 'timeout' | (query error)
    -- data.message: human-readable string
    -- init: data.attempt, data.retryIntervalMs
    -- worker-exit: data.code
    -- timeout: data.action
end)

AddEventHandler('oxmysql:ready', function(data)
    -- Fires once after a successful handshake, when attempt > 1
    -- data.phase: 'init'
    -- data.attempt: the attempt number that succeeded
end)
```

The existing `oxmysql:error` and `oxmysql:transaction-error` events for query/transaction failures are unchanged from upstream.

## Development

**Requirements:**

- Node.js 22+ (runtime target).
- Docker with `docker compose` v2 (for the test fixture).
- Git.
- A Node package manager: [Bun](https://bun.sh) 1.1+ (recommended), or npm / pnpm.

**Bun is recommended** because the release workflows use it and the lockfile tracks Bun's resolution. Since `3.2.0`, [`scripts/postinstall.js`](scripts/postinstall.js) detects the installer via `npm_config_user_agent` and dispatches `bun bootstrap` or `lerna bootstrap` as appropriate, so `npm install` / `pnpm install` also work end-to-end. If you hit a contributor toolchain issue, open an issue.

**Workflow:**

```bash
bun install              # install deps + apply patch-package patches + bootstrap lerna workspace
bun run test:up          # bring up MariaDB fixture (docker compose)
bun run test             # run the full vitest suite against it
bun run test:down        # tear it down (tmpfs volume, instant)
bun run build            # produce dist/, regenerate fxmanifest.lua, build the web UI
```

Tests and compatibility spec live in [`tests/`](tests/) and [`docs/compat-matrix.md`](docs/compat-matrix.md). Every behavior change must update the matrix and land a regression test. See [`docs/testing.md`](docs/testing.md) for the full contributor workflow.

## Branches

- **`main`** — upstream-tracking baseline. Untouched by this fork's release flow; present only for ancestry.
- **`mariadb-patch`** — the fork's release line. Tags (`v3.2.0` and later) are cut from here. Pulls from upstream or backports land here first.
- **`beta`** — prerelease line. Tags matching `v*.*.*-beta.*`, `v*.*.*-rc.*`, etc. are cut from here and trigger [`.github/workflows/beta.yml`](.github/workflows/beta.yml) to build a GitHub prerelease.

## Links

- [Changelog](CHANGELOG.md) — fork version history.
- [Compatibility matrix](docs/compat-matrix.md) — normative behavior spec for every public export.
- [Migration notes](MIGRATION.md) — for server owners coming from upstream oxmysql.
- [Testing](docs/testing.md) — how to run the regression suite.
- [Troubleshooting](docs/troubleshooting.md) — deployment verification, common pitfalls.
- [Security policy](SECURITY.md) — reporting vulnerabilities, trust boundary.

## License

LGPL-3.0-or-later. See [`LICENSE`](LICENSE).
