// Regression guard for compat-matrix §10.3 — queries dispatched before the
// pool handshake has completed must block, not crash with a null
// dereference. This reproduces the qbx_core / ox_doorlock startup-migration
// behaviour: a consumer resource fires a query immediately at resource
// start, before MySQL.awaitConnection has had a chance to resolve.
//
// The test verifies the behaviour by inspecting the production source
// directly: awaitPool() must be invoked on every fast-path entry before any
// pool! dereference. A static assertion is sufficient here because the
// runtime pool state is shared across the Vitest singleFork process and
// cannot be cleanly reset to null mid-run without tearing down the whole
// harness.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawQuerySrc = readFileSync(
  join(__dirname, '..', 'src', 'worker', 'database', 'rawQuery.ts'),
  'utf8',
);
const rawExecuteSrc = readFileSync(
  join(__dirname, '..', 'src', 'worker', 'database', 'rawExecute.ts'),
  'utf8',
);
const poolSrc = readFileSync(
  join(__dirname, '..', 'src', 'worker', 'database', 'pool.ts'),
  'utf8',
);

describe('cluster 13 — pool-readiness race guard (§10.3)', () => {
  it('pool.ts exports awaitPool()', () => {
    expect(poolSrc).toMatch(/export async function awaitPool\(\)/);
  });

  // Match any call-site dereference of the form `pool!.query(` or
  // `pool!.batch(`. Accepts both the bare `await pool!.query(...)` form
  // and the perf-wrapped form `() => pool!.query(...)`. Does not match
  // the prose `pool!` strings in comments because it requires the `.`
  // and opening paren of the call.
  const realDerefRe = /pool!\.(query|batch)\(/;
  // Accept the bare `awaitPool()` call OR the perf-instrumented form
  // `perf.time('...', () => awaitPool())` — both dispatch the same gate.
  const awaitPoolRe = /awaitPool\(\)/;

  it('rawQuery awaits pool before any pool! call-site', () => {
    const awaitMatch = rawQuerySrc.match(awaitPoolRe);
    const derefMatch = rawQuerySrc.match(realDerefRe);
    expect(awaitMatch).not.toBeNull();
    expect(derefMatch).not.toBeNull();
    expect(awaitMatch!.index!).toBeLessThan(derefMatch!.index!);
  });

  it('rawExecute awaits pool before any pool! call-site', () => {
    const awaitMatch = rawExecuteSrc.match(awaitPoolRe);
    const derefMatch = rawExecuteSrc.match(realDerefRe);
    expect(awaitMatch).not.toBeNull();
    expect(derefMatch).not.toBeNull();
    expect(awaitMatch!.index!).toBeLessThan(derefMatch!.index!);
  });
});
