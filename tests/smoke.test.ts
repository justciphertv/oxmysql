// CI smoke test for release quality.
//
// Exercises the happy path under four configurations that the 3.3.0
// release workflow covers:
//
//     (1) defaults — no env vars set
//     (2) OXMYSQL_PERF_TRACE=1              → perf instrumentation on
//     (3) OXMYSQL_TEST_BIGINT_AS_STRING=1   → mysql_bigint_as_string on
//     (4) OXMYSQL_TEST_DATE_AS_UTC=1        → mysql_date_as_utc on
//
// The whole point of a smoke test is that it must pass in ALL FOUR
// configurations: assertions only check invariants that hold regardless
// of which correctness flag is on (e.g. "round-trip returns the same
// logical value" rather than "returns type number"). The full suite
// covers the flag-specific shapes in clusters 5 / 6 / 22 — this file
// is a release-pipeline safety net, not a duplicate of those pins.
//
// Run manually:
//     bun run test:smoke
//     OXMYSQL_PERF_TRACE=1 bun run test:smoke
//     OXMYSQL_TEST_BIGINT_AS_STRING=1 bun run test:smoke
//     OXMYSQL_TEST_DATE_AS_UTC=1 bun run test:smoke

import { beforeAll, describe, expect, it } from 'vitest';
import { getPool, rawExecute, rawQuery, rawTransaction, reinitHarness } from './helpers/worker-harness';
import { setBigintAsString, setDateAsUtc } from '../src/worker/config';

const BIGINT_AS_STRING = process.env.OXMYSQL_TEST_BIGINT_AS_STRING === '1';
const DATE_AS_UTC = process.env.OXMYSQL_TEST_DATE_AS_UTC === '1';
const PERF_TRACE = process.env.OXMYSQL_PERF_TRACE === '1';

const modeLabel =
  [
    BIGINT_AS_STRING ? 'mysql_bigint_as_string=1' : null,
    DATE_AS_UTC ? 'mysql_date_as_utc=1' : null,
    PERF_TRACE ? 'OXMYSQL_PERF_TRACE=1' : null,
  ]
    .filter(Boolean)
    .join(' ') || 'defaults';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`query returned error: ${res.error}`);
  return res.result;
}

describe(`smoke — release-pipeline sanity (${modeLabel})`, () => {
  beforeAll(async () => {
    // The BIGINT flag must be applied BEFORE the pool is built because
    // it flips `bigIntAsNumber` / `insertIdAsNumber` in the connector
    // options. `setDateAsUtc` only affects typeCast so order does not
    // matter for it — set both to keep the bring-up identical.
    setBigintAsString(BIGINT_AS_STRING);
    setDateAsUtc(DATE_AS_UTC);
    await reinitHarness();
  });

  // ── connectivity ────────────────────────────────────────────────────

  it('pool is live (SELECT 1 returns 1)', async () => {
    const v = unwrap(await rawQuery('scalar', 'smoke', 'SELECT 1 AS x', []));
    // Accept `number` or `bigint` — MySQL's `1` is an INT literal and
    // should always come back as a number, but do not over-constrain.
    expect(Number(v)).toBe(1);
  });

  // ── basic DML round-trip ────────────────────────────────────────────

  it('INSERT + SELECT round-trip on a safe-range integer works', async () => {
    await getPool().query('TRUNCATE t_numeric');
    const id = unwrap(
      await rawQuery(
        'insert',
        'smoke',
        'INSERT INTO t_numeric (flag_bool, flag_u8) VALUES (?, ?)',
        [1, 77],
      ),
    );
    // Under default and perf-trace: number. Under bigint-as-string:
    // still number (safe-range insertId). Always a finite number here.
    expect(typeof id).toBe('number');
    expect(Number.isFinite(id as number)).toBe(true);

    const v = unwrap(
      await rawQuery('scalar', 'smoke', 'SELECT flag_u8 FROM t_numeric', []),
    );
    expect(v).toBe(77);
  });

  it('prepared SELECT (rawExecute) returns the same row', async () => {
    await getPool().query('TRUNCATE t_basic');
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('smoke', 11)");
    const rows = unwrap(
      await rawExecute('smoke', 'SELECT name, value FROM t_basic WHERE name = ?', [['smoke']], false),
    ) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('smoke');
    expect(rows[0].value).toBe(11);
  });

  // ── DATE round-trip (shape-invariant) ───────────────────────────────

  it('DATE round-trip is a finite number (flag decides local-tz vs UTC, not the shape)', async () => {
    await getPool().query('TRUNCATE t_dates');
    await getPool().query("INSERT INTO t_dates (d_date) VALUES ('2024-06-15')");
    const v = unwrap(
      await rawQuery('scalar', 'smoke', 'SELECT d_date FROM t_dates', []),
    ) as number;
    expect(typeof v).toBe('number');
    expect(Number.isFinite(v)).toBe(true);
    // Cross-check against the mode-appropriate expectation so a drift
    // in the flag plumbing is caught here, not only in the dedicated
    // flag-on cluster.
    const expected = DATE_AS_UTC
      ? new Date('2024-06-15T00:00:00Z').getTime()
      : new Date('2024-06-15 00:00:00').getTime();
    expect(v).toBe(expected);
  });

  // ── transaction envelope ────────────────────────────────────────────

  it('2x-insert transaction commits both rows', async () => {
    await getPool().query('TRUNCATE t_bulk');
    const res = await rawTransaction(
      'smoke',
      [
        { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['a', 1] },
        { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['b', 2] },
      ],
      [],
    );
    if ('error' in res) throw new Error(res.error);
    expect(res.result).toBe(true);

    const rows = unwrap(
      await rawQuery(null, 'smoke', 'SELECT k, v FROM t_bulk ORDER BY id', []),
    ) as Array<{ k: string; v: number }>;
    expect(rows).toEqual([
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
    ]);
  });

  // ── NULL handling (critical regardless of flag state) ───────────────

  it('NULL column round-trips as JS null under every flag', async () => {
    await getPool().query('TRUNCATE t_numeric');
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (NULL)');
    const v = unwrap(
      await rawQuery('scalar', 'smoke', 'SELECT big_signed FROM t_numeric', []),
    );
    expect(v).toBeNull();
  });

  // ── mode-specific correctness sanity ────────────────────────────────

  it(`BIGINT > 2^53 is preserved exactly when BIGINT flag is on, lossy when off (mode: ${modeLabel})`, async () => {
    await getPool().query('TRUNCATE t_numeric');
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (9007199254740993)');
    const v = unwrap(
      await rawQuery('scalar', 'smoke', 'SELECT big_signed FROM t_numeric', []),
    );
    if (BIGINT_AS_STRING) {
      expect(v).toBe('9007199254740993');
    } else {
      expect(v).toBe(9007199254740992); // legacy precision-loss behaviour
    }
  });
});
