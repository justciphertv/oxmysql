# Migration notes

For server owners switching from upstream [`CommunityOx/oxmysql`](https://github.com/CommunityOx/oxmysql) to this fork.

**TL;DR:** the public Lua / FiveM exports are unchanged. Your resources should work as-is. You need to add one line to `server.cfg` and know about three behaviour choices the fork has pinned. No database migration is required.

## Required change: worker permission

This fork runs queries in a Node.js worker thread, which FXServer gates behind an `unsafe` permission. Add to `server.cfg`, anywhere before `ensure oxmysql`:

```cfg
add_unsafe_worker_permission oxmysql
```

Without this line the worker fails to spawn at load time and no exports are registered — consuming resources will error with `No such export <method> in resource oxmysql`.

## Node version

The generated `fxmanifest.lua` declares `node_version '22'`. Your FXServer artifact must support Node 22 workers. Recent artifacts (build 12913+) do.

## FXServer build dependency

`fxmanifest.lua` declares `dependencies { '/server:12913' }`. If your artifact is older, the resource will refuse to start. Update the artifact.

## Install procedure

1. Stop FXServer completely (not `restart oxmysql`).
2. Delete `resources/oxmysql/` in full. Not just `dist/`.
3. Extract the release zip so you end up with `resources/oxmysql/`. If the zip's top-level folder name includes a commit hash (e.g. `oxmysql-v3.1.0-<hash>/oxmysql/...`), extract such that the final path is `resources/oxmysql/`, not `resources/oxmysql-v3.1.0-<hash>/`.
4. Confirm `add_unsafe_worker_permission oxmysql` is in `server.cfg`.
5. Start FXServer.

**Verify the deploy took effect.** The startup banner in the FXServer console prints:

```
[<mariadb-version>] Database server connection established! [oxmysql-mariadb-patch <hash>]
[oxmysql-mariadb-patch <hash>] pool options applied: jsonStrings=true autoJsonMap=false bigIntAsNumber=true insertIdAsNumber=true
```

The `<hash>` after `oxmysql-mariadb-patch` is the short git commit the build was cut from. It must match the suffix of the zip filename you extracted (e.g. `oxmysql-v3.1.0-<hash>.zip` → banner should say the same `<hash>`). If they don't match, your extraction didn't replace the running files — see [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Behaviour differences from upstream to be aware of

The fork deliberately diverges in a handful of places. None break the public export signatures or return shapes — consumer code continues to work — but if you know the internals, these matter.

### 1. BIGINT / insertId precision

Pool options are fixed at `bigIntAsNumber: true` and `insertIdAsNumber: true` (same as upstream). Values above `Number.MAX_SAFE_INTEGER` (`2^53 − 1` = `9007199254740991`) lose precision silently. In practice this bites anyone using `UNSIGNED BIGINT AUTO_INCREMENT` tables seeded past 2^53, or `UNSIGNED BIGINT` columns storing large external IDs.

**What you should do:** if any of your `AUTO_INCREMENT` columns could reasonably exceed 2^53 in this table's lifetime, or if you store external identifiers that large, test your flows now. A `bigint`/`string` opt-in mode is on the roadmap but not in 3.1.0.

### 2. DATE columns parse in the process-local timezone

The `typeCast` for `DATE` calls `new Date(value + ' 00:00:00').getTime()` — which parses in the Node process's local timezone. On a DST-observing system this produces a 23h or 25h delta between adjacent dates straddling spring-forward / fall-back. `DATETIME` / `TIMESTAMP` are stored with the full HH:mm:ss and are not affected.

**What you should do:** run FXServer with `TZ=UTC` in the environment (or equivalent on your host OS) if you care about DST-safe DATE arithmetic. This matches what most production deployments do anyway.

### 3. JSON columns return as strings

`JSON` columns come through as **raw JSON strings**, not parsed objects. Consumers are expected to `json.decode(row.column)` (Lua) or `JSON.parse(row.column)` (JS) themselves. This matches the upstream `mysql2` / `mysql-async` historical contract.

**What you should do:** nothing — all mainline consumers already decode manually. If you had a custom consumer that relied on receiving a parsed object, switch to decoding explicitly.

### 4. `BIT` column edge cases

Two carried-over defects that behave identically to upstream but are worth knowing:

- `BIT(n)` for `n > 1` returns only the first byte as a number, not the full integer. `BIT(16)` storing `32769` (`0x8001`) returns `128`.
- `BIT(1)` with a `NULL` value returns `false`, not `null`.

Fix is planned for a later release. No action needed if your schema doesn't use `BIT` in these shapes.

## New optional features

Two convars introduced by the fork. Both default to backward-compatible values; set them only if you want the new behaviour.

### `mysql_request_timeout_ms` — request-level safety net

Default `0` (disabled). When set to a positive integer, every worker request (query, execute, transaction, begin/endTransaction) is capped at that many milliseconds. A request that doesn't complete in the window resolves with an `{ error: 'oxmysql request ... timed out after Xms' }` payload and fires an `oxmysql:error` event with `phase: 'timeout'`.

Useful on production servers where a pathological query shouldn't silently hang a callback forever. Recommended starting value: `30000`.

```cfg
set mysql_request_timeout_ms 30000
```

### `mysql_init_retry_ms` — connection-retry interval

Default `30000`. Controls how long the worker waits between failed connection attempts during startup. Lower values (clamped to `>= 1000`) get you a faster bring-up when the DB is briefly unavailable; the default matches upstream's cadence.

```cfg
set mysql_init_retry_ms 5000
```

## Events to listen for

The fork fires events that upstream does not. Hooking these lets your monitoring resources react to worker / init issues:

```lua
AddEventHandler('oxmysql:error', function(data)
    -- data.phase is one of: 'init', 'worker', 'worker-exit', 'timeout'
    -- data.message is a human-readable string
    -- For 'init': data.attempt, data.retryIntervalMs
    -- For 'worker-exit': data.code
    -- For 'timeout': data.action
end)

AddEventHandler('oxmysql:ready', function(data)
    -- Fires once per process after a successful handshake when attempt > 1
    -- data.phase == 'init', data.attempt is the attempt number
end)
```

The existing `oxmysql:error` event for query/transaction failures (fired from the worker) is unchanged.

## What to test after the swap

Quick sanity list for a production rollout:

1. Resources that run schema migrations at load (qbx_core, ox_doorlock, Renewed-Banking, …) — confirm the migrations complete with no `Cannot read properties of null` errors. The Phase 5 pool-race fix handles this, but you want to see it in your environment.
2. Resources that `json.decode` column values (qbx_properties, qbx_spawn, any ox/qbx fork) — confirm no `bad argument #1 to 'decode' (string expected, got table)` errors.
3. Transactions with per-query parameters (`startTransaction` flows in economy / banking resources) — confirm commits and rollbacks both work.
4. The in-game `/mysql` UI (if you enable `mysql_ui`) — confirm it opens for a player with `command.mysql` ace, and that slow queries and per-resource counts look sane.
5. Stop and start the resource (`stop oxmysql` → wait 3 s → `start oxmysql`). Confirm the "worker exited" line prints and the next startup banner shows the same build stamp.

## Rollback

If something goes wrong, rollback is a file swap — no DB migration was performed. Keep your previous `resources/oxmysql/` directory backed up before the switch. To roll back: stop FXServer, delete the new `resources/oxmysql/`, restore the backup, start FXServer.

## Reporting issues

Issues go to [github.com/justciphertv/oxmysql/issues](https://github.com/justciphertv/oxmysql/issues). When reporting, please include:

- The full startup banner (both lines).
- The short git hash from the banner — this is the canonical build identifier.
- Your MariaDB/MySQL server version (from the same banner line).
- Relevant console errors, ideally with `set mysql_debug "true"` enabled for at least one failing resource so the `[typeCast-diag]` lines are in your log.
