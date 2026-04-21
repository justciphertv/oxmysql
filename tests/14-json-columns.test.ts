// Regression cluster 14 — JSON column contract (compat-matrix §4.6).
//
// mysql2 and mysql-async historically returned JSON columns as strings so
// Lua callers could json.decode them. The mariadb connector auto-parses
// JSON columns by default (`autoJsonMap: true`), which breaks every
// consumer that does json.decode(value). This cluster locks the
// string-contract: JSON columns come through as raw JSON strings, not
// parsed objects.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`error: ${res.error}`);
  return res.result;
}

describe('cluster 14 — JSON columns return as strings', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_json');
  });

  it('JSON column payload round-trips as a string, not a parsed object', async () => {
    await getPool().query(
      `INSERT INTO t_json (payload) VALUES ('{"a":1,"b":"x"}')`,
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT payload FROM t_json', []),
    );

    expect(typeof v).toBe('string');
    // Round-trip: JSON.parse on the result must yield the original shape.
    expect(JSON.parse(v as string)).toEqual({ a: 1, b: 'x' });
  });

  it('JSON array round-trips as a string', async () => {
    await getPool().query(
      `INSERT INTO t_json (payload) VALUES ('[1,2,"three",{"k":true}]')`,
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT payload FROM t_json', []),
    );

    expect(typeof v).toBe('string');
    expect(JSON.parse(v as string)).toEqual([1, 2, 'three', { k: true }]);
  });

  it('JSON NULL reads as null (not the string "null")', async () => {
    await getPool().query('INSERT INTO t_json (payload) VALUES (NULL)');

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT payload FROM t_json', []),
    );
    expect(v).toBeNull();
  });

  it('single() returns the row with JSON field as string', async () => {
    await getPool().query(
      `INSERT INTO t_json (payload, notes) VALUES ('{"q":42}', 'note')`,
    );

    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT payload, notes FROM t_json', []),
    ) as Record<string, unknown>;

    expect(typeof row.payload).toBe('string');
    expect(JSON.parse(row.payload as string)).toEqual({ q: 42 });
    expect(row.notes).toBe('note');
  });
});
