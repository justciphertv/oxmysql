// Thin harness that boots the worker modules in-process.
//
// This import order matters: `vi.mock('worker_threads', ...)` must be set up
// in the test file BEFORE this helper is imported, because the worker modules
// call `parentPort!.postMessage(...)` synchronously during their own import
// (config side-effects) and during any function call thereafter.

import type { CFXParameters, QueryType, TransactionQuery } from '../../src/types';

// The imports below intentionally go through the real source files — we are
// exercising the actual shaping / parse logic, not re-implementing it.
import { createConnectionPool, pool, resetPool } from '../../src/worker/database/pool';
import { rawQuery } from '../../src/worker/database/rawQuery';
import { rawExecute } from '../../src/worker/database/rawExecute';
import { rawTransaction } from '../../src/worker/database/rawTransaction';
import {
  beginTransaction,
  runTransactionQuery,
  endTransaction,
} from '../../src/worker/database/startTransaction';
import { initNamedPlaceholders, setIsolationLevel, updateConfig } from '../../src/worker/config';

import { buildPoolOptions } from './env';

export type HarnessInit = {
  mysql_transaction_isolation_level?: string;
  namedPlaceholders?: unknown;
  mysql_debug?: boolean | string[];
  poolOverrides?: Record<string, unknown>;
};

let initialized = false;

export async function initHarness(opts: HarnessInit = {}) {
  if (initialized) return;

  setIsolationLevel(
    opts.mysql_transaction_isolation_level ?? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  );
  initNamedPlaceholders(opts.namedPlaceholders);
  updateConfig({
    mysql_debug: opts.mysql_debug ?? false,
    mysql_slow_query_warning: 200,
    mysql_ui: false,
    mysql_log_size: 100,
  });

  await createConnectionPool(buildPoolOptions(opts.poolOverrides));
  if (!pool) throw new Error('Test harness: pool failed to initialize. Is MariaDB running?');
  initialized = true;
}

export function getPool() {
  if (!pool) throw new Error('Harness pool not initialized. Call initHarness() first.');
  return pool;
}

/**
 * Tear down the current pool, clear the `initialized` flag, and (if
 * `opts` is provided) re-initialise with new pool options. Intended for
 * benchmark harnesses that sweep pool settings; not used by the vitest
 * suite which keeps the same pool for every test.
 */
export async function reinitHarness(opts: HarnessInit = {}): Promise<void> {
  await resetPool();
  initialized = false;
  await initHarness(opts);
}

// Convenience re-exports so tests don't have to reach into src/ directly.
export {
  rawQuery,
  rawExecute,
  rawTransaction,
  beginTransaction,
  runTransactionQuery,
  endTransaction,
};
export type { CFXParameters, QueryType, TransactionQuery };
