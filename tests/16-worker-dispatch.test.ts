// Phase 5.2 regression — worker-side dispatch safety. Verifies the
// parentPort message handler wraps every action in try/catch so a
// malformed payload or unexpected throw cannot crash the worker, and
// instead produces a `{ error }` response that the parent's pending-book
// can settle normally.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleIncoming } from '../src/worker/worker';
import { captured } from './helpers/parent-port-mock';
import { initHarness } from './helpers/worker-harness';

describe('cluster 16 — worker dispatch safety', () => {
  beforeAll(async () => {
    // Ensure the pool is live so actions that DO need a pool (query, etc.)
    // behave realistically; malformed actions still hit the try/catch.
    await initHarness();
  });

  beforeEach(() => {
    captured.reset();
  });

  it('unknown action with an id is a no-op (no response, no throw)', async () => {
    await expect(
      handleIncoming({ action: 'definitely-not-a-real-action', id: 1, data: {} }),
    ).resolves.toBeUndefined();

    // No response posted because the switch hits no case — consistent with
    // pre-Phase-5.2 behaviour.
    expect(captured.byAction('response')).toHaveLength(0);
  });

  it('query with data=null does not crash the worker; responds with error', async () => {
    // Destructuring data would throw under the previous implementation; the
    // new try/catch turns it into an error response.
    await expect(
      handleIncoming({ action: 'query', id: 42, data: null }),
    ).resolves.toBeUndefined();

    const responses = captured.byAction('response');
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(42);
    expect(responses[0].data).toHaveProperty('error');
    expect((responses[0].data as { error: string }).error).toMatch(/dispatch failed/);
  });

  it('execute with data=null does not crash the worker; responds with error', async () => {
    await expect(
      handleIncoming({ action: 'execute', id: 7, data: null }),
    ).resolves.toBeUndefined();

    const responses = captured.byAction('response');
    const match = responses.find((r) => r.id === 7);
    expect(match).toBeDefined();
    expect(match?.data).toHaveProperty('error');
  });

  it('transaction with data=null does not crash the worker; responds with error', async () => {
    await expect(
      handleIncoming({ action: 'transaction', id: 11, data: null }),
    ).resolves.toBeUndefined();

    const match = captured.byAction('response').find((r) => r.id === 11);
    expect(match).toBeDefined();
    expect(match?.data).toHaveProperty('error');
  });

  it('dispatch failure prints a diagnostic to the FXServer console', async () => {
    await handleIncoming({ action: 'query', id: 99, data: null });

    const prints = captured.byAction('print');
    const diagnostic = prints.find((p) =>
      (p.data as unknown[])?.some(
        (line) => typeof line === 'string' && line.includes("dispatch failed for action='query'"),
      ),
    );
    expect(diagnostic).toBeDefined();
  });

  it('failure on a fire-and-forget action (no id) does not try to respond', async () => {
    await expect(
      handleIncoming({ action: 'endTransaction', data: null }),
    ).resolves.toBeUndefined();

    // Since id is undefined there is nothing to respond to, but we still
    // expect a print() diagnostic.
    const responses = captured.byAction('response');
    // Any response from previous tests in the same describe block would
    // have been cleared in beforeEach, so this filter is precise.
    expect(responses).toHaveLength(0);

    const prints = captured.byAction('print');
    const diagnostic = prints.find((p) =>
      (p.data as unknown[])?.some(
        (line) => typeof line === 'string' && line.includes("endTransaction"),
      ),
    );
    expect(diagnostic).toBeDefined();
  });

  it('malformed top-level message (undefined) is swallowed without crash', async () => {
    await expect(handleIncoming(undefined as any)).resolves.toBeUndefined();
  });
});

describe('cluster 16 — initialize is idempotent (audit M14)', () => {
  beforeAll(async () => {
    // Ensure a live pool is already in place so the idempotency branch
    // is the one we exercise.
    await initHarness();
  });

  beforeEach(() => {
    captured.reset();
  });

  it('a second initialize with pool already set does not re-enter the retry loop', async () => {
    // Drive handleIncoming with an initialize message carrying invalid
    // connection options. If the idempotency branch is working, the
    // worker re-applies the config fields but skips createConnectionPool
    // entirely — we observe this by asserting no 'connection attempt N
    // failed' print ever fires and no oxmysql:error phase:init event
    // is triggered.
    await handleIncoming({
      action: 'initialize',
      data: {
        connectionOptions: {
          host: '127.0.0.1',
          port: 1, // definitely unreachable
          user: 'not-a-user',
          password: 'not-a-password',
          database: 'nope',
          connectTimeout: 500,
        },
        mysql_transaction_isolation_level: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
        mysql_debug: false,
        namedPlaceholders: undefined,
        mysql_bit_full_integer: false,
        mysql_init_retry_ms: 1_000,
      },
    });

    const retryPrint = captured
      .byAction('print')
      .find((m) =>
        (m.data as unknown[])?.some(
          (line) => typeof line === 'string' && line.includes('connection attempt'),
        ),
      );
    expect(retryPrint).toBeUndefined();

    const initErrorEvent = captured
      .byAction('triggerEvent')
      .find(
        (m) =>
          m.data?.event === 'oxmysql:error' && m.data?.payload?.phase === 'init',
      );
    expect(initErrorEvent).toBeUndefined();
  });
});
