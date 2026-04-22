// Phase 5.4 regression — graceful teardown. The onResourceStop listener
// and the worker-side shutdown handler live in code paths that cannot be
// exercised from the worker-internals harness (the shutdown action calls
// process.exit(0), and onResourceStop requires FXServer globals).
//
// Verify the contract by source inspection — same pattern as cluster 13
// and 17.

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

describe('cluster 18 — graceful shutdown (§5.4)', () => {
  it('FiveM side registers an onResourceStop listener scoped to oxmysql itself', () => {
    // Match the handler and confirm it compares against resourceName so
    // we do not terminate on every resource's stop event.
    expect(fivemSrc).toMatch(/on\(`onResourceStop`/);
    expect(fivemSrc).toMatch(/stoppedResource !== resourceName/);
  });

  it('onResourceStop sends a shutdown message and schedules a terminate fallback', () => {
    expect(fivemSrc).toMatch(/channel\.emit\('shutdown'\)/);
    expect(fivemSrc).toMatch(/worker\.terminate\(\)/);
    // The terminate() call must be wrapped so it cannot throw if the
    // worker has already exited.
    expect(fivemSrc).toMatch(/try \{\s*worker\.terminate\(\)/);
  });

  it('worker handles the shutdown action by flushing the pool and exiting', () => {
    expect(workerSrc).toMatch(/case 'shutdown':/);
    expect(workerSrc).toMatch(/await pool\?\.end\(\)/);
    expect(workerSrc).toMatch(/process\.exit\(0\)/);
  });

  it('shutdown cleanup is wrapped so a dead pool does not prevent exit', () => {
    // Match: try { await pool?.end(); } catch { … } — whitespace tolerant.
    expect(workerSrc).toMatch(/try \{[\s\S]*?await pool\?\.end\(\)/);
  });

  it('shutdown case does not fall through to any future case below it', () => {
    // Explicit return after process.exit(0) — the return is unreachable
    // but documents the no-fallthrough contract and prevents a future
    // case appended below 'shutdown' from accidentally running if the
    // exit is ever removed.
    expect(workerSrc).toMatch(
      /case 'shutdown':[\s\S]*?process\.exit\(0\);[\s\S]*?return;/,
    );
  });
});
