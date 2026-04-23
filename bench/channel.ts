/**
 * Phase 3 channel-overhead benchmark. Spawns a real `worker_threads`
 * Worker running the production `src/worker/worker.ts` and drives the
 * parent↔worker protocol directly, measuring per-request round-trip
 * latency at concurrency levels that mirror the Phase 2 transaction
 * sweep.
 *
 * What it measures (per scenario × concurrency):
 *   - parent.post          : wall-clock cost of the `worker.postMessage`
 *                            call itself (synchronous; structured-clone).
 *   - parent.rtt           : from just-before postMessage to the parent
 *                            receiving the response (round-trip).
 *   - channel:worker.handler    : total worker-side span (from the
 *                            production instrumentation added in Phase 3).
 *   - channel:worker.postResponse : just the `parentPort.postMessage` call
 *                            inside sendResponse (worker side).
 *   - plus any `rawQuery:*` / `rawTransaction:*` phases the scenario
 *     exercises, inherited from Phase 1/2 instrumentation.
 *
 * Channel transit cost (one-way, estimated):
 *     ≈ (parent.rtt − worker.handler − parent.post − worker.postResponse) / 2
 *
 * Prereqs:
 *   - MariaDB fixture running (`bun run test:up`).
 *   - OXMYSQL_PERF_TRACE=1 in the environment (inherited by the worker).
 *
 * Usage:
 *     OXMYSQL_PERF_TRACE=1 bun run bench:channel
 *     OXMYSQL_PERF_TRACE=1 bun run bench:channel -- \
 *         --concurrencies=16,32 --iterations=2000 --warmup=200
 */

import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';
import { buildPoolOptions } from '../tests/helpers/env';

