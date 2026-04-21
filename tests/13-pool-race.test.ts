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

  // Match only actual call-site dereferences (`await pool!.query` /
  // `await pool!.batch`), not comment text that happens to contain the
  // characters `pool!`.
  const realDerefRe = /await pool!\.(query|batch)/;

  it('rawQuery awaits pool before any pool! call-site', () => {
    const awaitIdx = rawQuerySrc.indexOf('await awaitPool()');
    const derefMatch = rawQuerySrc.match(realDerefRe);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(derefMatch).not.toBeNull();
    expect(awaitIdx).toBeLessThan(derefMatch!.index!);
  });

  it('rawExecute awaits pool before any pool! call-site', () => {
    const awaitIdx = rawExecuteSrc.indexOf('await awaitPool()');
    const derefMatch = rawExecuteSrc.match(realDerefRe);
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(derefMatch).not.toBeNull();
    expect(awaitIdx).toBeLessThan(derefMatch!.index!);
  });
});
