// Regression cluster 10 — compatibility aliases (compat-matrix §8).
//
// The aliases are registered at FiveM export time, so we cannot test
// exports.oxmysql:* / exports['mysql-async']:* dispatch from this
// worker-internals harness. We therefore pin the alias MAPS themselves —
// if anyone removes or renames an entry, the resulting lua consumer
// breakage will be caught here.
//
// The §8.4 contract (MySQL.Sync.execute bound to update, MySQL.execute
// bound to query) lives in lib/MySQL.lua; we assert the lua file content
// so accidental edits to that map are caught in CI.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import ghmatti from '../src/compatibility/ghmattimysql';
import mysqlAsync from '../src/compatibility/mysql-async';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libMySQL = readFileSync(join(__dirname, '..', 'lib', 'MySQL.lua'), 'utf8');

describe('cluster 10 — compatibility aliases (static maps)', () => {
  it('ghmattimysql alias map matches the pinned contents', () => {
    expect(ghmatti).toEqual({
      query: 'execute',
      scalar: 'scalar',
      transaction: 'transaction',
      store: 'store',
    });
  });

  it('mysql-async alias map matches the pinned contents', () => {
    expect(mysqlAsync).toEqual({
      update: 'mysql_execute',
      insert: 'mysql_insert',
      query: 'mysql_fetch_all',
      single: 'mysql_fetch',
      scalar: 'mysql_fetch_scalar',
      transaction: 'mysql_transaction',
      store: 'mysql_store',
    });
  });
});

describe('cluster 10 — §8.4 Lua wrapper alias contract', () => {
  it('lib/MySQL.lua Sync/Async alias map pins the divergent `execute -> update`', () => {
    // MySQL.execute on the raw export is `query`, but MySQL.Sync.execute
    // and MySQL.Async.execute are bound to `update`. §8.4 requires both
    // contracts to remain stable.
    expect(libMySQL).toMatch(/local alias = \{[\s\S]*?execute = 'update'[\s\S]*?\}/);
    expect(libMySQL).toMatch(/fetchAll = 'query'/);
    expect(libMySQL).toMatch(/fetchScalar = 'scalar'/);
    expect(libMySQL).toMatch(/fetchSingle = 'single'/);
    expect(libMySQL).toMatch(/prepare = 'prepare'/);
  });

  it('lib/MySQL.lua declares the full Sync/Async method list pinned in §2', () => {
    // These are the methods passed to the setmetatable loop; missing any
    // would break the wrapper silently.
    const methods = ['scalar', 'single', 'query', 'insert', 'update', 'prepare', 'transaction', 'rawExecute'];
    for (const method of methods) {
      expect(libMySQL).toContain(`'${method}'`);
    }
  });
});

describe('cluster 10 — generated _async / Sync export parity (per compat matrix §8.3)', () => {
  // Full parity across callback / _async / Sync forms is validated end-to-end
  // by cluster 2's rawQuery tests: every public method ends up in exactly
  // the same rawQuery call path regardless of which wrapper the caller
  // picked. The FiveM wrappers (_async, Sync) are a thin Promise shim over
  // the same MySQL.<k> function, tested at the integration level.
  //
  // We therefore only need to assert that the wrapping logic in
  // src/fivem/index.ts registers all three forms. That file imports
  // native FiveM globals (GetCurrentResourceName etc.) that do not exist
  // in the test process, so we read the source as text and assert the
  // provide/registration shape.
  it('src/fivem/index.ts registers key, key_async, keySync exports', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'fivem', 'index.ts'),
      'utf8',
    );
    expect(source).toMatch(/global\.exports\(key, exp\)/);
    expect(source).toMatch(/global\.exports\(`\$\{key\}_async`, async_exp\)/);
    expect(source).toMatch(/global\.exports\(`\$\{key\}Sync`, async_exp\)/);
  });
});
