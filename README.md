# oxmysql

> A fork of [oxmysql](https://github.com/CommunityOx/oxmysql) using the [mariadb](https://www.npmjs.com/package/mariadb) connector and [worker threads](https://nodejs.org/api/worker_threads.html).
> Targets FXServer + MariaDB 10.5+ / MySQL 8+.

## Status

- `3.1.0` — first formal fork release.
- The public Lua / FiveM export surface is preserved 1:1 with upstream oxmysql. Existing resources using `MySQL.query`, `MySQL.single`, `MySQL.scalar`, `MySQL.insert`, `MySQL.update`, `MySQL.transaction`, `MySQL.startTransaction`, `MySQL.prepare`, `MySQL.rawExecute`, `MySQL.store`, the `mysql-async` aliases, and the `ghmattimysql` aliases work unchanged.
- Behaviour is pinned by a normative spec ([`docs/compat-matrix.md`](docs/compat-matrix.md)) and a 120-test vitest regression suite.

See [`MIGRATION.md`](MIGRATION.md) for the practical notes server owners need when swapping from upstream oxmysql. Short version:

- Add `add_unsafe_worker_permission oxmysql` to `server.cfg`.
- FXServer `node_version` requirement: `'22'` (set in generated `fxmanifest.lua`).
- MariaDB recommended; MySQL 8 supported.

## Install (server owners)

Download the release zip, extract into `resources/` so you end up with `resources/oxmysql/`, add the worker-permission line above, restart. Confirm the version in the server console startup banner:

```
[<db version>] Database server connection established! [oxmysql-mariadb-patch <hash>]
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
| `mysql_request_timeout_ms` | `0` *(disabled)* | **Fork-only.** When `> 0`, caps every worker request. `0` preserves the pre-Phase-5 forever-hang contract. |
| `mysql_init_retry_ms` | `30000` | **Fork-only.** Connection-retry interval. Clamped worker-side to `>= 1000`. |

## Development

**Requirements:**

- Node.js 22+ (runtime target)
- [Bun](https://bun.sh) 1.1+ (contributor toolchain — used for `bun install`, `lerna` bootstrap, and the build pipeline via `build.js`)
- Docker with `docker compose` v2 (for the test fixture)
- Git

> **Bun is a hard contributor requirement.** The `postinstall` script runs `patch-package && bun bootstrap`, and the release workflows install Bun before calling `bun run build`. `npm install` / `pnpm install` will not work end-to-end without reworking the dependency graph around the legacy `lerna@4` monorepo layout. If decoupling from Bun is valuable to you, open an issue — it's on the backlog but not yet prioritized.

**Workflow:**

```bash
bun install              # install deps + apply patch-package patches + lerna bootstrap
bun run test:up          # bring up MariaDB fixture
bun run test             # run the full vitest suite against it
bun run test:down        # tear it down (tmpfs volume, instant)
bun run build            # produce dist/, regenerate fxmanifest.lua, build the web UI
```

Tests and compatibility spec live in [`tests/`](tests/) and [`docs/compat-matrix.md`](docs/compat-matrix.md). Every behavior change must update the matrix and land a regression test. See [`docs/testing.md`](docs/testing.md) for the full contributor workflow.

## Links

- [Compatibility matrix](docs/compat-matrix.md) — normative behavior spec for every public export.
- [Testing](docs/testing.md) — how to run the regression suite.
- [Migration notes](MIGRATION.md) — for server owners coming from upstream oxmysql.
- [Troubleshooting](docs/troubleshooting.md) — deployment verification, common pitfalls.
- [Changelog](CHANGELOG.md) — fork version history.

## License

LGPL-3.0-or-later. See [`LICENSE`](LICENSE).
