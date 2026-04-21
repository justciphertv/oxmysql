// Regression cluster 6 — date and datetime handling. Pins the behaviour
// described in compat-matrix §5.
//
// The DST DATE test (§12 item 20) is deterministic by construction: it
// asserts that the typeCast result matches `new Date(str + ' 00:00:00')
// .getTime()` in the process's *current* timezone, whatever that is. If
// the process is running with TZ='America/New_York', the delta between
// 2024-03-10 and 2024-03-11 midnights is 23h (DST spring-forward); with
// TZ='UTC' it is 24h. Either outcome is self-consistent and pins the
// local-timezone behaviour pinned in §5.
//
// To exercise the DST-visible path explicitly in CI, run the suite with
// TZ=America/New_York.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

const midnightLocalMs = (dateStr: string) => new Date(`${dateStr} 00:00:00`).getTime();

describe('cluster 6 — dates', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_dates');
  });

  // ── DATETIME / TIMESTAMP ────────────────────────────────────────────────

  it('DATETIME round-trips as Unix epoch ms (server tz = UTC)', async () => {
    // The compose fixture pins the server to UTC (+00:00) and the container
    // TZ to UTC. The connector therefore returns the stored value as
    // "YYYY-MM-DD HH:mm:ss[.SSS]" with no tz suffix, and typeCast calls
    // new Date(string).getTime(). On Node, a date-only + time string without
    // a 'T' is parsed in local TZ, so this test's expected value is
    // computed the same way.
    await getPool().query(
      "INSERT INTO t_dates (d_datetime) VALUES ('2024-06-15 12:30:45')",
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_datetime FROM t_dates', []),
    ) as number;

    expect(typeof v).toBe('number');
    expect(v).toBe(new Date('2024-06-15 12:30:45').getTime());
  });

  it('NULL DATETIME reads as null (not epoch 0)', async () => {
    await getPool().query('INSERT INTO t_dates (d_datetime) VALUES (NULL)');

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_datetime FROM t_dates', []),
    );
    expect(v).toBeNull();
  });

  it('TIMESTAMP round-trips as Unix epoch ms', async () => {
    await getPool().query(
      "INSERT INTO t_dates (d_timestamp) VALUES ('2024-01-02 03:04:05')",
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_timestamp FROM t_dates', []),
    ) as number;
    expect(typeof v).toBe('number');
    expect(v).toBe(new Date('2024-01-02 03:04:05').getTime());
  });

  // ── DATE local-tz parse + DST (§12 items 20, 21) ────────────────────────

  it('DATE is parsed in local tz via `new Date(str + \' 00:00:00\')`', async () => {
    await getPool().query("INSERT INTO t_dates (d_date) VALUES ('2024-06-15')");

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_date FROM t_dates', []),
    ) as number;

    expect(typeof v).toBe('number');
    expect(v).toBe(midnightLocalMs('2024-06-15'));
  });

  it('DATE across DST transition uses process-local offsets (deterministic)', async () => {
    await getPool().query("INSERT INTO t_dates (d_date) VALUES ('2024-03-10'), ('2024-03-11')");

    const rows = unwrap(
      await rawQuery(null, 'test', 'SELECT d_date FROM t_dates ORDER BY id', []),
    ) as Array<{ d_date: number }>;

    expect(rows[0].d_date).toBe(midnightLocalMs('2024-03-10'));
    expect(rows[1].d_date).toBe(midnightLocalMs('2024-03-11'));

    const observedDelta = rows[1].d_date - rows[0].d_date;
    const expectedDelta = midnightLocalMs('2024-03-11') - midnightLocalMs('2024-03-10');
    expect(observedDelta).toBe(expectedDelta);

    // Advisory check: if the process happens to be in America/New_York,
    // the DST-visible delta should be 23h. This is NOT gating; it only
    // records the DST-observed behaviour when a DST zone is configured.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'America/New_York') {
      expect(observedDelta).toBe(23 * 3600 * 1000);
    }
  });

  it('NULL DATE reads as null', async () => {
    await getPool().query('INSERT INTO t_dates (d_date) VALUES (NULL)');
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT d_date FROM t_dates', []));
    expect(v).toBeNull();
  });

  // ── TIME / YEAR (defer to connector default) ────────────────────────────

  it('TIME falls through to the connector default (string HH:MM:SS)', async () => {
    await getPool().query("INSERT INTO t_dates (d_time) VALUES ('12:34:56')");
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_time FROM t_dates', []),
    );
    expect(typeof v).toBe('string');
    expect(v).toBe('12:34:56');
  });

  it('YEAR falls through to the connector default (number)', async () => {
    await getPool().query('INSERT INTO t_dates (d_year) VALUES (2024)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT d_year FROM t_dates', []),
    );
    expect(typeof v).toBe('number');
    expect(v).toBe(2024);
  });
});
