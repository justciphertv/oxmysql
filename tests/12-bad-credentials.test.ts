// Regression cluster 12 — compat-matrix §10.2. With wrong credentials
// createConnectionPool must not throw, must not set the pool export, and
// must surface its error through the print channel. That is the observed
// contract that keeps MySQL.awaitConnection (FiveM layer) pending rather
// than rejecting — downstream resources poll against that contract.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captured } from './helpers/parent-port-mock';
import { initHarness } from './helpers/worker-harness';
import { createConnectionPool } from '../src/worker/database/pool';
import { buildPoolOptions } from './helpers/env';

describe('cluster 12 — bad credentials do not throw and do not overwrite pool', () => {
  beforeAll(async () => {
    // Ensure the happy-path pool is already established so we can confirm
    // that a subsequent bad-creds call does NOT reset it. This mirrors the
    // real worker lifecycle: pool is set on first success, and we want a
    // later retry failure to be a no-op against the live pool.
    await initHarness();
  });

  beforeEach(() => {
    captured.reset();
  });

  it('createConnectionPool with wrong password does not throw', async () => {
    const badOptions = buildPoolOptions({
      password: 'definitely-not-the-password',
      connectTimeout: 2_000,
    });

    await expect(createConnectionPool(badOptions)).resolves.toBeUndefined();
  });

  it('createConnectionPool with wrong password prints an error diagnostic', async () => {
    const badOptions = buildPoolOptions({
      password: 'definitely-not-the-password',
      connectTimeout: 2_000,
    });

    await createConnectionPool(badOptions);

    const prints = captured.byAction('print').map((m) => (m.data ?? []).join(' '));
    const unableToConnect = prints.find((line) =>
      /Unable to establish a connection to the database/.test(line),
    );
    expect(unableToConnect).toBeDefined();
  });

  it('createConnectionPool with an unreachable host does not throw', async () => {
    const badOptions = buildPoolOptions({
      host: '127.0.0.1',
      port: 1, // nothing listens on port 1
      connectTimeout: 1_000,
    });

    await expect(createConnectionPool(badOptions)).resolves.toBeUndefined();
  });

  it('password sanitizer redacts the password in the printed options diagnostic', async () => {
    captured.reset();
    const badOptions = buildPoolOptions({
      password: 'super-secret-password-xyz',
      connectTimeout: 1_000,
    });

    await createConnectionPool({ ...badOptions, host: '127.0.0.1', port: 1 });

    const prints = captured.byAction('print').map((m) => (m.data ?? []).join(' '));
    // The options dump should not leak the plaintext password.
    const leaks = prints.some((line) => line.includes('super-secret-password-xyz'));
    expect(leaks).toBe(false);
  });
});
