# oxmysql — Compatibility Matrix

**Status:** normative. This document is the behavior specification for the public Lua/FiveM API surface exposed by this fork. All regression tests introduced in Phase 4 enforce these shapes against a live MariaDB instance. Any behavior that *differs* from what is written here is either (a) a bug to be fixed with a corresponding test, or (b) a deliberate change that updates this document first.

**Scope:** server-side `exports.oxmysql.*`, the Lua wrapper in `lib/MySQL.lua`, the `mysql-async` aliases, and the `ghmattimysql` aliases.

**Source cross-references:**
- Worker entry: `src/worker/worker.ts`
- Query dispatch: `src/worker/database/rawQuery.ts`, `src/worker/database/rawExecute.ts`
- Transactions: `src/worker/database/rawTransaction.ts`, `src/worker/database/startTransaction.ts`
- Response shaping: `src/worker/utils/parseResponse.ts`
- Placeholder parsing: `src/worker/utils/parseArguments.ts`, `src/worker/utils/parseExecute.ts`, `src/worker/utils/parseTransaction.ts`
- Type casting: `src/worker/utils/typeCast.ts`
- FiveM surface: `src/fivem/index.ts`
- Lua wrapper: `lib/MySQL.lua`

Items marked `[PHASE-4]` flag behaviors that are ambiguous, undocumented by upstream, or known-risky; Phase 4 must produce a regression test that pins the chosen behavior before it is ever changed.

---

## 1. Call conventions

### 1.1 Signature (all query exports)

```
method(query, parameters?, cb?, invokingResource?, isPromise?)
```

| Position | Type | Required | Notes |
|----------|------|----------|-------|
| `query` | `string` \| `number` (store id, via `lib/MySQL.lua` only) \| `table` (transactions only) | yes | Passing `number` only works through the Lua wrapper's `MySQL.<method>(...)` form, which resolves against `queryStore`. Server-side exports require a string or (for transactions) a table. |
| `parameters` | `table` \| `function` (callback-in-second-slot) \| `nil` | no | If a function, it is promoted to `cb` and parameters becomes `[]`. |
| `cb` | `function` \| `nil` | no | If absent, the call is fire-and-forget unless invoked through the Lua wrapper's `.await` / Sync path. |
| `invokingResource` | `string` | no, defaults to `GetInvokingResource()` | Used only for logging and the `oxmysql:*` events. Callers should not rely on being able to spoof it. |
| `isPromise` | `boolean` | no | Internal flag: when true, errors are delivered as `cb(null, errString)` instead of being printed. Set by the `_async` / `Sync` wrappers. |

### 1.2 Return forms

Every query export supports three invocation modes. All three must remain valid; Phase 4 tests each mode.

1. **Callback mode:** synchronous call returns nothing; the callback is invoked exactly once with the result, or (when `isPromise`) with `(null, errString)`.
2. **Promise mode (`<method>_async`, `<method>Sync`, Lua `.await`):** returns a `Promise` that resolves with the result or rejects with `Error(errString)`.
3. **Lua Sync (`MySQL.Sync.<alias>(...)`):** blocks the caller via `Citizen.Await` and returns the result directly; throws on error.

### 1.3 `invokingResource` defaulting

