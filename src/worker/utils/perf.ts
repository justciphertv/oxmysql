// Lightweight hot-path instrumentation. Toggled via the OXMYSQL_PERF_TRACE
// env var at worker start; when unset or !== '1' every helper in this
// module is a near-free no-op (one const read + one conditional per call
// site). Enabling it records per-phase count / sum / max in an in-memory
// map that benchmark drivers can `snapshot()` and `reset()` between runs.
//
// Design goals:
//   - Zero behavioural impact when disabled — callers pay at most a branch
//     and a property read per instrumented site.
//   - No external dependencies: pure Node + process.hrtime.bigint().
//   - Phase keys are opaque strings; callers pick their own taxonomy
//     (e.g. "rawQuery:awaitPool", "rawQuery:pool.query"). Using plain
//     strings keeps instrumentation additions cheap.
//   - The module holds no references that prevent GC of query arguments
//     or result rows; only summary stats persist.
//
// The module is ESM (package is "type": "module"), imported as a named
// namespace from call sites so esbuild can dead-code-eliminate the
// whole file under `--drop-labels`-style flags in the future if needed.

export type PerfPhaseStats = {
  /** Number of times this phase recorded an observation. */
  count: number;
  /** Cumulative elapsed time across all observations, in nanoseconds. */
  sumNs: bigint;
  /** Largest single observation, in nanoseconds. */
  maxNs: bigint;
};

const ENABLED: boolean = process.env.OXMYSQL_PERF_TRACE === '1';
const stats: Map<string, PerfPhaseStats> = new Map();

/** True when OXMYSQL_PERF_TRACE=1 was set at process start. */
export function enabled(): boolean {
  return ENABLED;
}

/** Returns a monotonic start time suitable for pairing with `mark()`. The
 *  return value is meaningful only when passed back to `mark()` in the
 *  same phase; do not compare across invocations. */
export function now(): bigint {
  return process.hrtime.bigint();
}

/** Record an elapsed time for `key`. `startNs` must come from `now()`.
 *  Zero-cost no-op when instrumentation is disabled. */
export function mark(key: string, startNs: bigint): void {
  if (!ENABLED) return;
  const elapsed = process.hrtime.bigint() - startNs;
  let s = stats.get(key);
  if (!s) {
    s = { count: 0, sumNs: 0n, maxNs: 0n };
    stats.set(key, s);
  }
  s.count += 1;
  s.sumNs += elapsed;
  if (elapsed > s.maxNs) s.maxNs = elapsed;
}

/** Wraps an async operation, returning its result and recording the
 *  elapsed time against `key`. Disabled fast path just calls `fn()` —
 *  the conditional compiles to a single branch on a hot loop and does
 *  not allocate when off. */
export async function time<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!ENABLED) return fn();
  const start = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    mark(key, start);
  }
}

/** Wrap a synchronous function. Symmetric with `time()` for consistency
 *  at call sites that mix sync and async instrumentation. */
export function timeSync<T>(key: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    mark(key, start);
  }
}

/** Shallow copy of the current stats map. Benchmark drivers call this
 *  after each scenario; callers must not mutate the returned value. */
export function snapshot(): Map<string, PerfPhaseStats> {
  const out = new Map<string, PerfPhaseStats>();
  for (const [k, v] of stats) {
    out.set(k, { count: v.count, sumNs: v.sumNs, maxNs: v.maxNs });
  }
  return out;
}

/** Clear all recorded stats. Call this between scenario runs so results
 *  do not bleed across phases. */
export function reset(): void {
  stats.clear();
}

/** Format a single phase as a human-readable row. */
export function formatRow(key: string, s: PerfPhaseStats): string {
  const sumMs = Number(s.sumNs) / 1e6;
  const avgUs = s.count === 0 ? 0 : Number(s.sumNs) / (s.count * 1e3);
  const maxUs = Number(s.maxNs) / 1e3;
  return (
    key.padEnd(40) +
    `  count=${String(s.count).padStart(6)}` +
    `  sum=${sumMs.toFixed(2).padStart(8)}ms` +
    `  avg=${avgUs.toFixed(2).padStart(8)}us` +
    `  max=${maxUs.toFixed(2).padStart(8)}us`
  );
}

/** Format the full stats map as a multi-line string, sorted by key so
 *  related phases (e.g. `rawQuery:awaitPool`, `rawQuery:pool.query`)
 *  appear together. */
export function formatReport(snap: Map<string, PerfPhaseStats> = stats): string {
  const keys = [...snap.keys()].sort();
  if (keys.length === 0) return '(no perf samples recorded)';
  const lines: string[] = [];
  for (const k of keys) lines.push(formatRow(k, snap.get(k)!));
  return lines.join('\n');
}
