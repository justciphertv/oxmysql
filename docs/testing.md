# Running the regression tests

The Phase 4 regression suite enforces the behavior pinned in
[`compat-matrix.md`](./compat-matrix.md). It runs against a real MariaDB
instance; the default setup uses the disposable container defined in
[`tests/compose.yml`](../tests/compose.yml).

## Requirements

- Node.js 22+
- Docker (with `docker compose` v2)
- Dependencies installed: `bun install` or `npm install`

## One-shot run

```bash
bun run test:up    # bring the MariaDB container up and wait for healthy
bun run test       # vitest run
bun run test:down  # tear it down (data volume is tmpfs, so this is cheap)
```

Or the equivalent with npm:

```bash
npm run test:up && npm test && npm run test:down
```

## Watch mode

```bash
bun run test:up
bun run test:watch
```

## Running against a non-Docker MariaDB

Set these environment variables and skip `test:up` / `test:down`:

| Variable | Default |
|----------|---------|
| `MARIADB_HOST` | `127.0.0.1` |
| `MARIADB_PORT` | `33060` |
| `MARIADB_USER` | `root` |
| `MARIADB_PASSWORD` | `oxtest` |
| `MARIADB_DATABASE` | `oxmysql_test` |

The test user must have `CREATE`, `DROP`, `INSERT`, `SELECT`, `UPDATE`,
`DELETE`, and the ability to set the session isolation level on the target
database.

## Timezone pinning

The compose fixture sets both the container `TZ=UTC` and the MariaDB server
`--default-time-zone=+00:00`. Tests that depend on timezone semantics
(§5 of the compat matrix, specifically the DST `DATE` test) additionally
pin the Node.js process timezone via `process.env.TZ = 'America/New_York'`
inside the test file itself, so DST transitions are deterministic regardless
of the host machine's locale.

## Scope

These tests cover the worker internals:
`rawQuery`, `rawExecute`, `rawTransaction`, `beginTransaction` /
`runTransactionQuery` / `endTransaction`, `parseArguments`, `parseExecute`,
`parseResponse`, and `typeCast`, plus the alias maps in
`src/compatibility/*.ts`.

They do **not** cover the FiveM-layer dispatch, the Lua wrapper in
`lib/MySQL.lua`, or the in-game UI. Those remain manual-verification items;
see the `[PHASE-4]` / manual notes in the compat matrix.
