# Troubleshooting

Diagnose-before-fix guide for common failure modes. If nothing here matches what you're seeing, open an issue with the banner stamp and relevant console lines.

---

## 1. Verifying which build is running

From `3.1.0` onward, the startup banner prints the short git commit the build was cut from:

```
[<mariadb-version>] Database server connection established! [oxmysql-mariadb-patch <hash>]
[oxmysql-mariadb-patch <hash>] pool options applied: jsonStrings=true autoJsonMap=false bigIntAsNumber=true insertIdAsNumber=true
```

The `<hash>` must match the short hash suffix of the zip filename you extracted. Mismatch means your extraction didn't replace the running files.

### Check from the shell

Run on the FXServer host:

**Git Bash / Linux shell:**
```bash
grep -oE 'oxmysql-mariadb-patch [a-f0-9]+' <fxserver-root>/resources/oxmysql/dist/worker.js | head -1
```

**PowerShell:**
```powershell
Select-String -Path '<fxserver-root>\resources\oxmysql\dist\worker.js' -Pattern 'oxmysql-mariadb-patch [a-f0-9]+' | Select-Object -First 1
```

Possible outcomes:

- **A hash matching the zip you extracted** → deploy took effect; problem is elsewhere.
- **A different hash** → an older build is in place. An older copy of `worker.js` somewhere is being loaded. Search for it:

  ```bash
  find <fxserver-root> -name worker.js -not -path '*/node_modules/*' 2>/dev/null
  ```

  Common culprits: `resources/[qb]/oxmysql/`, `resources/[standalone]/oxmysql/`, or an accidental `resources/oxmysql-v3.1.0-<hash>/` (extracted into a sibling folder with the zip's name rather than into `resources/oxmysql/`).
- **No match / empty output** → pre-`086a6b9` build installed (no stamp feature); update.

### Clean reinstall

1. Stop FXServer completely (not `restart oxmysql` — a full stop).
2. Delete `resources/oxmysql/` entirely.
3. Extract `oxmysql-v<version>-<hash>.zip` so the final path is `resources/oxmysql/` — not `resources/oxmysql-v<version>-<hash>/`.
4. Start FXServer. Check the banner shows the `<hash>` matching what you installed.

---

## 2. `No such export <method> in resource oxmysql`

The JS side never registered any exports. Typically means the worker failed to spawn and the module load aborted before the export-registration loop ran.

**Fix:** add to `server.cfg`:

```cfg
add_unsafe_worker_permission oxmysql
```

Anywhere before `ensure oxmysql`. Restart.

If the permission is already set and you still see this error, check for:
- A stale `dist/worker.js` that doesn't exist at the expected path (verify `resources/oxmysql/dist/worker.js` is present).
- An artifact older than FXServer build 12913 (check `fxmanifest.lua` — it declares that dependency).

---

## 3. `Cannot read properties of null (reading 'query')`

A consumer ran a query before the pool handshake completed. This was a real bug on pre-`b905fcc` builds; `3.1.0+` fixes it by blocking early queries until the pool is live.

**Fix:** upgrade to `3.1.0+`. The startup banner will show a hash >= `b905fcc`.

If you still see the error on a current build, open an issue with the banner and the triggering resource name.

---

## 4. `bad argument #1 to 'decode' (string expected, got table)`

A `JSON` column came through as a Lua table instead of a string. This bit several qbx/ox consumers on early fork builds. `3.1.0+` makes JSON-as-string the contract across three independent layers; running a current build should never hit this.

**Diagnose:**

1. Confirm banner shows a hash at or after `eaca0d4`.
2. Enable query diagnostics: `set mysql_debug "true"` in `server.cfg`.
3. Restart. The first time each unique column type flows through `typeCast`, a line like this prints:
   ```
   [typeCast-diag] name=coords type=BLOB columnType=252 colLen=4294967295 collation={"index":46,...} branch=BLOB-text returns=string(28) "{\"x\":1.5,...}"
   ```
4. The `branch` field is the decisive one:
   - `BLOB-text` or `JSON` or `default-next` → returning a string, fix is working.
   - `BLOB-binary` → the column's collation id is 63 (`binary`), and bytes are being spread into a number array. This is the reserved binary-data path and is intended for `BINARY` / `VARBINARY` / binary BLOBs. If your JSON column is landing here, it was declared with an unusual collation — check the DDL.

If `branch=BLOB-text` or `JSON` yet the Lua consumer still sees a table, something between the worker return and the consumer callback is interfering. Open an issue with the full `[typeCast-diag]` line and the consumer's Lua snippet.

---

## 5. Worker exited / every query hangs

On `3.1.0+` a worker crash is visible:

```
^1[oxmysql] worker exited (code <N>). All in-flight queries rejected. Restart the resource to re-spawn the worker.^0
```

Plus an `oxmysql:error` event with `phase: 'worker-exit'`. Pending queries resolve with an error payload rather than hanging.

**What to do:**

1. Restart the resource: `restart oxmysql`. Confirm the banner prints again.
2. Check what killed it. Common causes:
   - Out-of-memory — large batch/transaction. Lower `BATCH_CHUNK_SIZE` (default 1000) if this reproduces.
   - Unhandled async in a custom `typeCast` path. Not possible without editing this fork's source.
   - Kill signal from the OS.
3. On repeat crashes, capture the code from the exit line and open an issue.

---

## 6. `awaitConnection` hangs forever / init banner never prints

The worker is in its connection-retry loop. On `3.1.0+` this is visible:

```
^3[oxmysql] connection attempt N failed; retrying in 30s^0
```

Printed every 30 seconds (tunable via `mysql_init_retry_ms`). Corresponding `oxmysql:error` event fires each attempt with `phase: 'init'`.

**Typical causes:**
- Wrong credentials in `mysql_connection_string`.
- MariaDB/MySQL server not reachable from the FXServer host (firewall, DB not started, wrong host/port).
- Authentication plugin mismatch (rare — the fork's error message for `auth_gssapi_client` is explicit).

**What to do:** fix the connection string, then either wait for the next retry cycle or restart the resource.

---

## 7. `Expected N parameters, but received M`

A placeholder mismatch: the query has `N` `?` placeholders but you passed `M` values. Thrown from `parseArguments`.

**Notes:**

- `??` (double question mark) is not counted as a placeholder — it's the MariaDB JSON path operator.
- Named placeholders (`:name`, `@name`) are handled separately and don't raise this error.

---

## 8. Slow queries — what to measure

1. Set `set mysql_slow_query_warning 200` (default). Any query taking longer than 200 ms prints a yellow console warning.
2. Enable `set mysql_debug "<resource>"` for a specific resource (JSON-array form) or `"true"` for all. This routes queries through the profiler path (uses `INFORMATION_SCHEMA.PROFILING`) for more accurate timings.
3. Enable `set mysql_ui "true"` and run `/mysql` in-game (requires the `command.mysql` ace). Gives you per-resource aggregates and a sortable per-query list.

---

## 9. Reporting an issue

If none of the above helps, open an issue at [github.com/justciphertv/oxmysql/issues](https://github.com/justciphertv/oxmysql/issues). Please include:

- The full two-line startup banner (hash + pool options).
- The MariaDB/MySQL server version from the banner.
- The complete error with stack trace if applicable.
- If the error mentions `typeCast`: enable `mysql_debug` and include `[typeCast-diag]` lines.
- If the error mentions a specific resource: the SQL and Lua code from the failing function.
- Your FXServer build number if relevant.

The banner stamp alone eliminates 90% of the deployment-drift confusion that otherwise costs multiple round-trips.
