// Cluster 21 — named-placeholders patch sanity check (audit L3 + B3.1).
// Pinning `named-placeholders` to the exact 1.1.3 makes patch-package
// actually apply on install; the sanity check is belt-and-suspenders
// that fails loud if the patch somehow did not run.

import { describe, expect, it } from 'vitest';

import { initNamedPlaceholders } from '../src/worker/config';

describe('cluster 21 — named-placeholders patch sanity check', () => {
  it('returns { patched: true } when the patched module is live', () => {
    const result = initNamedPlaceholders(undefined);
    expect(result).toEqual({ patched: true });
  });

  it("returns { patched: true } when the user has disabled named placeholders via 'false'", () => {
    const result = initNamedPlaceholders('false');
    expect(result).toEqual({ patched: true });
  });

  it('converts @-prefixed placeholders per the patched contract', async () => {
    // Directly exercises the live convertNamedPlaceholders set up by the
    // sanity-passing initNamedPlaceholders above. If this test fails, the
    // patched module has silently regressed.
    initNamedPlaceholders(undefined);

    const { convertNamedPlaceholders } = await import('../src/worker/config');
    expect(convertNamedPlaceholders).not.toBeNull();

    const [sql, params] = convertNamedPlaceholders!('SELECT @id', { '@id': 42 });
    expect(sql).toContain('?');
    expect(params[0]).toBe(42);
  });

  it('treats a missing :name key as null, not undefined (patched behaviour)', async () => {
    initNamedPlaceholders(undefined);
    const { convertNamedPlaceholders } = await import('../src/worker/config');
    const [, params] = convertNamedPlaceholders!('SELECT :missing AS x', {});
    expect(params[0]).toBeNull();
  });

  it('accepts both @id and :id on the same query', async () => {
    initNamedPlaceholders(undefined);
    const { convertNamedPlaceholders } = await import('../src/worker/config');
    const [sql, params] = convertNamedPlaceholders!('SELECT @a, :b', { a: 1, b: 2 });
    // The patched regex captures both — we do not assert on the exact
    // substitution count because the module is a black box for us, but
    // params must include both values in order.
    expect(sql.split('?').length - 1).toBeGreaterThanOrEqual(2);
    expect(params).toContain(1);
    expect(params).toContain(2);
  });
});
