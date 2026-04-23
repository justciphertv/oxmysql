// Phase 5.3 regression — init retry telemetry. The initialize handler's
// retry loop is a hot path that only fires on misconfigured deployments,
// which makes it awkward to exercise at runtime (the shared test harness
// always has a live pool by the time this test file is reached; resetting
// module-level pool state cleanly from within Vitest singleFork is not
// worth the scaffolding). Verify the contract by source inspection
// instead — same approach as cluster 13.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerSrc = readFileSync(
  join(__dirname, '..', 'src', 'worker', 'worker.ts'),
  'utf8',
);
const fivemSrc = readFileSync(
  join(__dirname, '..', 'src', 'fivem', 'index.ts'),
  'utf8',
);

describe('cluster 17 — init retry telemetry (§5.3)', () => {
  it('worker initialize loop reads mysql_init_retry_ms from the payload', () => {
    expect(workerSrc).toMatch(/mysql_init_retry_ms/);
    // Retry interval is clamped >= 1000ms with a default of 30000.
    expect(workerSrc).toMatch(/Math\.max\(1_?000, Number\(data\?.mysql_init_retry_ms\) \|\| 30_?000\)/);
  });

  it('each failed attempt increments an attempt counter visible in telemetry', () => {
    expect(workerSrc).toMatch(/attempt \+= 1/);
    expect(workerSrc).toMatch(/triggerFivemEvent\([\s\S]*?'oxmysql:error'[\s\S]*?phase: 'init'/);
    expect(workerSrc).toMatch(/phase: 'init',\s*attempt,\s*retryIntervalMs,/);
  });

  it('prints a visible retry diagnostic every cycle', () => {
    expect(workerSrc).toMatch(/connection attempt \$\{attempt\} failed; retrying in/);
  });

  it('emits oxmysql:ready on success after >1 attempts', () => {
    expect(workerSrc).toMatch(/triggerFivemEvent\('oxmysql:ready'/);
    expect(workerSrc).toMatch(/if \(attempt > 1\)/);
  });

  it('FiveM side exposes the convar and forwards it in the initialize payload', () => {
    expect(fivemSrc).toMatch(/GetConvarInt\('mysql_init_retry_ms', 30_?000\)/);
    // Be tolerant of additional keys between mysql_init_retry_ms and
    // mysql_debug: — Phase A3 adds mysql_bit_full_integer there.
    expect(fivemSrc).toMatch(/mysql_init_retry_ms,\s*[\s\S]*?mysql_debug:/);
  });

  it('preserves the pre-Phase-5.3 default cadence (30s) when the convar is unset', () => {
    // Workers clamped at 1s min, so setting a garbage value falls back to
    // the 30000 default. Both the FiveM-side default and the worker-side
    // fallback must point at 30000 for the contract to remain unchanged.
    expect(fivemSrc).toMatch(/mysql_init_retry_ms', 30_?000\)/);
    expect(workerSrc).toMatch(/\|\| 30_?000\)/);
  });
});
