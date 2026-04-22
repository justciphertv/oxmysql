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

  // Faithful reproduction of the qbx_properties consumer pattern: a table
  // declared with the exact charset, collate, and JSON NOT NULL DEFAULT
  // (JSON_OBJECT()) shape reported in the field, selected via single() the
  // way the Lua wrapper ultimately does. If this returns anything other
  // than strings, the typeCast fix is insufficient.
  it('qbx_properties-shaped table returns every JSON column as a string', async () => {
    await getPool().query('TRUNCATE t_qbx_props');

    await getPool().query(
      `INSERT INTO t_qbx_props (property_name, coords, price, interior, keyholders, interact_options, stash_options) ` +
        `VALUES ('casa', '{"x":1.5,"y":-2.3,"z":30.0}', 10000, 'interior_name', ` +
        `'{"abc":true}', '{"points":[1,2,3]}', '{"stashes":{"main":"id1"}}')`,
    );

    const row = unwrap(
      await rawQuery(
        'single',
        'test',
        'SELECT property_name, coords, price, interior, keyholders, interact_options, stash_options FROM t_qbx_props LIMIT 1',
        [],
      ),
    ) as Record<string, unknown>;

    // Every JSON column must be a string so the Lua consumer can json.decode.
    for (const col of ['coords', 'keyholders', 'interact_options', 'stash_options']) {
      expect(typeof row[col]).toBe('string');
      expect(() => JSON.parse(row[col] as string)).not.toThrow();
    }

    // Sanity: non-JSON columns unaffected.
    expect(row.property_name).toBe('casa');
    expect(row.interior).toBe('interior_name');
    expect(row.price).toBe(10000);
  });

  // Exercise the DEFAULT (JSON_OBJECT()) path. When a row is inserted without
  // explicitly providing the JSON columns, MariaDB evaluates JSON_OBJECT()
  // at insert time. On read, those values must still come back as strings
  // (the string "{}") — not as JS objects.
  it('DEFAULT (JSON_OBJECT()) values read back as the string "{}"', async () => {
    await getPool().query('TRUNCATE t_qbx_props');
    await getPool().query(
      `INSERT INTO t_qbx_props (property_name, coords, interior) ` +
        `VALUES ('default-test', '{}', 'i')`,
    );

    const row = unwrap(
      await rawQuery(
        'single',
        'test',
        'SELECT keyholders, interact_options, stash_options FROM t_qbx_props WHERE property_name = ?',
        ['default-test'],
      ),
    ) as Record<string, unknown>;

    for (const col of ['keyholders', 'interact_options', 'stash_options']) {
      expect(typeof row[col]).toBe('string');
      expect(row[col]).toBe('{}');
    }
  });
});