`GetInvokingResource()` is evaluated at the time of call dispatch. When the Lua wrapper forwards a call, it passes `resourceName` (the caller's resource) as `invokingResource`; this is the canonical value used for slow-query logging, the `mysql_debug` allow-list, and the in-game UI bucketing.

---

## 2. Public export reference

### 2.1 `MySQL.query` / `MySQL.execute` / `MySQL.fetch`

- All three are the same underlying function (see `src/fivem/index.ts:574-575`).
- Worker type: `null` (SELECT-style result).
- **Input:** any SQL string.
- **Output:** the raw connector result.
  - For `SELECT`-like statements: `Record<string, unknown>[]` (rows). Empty result is `[]`, not `null`.
  - For write statements (`INSERT`/`UPDATE`/`DELETE`): an `UpsertResult` object with the shape `{ affectedRows, insertId, warningStatus }` (mariadb connector shape). Callers should use `MySQL.insert` or `MySQL.update` for typed access; the raw shape through `MySQL.query` is the connector's native object.

> **[PHASE-4]** Pin the exact keys present on the `UpsertResult` returned for DML via `MySQL.query` (not `MySQL.insert`) — upstream documentation on mysql2 returned `{ affectedRows, insertId, warningStatus }` plus occasionally `info`; mariadb's shape is similar but not identical.

### 2.2 `MySQL.single`

- Worker type: `'single'`.
- **Output:** the first row of a result set, or `null` if the result set is empty.
- Row shape is `Record<string, unknown>` — every selected column is present, even when its value is `null`.
- The callback receives `null` (not `undefined`) for an empty set.

### 2.3 `MySQL.scalar`

- Worker type: `'scalar'`.
- **Output:** the first column of the first row, or `null` if the result set is empty.
- If the first row exists but has multiple columns, `scalar` returns the value of whichever column JavaScript's `Object.values` yields first (insertion order; in practice the column order of the `SELECT` list).
- `0`, `false`, `''` are returned as-is (not coerced to `null`).

> **[PHASE-4]** Pin the `scalar` behavior for rows whose first column is `null` — `parseResponse` uses `(row && Object.values(row)[0]) ?? null`, so a row where the first column is literally `NULL` collapses to `null`. This is indistinguishable from "no row exists." Document this as *intentional* and add a regression test.

### 2.4 `MySQL.insert`

- Worker type: `'insert'`.
- **Output:** a JavaScript `number` holding `insertId`, or `null` if the connector did not return an `insertId` (e.g. `INSERT ... SELECT` that matched nothing, or a table with no `AUTO_INCREMENT`).
- Pool is configured with `insertIdAsNumber: true`, so no `BigInt` ever surfaces from this path.

> **[PHASE-4]** Pin behavior for `insertId > Number.MAX_SAFE_INTEGER` (2^53 − 1). With `insertIdAsNumber: true`, large unsigned BIGINT ids are silently truncated. Test must assert *current* behavior (truncation) and the migration note documents it as a known trade-off.

### 2.5 `MySQL.update`

- Worker type: `'update'`.
- **Output:** `affectedRows` as a JavaScript `number`, or `null` if the connector omits it.
- Used for `UPDATE` and `DELETE`. `INSERT ... ON DUPLICATE KEY UPDATE` also flows through this shape when called as `MySQL.update`.

### 2.6 `MySQL.prepare`

- Worker type: `'execute'` with `unpack: true`.
- **Intent:** convenience wrapper over `rawExecute` that unpacks "the obvious scalar" for the caller.
- **Input:** a single SQL string + parameters in one of:
  - a single array: `[1, 'a']` → one execution
  - an array of arrays: `[[1, 'a'], [2, 'b']]` → batch execution
  - an object keyed by 1-based numeric strings: `{ '1': 1, '2': 'a' }` → normalized to a single array
- **Output, unpacked:**

  | Query type | Single param set | Multiple param sets |
  |------------|-----------------|---------------------|
  | `INSERT`/`UPDATE`/`DELETE` | `insertId` or `affectedRows` (per `parseResponse`) | array of per-iteration results |
  | `SELECT` (single column) | the scalar value of that column in the first row, or `null` | array of scalars, one per param set |
  | `SELECT` (multi-column) | the first row object, or `null` | array of first-row objects |

- Query-type classification is done by `executeType()`, which matches **only uppercase** `INSERT `/`UPDATE `/`DELETE ` prefixes (see §6.2).

> **[PHASE-4]** Pin: lowercase `insert into ...` passed to `prepare` is currently classified as a SELECT and follows the unpack-first-column path. This is an existing bug (H10 in the audit). Test must lock down the observed behavior; the decision to fix it happens after the test exists.

### 2.7 `MySQL.rawExecute`

- Worker type: `'execute'` with `unpack: false`.
- **Intent:** expose the full raw connector result for every param set without unwrapping.
- **Output shape:**

  | Case | Result |
  |------|--------|
  | Single param set, SELECT | full `Record<string, unknown>[]` |
  | Single param set, DML | full `UpsertResult` object |
  | Multiple param sets, SELECT | array of result sets |
  | Multiple param sets, DML | array of `UpsertResult` objects; for compatibility, the array is *collapsed to the single element* when `batchResults.length === 1` (see `rawExecute.ts:55-58`). |

> **[PHASE-4]** Pin the "collapse single-element batch" behavior — this is counter-intuitive for callers that always want an array. Document it explicitly, add a test.

### 2.8 `MySQL.transaction`

- Worker type: `'transaction'`.
- **Input accepts three forms:**
  1. `queries: string[]`, same `parameters` used for every entry.
  2. `queries: { query: string, parameters?: any[], values?: any[] }[]` — per-entry parameters; either `parameters` or the legacy `values` key is accepted.
  3. `queries: [string, any[]][]` — tuple form.
- **Output:** `true` on commit, rejects / returns an error string on rollback. The callback receives `true` on success.
- Isolation level is whatever `mysql_transaction_isolation_level` convar maps to (default: `READ COMMITTED`).
- Rollback semantics:
  - Any thrown error from any query in the list triggers `ROLLBACK` and the whole transaction reports error.
  - A failed `ROLLBACK` marks the underlying connection as tainted (`.failed = true`); the connection is destroyed on dispose instead of returned to the pool.
  - On error, a `oxmysql:transaction-error` event is emitted.
- Bulk optimization: consecutive entries with the same SQL text are grouped and submitted via mariadb's `batch()` for `INSERT`/`UPDATE`/`DELETE`/`REPLACE`. The group is chunked at `BATCH_CHUNK_SIZE = 1000` rows. If `batch()` raises, the code falls back to per-row text-protocol queries within the same transaction.

> **[PHASE-4]** Pin: the DML-batch grouping must not change observable transaction semantics — commit atomicity, affected-row totals, and error reporting all must match the non-grouped form. Regression tests:
> - 3 different SQLs interleaved (proves no false grouping)
> - 1500 rows of the same `INSERT` (proves chunking doesn't split the transaction)
> - a chunk that fails mid-way (proves rollback)

### 2.9 `MySQL.startTransaction`

- **Input:** an async function `(queryFn) => Promise<any>`.
- **Contract:**
  - `queryFn(sql, values)` runs a single statement on the transaction's dedicated connection and returns the raw connector result (the same shape `MySQL.query` returns).
  - The outer function must return a truthy value to commit, or literally `false` to roll back.
  - Throws inside the outer function also roll back.
  - A 30-second wall-clock timeout fires a rollback via `endTransaction` and marks the transaction closed. Every `queryFn` call from user code that observes the aborted signal (either before or after its `sendToWorker` roundtrip completes) throws `Transaction has timed out after 30 seconds.` An `AbortController` plus a worker-side `closed` flag together guarantee that **no new query is started on a torn-down connection** and that the `endTransaction` rollback does not overlap a still-in-flight query — the 3.1.0 M1 race is fixed in 3.2.0 as an unconditional correctness change.
- **Output:** `true` if committed, `false` if rolled back.
- Still emits a "experimental" console warning *once per process lifetime*.

> **[PINNED by tests/09-start-transaction.test.ts]** M1 race guard — `runTransactionQuery` after `endTransaction` has closed the connection returns an `{ error }` payload instead of starting fresh work.

#### 2.9.1 `mysql_start_transaction_propagate_errors` convar

**Default:** `false` (preserves 3.1.0 pinned behaviour).
**Scope:** affects only `MySQL.startTransaction` / `endTransaction`. `MySQL.transaction`, `rawTransaction`, and every other export are untouched.

| Flag value | `beginTransaction` failure | Commit / rollback failure | Default shape |
|------------|----------------------------|---------------------------|---------------|
| `false` (default) | `console.error(...)` + return `false` | Silently swallowed (`catch {}` on the worker side returns `{ result: true }`); `MySQL.startTransaction` returns `true` | boolean return |
| `true` | Throws `Error(<worker reason>)` | Throws `Error('<resource> startTransaction <commit\|rollback> failed: <reason>')` | boolean return on success, `throw` on begin/commit/rollback failure |

Under `false`, the function shape is byte-for-byte identical to 3.1.0. Under `true`:
- A failed `beginTransaction` throws; callers should wrap in `try/catch` or `pcall`.
- A failed commit or rollback throws; the outer `MySQL.startTransaction` promise rejects.
- A timed-out transaction still returns `false` (the timeout handler has already processed the rollback before the caller's await resolves).

Worker-side plumbing is unconditional: `endTransaction` always returns `{ result: true } | { error: string }`. The parent chooses whether to dispatch it as `sendToWorker` (request-response, flag-on) or `emitToWorker` (fire-and-forget, flag-off).

> **[PINNED by tests/09-start-transaction.test.ts]** `endTransaction` returns `{ result: true }` on success and `{ error: string }` on commit/rollback failure. Unknown `connectionId` resolves to `{ result: true }` (no-op).

> **[MANUAL VERIFICATION]** The flag-on `MySQL.startTransaction` throw path lives in `src/fivem/index.ts` and is not reachable from the worker-internals harness. Operators enabling the convar should verify with a live FXServer test.

### 2.10 `MySQL.store`

- **Input:** a string. No parameters. Callback receives the same string back.
- **Intent:** via the Lua wrapper (`lib/MySQL.lua` `addStore`) this pushes the query into a `queryStore` array and returns a 1-based numeric id that can later be passed as the first argument to any query method. The server-side export only implements the echo — the id assignment happens Lua-side.

### 2.11 `MySQL.isReady`, `MySQL.awaitConnection`

- `isReady()`: returns boolean. Becomes `true` only after the worker signals `dbVersion` (i.e. the pool successfully executed `SELECT VERSION()`).
- `awaitConnection()`: returns a promise that resolves to `true` once `isReady()` is true. Polls via `setTimeout(0)` internally.

---

## 3. Placeholder handling

### 3.1 Positional `?`

Count = `query.match(/\?(?!\?)/g)?.length`. The `?!\?` ensures `??` (MariaDB's JSON path operator) is not counted. Parameters array is padded with `null` if shorter than placeholder count; thrown error if longer.

### 3.2 Named `:name` and `@name`

- Triggered when `parameters` is a non-array object and the query contains either `:` or `@` (cheap substring check first).
- Conversion is performed by `named-placeholders` (patched: see `patches/named-placeholders+1.1.3.patch`). The patch:
  - adds `@` as an accepted prefix
  - strips a leading `@` or `:` from parameter object keys so `{ ':id': 1 }` and `{ '@id': 1 }` and `{ id: 1 }` all bind to `:id` / `@id`
  - substitutes missing keys with `null` instead of `undefined`
  - ignores occurrences inside single or double quoted string literals
- Named-placeholder conversion can be disabled by setting `namedPlaceholders=false` in the connection string (string `'false'`, not boolean).

> **[PHASE-4]** Pin: quoted-string protection. `SELECT ':notaparam' AS x, :real` with `{ real: 1 }` must produce one binding, not two.
> **[PHASE-4]** Pin: `@` and `:` interchangeability. Verify `{ '@id': 1 }`, `{ ':id': 1 }`, and `{ id: 1 }` all work.
> **[PHASE-4]** Pin: missing key → `null`, not an error and not `undefined`.

### 3.3 Object with numeric string keys

When `parameters` is an object whose keys parse as integers (`{ '1': 'a', '2': 'b' }`):
- In `parseArguments` (used by `query`/`single`/`scalar`/`insert`/`update`): the object is read as `parameters[i + 1]` for 1-based indexing (see `parseArguments.ts:20`).
- In `parseExecute` (used by `prepare`/`rawExecute`): `parseInt(key) - 1` is used as the array index.

> **[PHASE-4]** Pin: a non-array object with non-numeric keys passed to `rawExecute` silently drops all entries (`parseInt('a')` → `NaN`). Test must lock observed behavior; see audit item H9.

### 3.4 Null-safe parameter rules

- `null` is always preserved and sent to the connector as SQL `NULL`.
- `undefined` entries in a positional array are coerced to `null` by the padding logic.
- A missing named key is converted to `null` by the patched named-placeholders.
- An empty parameters array combined with a query containing `?` placeholders results in an array of `null`s of the placeholder count.

---

## 4. Numeric coercion

### 4.1 Integer columns

- `TINYINT(1)` → JavaScript `boolean` (true when stringified value is `'1'`; see `typeCast.ts:24`). **All other widths of TINYINT** defer to the connector default (`next()`), producing a `number`.
- `SMALLINT`, `MEDIUMINT`, `INT` → JavaScript `number`.
- `BIGINT` (any signedness), **default (flag off)** → JavaScript `number` (pool option `bigIntAsNumber: true`). Values above `Number.MAX_SAFE_INTEGER` lose precision silently. Pinned by `tests/05-numeric.test.ts`.
- `BIGINT`, **`mysql_bigint_as_string = true`** → `number` for values in `[-2^53+1, 2^53-1]`; decimal **string** otherwise (exact value preserved). Pinned by `tests/22-bigint-as-string.test.ts`. See §4.1.1 below.

### 4.2 `DECIMAL` / `NUMERIC`

- No custom typecast is installed; the mariadb connector default for `DECIMAL` is a **JavaScript `string`** (e.g. `"12345.67"`). This matches the mysql-async historical contract.
- `FLOAT` / `DOUBLE` → JavaScript `number` (double-precision).

> **[PHASE-4]** Pin `DECIMAL` as a string. A regression test must select a `DECIMAL(20,4)` with enough precision to be unrepresentable as `number` and assert the result is a string.

#### 4.1.1 `mysql_bigint_as_string` convar (3.x+)

**Default:** `false` (preserves the pinned lossy `number` behaviour).
**Scope:** affects the `BIGINT` typeCast branch **and** the `insertId` shaping in `parseResponse`. No other column type is touched.

Setting the flag to `true`:

- Flips the pool config to `bigIntAsNumber: false` and `insertIdAsNumber: false`. This change only happens when the pool is built — i.e. at worker init / resource start.
- `BIGINT` values within `[-9007199254740991, 9007199254740991]` continue to return as `number` (same shape as flag off).
- `BIGINT` values outside that range return as a **decimal string** — exact digits, no precision loss. Same rule applies to `insertId`.
- `NULL` still returns `null`.

| Shape | Flag off (default) | Flag on (corrected) |
|-------|--------------------|---------------------|
| `BIGINT` ≤ 2^53 - 1 | `number` | `number` — unchanged |
| `BIGINT` = 2^53 + 1 | `number` `9007199254740992` (lossy) | `string` `"9007199254740993"` |
| `BIGINT` = -(2^53 + 1) | `number` `-9007199254740992` (lossy) | `string` `"-9007199254740993"` |
| `BIGINT NULL` | `null` | `null` — unchanged |
| `insertId` ≤ 2^53 - 1 | `number` | `number` — unchanged |
| `insertId` > 2^53 - 1 | `number` (lossy) | `string` (exact) |

> **[PINNED by tests/22-bigint-as-string.test.ts]** Flag-on: safe-range BIGINT → number; over-range (signed and negative) → exact decimal string; insertId follows the same rule.

### 4.3 `insertId`

- Default (flag off): returned by `MySQL.insert` as JavaScript `number` (pool option `insertIdAsNumber: true`, plus explicit `Number()` wrap in `parseResponse`).
- With `mysql_bigint_as_string = true`: `number` when safely representable, decimal string when not. See §4.1.1.
- `null` when the connector did not produce one.

### 4.4 `BIT(n)`

Default behaviour (flag off — matches 3.1.0 byte-for-byte):

- `BIT(1)` → JavaScript `boolean` (true when the first byte equals 1).
  - **Pinned defect (H6b):** `BIT(1) NULL` returns `false`, not `null`. The expression `column.buffer()?.[0] === 1` evaluates to `false` when `buffer()` is `null`.
- `BIT(n > 1)` → JavaScript `number` holding **only the first byte** of the value.
  - `NULL` is correctly returned as `null` for these widths.

> **[PINNED by tests/05-numeric.test.ts]** Flag-off: `BIT(16) = b'1000000000000001'` returns `128` (first byte), not `32769`. Audit item H6.
> **[PINNED by tests/05-numeric.test.ts]** Flag-off: `BIT(1) NULL` returns `false`. Audit item H6b.

#### 4.4.1 `mysql_bit_full_integer` convar (3.2.0+)

**Default:** `false` (preserves flag-off behaviour above).
**Scope:** affects only the `BIT` typeCast branch. No other column type is touched.

Set to `true` to opt into corrected BIT decoding:

| Shape | Flag off (default) | Flag on (corrected) |
|-------|--------------------|---------------------|
| `BIT(1)` value `0` or `1` | `boolean` (`false` / `true`) | `boolean` (`false` / `true`) — unchanged |
| `BIT(1)` `NULL` | `false` (H6b defect) | `null` |
| `BIT(8)` value `0..255` | `number` (first byte = full value) | `number` — unchanged |
| `BIT(16)` value `32769` (`0x8001`) | `number` `128` (H6 defect) | `number` `32769` |
| `BIT(n)` `NULL`, `n > 1` | `null` | `null` — unchanged |

The flag-on decoder returns:
- `number` when the value fits in `Number.MAX_SAFE_INTEGER` (true for every `BIT(n ≤ 53)` value).
- `bigint` when the bit width forces it (`BIT(n > 53)` with the high bits set).

The boolean interpretation of `BIT(1)` non-null is preserved under both flag states — the single-bit integer and the boolean interpretation agree, and callers that do `if (row.flag)` continue to work.

> **[PINNED by tests/05-numeric.test.ts]** Flag-on: `BIT(1) NULL` → `null`. `BIT(16) = b'1000000000000001'` → `32769`. `BIT(8) = 128` → `128`. `BIT(n > 1) NULL` → `null`.

### 4.5 Bit/Boolean-adjacent

- `ZEROFILL` and `UNSIGNED` attributes: currently pass through the connector; no special handling. An `UNSIGNED BIGINT` column near 2^64 is subject to the same precision loss as §4.1.

### 4.6 `JSON` and binary-flag classification of BLOB/TEXT columns

- `JSON` columns are returned as **JavaScript `string`s** containing the raw JSON text, matching the mysql2 / mysql-async historical contract. Consumers (Lua callers using `json.decode`, JS callers using `JSON.parse`) are responsible for deserialisation.
- `NULL` JSON columns are returned as `null` (not the literal string `"null"`).

The BLOB/TEXT branch in `typeCast.ts` classifies "binary data" using **collation id 63** (the MariaDB `binary` collation — the same signal the connector itself uses in `text-decoder.js`). It does **not** use the MySQL column-level `BINARY` flag (`0x80`), because that flag is also set on JSON columns (whose internal collation is `utf8mb4_bin`) and would cause the typeCast to spread the value into a number array. The number-array path is intentionally reserved for columns declared with the `binary` collation — BINARY, VARBINARY, binary BLOBs.

> **[PINNED by tests/14-json-columns.test.ts]** JSON columns come through as strings; `JSON NULL` comes through as `null`; arrays and objects in JSON round-trip via `JSON.parse(value)`.

---

## 5. Date / time handling

All values documented here are what reaches the Lua callback.

| Column type | Representation |
|-------------|----------------|
| `DATETIME`, `DATETIME2`, `TIMESTAMP`, `TIMESTAMP2`, `NEWDATE` | JavaScript `number`, milliseconds since Unix epoch (UTC). Parsed via `new Date(connectorString).getTime()`. |
| `DATE` **default (flag off)** | JavaScript `number`, milliseconds since Unix epoch. Parsed via `new Date(value + ' 00:00:00').getTime()` — **the server process's local timezone is used**. |
| `DATE`, **`mysql_date_as_utc = true`** | JavaScript `number`, midnight UTC ms. Parsed via `new Date(\`${value}T00:00:00Z\`).getTime()`. DST-immune; see §5.1. |
| `TIME` | Defers to connector default (string `"HH:MM:SS"`). |
| `YEAR` | Defers to connector default (number). |
| `NULL` values | `null`. |

> **[PINNED by tests/06-dates.test.ts]** Flag-off: DATE parses in process-local tz; DST transitions produce 23h/25h deltas on DST-observing hosts; `DATETIME` / `TIMESTAMP` round-trip; `NULL` returns `null` (not `0`).

#### 5.1 `mysql_date_as_utc` convar (3.x+)

**Default:** `false` (preserves the pinned local-tz behaviour).
**Scope:** affects only the `DATE` typeCast branch. `DATETIME`, `TIMESTAMP`, `TIME`, `YEAR` are untouched.

Setting the flag to `true`:

- `DATE` columns parse as `${value}T00:00:00Z` — midnight UTC. Adjacent dates always have a 24-hour delta, regardless of DST or the host OS timezone.
- `NULL` still returns `null`.
- No pool rebuild required — the flag is read by `typeCast` on every column decode.

| Shape | Flag off (default) | Flag on (corrected) |
|-------|--------------------|---------------------|
| `DATE '2024-06-15'` in `TZ=UTC` | `Date.UTC(2024, 5, 15)` | `Date.UTC(2024, 5, 15)` — unchanged |
| `DATE '2024-06-15'` in `TZ=America/New_York` | `Date.UTC(2024, 5, 15) + 4h` (tz-offset) | `Date.UTC(2024, 5, 15)` |
| `DATE '2024-03-10' → '2024-03-11'` delta (DST spring-forward) | 23h in `TZ=America/New_York` | 24h always |
| `DATE NULL` | `null` | `null` — unchanged |

> **[PINNED by tests/06-dates.test.ts]** Flag-on: DATE returns midnight UTC ms; DST-straddling dates have a 24h delta; `DATETIME` is unaffected.

---

## 6. Query classification

### 6.1 `parseResponse` type selector

`rawQuery` passes the caller-chosen `type` directly to `parseResponse`:

| Caller | `type` | Result shaping |
|--------|--------|----------------|
| `query`/`execute`/`fetch` | `null` | raw connector result |
| `single` | `'single'` | `result[0] ?? null` |
| `scalar` | `'scalar'` | `(result[0] && Object.values(result[0])[0]) ?? null` |
| `insert` | `'insert'` | `Number(result.insertId)` or `null` |
| `update` | `'update'` | `Number(result.affectedRows)` or `null` |

### 6.2 `executeType` (rawExecute / prepare only)

Classifies by looking at the first keyword, **case-insensitive** and tolerant of leading whitespace:

| Prefix (any case, any leading whitespace) | Classification |
|-------------------------------------------|----------------|
| `INSERT ` | `'insert'` |
| `UPDATE ` | `'update'` |
| `DELETE ` | `'update'` (shares the affectedRows return shape) |
| anything else | `null` (treated as SELECT) |

> **[PINNED by tests/07-raw-execute-prepare.test.ts]** `prepare('insert into …', [[…]], true)` returns a numeric `insertId`. `prepare('INSERT INTO …', …)` continues to return the same. `   delete from …` (leading whitespace, lowercase) classifies as `update` and returns `affectedRows`. Audit item H10 is fixed in 3.2.0.

### 6.3 Multi-statement semantics

- `multipleStatements` is not enabled by default. When a user enables it via the connection string, a warning is printed on pool creation.
- Behavior with multiple statements in one call is *out of spec* — no regression tests will be added for it beyond the warning-is-printed assertion.

---

## 7. Transactions

### 7.1 Connection affinity

- `MySQL.transaction` acquires one pool connection, runs all statements on it, commits, returns it.
- `MySQL.startTransaction` acquires one pool connection, tracks it by `threadId` in the worker's `activeConnections` map, and holds it until `endTransaction` (commit, rollback, or timeout).

### 7.2 Isolation level

Set from `mysql_transaction_isolation_level` convar at pool creation:

| Convar value | Effective SQL |
|--------------|---------------|
| `1` | `REPEATABLE READ` |
| `2` *(default)* | `READ COMMITTED` |
| `3` | `READ UNCOMMITTED` |
| `4` | `SERIALIZABLE` |
| other | falls back to `READ COMMITTED` |

The level is applied via `initSql` on every connection handed out by the pool.

### 7.3 Rollback + tainted connections

- On any query failure mid-transaction the handler calls `connection.rollback()`.
- If the rollback itself raises, the connection is flagged `.failed = true` and destroyed on `Symbol.dispose` instead of returned to the pool. This prevents a half-dead connection from being reused.

### 7.4 `oxmysql:transaction-error`

On failure the worker emits `oxmysql:transaction-error` with `{ query, parameters, message, err, resource }`. Consumers using this event must continue to receive it; Phase 4 verifies it fires.

### 7.5 `oxmysql:error`

On any non-transaction query failure, the worker emits `oxmysql:error` with `{ query, parameters, message, err, resource }`. Phase 4 verifies it fires.

---

## 8. Compatibility aliases

### 8.1 `mysql-async` aliases

Registered via `provide('mysql-async', ...)` (see `src/fivem/index.ts:611-614` and `src/compatibility/mysql-async.ts`). Callable as `exports['mysql-async']:<alias>(...)`.

| Source method | `mysql-async` alias |
|---------------|---------------------|
| `update` | `mysql_execute` |
| `insert` | `mysql_insert` |
| `query` | `mysql_fetch_all` |
| `scalar` | `mysql_fetch_scalar` |
| `transaction` | `mysql_transaction` |
| `store` | `mysql_store` |

Argument order matches the source method (`query, parameters, cb`). Each alias has the same three invocation modes (callback, `_async`, `Sync`) because all exports register all three.

> **[PHASE-4]** Confirm whether real-world `mysql-async` consumers expect a `mysql_fetch` alias pointing at `single` — if yes, Phase 5 adds it. Regression test only asserts the aliases that ship today.

### 8.2 `ghmattimysql` aliases

Registered via `provide('ghmattimysql', ...)`. Both a callback form and a `<alias>Sync` form are registered per entry.

| Source method | `ghmattimysql` alias |
|---------------|----------------------|
| `query` | `execute` |
| `scalar` | `scalar` |
| `transaction` | `transaction` |
| `store` | `store` |

> **[PHASE-4]** Pin: calls to `exports.ghmattimysql:execute(sql, params, cb)` must produce the same shape as `exports.oxmysql:query`.

### 8.3 Generated `_async` and `Sync` exports

For every key `k` on the `MySQL` object, three exports are registered:

- `k` — callback form
- `k_async` — returns a promise
- `kSync` — returns a promise (identical to `_async`; kept for historical `MySQL.Sync` Lua wrapper compatibility)

Phase 4 must assert, for at least one representative method, that all three forms return equivalent results for the same query.

### 8.4 Lua `MySQL.Sync` / `MySQL.Async` alias map

Defined in `lib/MySQL.lua:101-109`:

| Alias | Bound method |
|-------|--------------|
| `fetchAll` | `query` |
| `fetchScalar` | `scalar` |
| `fetchSingle` | `single` |
| `insert` | `insert` |
| `execute` | `update` *(note: differs from `MySQL.execute` which is `query`)* |
| `transaction` | `transaction` |
| `prepare` | `prepare` |

The `execute` alias discrepancy is intentional and preserves mysql-async expectations. Phase 4 has a dedicated test that calls `MySQL.Sync.execute` on a write and `MySQL.execute` on a read and asserts different return shapes.

---

## 9. Errors and logging

### 9.1 Error delivery

- Callback mode without `isPromise`: error is `console.error`'d; the callback is **not** invoked.
- Callback mode with `isPromise` (i.e. through `_async`/`Sync`): callback is invoked as `cb(null, errorString)`. The promise wrapper rejects.
- `errorString` is of the form `"<resource> was unable to execute a query!\nQuery: <sql>\n<message>"` for `logError`, and `"<resource> was unable to complete a transaction!\n<query+params>\n<message>"` for transactions.

> **[PHASE-4]** Pin error-string format. Consumers grep this; changing it is a breaking change.

### 9.2 Slow-query reporting

- A query that takes ≥ `mysql_slow_query_warning` ms (default 200) triggers a console print including the resource, execution time, and query.
- If `mysql_ui` is `true`, slow and non-slow queries are pushed to the in-game UI buffer (size: `mysql_log_size`).

### 9.3 `mysql_debug`

Boolean or JSON array of resource names. When truthy:
- The slow-query threshold still applies but every query on the matched resource is logged.
- Queries go through the profiler code path (dedicated connection + `SET profiling = 1`), which is measurably slower and uses MariaDB's `INFORMATION_SCHEMA.PROFILING`.

> **[PHASE-4]** Confirm MariaDB's `INFORMATION_SCHEMA.PROFILING` is still populated on the supported MariaDB versions. MariaDB has deprecated `SHOW PROFILES` in favor of the performance schema. If deprecated, the profiler path may no-op silently.

---

## 10. Startup and readiness

### 10.1 `isReady`

- Worker emits `dbVersion` action after the first successful `SELECT VERSION()`.
- Parent sets `isReady = true` on that message.
- `MySQL.isReady()` returns the boolean.
- `MySQL.awaitConnection()` returns a promise resolving to `true` once `isReady` flips.

### 10.2 Initial connection failure

- Worker retries `createConnectionPool` every 30 s until it succeeds.
- No give-up condition; no retry counter exposed today.

> **[PHASE-4]** Pin observable startup behavior: wrong credentials must not throw from `awaitConnection`; they must keep it pending. A test confirms this; Phase 5 hardens it with retry counters and telemetry without breaking the test contract.

### 10.3 Query dispatch before the pool is ready

A common real-world pattern is consumer resources firing schema migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ...`) at resource start without waiting for `MySQL.awaitConnection`. These queries reach the worker before the first successful handshake has set `pool`.

Behaviour guarantee: the worker blocks such queries until the pool is live, then executes them in dispatch order. Concretely, `rawQuery` and `rawExecute` call `awaitPool()` before any `pool!.query` / `pool!.batch` reference. `rawTransaction` and `startTransaction` already wait via `getConnection`.

- The query's promise does not reject while the pool is still initialising.
- The query's promise does not resolve until after the handshake completes.
- Credentials that never succeed keep these promises pending forever, consistent with `MySQL.awaitConnection`'s pending-forever behaviour pinned in §10.2.

### 10.3 Resource-state contract (Lua)

`MySQL.ready(cb)` waits until:
1. `GetResourceState('oxmysql') == 'started'`, then
2. `oxmysql.awaitConnection()` resolves.

Phase 4 does not run in the FXServer runtime; this contract is documented here and tested indirectly through the TS `isReady`/`awaitConnection` surfaces.

---

## 10.4 Connection string parsing (`mysql_connection_string`)

Two accepted forms: URI (`mysql://user:pass@host:port/database?opt=val`) and semicolon-delimited key-value (`user=root;password=secret;host=localhost;database=app`).

The URI form's **port** field is validated. Accepted shapes:

| Input | Resulting `port` | Warning fires? |
|-------|------------------|----------------|
| Valid digit-string in `[1, 65535]` (e.g. `:3306`) | `number` | no |
| Omitted (e.g. `mysql://user@host/db`) | `undefined` (mariadb defaults to 3306) | no |
| Non-numeric (e.g. `:abc`) | `undefined` (mariadb defaults to 3306) | **yes** |
| Out of range (`0`, `70000`, …) | `undefined` (mariadb defaults to 3306) | **yes** |

The **effective pool behavior** is unchanged from the pre-audit-M5 code — an invalid port still falls back to 3306. The added warning makes the misconfiguration visible in the FXServer console so operators can correct it.

Key-value form normalises aliased keys to canonical names at parse time:

| Alias | Normalises to |
|-------|---------------|
| `host`, `hostname`, `ip`, `server`, `data source`, `addr`, `address` | `host` |
| `user`, `userid`, `user id`, `username`, `user name`, `uid` | `user` |
| `pwd`, `pass` | `password` |
| `db` | `database` |

> **[PINNED by tests/19-connection-string.test.ts]** All of the above, including the two-warn branches and the k=v alias normalisation.

## 11. Out-of-spec behavior (will not be tested)

These are intentional non-goals; Phase 4 will not add tests for them, and they are *not* part of the compatibility contract:

- Semantics of `multipleStatements = true` queries beyond the warning.
- Concurrent modification of the `queryStore` from Lua across threads.
- Behaviors that differ between MySQL and MariaDB server implementations (e.g. JSON path operator handling, SQL mode quirks). This library targets MariaDB; MySQL-server compatibility is best-effort.
- The in-game UI NUI contract (`oxmysql:fetchResource`, `oxmysql:loadResource`) — covered separately by UI-level tests if/when they exist.
- The `logger/fivemanage.js` integration — user-pluggable surface.

---

## 12. Phase 4 regression targets (summary)

Every `[PHASE-4]` callout above must correspond to at least one test in the Phase 4 harness. Consolidated list:

1. `MySQL.query` raw DML result shape (§2.1)
2. `scalar` null-vs-missing-row indistinguishability (§2.3)
3. `insertId > 2^53` truncation (§2.4, §4.3)
4. `rawExecute` single-batch-element collapse (§2.7)
5. `prepare` with lowercase DML (§2.6, §6.2)
6. `transaction` batch grouping preserves atomicity (§2.8)
7. `transaction` batch grouping with mid-chunk failure rolls back (§2.8)
8. `transaction` 1500-row batch chunks correctly (§2.8)
9. `startTransaction` commit / user-false / timeout paths (§2.9)
10. `startTransaction` timeout race with in-flight `queryFn` (§2.9)
11. `startTransaction` swallowed commit error returns `true` (§2.9)
12. Named-placeholder quoted-string protection (§3.2)
13. `@` / `:` / bare-key interchangeability (§3.2)
14. Missing named key → `null` (§3.2)
15. Non-numeric-key object to `rawExecute` drops silently (§3.3)
16. `BIGINT` precision loss on write+read (§4.1)
17. `DECIMAL` returned as string (§4.2)
18. `BIT(16)` returns first byte only (§4.4)
19. `DATETIME` UTC round-trip (§5)
20. `DATE` local-tz DST behavior (§5)
21. `NULL` datetime → `null` (§5)
22. `oxmysql:error` fires on query failure (§7.5)
23. `oxmysql:transaction-error` fires on transaction failure (§7.4)
24. `ghmattimysql:execute` == `oxmysql:query` (§8.2)
25. `method`, `method_async`, `methodSync` parity for one representative method (§8.3)
26. `MySQL.Sync.execute` (write) vs `MySQL.execute` (read) divergence (§8.4)
27. Error string format stability (§9.1)
28. MariaDB `INFORMATION_SCHEMA.PROFILING` availability probe (§9.3)
29. `awaitConnection` stays pending on bad credentials (§10.2)

Each target is a single test or a tight cluster. When the test exists, the `[PHASE-4]` marker in this document is replaced with `[PINNED by tests/…]`.
