// Regression cluster 3 — exercises the pinned behaviour in compat-matrix
// §2.2 (single), §2.3 (scalar), §6.1 (parseResponse), plus the
// empty-result-consistency requirement added in the Phase 4 scope.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

describe('cluster 3 — scalar, single, and empty-result consistency', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_basic');
  });

  // ── single ──────────────────────────────────────────────────────────────

  it('single returns the first row as an object', async () => {
    unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?), (?, ?)', [
        'a',
        1,
        'b',
        2,
      ]),
    );

    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT name, value FROM t_basic ORDER BY id', []),
    ) as Record<string, unknown>;

    expect(row).toMatchObject({ name: 'a', value: 1 });
  });

  it('single on empty result returns null (not undefined)', async () => {
    const res = await rawQuery('single', 'test', 'SELECT name FROM t_basic', []);
    expect('result' in res).toBe(true);
    if ('result' in res) expect(res.result).toBeNull();
  });

  // ── scalar ──────────────────────────────────────────────────────────────

  it('scalar returns the first column value of the first row', async () => {
    unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        'only',
        42,
      ]),
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT value, name FROM t_basic LIMIT 1', []),
    );
    expect(v).toBe(42);
  });

  it('scalar returns 0 as-is (not coerced to null)', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT 0 AS x', []));
    expect(v).toBe(0);
  });

  it('scalar returns empty string as-is (not coerced to null)', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', "SELECT '' AS x", []));
    expect(v).toBe('');
  });

  it('scalar returns TINYINT(1)=0 as false (not null)', async () => {
    // typeCast only coerces actually-declared TINYINT(1) columns to
    // boolean — not the result of a boolean expression (which MariaDB
    // returns as a wider INT). Use the t_numeric.flag_bool column, which
    // is declared TINYINT(1). This also confirms scalar does not collapse
    // false to null via `?? null`.
    await getPool().query('TRUNCATE t_numeric');
    await getPool().query('INSERT INTO t_numeric (flag_bool) VALUES (0)');

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT flag_bool FROM t_numeric', []),
    );
    expect(v).toBe(false);
  });

  it('scalar on empty result returns null', async () => {
    const v = await rawQuery('scalar', 'test', 'SELECT value FROM t_basic', []);
    expect('result' in v).toBe(true);
    if ('result' in v) expect(v.result).toBeNull();
  });

  it('scalar where first column IS NULL returns null (indistinguishable from empty; §2.3)', async () => {
    unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        'nullv',
        null,
      ]),
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT value FROM t_basic WHERE name = ?', ['nullv']),
    );
    expect(v).toBeNull();
  });

  // ── empty-result consistency (added for Phase 4) ────────────────────────

  it('empty-result is consistent: query=[], single=null, scalar=null', async () => {
    const qRes = await rawQuery(null, 'test', 'SELECT * FROM t_basic', []);
    const sRes = await rawQuery('single', 'test', 'SELECT * FROM t_basic', []);
    const vRes = await rawQuery('scalar', 'test', 'SELECT value FROM t_basic', []);

    expect('result' in qRes && qRes.result).toEqual([]);
    expect('result' in sRes && sRes.result).toBeNull();
    expect('result' in vRes && vRes.result).toBeNull();
  });
});
