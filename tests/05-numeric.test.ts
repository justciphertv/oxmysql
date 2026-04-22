// Regression cluster 5 — numeric coercion. Pins the currently observed
// behaviour for compat-matrix §4 (numeric types) and the added TINYINT(1)
// vs wider TINYINT split. Several of these assertions pin behaviour that
// is a known trade-off (BIGINT / insertId precision) or a defect (BIT(>1)
// truncation) — the tests exist so future changes are deliberate.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, initHarness, rawQuery } from './helpers/worker-harness';
import { setBitFullInteger } from '../src/worker/config';

function unwrap<T>(res: { result: T } | { error: string }): T {
  if ('error' in res) throw new Error(`rawQuery returned error: ${res.error}`);
  return res.result;
}

describe('cluster 5 — numeric coercion', () => {
  beforeAll(async () => {
    await initHarness();
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_numeric');
    await getPool().query('TRUNCATE t_bit');
    await getPool().query('TRUNCATE t_uids');
  });

  // ── TINYINT ─────────────────────────────────────────────────────────────

  it('TINYINT(1) is coerced to boolean', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_numeric (flag_bool, flag_u8) VALUES (?, ?)',
        [1, 7],
      ),
    );
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT flag_bool, flag_u8 FROM t_numeric', []),
    ) as Record<string, unknown>;
    expect(typeof row.flag_bool).toBe('boolean');
    expect(row.flag_bool).toBe(true);
  });

  it('TINYINT(1) with value 0 is coerced to false', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_numeric (flag_bool, flag_u8) VALUES (?, ?)',
        [0, 0],
      ),
    );
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT flag_bool FROM t_numeric', []),
    ) as Record<string, unknown>;
    expect(row.flag_bool).toBe(false);
  });

  it('Wider TINYINT (display width > 1) remains numeric (not boolean)', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_numeric (flag_bool, flag_u8) VALUES (?, ?)',
        [1, 123],
      ),
    );
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT flag_u8 FROM t_numeric', []),
    ) as Record<string, unknown>;
    expect(typeof row.flag_u8).toBe('number');
    expect(row.flag_u8).toBe(123);
  });

  // ── BIGINT precision loss (§4.1 / audit H8) ─────────────────────────────

  it('BIGINT > 2^53 loses precision on read (bigIntAsNumber = true)', async () => {
    // 9007199254740993 = 2^53 + 1. Any IEEE-754 double rounds this to 2^53.
    await getPool().query(
      'INSERT INTO t_numeric (big_signed) VALUES (9007199254740993)',
    );

    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT big_signed FROM t_numeric', []),
    ) as number;

    expect(typeof v).toBe('number');
    // The round-trip is lossy and the returned value matches 2^53.
    // If this assertion fails, someone changed bigIntAsNumber/insertIdAsNumber
    // without updating the compat matrix.
    expect(v).toBe(9007199254740992);
  });

  // ── insertId precision loss (§4.3 / audit H8) ───────────────────────────

  it('insertId > 2^53 is truncated by insertIdAsNumber = true', async () => {
    // The beforeEach TRUNCATE reset AUTO_INCREMENT to 1; reseed explicitly
    // for this test so the behaviour pins regardless of how many times
    // the suite has run against the fixture.
    await getPool().query('ALTER TABLE t_uids AUTO_INCREMENT = 9007199254740993');

    const id = unwrap(
      await rawQuery('insert', 'test', 'INSERT INTO t_uids (note) VALUES (?)', ['hi']),
    ) as number;
    expect(typeof id).toBe('number');
    expect(id).toBe(9007199254740992); // precision-lost to 2^53
  });

  // ── DECIMAL ─────────────────────────────────────────────────────────────

  it('DECIMAL is returned as a string to preserve precision', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_numeric (dec_small, dec_large) VALUES (?, ?)',
        ['12345.67', '1234567890123456789012.34567890'],
      ),
    );

    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT dec_small, dec_large FROM t_numeric', []),
    ) as Record<string, unknown>;

    expect(typeof row.dec_small).toBe('string');
    expect(row.dec_small).toBe('12345.67');
    expect(typeof row.dec_large).toBe('string');
    expect(row.dec_large).toBe('1234567890123456789012.34567890');
  });

  // ── FLOAT / DOUBLE ──────────────────────────────────────────────────────

  it('FLOAT and DOUBLE return JavaScript numbers', async () => {
    unwrap(
      await rawQuery(
        'insert',
        'test',
        'INSERT INTO t_numeric (num_float, num_double) VALUES (?, ?)',
        [1.5, 2.25],
      ),
    );

    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT num_float, num_double FROM t_numeric', []),
    ) as Record<string, unknown>;

    expect(typeof row.num_float).toBe('number');
    expect(typeof row.num_double).toBe('number');
    expect(row.num_double).toBe(2.25);
  });

  // ── BIT ─────────────────────────────────────────────────────────────────

  it('BIT(1) is coerced to boolean', async () => {
    await getPool().query("INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'0', b'0')");
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b1 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(typeof row.b1).toBe('boolean');
    expect(row.b1).toBe(true);
  });

  it('BIT(8) returns a numeric byte', async () => {
    await getPool().query("INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'10000000', b'0')");
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b8 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(typeof row.b8).toBe('number');
    expect(row.b8).toBe(0x80); // 128
  });

  // Audit H6 pinned default behaviour (flag off).
  it('BIT(16) with flag off returns only the first byte (pinned H6)', async () => {
    // b'1000000000000001' = 0x8001 = 32769. MariaDB stores big-endian so
    // the buffer is [0x80, 0x01]. typeCast returns buffer()[0] = 0x80 = 128
    // under the default (flag off). The flag-on behaviour lives in its
    // own describe block below.
    await getPool().query(
      "INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'0', b'1000000000000001')",
    );
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b16 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(typeof row.b16).toBe('number');
    expect(row.b16).toBe(0x80); // 128, NOT 32769
  });

  // Audit H6b pinned default behaviour (flag off).
  it('BIT NULL with flag off: b1=false (pinned H6b), b8=null, b16=null', async () => {
    await getPool().query('INSERT INTO t_bit (b1, b8, b16) VALUES (NULL, NULL, NULL)');
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b1, b8, b16 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(row.b1).toBe(false);
    expect(row.b8).toBeNull();
    expect(row.b16).toBeNull();
  });
});

