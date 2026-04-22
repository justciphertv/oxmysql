import { MySql, activeConnections, getConnection } from './connection';
import { logError } from '../logger';
import type { CFXParameters } from '../../types';
import { parseArguments } from '../utils/parseArguments';

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
  try {
    const conn = await getConnection();
    await conn.beginTransaction();
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
    const result = await runQuery(conn, sql, values);
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

  // Mark the wrapper closed so any concurrent runTransactionQuery refuses
  // to start new work, then wait for any op already in flight to complete
  // before committing / rolling back. Together these prevent the M1 race.
  conn.closed = true;
  try {
    await conn.waitUntilIdle();
  } catch {
    /* waitUntilIdle never throws, but defensive */
  }

  let endError: Error | null = null;

  try {
    if (commit) {
      await conn.commit();
    } else {
      await conn.rollback();
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

  if (endError) {
    return {
      error: `${commit ? 'commit' : 'rollback'} failed: ${endError.message}`,
    };
  }
  return { result: true };
};
