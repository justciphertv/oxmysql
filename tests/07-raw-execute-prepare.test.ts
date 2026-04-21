// Regression cluster 7 — rawExecute and prepare (compat-matrix §2.6, §2.7,
// §6.2). Exercises the fast-path batching, the unpack-semantics for
// MySQL.prepare, the lowercase-DML mis-classification, and the
// single-element-batch collapse.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawExecute } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawExecute returned error: ${res.error}`);
  return res.result;
}

describe('cluster 7 — rawExecute and prepare', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_basic');
  });

  // ── rawExecute (unpack=false) ───────────────────────────────────────────

  it('single SELECT param set returns a rows array', async () => {
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('r', 10), ('s', 20)");

    const rows = unwrap(
      await rawExecute('test', 'SELECT name, value FROM t_basic ORDER BY id', [[]]),
    ) as Array<Record<string, unknown>>;

    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'r', value: 10 });
  });

  it('multiple SELECT param sets returns an array of row arrays', async () => {
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('a', 1), ('b', 2), ('c', 3)");

    const results = unwrap(
      await rawExecute('test', 'SELECT name FROM t_basic WHERE value = ?', [[1], [2]]),
    ) as Array<Array<Record<string, unknown>>>;

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    expect((results[0] as any)[0].name).toBe('a');
    expect((results[1] as any)[0].name).toBe('b');
  });

  it('single DML param set returns the raw UpsertResult', async () => {
    const res = unwrap(
      await rawExecute('test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [['x', 1]]),
    ) as { affectedRows: number | bigint; insertId: number | bigint };

    expect(res).toBeDefined();
    expect(Number(res.affectedRows)).toBe(1);
    expect(Number(res.insertId)).toBeGreaterThan(0);
  });

  it('single-element DML batch collapses to that element (§2.7)', async () => {
    // batchResults.length === 1 collapses to result[0]. Pin this pending
    // any future deliberate change.
    const res = unwrap(
      await rawExecute('test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [['y', 7]]),
    );

    // Not an array of UpsertResult — just one UpsertResult-like object.
    expect(Array.isArray(res)).toBe(false);
    expect(typeof res).toBe('object');
  });

  it('multi-param DML batch returns an array of UpsertResult', async () => {
    const res = unwrap(
      await rawExecute('test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]),
    ) as Array<{ affectedRows: number | bigint }>;

    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
    for (const r of res) expect(Number(r.affectedRows)).toBe(1);
  });

  // ── prepare (rawExecute with unpack=true) ───────────────────────────────

  it('prepare INSERT returns insertId (scalar) for a single param set', async () => {
    // Drive prepare via the underlying execute/unpack path.
    const res = unwrap(
      await rawExecute('test', 'INSERT INTO t_basic (name, value) VALUES (?, ?)', [['pz', 5]], true),
    );

    expect(typeof res).toBe('number');
    expect(res as number).toBeGreaterThan(0);
  });

  it('prepare SELECT with single column returns the scalar value', async () => {
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 99)");

    const res = unwrap(
      await rawExecute('test', 'SELECT value FROM t_basic WHERE name = ?', [['only']], true),
    );

    expect(res).toBe(99);
  });

  it('prepare SELECT with multiple columns returns the first row', async () => {
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('only', 77)");

    const res = unwrap(
      await rawExecute(
        'test',
        'SELECT name, value FROM t_basic WHERE name = ?',
        [['only']],
        true,
      ),
    ) as Record<string, unknown>;

    expect(res).toMatchObject({ name: 'only', value: 77 });
  });

  it('prepare SELECT on empty result returns null', async () => {
    const res = unwrap(
      await rawExecute(
        'test',
        'SELECT value FROM t_basic WHERE name = ?',
        [['nope']],
        true,
      ),
    );
    expect(res).toBeNull();
  });

  // ── executeType case-sensitivity bug (audit H10) ────────────────────────

  it('prepare with lowercase `insert` is classified as SELECT (H10)', async () => {
    // Per compat-matrix §6.2: executeType() is case-sensitive, so lowercase
    // DML follows the SELECT unpack path — meaning the return shape is
    // the SELECT-unpack shape, not insertId. Pin this until H10 is fixed.
    const res = await rawExecute(
      'test',
      'insert into t_basic (name, value) values (?, ?)',
      [['lc', 42]],
      true,
    );

    // The mariadb connector will accept the statement and return an
    // UpsertResult from pool.query. Our code's SELECT-unpack path will
    // then try to treat that UpsertResult as a rows array. Pin whichever
    // observable shape that produces.
    if ('error' in res) {
      // Observed outcome: the unpack path raises because the result does
      // not look like rows.
      expect(res.error).toBeDefined();
    } else {
      // Observed outcome: unpack returns something non-numeric (not an
      // insertId). That by itself is the visible bug.
      expect(typeof res.result).not.toBe('number');
    }
  });

  // ── SELECT with multiple param sets and unpack=true ─────────────────────

  it('prepare SELECT with multiple param sets returns an array of scalars or rows', async () => {
    await getPool().query("INSERT INTO t_basic (name, value) VALUES ('a', 1), ('b', 2)");

    const res = unwrap(
      await rawExecute(
        'test',
        'SELECT value FROM t_basic WHERE name = ?',
        [['a'], ['b']],
        true,
      ),
    ) as unknown[];

    expect(Array.isArray(res)).toBe(true);
    expect(res).toEqual([1, 2]);
  });
});
