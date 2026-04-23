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

## Parent↔worker channel overhead (Phase 3)

The request lifecycle includes one additional cost that pool tuning cannot
address: the latency of shipping a request from FiveM (parent thread) to
the worker, and the response back. Measured with `bench/channel.ts` using
a dedicated `noop` worker action that returns immediately with no DB work,
so the parent-measured round-trip is **pure channel cost**.

### Measured (noop action, OXMYSQL_PERF_TRACE=1)

| concurrency | ops/s | parent.rtt avg | parent.post | worker.handler | worker.postResponse | one-way transit est. |
|------------:|------:|---------------:|------------:|---------------:|--------------------:|---------------------:|
| 16 | 45 484 |   342 µs |  4.0 µs |  7.8 µs |  4.0 µs | **≈ 163 µs** |
| 32 | 45 642 |   692 µs |  3.0 µs |  8.5 µs |  4.1 µs | **≈ 338 µs** |

The synchronous call costs (`parent.post`, `worker.postResponse`) are
3–15 µs — structured clone of the envelope object is near-free. The
remaining ~150–340 µs per crossing is **event-loop scheduling + cross-
thread wake-up latency** inherent to `worker_threads`. It grows with
concurrency because each queued response has to wait its turn in the
receiving thread's task queue.

### Channel cost vs. DB work

For real workloads the channel is a small fraction of round-trip time:

| scenario | conc | parent.rtt avg | worker handler | channel (RTT−handler) | channel % |
|----------|-----:|---------------:|---------------:|----------------------:|----------:|
| noop              | 16 |   342 µs |     8 µs |  **334 µs** | **98 %** |
| query:SELECT-1    | 16 |  2 600 µs | 2 156 µs |    444 µs |   17 % |
| query:SELECT-1    | 32 |  3 910 µs | 3 515 µs |    395 µs |   10 % |
| query:indexed-pt  | 16 |  2 410 µs | 2 036 µs |    374 µs |   16 % |
| query:indexed-pt  | 32 |  5 360 µs | 4 972 µs |    388 µs |    7 % |
| tx:2x-insert      | 16 |  6 460 µs | 6 096 µs |    364 µs |    6 % |
| tx:2x-insert      | 32 | 10 410 µs |10 126 µs |    284 µs |    3 % |

Key takeaways:

- Channel overhead is ~**300–400 µs per round-trip** across scenarios,
  dominated by cross-thread scheduling — not by message size.
- Any workload that actually touches the DB amortises the channel to
  ≤ 17 % of RTT at `concurrency ≥ 16`, and ≤ 10 % at `concurrency = 32`.
- The channel is **not the bottleneck** for any measured DB scenario.
  Pool contention (Phase 2) and MariaDB server time dominate.

### What would a channel optimization look like, and should we?

Potential reductions that were considered and **not** pursued:

- **Transferable buffers / shared memory.** Would reduce the ~4–15 µs
  structured-clone cost. Negligible vs. the ~300 µs scheduling floor.
- **Envelope field pruning.** Removing e.g. `action` in favour of a
  numeric opcode saves bytes but not meaningful time — already small.
- **Response batching.** The worker could coalesce multiple responses
  into one `postMessage`. This would break the 1:1 request/response
  contract, complicates cancellation, and the measured ceiling (~45 k
  ops/s) is already well above any realistic FiveM workload.

**None of these clear the ~300 µs wake-up floor**, so all are deferred.
If future workloads demonstrate a strictly-serial hot path bottlenecked
by channel RTT (unusual for FiveM), revisit with a targeted benchmark.

### How to reproduce

```bash
bun run test:up
OXMYSQL_PERF_TRACE=1 bun run bench:channel -- \
  --concurrencies=16,32 --iterations=2000 --warmup=200
```

The bench spawns a real worker thread (not the in-process harness) and
measures per-iteration parent→worker→parent wall time with sub-µs
resolution.

## Phase 2 deferred items

From the Phase 2 investigation (see Git history under `perf/transaction-under-load`):

- **Transaction round-trip reduction.** `BEGIN + batch + COMMIT` is three serial MariaDB round-trips. Some connectors support `START TRANSACTION` prepended to the first DML in a single round-trip; this would shave ≈ 2.5–3 ms off every transaction. Not pursued here: the connector we use does not expose a safe primitive, and the public API contract (`MySQL.transaction(queries)` / `MySQL.startTransaction(cb)`) does not assume any particular protocol shape, so a change can be done later without breaking compatibility.
- **LIFO pool acquisition.** The mariadb connector is FIFO; a LIFO pool would reduce tail latency slightly under bursty load at the cost of worse fairness. No compelling evidence to justify forking the connector's pool implementation.
- **Connection pinning for short-lived transactions.** A second pool dedicated to transactions, separate from the query pool, could reduce cross-interference. Same argument applies — fork-maintenance overhead exceeds the expected win.

If real-world workloads start hitting the ≈ 8 ms transaction floor as a ceiling, revisit.
