import { MySql, activeConnections, getConnection } from './connection';
import { logError } from '../logger';
import type { CFXParameters } from '../../types';
import { parseArguments } from '../utils/parseArguments';
import * as perf from '../utils/perf';

async function runQuery(conn: MySql | null, sql: string, values: CFXParameters) {
  [sql, values] = parseArguments(sql, values);

  try {
    if (!conn) throw new Error(`Connection used by transaction timed out after 30 seconds.`);

    return await conn.query(sql, values);
  } catch (err: any) {
    throw new Error(`Query: ${sql}\n${JSON.stringify(values)}\n${err.message}`);
  }
}

export const beginTransaction = async (
  invokingResource: string
): Promise<{ connectionId: number } | { error: string }> => {
  const totalStart = perf.now();
  try {
    const acquireStart = perf.now();
    const conn = await getConnection();
    perf.mark('startTransaction:beginTransaction:getConnection', acquireStart);
    await perf.time('startTransaction:beginTransaction:BEGIN', () => conn.beginTransaction());
    perf.mark('startTransaction:beginTransaction:total', totalStart);
    return { connectionId: conn.id };
  } catch (err: any) {
    return { error: logError(invokingResource, err) };
  }
};

export const runTransactionQuery = async (
  invokingResource: string,
  connectionId: number,
  sql: string,
  values: CFXParameters
): Promise<{ result: any } | { error: string }> => {
  const totalStart = perf.now();
  const conn = activeConnections[connectionId] ?? null;

  // Audit M1 race guard: once endTransaction has begun tearing the
  // transaction down, refuse to start fresh queries on the same
  // connection. Without this, the parent's timeout handler and a
  // still-pending queryFn call can land on the worker in a short window
  // where `activeConnections` still holds the MySql wrapper but is about
  // to be reaped.
  if (!conn || conn.closed) {
    return {
      error: conn?.closed
        ? `Transaction has been closed; query not executed.`
        : `Connection used by transaction timed out after 30 seconds.`,
    };
  }

  try {
    const result = await perf.time('startTransaction:runTransactionQuery:execute', () =>
      runQuery(conn, sql, values)
    );
    perf.mark('startTransaction:runTransactionQuery:total', totalStart);
    return { result };
  } catch (err: any) {
    return { error: err.message };
  }
};

export const endTransaction = async (
  connectionId: number,
  commit: boolean
): Promise<{ result: true } | { error: string }> => {
  const conn = activeConnections[connectionId];

  if (!conn) return { result: true };

  const totalStart = perf.now();
  // Mark the wrapper closed so any concurrent runTransactionQuery refuses
  // to start new work, then wait for any op already in flight to complete
  // before committing / rolling back. Together these prevent the M1 race.
  conn.closed = true;
  try {
    await perf.time('startTransaction:endTransaction:waitUntilIdle', () => conn.waitUntilIdle());
  } catch {
    /* waitUntilIdle never throws, but defensive */
  }

  let endError: Error | null = null;

  try {
    if (commit) {
      await perf.time('startTransaction:endTransaction:commit', () => conn.commit());
    } else {
      await perf.time('startTransaction:endTransaction:rollback', () => conn.rollback());
    }
  } catch (err: any) {
    endError = err instanceof Error ? err : new Error(String(err));
    conn.failed = true;
  } finally {
    delete activeConnections[connectionId];
    // If the commit/rollback failed, the connection is in an indeterminate
    // state; destroy it rather than returning a tainted connection to the
    // pool. Matches the rawTransaction behaviour.
    if (conn.failed) {
      try {
        conn.connection.destroy();
      } catch {
        /* already gone */
      }
    } else {
      try {
        conn.connection.release();
      } catch {
        /* already gone */
      }
    }
  }

  perf.mark('startTransaction:endTransaction:total', totalStart);

  if (endError) {
    return {
      error: `${commit ? 'commit' : 'rollback'} failed: ${endError.message}`,
    };
  }
  return { result: true };
};
