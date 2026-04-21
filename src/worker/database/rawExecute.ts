import { logError, logQuery } from '../logger';
import type { CFXParameters, QueryType } from '../../types';
import { parseResponse } from '../utils/parseResponse';
import { executeType, parseExecute } from '../utils/parseExecute';
import { getConnection } from './connection';
import { awaitPool, pool } from './pool';
import { mysql_debug } from '../config';
import { performance } from 'perf_hooks';
import validateResultSet from '../utils/validateResultSet';
import { profileBatchStatements, runProfiler } from '../profiler';

export const rawExecute = async (
  invokingResource: string,
  query: string,
  parameters: CFXParameters,
  unpack?: boolean
): Promise<{ result: any } | { error: string }> => {
  let type: QueryType;
  let placeholders: number;

  try {
    type = executeType(query);
    placeholders = query.split('?').length - 1;
    parameters = parseExecute(placeholders, parameters);
  } catch (err: any) {
    return { error: logError(invokingResource, err, query, parameters) };
  }

  // Pad all parameter arrays with nulls to match placeholder count
  for (let index = 0; index < parameters.length; index++) {
    const values = parameters[index];

    if (values && placeholders > values.length) {
      for (let i = values.length; i < placeholders; i++) {
        values[i] = null;
      }
    }
  }

  try {
    // See rawQuery for rationale — block until the pool handshake has
    // completed so the fast-path pool!.query / pool!.batch calls below
    // cannot dereference null.
    await awaitPool();

    // ── Fast paths: bypass the single-connection overhead when profiling is off ──

    if (!mysql_debug) {
      const startTime = performance.now();

      if (type !== null) {
        if (parameters.length > 1) {
          // DML bulk: COM_STMT_BULK_EXECUTE — ~30x faster than looping.
          const batchResults = (await pool!.batch(query, parameters)) as any[];
          logQuery(invokingResource, query, performance.now() - startTime, parameters);

          if (unpack) {
            // batch() returns UpsertResult[] — map each for insertId / affectedRows
            const parsed = batchResults.map((r) => parseResponse(type, r));
            return { result: parsed.length === 1 ? parsed[0] : parsed };
          }

          return { result: batchResults.length === 1 ? batchResults[0] : batchResults };
        } else {
          // Single DML: pool.query() avoids the MySql wrapper acquire/release overhead.
          const result = await pool!.query(query, parameters[0] ?? []);
          logQuery(invokingResource, query, performance.now() - startTime, parameters[0]);
          return { result: unpack ? parseResponse(type, result) : result };
        }
      } else {
        if (parameters.length > 1) {
          // SELECT, multiple param sets: run all concurrently across pool connections.
          // The pool queues internally when all connections are busy — always safe.
          const results = await Promise.all(
            parameters.map(async (values) => {
              const result = await pool!.query(query, values);
              validateResultSet(invokingResource, query, result);
              return result as any[];
            })
          );

          logQuery(invokingResource, query, performance.now() - startTime, parameters);

          if (unpack) {
            // Extract scalar / first-row from each result set
            const parsed = results.map((rows) => {
              const row = rows?.[0];
              if (!row) return null;
              return Object.keys(row).length === 1 ? Object.values(row)[0] : row;
            });
            return { result: parsed.length === 1 ? parsed[0] : parsed };
          }

          return { result: results };
        } else {
          // Single SELECT: pool.query() avoids the MySql wrapper overhead.
          const result = (await pool!.query(query, parameters[0] ?? [])) as any[];
          logQuery(invokingResource, query, performance.now() - startTime, parameters[0]);
          validateResultSet(invokingResource, query, result);

          if (unpack) {
            const row = result?.[0];
            if (row && Object.keys(row).length === 1) return { result: Object.values(row)[0] };
            return { result: row ?? null };
          }

          return { result: result ?? null };
        }
      }
    }

    // ── Slow path: single dedicated connection (profiler enabled, or single param set) ──

    using connection = await getConnection();

    if (!connection) return { error: `${invokingResource} was unable to acquire a database connection.` };

    const hasProfiler = await runProfiler(connection, invokingResource);
    const parametersLength = parameters.length == 0 ? 1 : parameters.length;
    const response = [] as any[];

    for (let index = 0; index < parametersLength; index++) {
      const values = parameters[index];
      const startTime = !hasProfiler && performance.now();
      const result = await connection.query(query, values);

      if (Array.isArray(result) && result.length > 1) {
        for (const value of result) {
          response.push(unpack ? parseResponse(type, value) : value);
        }
      } else response.push(unpack ? parseResponse(type, result) : result);

      if (hasProfiler && ((index > 0 && index % 100 === 0) || index === parametersLength - 1)) {
        await profileBatchStatements(connection, invokingResource, query, parameters, index < 100 ? 0 : index);
      } else if (startTime) {
        logQuery(invokingResource, query, performance.now() - startTime, values);
      }

      validateResultSet(invokingResource, query, result);
    }

    const finalResult = response.length === 1 ? response[0] : response;

    if (unpack && type === null && response.length === 1) {
      if (response[0]?.[0] && Object.keys(response[0][0]).length === 1) {
        return { result: Object.values(response[0][0])[0] };
      }
      return { result: response[0]?.[0] };
    }

    return { result: finalResult };
  } catch (err: any) {
    return { error: logError(invokingResource, err, query, parameters) };
  }
};
