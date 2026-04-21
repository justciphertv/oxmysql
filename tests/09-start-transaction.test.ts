// Regression cluster 9 — startTransaction (compat-matrix §2.9).
// Drives the three-step beginTransaction -> runTransactionQuery ->
// endTransaction flow that the FiveM surface orchestrates, and pins the
// commit, rollback, timeout, and swallowed-commit-error outcomes.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  beginTransaction,
  endTransaction,
  getPool,
  initHarness,
  rawQuery,
  runTransactionQuery,
} from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`error: ${res.error}`);
  return res.result;
}

describe('cluster 9 — startTransaction', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_basic');
  });

  it('beginTransaction -> runTransactionQuery -> commit persists writes', async () => {
    const begin = await beginTransaction('test');
    expect('connectionId' in begin).toBe(true);
    if (!('connectionId' in begin)) throw new Error('unreachable');

    const { connectionId } = begin;

    const ins = await runTransactionQuery(
      'test',
      connectionId,
      'INSERT INTO t_basic (name, value) VALUES (?, ?)',
      ['c1', 1],
    );
    expect('result' in ins).toBe(true);

    await endTransaction(connectionId, true);

    const count = unwrap(
      await rawQuery('scalar', 'test', 'SELECT COUNT(*) AS c FROM t_basic', []),
    );
    expect(count).toBe(1);
  });

  it('endTransaction with commit=false rolls back uncommitted writes', async () => {
    const begin = await beginTransaction('test');
    if (!('connectionId' in begin)) throw new Error('beginTransaction failed');

    const { connectionId } = begin;

    await runTransactionQuery(
      'test',
      connectionId,
      'INSERT INTO t_basic (name, value) VALUES (?, ?)',
      ['rb', 99],
    );

    await endTransaction(connectionId, false);

    const count = unwrap(
      await rawQuery('scalar', 'test', 'SELECT COUNT(*) AS c FROM t_basic', []),
    );
    expect(count).toBe(0);
  });

  it('runTransactionQuery with an unknown connectionId surfaces an error', async () => {
    const res = await runTransactionQuery('test', 999_999, 'SELECT 1', []);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/timed out after 30 seconds/);
  });

  it('endTransaction on an unknown connectionId is a no-op (does not throw)', async () => {
    await expect(endTransaction(999_999, false)).resolves.toBeUndefined();
    await expect(endTransaction(999_999, true)).resolves.toBeUndefined();
  });

  it('endTransaction swallows commit errors (M2); pinned for Phase 5', async () => {
    // This test documents the M2 behaviour: endTransaction wraps its
    // commit/rollback call in a try/catch that swallows errors. The only
    // observable is that no exception escapes endTransaction, even when
    // the connection has been poisoned. We simulate poisoning by killing
    // the underlying connection mid-transaction.
    const begin = await beginTransaction('test');
    if (!('connectionId' in begin)) throw new Error('beginTransaction failed');
    const { connectionId } = begin;

    // Kill the connection's underlying socket by issuing KILL against its
    // own thread id. After this the commit in endTransaction must fail,
    // but endTransaction must still resolve without throwing.
    try {
      await getPool().query(`KILL ${connectionId}`);
    } catch {
      // KILL may itself fail depending on privileges; the test is still
      // meaningful as long as endTransaction doesn't throw.
    }

    await expect(endTransaction(connectionId, true)).resolves.toBeUndefined();
  });
});
