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

  // ── executeType case-insensitivity (audit H10 fixed in 3.2.0) ──────────

  it('prepare with lowercase `insert` is correctly classified as DML', async () => {
    // 3.2.0: executeType() trims leading whitespace and uppercases the
    // first keyword. Lowercase DML now takes the DML unpack path and
    // returns a numeric insertId — matching compat-matrix §6.2.
    const id = unwrap(
      await rawExecute(
        'test',
        'insert into t_basic (name, value) values (?, ?)',
        [['lc', 42]],
        true,
      ),
    );
    expect(typeof id).toBe('number');
    expect(id as number).toBeGreaterThan(0);
  });

  it('prepare with uppercase `INSERT` continues to return insertId', async () => {
    // Regression guard: the 3.2.0 normalisation must not have broken the
    // case already-pinned by cluster 7 / compat-matrix §6.2.
    const id = unwrap(
      await rawExecute(
        'test',
        'INSERT INTO t_basic (name, value) VALUES (?, ?)',
        [['UC', 1]],
        true,
      ),
    );
    expect(typeof id).toBe('number');
    expect(id as number).toBeGreaterThan(0);
  });

  it('prepare with leading whitespace + lowercase DML is classified correctly', async () => {
    // trimStart() in the normalisation handles leading whitespace — a
    // defensive extension beyond the narrow H10 report that also covers
    // generated SQL with indentation.
    await getPool().query('INSERT INTO t_basic (name, value) VALUES (?, ?)', ['w', 42]);

    const affected = unwrap(
      await rawExecute(
        'test',
        '   delete from t_basic where value = ?',
        [[42]],
        true,
      ),
    );
    // DELETE returns affectedRows via the UPDATE-shape unpack.
    expect(typeof affected).toBe('number');
    expect(affected).toBe(1);
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
