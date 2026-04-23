import { createPool } from 'mariadb';
import type { Pool, PoolConfig } from 'mariadb';
import { mysql_transaction_isolation_level, mysql_bigint_as_string } from '../config';
import { typeCast } from '../utils/typeCast';
import { print } from '../utils/events';
import { parentPort } from 'worker_threads';
import { sleep } from '../utils/sleep';
import { BUILD_STAMP } from '../build-stamp';

export let pool: Pool | null = null;
export let dbVersion = '';

/**
 * Block until the connection pool is ready for queries. Any code path that
 * would call `pool!.query` / `pool!.batch` directly must await this first;
 * otherwise a query dispatched before the first successful handshake
 * dereferences null and crashes the caller. `getConnection` already does
 * the same wait for slow-path code.
 */
export async function awaitPool(): Promise<Pool> {
  while (!pool) await sleep(0);
  return pool;
}

/**
 * Tear down the current pool and reset module state so a subsequent
 * `createConnectionPool` call rebuilds from scratch. Intended for the
 * benchmark harness and for potential future CLI tooling that needs to
 * re-open the pool with different options. NOT called from production
 * code paths — graceful shutdown uses `pool?.end()` directly and then
 * exits the worker process.
 */
export async function resetPool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* best-effort teardown; a poisoned connector should not prevent
       * the next bench iteration from recreating the pool. */
    }
  }
  pool = null;
  dbVersion = '';
}

export async function createConnectionPool(options: PoolConfig) {
  try {
    // `mysql_bigint_as_string` flips the connector from number-with-
    // precision-loss to BigInt-for-everything. typeCast / parseResponse
    // then convert BigInts back to `number` when safely representable
    // and to lexical strings when not. Flag off preserves the exact
    // historical behaviour (number for every BIGINT / insertId, lossy
    // above 2^53). See compat-matrix §4.1 / §4.3.
    const numericAsNumber = !mysql_bigint_as_string;

    const dbPool = createPool({
      ...options,
      typeCast,
      initSql: mysql_transaction_isolation_level,
      checkDuplicate: false,
      bigIntAsNumber: numericAsNumber,
      insertIdAsNumber: numericAsNumber,
      // Match the mysql2 / mysql-async contract: JSON columns arrive in the
      // result as strings. Consumers (qbx_properties, qbx_spawn, …) call
      // json.decode() on them from Lua. The mariadb connector has TWO
      // independent JSON controls:
      //   - `jsonStrings: true`  — applies to explicit `FieldType.JSON`
      //   - `autoJsonMap: false` — applies to LONGTEXT-with-JSON-format-hint
      // We need BOTH; the decoder's FieldType.JSON branch short-circuits
      // before the autoJsonMap check, so autoJsonMap alone is not enough.
      // Setting jsonStrings also implies !autoJsonMap (see mariadb
      // config/connection-options.js), but we set both explicitly for
      // clarity.
      jsonStrings: true,
      autoJsonMap: false,
    });

    const result = await dbPool.query<Array<{ version: string }>>('SELECT VERSION() as version');
    dbVersion = `^5[${result[0].version}]`;

    print(
      `${dbVersion} ^2Database server connection established!^0 ^7[oxmysql-mariadb-patch ${BUILD_STAMP}]^0`,
    );
    // Diagnostic banner: print the JSON-related options we applied so
    // operators can confirm the fix is live even before any query fires.
    print(
      `^7[oxmysql-mariadb-patch ${BUILD_STAMP}] pool options applied: ` +
        `jsonStrings=true autoJsonMap=false bigIntAsNumber=true insertIdAsNumber=true^0`,
    );
    parentPort?.postMessage({ action: 'dbVersion', data: dbVersion });

    if (options.multipleStatements) {
      print(`multipleStatements is enabled. Used incorrectly, this option may cause SQL injection.`);
    }

    pool = dbPool;
  } catch (err) {
    const error = err as { message?: string; code?: string; errno?: number };
    const message = error.message?.includes('auth_gssapi_client')
      ? `Requested authentication using unknown plugin auth_gssapi_client.`
      : error.message;

    print(
      `^3Unable to establish a connection to the database (${error.code})!\n^1Error${
        error.errno ? ` ${error.errno}` : ''
      }: ${message}^0`
    );

    print(`See https://github.com/overextended/oxmysql/issues/154 for more information.`);

    if ((options as Record<string, unknown>).password) (options as Record<string, unknown>).password = '******';
    print(JSON.stringify(options));
  }
}
