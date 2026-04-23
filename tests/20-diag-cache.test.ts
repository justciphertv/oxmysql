// Cluster 20 — DIAG cache on the config/update path (audit O4 + B2.2).
// The diag_enabled boolean lives in src/worker/config.ts and is updated
// by updateConfig() whenever mysql_debug changes. This contract matters
// because:
//   1. typeCast reads the cached boolean on every column decode — the
//      hot path assumes reads are cheap.
//   2. Operators flip `mysql_debug` at runtime via
//      AddConvarChangeListener -> emitToWorker('updateConfig', ...);
//      the cached flag must reflect the new value without a worker
//      restart.

import { describe, expect, it } from 'vitest';
import * as workerConfig from '../src/worker/config';
import { updateConfig } from '../src/worker/config';

// ESM live binding — this function's return value reflects the current
// module-scope value of diag_enabled every time it is called.
const currentDiagEnabled = () => workerConfig.diag_enabled;

describe('cluster 20 — diag_enabled cache', () => {
  it('starts out matching the OXMYSQL_DIAG env var state', () => {
    const envFlag = process.env.OXMYSQL_DIAG === '1';
    expect(workerConfig.diag_enabled).toBe(envFlag);
  });

  it('is flipped on by updateConfig when mysql_debug is truthy', () => {
    updateConfig({
      mysql_debug: true,
      mysql_slow_query_warning: 200,
      mysql_ui: false,
      mysql_log_size: 100,
    });

    expect(currentDiagEnabled()).toBe(true);
  });

  it('is flipped off by updateConfig when mysql_debug is false again', () => {
    updateConfig({
      mysql_debug: false,
      mysql_slow_query_warning: 200,
      mysql_ui: false,
      mysql_log_size: 100,
    });

    // When OXMYSQL_DIAG is set, the env var keeps the flag on regardless
    // of mysql_debug; skip the strict-false assertion in that case.
    if (process.env.OXMYSQL_DIAG === '1') {
      expect(currentDiagEnabled()).toBe(true);
    } else {
      expect(currentDiagEnabled()).toBe(false);
    }
  });

  it('treats a non-empty string[] mysql_debug (resource allow-list) as truthy', () => {
    updateConfig({
      mysql_debug: ['some-resource'],
      mysql_slow_query_warning: 200,
      mysql_ui: false,
      mysql_log_size: 100,
    });

    expect(currentDiagEnabled()).toBe(true);

    // Restore the default so subsequent test files observe a clean slate.
    updateConfig({
      mysql_debug: false,
      mysql_slow_query_warning: 200,
      mysql_ui: false,
      mysql_log_size: 100,
    });
  });
});
