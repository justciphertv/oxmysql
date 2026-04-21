// Regression cluster 8 — rawTransaction (compat-matrix §2.8, §7).
// Covers the commit happy path, rollback, multi-shape queries argument,
// batch-grouping for DML, the 1000-row chunk size, and the oxmysql:error
// / oxmysql:transaction-error events.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captured } from './helpers/parent-port-mock';
import { getPool, initHarness, rawQuery, rawTransaction } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`error: ${res.error}`);
  return res.result;
}

describe('cluster 8 — transactions', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    captured.reset();
    await getPool().query('TRUNCATE t_bulk');
    await getPool().query('TRUNCATE t_basic');
  });

  it('commits when all queries succeed', async () => {
    const res = unwrap(
      await rawTransaction(
        'test',
        [
          { query: 'INSERT INTO t_basic (name, value) VALUES (?, ?)', parameters: ['a', 1] },
          { query: 'INSERT INTO t_basic (name, value) VALUES (?, ?)', parameters: ['b', 2] },
        ],
        [],
      ),
    );
    expect(res).toBe(true);

    const count = unwrap(
      await rawQuery('scalar', 'test', 'SELECT COUNT(*) AS c FROM t_basic', []),
    );
    expect(count).toBe(2);
  });

  it('rolls back on any query failure and emits oxmysql:transaction-error', async () => {
    const res = await rawTransaction(
      'test',
      [
        { query: 'INSERT INTO t_basic (name, value) VALUES (?, ?)', parameters: ['a', 1] },
        // Violates NOT NULL:
        { query: 'INSERT INTO t_basic (name, value) VALUES (?, ?)', parameters: [null, 2] },
      ],
      [],
    );

    expect('error' in res).toBe(true);

    const count = unwrap(
      await rawQuery('scalar', 'test', 'SELECT COUNT(*) AS c FROM t_basic', []),
    );
    expect(count).toBe(0);

    // oxmysql:transaction-error must have been emitted via parentPort.
    const triggered = captured
      .byAction('triggerEvent')
      .find((m) => m.data?.event === 'oxmysql:transaction-error');
    expect(triggered).toBeDefined();
    expect(triggered?.data?.payload?.resource).toBe('test');
  });

  it('accepts tuple-style queries: [[sql, params], ...]', async () => {
    const res = unwrap(
      await rawTransaction(
        'test',
        [
          ['INSERT INTO t_basic (name, value) VALUES (?, ?)', ['t', 1]],
          ['INSERT INTO t_basic (name, value) VALUES (?, ?)', ['u', 2]],
        ] as any,
        [],
      ),
    );
    expect(res).toBe(true);

    const rows = unwrap(
      await rawQuery(null, 'test', 'SELECT name FROM t_basic ORDER BY id', []),
    ) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(['t', 'u']);
  });

  it('accepts shared-parameters shape: strings[] + params[]', async () => {
    const res = unwrap(
      await rawTransaction(
        'test',
        [
          'INSERT INTO t_basic (name, value) VALUES (?, ?)',
          'UPDATE t_basic SET value = value + 1 WHERE name = ?',
        ] as any,
        ['shared', 1] as any,
      ),
    );
    expect(res).toBe(true);
  });

  it('groups consecutive same-SQL DML entries and uses batch() (atomic)', async () => {
    // 50 INSERTs into t_bulk, interleaved with one DIFFERENT statement, so
    // we exercise both the grouped and the ungrouped branch within one
    // transaction. Atomicity must be preserved across both branches.
    const entries: Array<{ query: string; parameters: any[] }> = [];
    for (let i = 0; i < 50; i++) {
      entries.push({ query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['x', i] });
    }
    entries.push({ query: 'UPDATE t_bulk SET v = v + 100 WHERE k = ?', parameters: ['x'] });
    for (let i = 0; i < 50; i++) {
      entries.push({ query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['y', i] });
    }

    const res = unwrap(await rawTransaction('test', entries, []));
    expect(res).toBe(true);

    const xCount = unwrap(
      await rawQuery('scalar', 'test', "SELECT COUNT(*) AS c FROM t_bulk WHERE k = 'x'", []),
    );
    const yCount = unwrap(
      await rawQuery('scalar', 'test', "SELECT COUNT(*) AS c FROM t_bulk WHERE k = 'y'", []),
    );
    const xMin = unwrap(
      await rawQuery('scalar', 'test', "SELECT MIN(v) AS m FROM t_bulk WHERE k = 'x'", []),
    );
    // The UPDATE bumped every x-row by 100, so the minimum must be 100
    // (originally 0). The y-rows are untouched and still start at 0.
    expect(xCount).toBe(50);
    expect(yCount).toBe(50);
    expect(xMin).toBe(100);
  });

  it('handles 1500-row same-SQL DML batch (spans BATCH_CHUNK_SIZE = 1000)', async () => {
    const entries: Array<{ query: string; parameters: any[] }> = [];
    for (let i = 0; i < 1500; i++) {
      entries.push({ query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['z', i] });
    }

    const res = unwrap(await rawTransaction('test', entries, []));
    expect(res).toBe(true);

    const count = unwrap(
      await rawQuery('scalar', 'test', "SELECT COUNT(*) AS c FROM t_bulk WHERE k = 'z'", []),
    );
    expect(count).toBe(1500);
  });

  it('a mid-chunk failure still rolls back the whole transaction', async () => {
    // Insert 2 valid rows into t_bulk, then one that violates the NOT NULL
    // on `k`. Whole transaction must roll back.
    const entries: Array<{ query: string; parameters: any[] }> = [
      { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['x', 1] },
      { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: ['x', 2] },
      { query: 'INSERT INTO t_bulk (k, v) VALUES (?, ?)', parameters: [null, 3] },
    ];
    const res = await rawTransaction('test', entries, []);
    expect('error' in res).toBe(true);

    const count = unwrap(
      await rawQuery('scalar', 'test', 'SELECT COUNT(*) AS c FROM t_bulk', []),
    );
    expect(count).toBe(0);
  });

  it('rejects a non-array queries argument', async () => {
    const res = await rawTransaction('test', 'not an array' as any, []);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/Transaction queries must be array/);
  });
});

describe('cluster 8 — oxmysql:error on non-transaction query', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(() => {
    captured.reset();
  });

  it('non-transaction query failure emits oxmysql:error', async () => {
    const res = await rawQuery('single', 'test-q', 'SELECT * FROM no_such_table_xyz', []);
    expect('error' in res).toBe(true);

    const evt = captured
      .byAction('triggerEvent')
      .find((m) => m.data?.event === 'oxmysql:error');
    expect(evt).toBeDefined();
    expect(evt?.data?.payload?.resource).toBe('test-q');
  });
});