// ── BIT with mysql_bit_full_integer = true (audit H6 + H6b corrected) ──
// These tests toggle the shared worker config flag, run, then restore it.
// Vitest runs tests within a file sequentially, so the shared state is
// safe. Other test files that observe BIT behaviour always run with the
// flag off (the default), preserving the 3.1.0 pinned semantics.

describe('cluster 5 — BIT with mysql_bit_full_integer flag enabled', () => {
  beforeAll(async () => {
    await initHarness();
    setBitFullInteger(true);
  });

  afterAll(() => {
    setBitFullInteger(false);
  });

  beforeEach(async () => {
    await getPool().query('TRUNCATE t_bit');
  });

  it('BIT(1) non-null is still a boolean (flag preserves boolean semantics)', async () => {
    await getPool().query("INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'0', b'0')");
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b1 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(typeof row.b1).toBe('boolean');
    expect(row.b1).toBe(true);
  });

  it('BIT(1) NULL returns null (H6b fix; was false with flag off)', async () => {
    await getPool().query('INSERT INTO t_bit (b1, b8, b16) VALUES (NULL, NULL, NULL)');
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT b1 FROM t_bit', []),
    );
    expect(v).toBeNull();
  });

  it('BIT(8) with value 128 returns 128 as number (unchanged; first byte = full value)', async () => {
    await getPool().query(
      "INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'10000000', b'0')",
    );
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT b8 FROM t_bit', []),
    );
    expect(typeof v).toBe('number');
    expect(v).toBe(128);
  });

  it('BIT(16) returns the full big-endian integer (H6 fix; was first-byte-only)', async () => {
    // 32769 = 0x8001, stored big-endian as [0x80, 0x01].
    await getPool().query(
      "INSERT INTO t_bit (b1, b8, b16) VALUES (b'1', b'0', b'1000000000000001')",
    );
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT b16 FROM t_bit', []),
    );
    expect(typeof v).toBe('number');
    expect(v).toBe(32769);
  });

  it('BIT(16) of 0 returns 0 as number', async () => {
    await getPool().query("INSERT INTO t_bit (b1, b8, b16) VALUES (b'0', b'0', b'0')");
    const v = unwrap(
      await rawQuery('scalar', 'test', 'SELECT b16 FROM t_bit', []),
    );
    expect(typeof v).toBe('number');
    expect(v).toBe(0);
  });

  it('BIT(n > 1) NULL still returns null (flag does not regress the wider-BIT null path)', async () => {
    await getPool().query('INSERT INTO t_bit (b1, b8, b16) VALUES (NULL, NULL, NULL)');
    const row = unwrap(
      await rawQuery('single', 'test', 'SELECT b8, b16 FROM t_bit', []),
    ) as Record<string, unknown>;
    expect(row.b8).toBeNull();
    expect(row.b16).toBeNull();
  });
});
