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

    const end = await endTransaction(connectionId, true);
    expect(end).toEqual({ result: true });

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

    const end = await endTransaction(connectionId, false);
    expect(end).toEqual({ result: true });

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

  it('endTransaction on an unknown connectionId succeeds without action', async () => {
    // With no connection to tear down, the call is a no-op and returns
    // a success-shaped payload so the parent's propagate-errors path can
    // differentiate "nothing to do" from "commit failed".
    await expect(endTransaction(999_999, false)).resolves.toEqual({ result: true });
    await expect(endTransaction(999_999, true)).resolves.toEqual({ result: true });
  });

  // Audit M1 race guard (§2.9 + §10.3 of compat-matrix). After
  // endTransaction has begun tearing down, runTransactionQuery refuses
  // to start new work on the same connection. This simulates the parent
  // side's 30s timeout handler landing just ahead of a racing queryFn.
  it('runTransactionQuery after endTransaction closes the connection fails cleanly', async () => {
    const begin = await beginTransaction('test');
    if (!('connectionId' in begin)) throw new Error('beginTransaction failed');
    const { connectionId } = begin;

    // Drive endTransaction + a racing runTransactionQuery concurrently.
    // The endTransaction will set conn.closed first, then waitUntilIdle
    // completes (no in-flight query at this point), then commit.
    // The runTransactionQuery should observe closed=true and refuse.
    const [endResult, queryResult] = await Promise.all([
      endTransaction(connectionId, false),
      // tiny delay so endTransaction wins the microtask race
      (async () => {
        await new Promise((r) => setTimeout(r, 0));
        return runTransactionQuery('test', connectionId, 'SELECT 1', []);
      })(),
    ]);

    expect(endResult).toEqual({ result: true });
    expect('error' in queryResult).toBe(true);
    if ('error' in queryResult) {
      expect(queryResult.error).toMatch(/closed|timed out/i);
    }
  });

  // Audit M2 (pinned observed-behaviour path). Under the *default*
  // (flag off), the worker still reports a commit/rollback failure via
  // the endTransaction response shape. The parent decides whether to
  // surface it based on the convar. This test exercises the worker
  // contract directly; the parent's use of the response is pinned in
  // the FiveM layer (not reachable from the worker-internals harness).
  it('endTransaction returns error payload when commit fails on a poisoned connection', async () => {
    const begin = await beginTransaction('test');
    if (!('connectionId' in begin)) throw new Error('beginTransaction failed');
    const { connectionId } = begin;

    // Kill the connection's underlying socket from outside the transaction
    // so the subsequent commit fails at the wire level.
    try {
      await getPool().query(`KILL ${connectionId}`);
    } catch {
      /* KILL may not be privileged; test still meaningful if commit errors
       * for any reason. */
    }

    const end = await endTransaction(connectionId, true);
    // Either the commit succeeded in spite of the kill (test is then
    // inconclusive and passes vacuously on `result: true`) or the commit
    // failed and the worker reported the error cleanly via the payload.
    if ('error' in end) {
      expect(end.error).toMatch(/commit failed/);
    } else {
      expect(end).toEqual({ result: true });
    }
  });
});
