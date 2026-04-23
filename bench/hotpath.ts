/**
 * Hot-path benchmark harness. Drives representative workloads through
 * the worker's raw code paths with OXMYSQL_PERF_TRACE=1 so each
 * instrumentation phase records breakdown timings. Produces a report
 * that separates pool wait, connector execution, and response shaping
 * per scenario and per concurrency level.
 *
 * Usage (from repo root, MariaDB fixture already running via
 * `bun run test:up`):
 *
 *     OXMYSQL_PERF_TRACE=1 bun run bench
 *
 * Or to run a subset:
 *
 *     OXMYSQL_PERF_TRACE=1 bun run bench -- --only=prepare,transaction
 *
 * The harness bypasses the parent↔worker messaging layer: it calls the
 * rawQuery / rawExecute / rawTransaction functions directly so the
 * instrumentation we are measuring can be attributed to DB code and
 * not to the test-level scaffolding. Parent-side messaging overhead is
 * measured separately (Phase 1 does not cover it; it will be added if
 * Phase 2 or 3 finds cross-worker latency relevant).
 *
 * Intentional non-goals for Phase 1:
 *   - Not a regression tool. This does not enforce ops/s thresholds.
 *   - Not a replacement for the vitest suite.
 *   - Does not exercise the FiveM layer.
 */

import { performance } from 'node:perf_hooks';

import {
  initHarness,
  rawExecute,
  rawQuery,
  rawTransaction,
  reinitHarness,
  getPool,
} from '../tests/helpers/worker-harness';
import * as perf from '../src/worker/utils/perf';

if (!perf.enabled()) {
  // eslint-disable-next-line no-console
  console.error(
    '[bench] OXMYSQL_PERF_TRACE is not set to "1" — instrumentation will not record anything. ' +
      'Re-run with `OXMYSQL_PERF_TRACE=1 bun run bench`.',
  );
  process.exit(2);
}

// ── Scenario definitions ────────────────────────────────────────────────

type ScenarioFn = () => Promise<unknown>;

interface Scenario {
  name: string;
  /** Called once before the timed loop; use for setup/warm-up. */
  setup?: () => Promise<void>;
  /** One unit of work. Return value is ignored. */
  unit: ScenarioFn;
}

const scenarios: Scenario[] = [
  // Point-query baselines via rawQuery (type=null → default).
  {
    name: 'query:SELECT-1',
    unit: () => rawQuery(null, 'bench', 'SELECT 1 AS x', []),
  },
  {
    name: 'query:indexed-select',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
      await getPool().query(
        "INSERT INTO t_basic (name, value) VALUES ('a', 1), ('b', 2), ('c', 3)",
      );
    },
    unit: () =>
      rawQuery(
        null,
        'bench',
        'SELECT id, name, value FROM t_basic WHERE name = ?',
        ['a'],
      ),
  },

  // single vs scalar through rawQuery.
  {
    name: 'single:indexed-row',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
      await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 42)");
    },
    unit: () =>
      rawQuery(
        'single',
        'bench',
        'SELECT id, name, value FROM t_basic WHERE name = ?',
        ['only'],
      ),
  },
  {
    name: 'scalar:indexed-value',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
      await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 42)");
    },
    unit: () =>
      rawQuery(
        'scalar',
        'bench',
        'SELECT value FROM t_basic WHERE name = ?',
        ['only'],
      ),
  },

  // Prepare / rawExecute hot paths — unpack on/off, DML vs SELECT.
  {
    name: 'prepare:scalar-point',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
      await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 99)");
    },
    unit: () =>
      rawExecute(
        'bench',
        'SELECT value FROM t_basic WHERE name = ?',
        [['only']],
        true,
      ),
  },
  {
    name: 'prepare:row-point',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
      await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 77)");
    },
    unit: () =>
      rawExecute(
        'bench',
        'SELECT id, name, value FROM t_basic WHERE name = ?',
        [['only']],
        true,
      ),
  },
  {
    name: 'prepare:DML-single-insert',
    setup: async () => {
      await getPool().query('TRUNCATE t_basic');
    },
    unit: () =>
      rawExecute(
        'bench',
        'INSERT INTO t_basic (name, value) VALUES (?, ?)',
        [['x', 1]],
        true,
      ),
  },

  // Transaction 2x insert — the canonical "transaction under load" case.
  {
    name: 'transaction:2x-insert',
    setup: async () => {
      await getPool().query('TRUNCATE t_bulk');
    },
    unit: () =>
      rawTransaction(
        'bench',
        [
          { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['a', 1] },
          { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['b', 2] },
        ],
        [],
      ),
  },
];

// ── Harness ─────────────────────────────────────────────────────────────

function parseIntList(argName: string, fallback: number[]): number[] {
  const arg = process.argv.find((a) => a.startsWith(`--${argName}=`));
  if (!arg) return fallback;
  const parts = arg
    .slice(`--${argName}=`.length)
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : fallback;
}

