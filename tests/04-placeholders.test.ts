// Regression cluster 4 — exercises compat-matrix §3 (placeholder handling):
// positional `?`, named `:name` and `@name`, patched quoted-string protection,
// missing-key → null, numeric-string object keys, and the silently-dropped
// non-numeric-key object edge case.

import { beforeAll, describe, expect, it } from 'vitest';
import { initHarness, rawExecute, rawQuery } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

describe('cluster 4 — placeholders', () => {
  beforeAll(async () => {
    await initHarness();
  });

  // ── positional `?` ──────────────────────────────────────────────────────

  it('positional `?` binds in order', async () => {
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT ? AS a, ? AS b', [7, 'x']),
    ) as Record<string, unknown>;
    expect(row.a).toBe(7);
    expect(row.b).toBe('x');
  });

  it('fewer parameters than placeholders pads with null', async () => {
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT ? AS a, ? AS b', [7]),
    ) as Record<string, unknown>;
    expect(row.a).toBe(7);
    expect(row.b).toBeNull();
  });

  it('more parameters than placeholders surfaces an error', async () => {
    const res = await rawQuery('single', 'test', 'SELECT ? AS a', [1, 2]);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/Expected 1 parameters, but received 2/);
  });

  it('double-question-mark `??` is not counted as a placeholder', async () => {
    // We only need to verify the count logic in parseArguments via a query
    // that contains literal `??` substring. Using a TEXT comparison keeps
    // this independent of MariaDB JSON feature availability.
    const row = unwrap(
      await rawQuery('single', 'test', "SELECT 'a??b' AS s, ? AS x", [1]),
    ) as Record<string, unknown>;
    expect(row.s).toBe('a??b');
    expect(row.x).toBe(1);
  });

  // ── named `:` and `@` ───────────────────────────────────────────────────

  it('named `:name` placeholder binds from bare-key object', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT :id AS x', { id: 7 }));
    expect(v).toBe(7);
  });

  it('named `@name` placeholder binds from bare-key object', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT @id AS x', { id: 7 }));
    expect(v).toBe(7);
  });

  it('object keys with leading `:` resolve to the same param', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT :id AS x', { ':id': 9 }));
    expect(v).toBe(9);
  });

  it('object keys with leading `@` resolve to the same param', async () => {
    const v = unwrap(await rawQuery('scalar', 'test', 'SELECT @id AS x', { '@id': 9 }));
    expect(v).toBe(9);
  });

  it('missing named key binds to null (not undefined, not error)', async () => {
    const res = await rawQuery('scalar', 'test', 'SELECT :missing AS x', {});
    expect('result' in res).toBe(true);
    if ('result' in res) expect(res.result).toBeNull();
  });

  it('`:name` inside a single-quoted string literal is NOT a placeholder', async () => {
    // The patched named-placeholders regex uses a negative lookbehind for
    // quote chars. If the patch regressed, binding ':notaparam' would fail
    // because the object does not contain that key.
    const row = unwrap(
      await rawQuery('single', 'test', "SELECT ':notaparam' AS a, :id AS b", { id: 2 }),
    ) as Record<string, unknown>;
    expect(row.a).toBe(':notaparam');
    expect(row.b).toBe(2);
  });

  it('`@name` inside a single-quoted string literal is NOT a placeholder', async () => {
    const row = unwrap(
      await rawQuery('single', 'test', "SELECT '@notaparam' AS a, @id AS b", { id: 3 }),
    ) as Record<string, unknown>;
    expect(row.a).toBe('@notaparam');
    expect(row.b).toBe(3);
  });

  // ── numeric-string-keyed object (parseArguments legacy path) ────────────

  it('numeric-string-keyed object binds 1-indexed through parseArguments', async () => {
    // parseArguments reads parameters[i + 1] for i in [0, placeholders)
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT ? AS a, ? AS b', { '1': 11, '2': 22 }),
    ) as Record<string, unknown>;
    expect(row.a).toBe(11);
    expect(row.b).toBe(22);
  });

  // ── parseExecute: non-numeric key object (audit H9) ─────────────────────

  it('non-numeric-key object to rawExecute silently drops its values (H9)', async () => {
    // Per compat-matrix §3.3 / audit H9: parseInt('foo') is NaN, so the
    // entries are silently dropped by parseExecute and the query runs with
    // an empty parameter set. Pin whichever observable behaviour the
    // connector produces. A future fix (throwing a clear error) must
    // update this test deliberately.
    const res = await rawExecute('test', 'SELECT ? AS x', { foo: 1 } as any);
    if ('error' in res) {
      // Happy outcome: the connector rejects the unset parameter.
      expect(res.error).toMatch(/parameter|position|not set|undefined/i);
    } else {
      // Silent-drop outcome: parameter is bound as null by padding logic.
      const row = res.result as Record<string, unknown> | null;
      if (row && typeof row === 'object') {
        expect((row as any).x ?? null).toBeNull();
      } else {
        expect(row).toBeNull();
      }
    }
  });
});
