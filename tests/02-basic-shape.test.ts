// Regression cluster 2 — exercises the pinned behaviour in compat-matrix
// sections §2.1 (query), §2.4 (insert), §2.5 (update), §6.1 (parseResponse
// type selector). All assertions must match the spec; any divergence means
// either the spec or the code is wrong — stop and reconcile before changing
// runtime behaviour.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

describe('cluster 2 — basic CRUD and response shape', () => {
  beforeAll(async () => {
    await initHarness();
    await getPool().query('TRUNCATE t_basic');
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_basic');
  });

  it('INSERT via rawQuery type=insert returns a numeric insertId', async () => {
    const id = unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        'alpha',
        1,
      ]),
    );
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('UPDATE via rawQuery type=update returns a numeric affectedRows', async () => {
    unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        'beta',
        2,
      ]),
    );

    const affected = unwrap(
      await rawQuery('update', 'test', 'UPDATE t_basic SET value = ? WHERE name = ?', [99, 'beta']),
    );
    expect(typeof affected).toBe('number');
    expect(affected).toBe(1);
  });

  it('DELETE via rawQuery type=update returns affectedRows (shares the UPDATE shape)', async () => {
    unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        'gamma',
        3,
      ]),
    );

    const affected = unwrap(
      await rawQuery('update', 'test', 'DELETE FROM t_basic WHERE name = ?', ['gamma']),
    );
    expect(affected).toBe(1);
  });

  it('SELECT via rawQuery type=null returns the full rows array', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_basic (name, value) VALUES (?, ?), (?, ?)',
        ['a', 1, 'b', 2],
      ),
    );

    const rows = unwrap(
      await rawQuery(null, 'test', 'SELECT name, value FROM t_basic ORDER BY id', []),
    ) as Array<Record<string, unknown>>;

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'a', value: 1 });
    expect(rows[1]).toMatchObject({ name: 'b', value: 2 });
  });

  it('UPDATE matching zero rows returns 0 (not null)', async () => {
    const affected = unwrap(
      await rawQuery('update', 'test', 'UPDATE t_basic SET value = 0 WHERE id = 999999', []),
    );
    expect(affected).toBe(0);
  });

  it('DELETE matching zero rows returns 0 (not null)', async () => {
    const affected = unwrap(
      await rawQuery('update', 'test', 'DELETE FROM t_basic WHERE id = 999999', []),
    );
    expect(affected).toBe(0);
  });

  it('INSERT error surfaces as { error } with no { result }', async () => {
    // NOT NULL violation on t_basic.name
    const res = await rawQuery(
      'insert',
      'test',
      'INSERT INTO t_basic (name, value) VALUES (?, ?)',
      [null, 1],
    );
    expect('error' in res).toBe(true);
    expect('result' in res).toBe(false);
    if ('error' in res) expect(res.error).toMatch(/test was unable to execute a query/);
  });
});
