# Performance tuning

Evidence-based guidance for operators running oxmysql at production concurrency. All numbers in this document come from [`bench/hotpath.ts`](../bench/hotpath.ts) run against a local MariaDB 11 Docker fixture. Your results will vary with network latency to the DB, MariaDB tuning, and the CPU you run FXServer on — but the *shape* of the curves is what matters for tuning decisions.

## TL;DR

Set `connectionLimit` in your `mysql_connection_string` to **at least the number of concurrent queries you expect at peak**, with a small headroom. The mariadb connector's default is `10`; this is a reasonable starting point for most FiveM servers. Going much higher rarely helps and can start to hurt past ≈ peak concurrency.

Example:

```
mysql_connection_string "mysql://user:pass@host/db?connectionLimit=20"
```

## Why this matters

Every query that reaches oxmysql first has to borrow a connection from the pool. When the pool has fewer connections than the number of in-flight queries, the extras queue FIFO behind the busy connections. The wait time compounds with concurrency: with `connectionLimit: 4` and 32 concurrent transactions, the average query sits in the queue for tens of milliseconds before it even touches MariaDB.

### Measured data

Same benchmark harness, same MariaDB instance, same workload; only `connectionLimit` and client-side concurrency change. Values are average (avg) and max wall-clock time per operation, in microseconds, for the `transaction:2x-insert` scenario (which holds a pooled connection for `BEGIN + batch + COMMIT`):

| `connectionLimit` | concurrency | `pool.getConnection` avg | `pool.getConnection` max | total transaction avg | ops/s |
|-------------------|-------------|-------------------------:|-------------------------:|----------------------:|------:|
| 4 | 16 | 13 611 µs | 1 137 ms | 18 057 µs | 876 |
| 4 | 32 | 25 121 µs | 911 ms | 28 693 µs | 1 093 |
| 10 | 16 | 4 124 µs | 685 ms | 10 948 µs | 1 434 |
| 10 | 32 | 12 523 µs | 580 ms | 18 261 µs | 1 708 |
| 20 | 16 | 25 µs | 752 µs | 8 259 µs | 1 922 |
| 20 | 32 | 6 768 µs | 562 ms | 18 043 µs | 1 741 |

Key patterns:

- **Pool wait dominates whenever `concurrency > connectionLimit`.** At `connectionLimit: 4`, every concurrency level above 4 pays 13+ ms of pure queuing per operation.
- **Pool wait effectively vanishes once `connectionLimit >= concurrency`.** The `conn=20, conc=16` row shows `pool.getConnection` at 25 µs average, 752 µs max — the connector is answering from its free-connection queue immediately.
- **Going far above peak concurrency is not free.** `conn=20, conc=32` keeps some queue wait (expected: 32 > 20) *and* its per-phase `BEGIN` / `batch` / `COMMIT` each drift upward (~3.6–3.8 ms each) vs. `conn=10, conc=32` (~1.8–2.0 ms each). This appears to be MariaDB server-side thread contention: past a point, more concurrent connections push the DB into its own scheduling overhead.
- **Beyond the queue, transactions are already lean.** With pool wait removed (e.g. `conn=20, conc=16`), the non-queuing cost is `getConnection 25 µs + BEGIN 2.7 ms + batch 2.9 ms + COMMIT 2.7 ms ≈ 8.3 ms total`. This is three serial MariaDB round-trips for BEGIN, the batch DML, and COMMIT. Reducing that floor requires changing the transaction protocol itself, which is out of scope for a 3.x release.

### Point queries

Non-transactional reads hold a pool connection for the duration of one round-trip only, so the contention ceiling is different:

| `connectionLimit` | `query:SELECT-1` @ conc=16 | @ conc=32 | `prepare:scalar-point` @ conc=16 | @ conc=32 |
|-------------------|-----------------------:|----------:|-----------------------------:|----------:|
| 4 | 2 234 ops/s | 2 291 | 2 717 | 2 902 |
| 10 | 5 408 | 5 070 | 5 016 | 4 949 |
| 20 | 3 914 | 4 090 | 5 439 | 4 648 |

`connectionLimit: 10` is near-optimal at 16–32 concurrent point queries; going to 20 gives no benefit and occasionally regresses, consistent with MariaDB-side contention dominating past that point.

## Recommendations

### For most deployments

- Keep `connectionLimit` at the mariadb connector default (`10`). Fine for single-server FiveM up to ~16 concurrent queries.
- Leave `mysql_request_timeout_ms` at `0` unless you have a specific reason to cap queries.

### High-traffic servers (~32+ concurrent queries)

- Bump `connectionLimit` to **≈ peak concurrency** — `?connectionLimit=32` if you routinely see 32 concurrent in-flight queries. Going beyond that rarely helps and can hurt.
- Enable `mysql_request_timeout_ms` (e.g. `30000`) so a pathological query cannot hold a connection indefinitely.

### Hosted / shared MariaDB

- Respect the server-side `max_connections` limit. Spreading it across multiple oxmysql-using resources on the same server is a consumer-level coordination problem, not a pool-level one.

### What NOT to do

- Do not set `connectionLimit` arbitrarily high "just in case". 50–100+ connections push the cost curve the wrong way past moderate concurrency, as the per-transaction phases inflate from server-side contention.
- Do not assume a slow query is oxmysql's fault if your `pool.getConnection` wait is high. Enable `mysql_debug` and look for the `connection:pool.getConnection` phase in `[typeCast-diag]` output — if it is >5 ms average, the fix is `connectionLimit`, not a code change.

## How to reproduce

From the repo root, with the test fixture running:

```bash
bun run test:up
OXMYSQL_PERF_TRACE=1 bun run bench -- \
  --connectionLimits=4,10,20 \
  --concurrencies=16,32 \
  --only=transaction,query:SELECT-1,prepare:scalar-point \
  --iterations=1000
```

The harness re-initialises the pool between `connectionLimit` values so you get a clean run per combination. Override `--concurrencies=...` and `--iterations=...` to focus on other shapes.

## Phase 2 deferred items

From the Phase 2 investigation (see Git history under `perf/transaction-under-load`):

- **Transaction round-trip reduction.** `BEGIN + batch + COMMIT` is three serial MariaDB round-trips. Some connectors support `START TRANSACTION` prepended to the first DML in a single round-trip; this would shave ≈ 2.5–3 ms off every transaction. Not pursued here: the connector we use does not expose a safe primitive, and the public API contract (`MySQL.transaction(queries)` / `MySQL.startTransaction(cb)`) does not assume any particular protocol shape, so a change can be done later without breaking compatibility.
- **LIFO pool acquisition.** The mariadb connector is FIFO; a LIFO pool would reduce tail latency slightly under bursty load at the cost of worse fairness. No compelling evidence to justify forking the connector's pool implementation.
- **Connection pinning for short-lived transactions.** A second pool dedicated to transactions, separate from the query pool, could reduce cross-interference. Same argument applies — fork-maintenance overhead exceeds the expected win.

If real-world workloads start hitting the ≈ 8 ms transaction floor as a ceiling, revisit.
