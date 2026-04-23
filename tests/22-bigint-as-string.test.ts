// Regression cluster 22 — BIGINT / insertId with `mysql_bigint_as_string`
// flag enabled. Pins the opt-in behaviour documented in compat-matrix
// §4.1 and §4.3 that was introduced in Phase 4: values safely
// representable as IEEE-754 double stay `number`, values outside
// `Number.MAX_SAFE_INTEGER` range come through as decimal strings so no
// precision is lost.
//
// The flag flips the connector pool's `bigIntAsNumber` /
// `insertIdAsNumber` options, so this file must tear down and rebuild
// the pool. Runs last by file-order; afterAll restores the default
// (flag off) and rebuilds the pool so any suite that observes
// file-ordering inside a single vitest fork continues to see the
// pinned legacy semantics.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getPool,
  rawQuery,
  reinitHarness,
} from './helpers/worker-harness';
import { setBigintAsString } from '../src/worker/config';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

describe('cluster 22 — BIGINT / insertId with mysql_bigint_as_string flag enabled', () => {
  beforeAll(async () => {
    // Flag must be set BEFORE the pool is (re)built because it flips
    // `bigIntAsNumber` / `insertIdAsNumber` in the connector options.
    setBigintAsString(true);
    await reinitHarness();
  });

  afterAll(async () => {
    setBigintAsString(false);
    await reinitHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_numeric');
    await getPool().query('TRUNCATE t_uids');
  });

  // ── BIGINT reads ────────────────────────────────────────────────────────

  it('BIGINT within Number.MAX_SAFE_INTEGER is returned as `number`', async () => {
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (9007199254740991)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT big_signed FROM t_numeric', []),
    );
    expect(typeof v).toBe('number');
    expect(v).toBe(9007199254740991);
  });

  it('BIGINT above Number.MAX_SAFE_INTEGER is returned as a decimal string (exact value)', async () => {
    // 9007199254740993 = 2^53 + 1 — the canonical case where number
    // representation is lossy and the string-mode fix must preserve it.
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (9007199254740993)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT big_signed FROM t_numeric', []),
    );
    expect(typeof v).toBe('string');
    expect(v).toBe('9007199254740993');
  });

  it('Negative BIGINT past -Number.MAX_SAFE_INTEGER is returned as a decimal string', async () => {
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (-9007199254740993)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT big_signed FROM t_numeric', []),
    );
    expect(typeof v).toBe('string');
    expect(v).toBe('-9007199254740993');
  });

  it('NULL BIGINT still reads as null (flag does not regress the null path)', async () => {
    await getPool().query('INSERT INTO t_numeric (big_signed) VALUES (NULL)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT big_signed FROM t_numeric', []),
    );
    expect(v).toBeNull();
  });

  // ── insertId ────────────────────────────────────────────────────────────

  it('insertId within Number.MAX_SAFE_INTEGER is returned as `number`', async () => {
    // Reset the counter so the test is deterministic regardless of prior runs.
    await getPool().query('ALTER TABLE t_uids AUTO_INCREMENT = 100');
    const id = unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_uids (note) VALUES (?)', ['small']),
    );
    expect(typeof id).toBe('number');
    expect(id).toBe(100);
  });

  it('insertId above Number.MAX_SAFE_INTEGER is returned as a decimal string (exact value)', async () => {
    // Seed past 2^53 so the very next auto-increment lands on 2^53 + 1.
    await getPool().query('ALTER TABLE t_uids AUTO_INCREMENT = 9007199254740993');
    const id = unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_uids (note) VALUES (?)', ['big']),
    );
    expect(typeof id).toBe('string');
    expect(id).toBe('9007199254740993');
  });
});