function parseIntArg(argName: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${argName}=`));
  if (!arg) return fallback;
  const n = Number.parseInt(arg.slice(`--${argName}=`.length).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const concLevels = parseIntList('concurrencies', [1, 16, 32]);
const connectionLimits = parseIntList('connectionLimits', [0]); // 0 = use fixture default
const WARMUP = parseIntArg('warmup', 50);
const ITERATIONS = parseIntArg('iterations', 1_000);

type RunResult = {
  scenario: string;
  concurrency: number;
  connectionLimit: number;
  iterations: number;
  wallMs: number;
  opsPerSec: number;
  breakdown: Map<string, perf.PerfPhaseStats>;
};

async function runScenario(
  scenario: Scenario,
  concurrency: number,
  connectionLimit: number,
): Promise<RunResult> {
  if (scenario.setup) await scenario.setup();

  // Warm up — exercise the path so JIT / connection pool reaches steady
  // state, then discard the samples.
  for (let i = 0; i < WARMUP; i++) await scenario.unit();
  perf.reset();

  const start = performance.now();

  if (concurrency === 1) {
    for (let i = 0; i < ITERATIONS; i++) await scenario.unit();
  } else {
    let dispatched = 0;
    const inFlight = new Set<Promise<unknown>>();
    const target = ITERATIONS;

    while (dispatched < target) {
      while (inFlight.size < concurrency && dispatched < target) {
        const p = scenario.unit().finally(() => inFlight.delete(p));
        inFlight.add(p);
        dispatched += 1;
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  }

  const wallMs = performance.now() - start;
  return {
    scenario: scenario.name,
    concurrency,
    connectionLimit,
    iterations: ITERATIONS,
    wallMs,
    opsPerSec: (ITERATIONS / wallMs) * 1000,
    breakdown: perf.snapshot(),
  };
}

function formatResult(r: RunResult): string {
  const lines: string[] = [];
  const cl = r.connectionLimit > 0 ? ` connLimit=${r.connectionLimit}` : '';
  lines.push(
    `=== ${r.scenario}  conc=${r.concurrency}${cl}  n=${r.iterations}  ` +
      `wall=${r.wallMs.toFixed(0)}ms  ops/s=${r.opsPerSec.toFixed(0)} ===`,
  );

  const keys = [...r.breakdown.keys()].sort();
  if (keys.length === 0) {
    lines.push('  (no perf samples — scenario may not touch any instrumented path)');
  }
  for (const k of keys) {
    const s = r.breakdown.get(k)!;
    const sumMs = Number(s.sumNs) / 1e6;
    const avgUs = s.count === 0 ? 0 : Number(s.sumNs) / (s.count * 1e3);
    const maxUs = Number(s.maxNs) / 1e3;
    lines.push(
      `  ${k.padEnd(52)} ` +
        `count=${String(s.count).padStart(5)}  ` +
        `sum=${sumMs.toFixed(1).padStart(7)}ms  ` +
        `avg=${avgUs.toFixed(1).padStart(7)}us  ` +
        `max=${maxUs.toFixed(1).padStart(8)}us`,
    );
  }
  return lines.join('\n');
}

// ── CLI filter ──────────────────────────────────────────────────────────

function parseOnlyFilter(): string[] | null {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const values = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

function scenarioMatches(name: string, filter: string[] | null): boolean {
  if (!filter) return true;
  return filter.some((f) => name.startsWith(f));
}

// ── Main ────────────────────────────────────────────────────────────────

async function initForLimit(connectionLimit: number): Promise<void> {
  const poolOverrides = connectionLimit > 0 ? { connectionLimit } : undefined;
  await reinitHarness(poolOverrides ? { poolOverrides } : {});
}

async function main() {
  const filter = parseOnlyFilter();
  const active = scenarios.filter((s) => scenarioMatches(s.name, filter));

  // eslint-disable-next-line no-console
  console.log('[bench] initializing harness...');
  // First init picks the first connectionLimit (or fixture default when 0).
  await initForLimit(connectionLimits[0]);

  // eslint-disable-next-line no-console
  console.log(
    `[bench] warmup=${WARMUP} iterations=${ITERATIONS} ` +
      `concurrencies=${concLevels.join(',')} ` +
      `connectionLimits=${connectionLimits.join(',')}` +
      (filter ? `  filter=${JSON.stringify(filter)} (${active.length}/${scenarios.length} scenarios)` : ''),
  );

  const results: RunResult[] = [];

  for (let li = 0; li < connectionLimits.length; li++) {
    const limit = connectionLimits[li];
    if (li > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n[bench] reinit pool with connectionLimit=${limit || 'default'}`);
      await initForLimit(limit);
    }

    for (const scenario of active) {
      for (const conc of concLevels) {
        const r = await runScenario(scenario, conc, limit);
        results.push(r);
        // eslint-disable-next-line no-console
        console.log('\n' + formatResult(r));
      }
    }
  }

  // Compact summary grid: one block per connection limit.
  const scenarioNames = [...new Set(results.map((r) => r.scenario))];
  for (const limit of connectionLimits) {
    // eslint-disable-next-line no-console
    console.log(`\n=== summary (ops/s) connectionLimit=${limit || 'default'} ===`);
    const header = 'scenario'.padEnd(32) + concLevels.map((c) => `conc=${c}`.padStart(12)).join('');
    // eslint-disable-next-line no-console
    console.log(header);
    for (const name of scenarioNames) {
      const row =
        name.padEnd(32) +
        concLevels
          .map((c) => {
            const r = results.find(
              (x) => x.scenario === name && x.concurrency === c && x.connectionLimit === limit,
            );
            return (r ? r.opsPerSec.toFixed(0) : '—').padStart(12);
          })
          .join('');
      // eslint-disable-next-line no-console
      console.log(row);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench] fatal:', err);
  process.exit(1);
});
