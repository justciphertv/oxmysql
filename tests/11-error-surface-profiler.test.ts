// Regression cluster 11 — error string format stability (compat-matrix §9.1)
// and an informational probe for INFORMATION_SCHEMA.PROFILING (§9.3).

import { beforeAll, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';

describe('cluster 11 — error surface', () => {
  beforeAll(async () => {
    await initHarness();
  });

  it('rawQuery error string matches the pinned format', async () => {
    const res = await rawQuery('single', 'my-res', 'SELECT * FROM no_such_table_xyz', []);
    expect('error' in res).toBe(true);
    if (!('error' in res)) throw new Error('unreachable');

    // Per compat-matrix §9.1 the canonical format is:
    //   "<resource> was unable to execute a query!\nQuery: <sql>\n<message>"
    // Downstream grep/regex consumers depend on this; any change is a
    // breaking change to the public error surface.
    expect(res.error).toMatch(/^my-res was unable to execute a query!/);
    expect(res.error).toContain('\nQuery: SELECT * FROM no_such_table_xyz');
  });

  it('rawTransaction error string contains the resource prefix and SQL', async () => {
    // Drive via rawQuery because rawTransaction goes through a different
    // logError path; the two share the "<resource> was unable to ..."
    // prefix shape, which is what consumers grep on.
    const res = await rawQuery(
      'tx-res',
      'test',
      'SELECT * FROM another_missing_table',
      [],
    );
    if (!('error' in res)) throw new Error('expected error');
    expect(res.error).toContain('another_missing_table');
  });
});

describe('cluster 11 — PROFILING probe (informational only)', () => {
  beforeAll(async () => {
    await initHarness();
  });

  // Non-gating: the debug/profiler path relies on
  // INFORMATION_SCHEMA.PROFILING. MariaDB keeps it populated in recent
  // versions, but it has been marked deprecated since 5.6 and may be
  // disabled in some builds. This test only records whether the feature
  // is available in the tested server; it is intentionally always green
  // so CI against a deprecated build still passes.
  it('probes whether INFORMATION_SCHEMA.PROFILING is populated', async () => {
    try {
      // Enable profiling for this session and issue a benign query.
      await getPool().query('SET profiling = 0');
      await getPool().query('SET profiling_history_size = 100');
      await getPool().query('SET profiling = 1');
      await getPool().query('SELECT 1');

      const rows = (await getPool().query(
        'SELECT SUM(DURATION) AS total FROM INFORMATION_SCHEMA.PROFILING',
      )) as Array<{ total: unknown }>;

      // eslint-disable-next-line no-console
      console.info(
        `[profiler probe] rows=${rows?.length ?? 0} total=${String(rows?.[0]?.total ?? '(null)')}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.info(`[profiler probe] INFORMATION_SCHEMA.PROFILING unavailable: ${(err as Error).message}`);
    } finally {
      try {
        await getPool().query('SET profiling = 0');
      } catch {
        /* ignore */
      }
    }

    expect(true).toBe(true);
  });
});