if (process.env.OXMYSQL_PERF_TRACE !== '1') {
  // eslint-disable-next-line no-console
  console.error(
    '[bench:channel] OXMYSQL_PERF_TRACE=1 is required. Re-run with the env var set.',
  );
  process.exit(2);
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseIntList(argName: string, fallback: number[]): number[] {
  const arg = process.argv.find((a) => a.startsWith(`--${argName}=`));
  if (!arg) return fallback;
  const parts = arg
    .slice(`--${argName}=`.length)
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : fallback;
}
function parseIntArg(argName: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${argName}=`));
  if (!arg) return fallback;
  const n = Number.parseInt(arg.slice(`--${argName}=`.length).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const concLevels = parseIntList('concurrencies', [16, 32]);
const ITERATIONS = parseIntArg('iterations', 2_000);
const WARMUP = parseIntArg('warmup', 200);

// ── Worker setup ────────────────────────────────────────────────────────
const workerUrl = new URL('../src/worker/worker.ts', import.meta.url);
const worker = new Worker(workerUrl);

type PendingResolver = (data: any) => void;
const pending = new Map<number, PendingResolver>();
let nextId = 0;
let workerReady = false;
let workerReadyResolvers: Array<() => void> = [];

worker.on('message', (msg: any) => {
  if (!msg) return;
  if (msg.action === 'response' && typeof msg.id === 'number') {
    const r = pending.get(msg.id);
    pending.delete(msg.id);
    r?.(msg.data);
    return;
  }
  switch (msg.action) {
    case 'print': {
      // Forward worker diagnostics — useful for surfacing connection
      // errors during init. Prefix to distinguish from harness output.
      // eslint-disable-next-line no-console
      console.log('[worker]', ...(Array.isArray(msg.data) ? msg.data : [msg.data]));
      break;
    }
    case 'dbVersion': {
      workerReady = true;
      const rs = workerReadyResolvers;
      workerReadyResolvers = [];
      for (const r of rs) r();
      break;
    }
    // Other worker-originating messages (scheduleTick, triggerEvent,
    // logQuery, callLogger) are not meaningful outside FiveM — drop.
    default:
      break;
  }
});

worker.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[bench:channel] worker error:', err);
  process.exit(1);
});

function send<T = any>(action: string, data?: any): Promise<T> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ action, id, data });
  });
}

/** Like `send` but returns parent-side timing for the postMessage call
 *  and the full RTT, in milliseconds. */
function sendTimed<T = any>(
  action: string,
  data?: any,
): Promise<{ result: T; postMs: number; rttMs: number }> {
  return new Promise((resolve) => {
    const id = nextId++;
    const postStart = performance.now();
    pending.set(id, (resp) => {
      const recv = performance.now();
      resolve({ result: resp?.result, postMs: postEnd - postStart, rttMs: recv - postStart });
    });
    worker.postMessage({ action, id, data });
    const postEnd = performance.now();
  });
}

type WorkerPerfSnap = Record<string, { count: number; sumNs: string; maxNs: string }>;

async function perfReset(): Promise<void> {
  await send('perfReset');
}
async function perfSnapshot(): Promise<WorkerPerfSnap> {
  const resp = await send<{ result: WorkerPerfSnap }>('perfSnapshot');
  return resp.result;
}

function waitReady(): Promise<void> {
  if (workerReady) return Promise.resolve();
  return new Promise((r) => workerReadyResolvers.push(r));
}

// ── Init protocol ───────────────────────────────────────────────────────
async function initWorker(): Promise<void> {
  const poolOpts = buildPoolOptions({});
  // The worker's 'initialize' action does not reply with a response
  // envelope; it emits a `dbVersion` message when the pool is up.
  worker.postMessage({
    action: 'initialize',
    data: {
      connectionOptions: poolOpts,
      mysql_transaction_isolation_level: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      mysql_debug: false,
      namedPlaceholders: undefined,
      mysql_bit_full_integer: false,
    },
  });
  await waitReady();
}

// ── Scenarios ───────────────────────────────────────────────────────────

type ScenarioFn = () => Promise<{ postMs: number; rttMs: number }>;
interface Scenario {
  name: string;
  setup?: () => Promise<void>;
  unit: ScenarioFn;
}

const scenarios: Scenario[] = [
  {
    name: 'noop',
    unit: async () => {
      const t = await sendTimed('noop');
      return { postMs: t.postMs, rttMs: t.rttMs };
    },
  },
  {
    name: 'query:SELECT-1',
    unit: async () => {
      const t = await sendTimed('query', {
        type: null,
        invokingResource: 'bench',
        query: 'SELECT 1 AS x',
        parameters: [],
      });
      return { postMs: t.postMs, rttMs: t.rttMs };
    },
  },
  {
    name: 'query:indexed-point',
    setup: async () => {
      await send('query', {
        type: null,
        invokingResource: 'bench-setup',
        query: 'TRUNCATE t_basic',
        parameters: [],
      });
      await send('query', {
        type: null,
        invokingResource: 'bench-setup',
        query: "INSERT INTO t_basic (name, value) VALUES ('only', 42)",
        parameters: [],
      });
    },
    unit: async () => {
      const t = await sendTimed('query', {
        type: null,
        invokingResource: 'bench',
        query: 'SELECT id, name, value FROM t_basic WHERE name = ?',
        parameters: ['only'],
      });
      return { postMs: t.postMs, rttMs: t.rttMs };
    },
  },
  {
    name: 'transaction:2x-insert',
    setup: async () => {
      await send('query', {
        type: null,
        invokingResource: 'bench-setup',
        query: 'TRUNCATE t_bulk',
        parameters: [],
      });
    },
    unit: async () => {
      const t = await sendTimed('transaction', {
        invokingResource: 'bench',
        queries: [
          { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['a', 1] },
          { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['b', 2] },
        ],
        parameters: [],
      });
      return { postMs: t.postMs, rttMs: t.rttMs };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

type Stats = { count: number; sum: number; max: number };
const newStats = (): Stats => ({ count: 0, sum: 0, max: 0 });
const push = (s: Stats, v: number) => {
  s.count += 1;
  s.sum += v;
  if (v > s.max) s.max = v;
};

interface Result {
  scenario: string;
  concurrency: number;
  iterations: number;
  wallMs: number;
  opsPerSec: number;
  post: Stats; // parent.post, ms
  rtt: Stats; // parent.rtt, ms
  worker: WorkerPerfSnap;
}

async function runOne(scenario: Scenario, concurrency: number): Promise<Result> {
  if (scenario.setup) await scenario.setup();

  // Warm up
  for (let i = 0; i < WARMUP; i++) await scenario.unit();
  await perfReset();

  const post = newStats();
  const rtt = newStats();

  const start = performance.now();
  let dispatched = 0;
  const inFlight = new Set<Promise<unknown>>();

  while (dispatched < ITERATIONS) {
    while (inFlight.size < concurrency && dispatched < ITERATIONS) {
      const p = scenario
        .unit()
        .then((r) => {
          push(post, r.postMs);
          push(rtt, r.rttMs);
        })
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      dispatched += 1;
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  const wallMs = performance.now() - start;

  const workerSnap = await perfSnapshot();

  return {
    scenario: scenario.name,
    concurrency,
    iterations: ITERATIONS,
    wallMs,
    opsPerSec: (ITERATIONS / wallMs) * 1000,
    post,
    rtt,
    worker: workerSnap,
  };
}

function fmtMs(n: number): string {
  return n >= 1 ? `${n.toFixed(2)} ms` : `${(n * 1000).toFixed(1)} µs`;
}

function formatResult(r: Result): string {
  const lines: string[] = [];
  lines.push(
    `=== ${r.scenario}  conc=${r.concurrency}  n=${r.iterations}  ` +
      `wall=${r.wallMs.toFixed(0)}ms  ops/s=${r.opsPerSec.toFixed(0)} ===`,
  );
  const postAvg = r.post.count ? r.post.sum / r.post.count : 0;
  const rttAvg = r.rtt.count ? r.rtt.sum / r.rtt.count : 0;
  lines.push(
    `  parent.post          avg=${fmtMs(postAvg).padStart(9)}  max=${fmtMs(r.post.max).padStart(9)}`,
  );
  lines.push(
    `  parent.rtt           avg=${fmtMs(rttAvg).padStart(9)}  max=${fmtMs(r.rtt.max).padStart(9)}`,
  );

  // Worker phases (converted to µs averages like bench/hotpath)
  const keys = Object.keys(r.worker).sort();
  for (const k of keys) {
    if (!k.startsWith('channel:') && !k.startsWith('rawQuery:') &&
        !k.startsWith('rawTransaction:') && !k.startsWith('getConnection:')) {
      continue;
    }
    const v = r.worker[k];
    const sumNs = BigInt(v.sumNs);
    const maxNs = BigInt(v.maxNs);
    const avgUs = v.count ? Number(sumNs) / (v.count * 1e3) : 0;
    const maxUs = Number(maxNs) / 1e3;
    lines.push(
      `  ${k.padEnd(40)} count=${String(v.count).padStart(6)}  ` +
        `avg=${avgUs.toFixed(1).padStart(8)}us  max=${maxUs.toFixed(1).padStart(9)}us`,
    );
  }

  // Estimated channel transit (one-way)
  const handler = r.worker['channel:worker.handler'];
  const workerPost = r.worker['channel:worker.postResponse'];
  if (handler) {
    const handlerAvgMs = handler.count ? Number(BigInt(handler.sumNs)) / handler.count / 1e6 : 0;
    const workerPostAvgMs = workerPost?.count
      ? Number(BigInt(workerPost.sumNs)) / workerPost.count / 1e6
      : 0;
    // parent.rtt = parent.post + transit(→) + worker.handler + worker.postResponse + transit(←)
    // ⇒ transit_total ≈ parent.rtt − parent.post − worker.handler − worker.postResponse
    const transitTotal = rttAvg - postAvg - handlerAvgMs - workerPostAvgMs;
    const oneWay = transitTotal / 2;
    lines.push(
      `  ▸ est. channel one-way transit ≈ ${fmtMs(oneWay)}  ` +
        `(round-trip overhead ≈ ${fmtMs(transitTotal)})`,
    );
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  // eslint-disable-next-line no-console
  console.log('[bench:channel] spawning worker and initializing pool...');
  await initWorker();
  // eslint-disable-next-line no-console
  console.log(
    `[bench:channel] ready.  warmup=${WARMUP}  iterations=${ITERATIONS}  ` +
      `concurrencies=${concLevels.join(',')}`,
  );

  const results: Result[] = [];
  for (const scenario of scenarios) {
    for (const conc of concLevels) {
      const r = await runOne(scenario, conc);
      results.push(r);
      // eslint-disable-next-line no-console
      console.log('\n' + formatResult(r));
    }
  }

  // Summary grid
  // eslint-disable-next-line no-console
  console.log('\n=== summary (ops/s) ===');
  const header = 'scenario'.padEnd(32) + concLevels.map((c) => `conc=${c}`.padStart(12)).join('');
  // eslint-disable-next-line no-console
  console.log(header);
  for (const s of scenarios) {
    const row =
      s.name.padEnd(32) +
      concLevels
        .map((c) => {
          const r = results.find((x) => x.scenario === s.name && x.concurrency === c);
          return (r ? r.opsPerSec.toFixed(0) : '—').padStart(12);
        })
        .join('');
    // eslint-disable-next-line no-console
    console.log(row);
  }

  // eslint-disable-next-line no-console
  console.log('\n=== summary (parent.rtt avg µs) ===');
  // eslint-disable-next-line no-console
  console.log(header);
  for (const s of scenarios) {
    const row =
      s.name.padEnd(32) +
      concLevels
        .map((c) => {
          const r = results.find((x) => x.scenario === s.name && x.concurrency === c);
          if (!r) return '—'.padStart(12);
          const avg = r.rtt.sum / r.rtt.count;
          return (avg * 1000).toFixed(0).padStart(12);
        })
        .join('');
    // eslint-disable-next-line no-console
    console.log(row);
  }

  // Graceful teardown
  worker.postMessage({ action: 'shutdown' });
  await new Promise((r) => worker.once('exit', r));
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench:channel] fatal:', err);
  process.exit(1);
});
