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
import * as perf from '../utils/perf';

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

  const totalStart = perf.now();
  try {
    // See rawQuery for rationale — block until the pool handshake has
    // completed so the fast-path pool!.query / pool!.batch calls below
    // cannot dereference null.
    await perf.time('rawExecute:awaitPool', () => awaitPool());

    // ── Fast paths: bypass the single-connection overhead when profiling is off ──

    if (!mysql_debug) {
      const startTime = performance.now();

      if (type !== null) {
        if (parameters.length > 1) {
          // DML bulk: COM_STMT_BULK_EXECUTE — ~30x faster than looping.
          const batchResults = (await perf.time('rawExecute:pool.batch(DML-bulk)', () =>
            pool!.batch(query, parameters)
          )) as any[];
          logQuery(invokingResource, query, performance.now() - startTime, parameters);

          if (unpack) {
            // batch() returns UpsertResult[] — map each for insertId / affectedRows
            const shapeStart = perf.now();
            const parsed = batchResults.map((r) => parseResponse(type, r));
            perf.mark('rawExecute:shape(DML-bulk-unpack)', shapeStart);
            perf.mark('rawExecute:total(DML-bulk)', totalStart);
            return { result: parsed.length === 1 ? parsed[0] : parsed };
          }

          perf.mark('rawExecute:total(DML-bulk)', totalStart);
          return { result: batchResults.length === 1 ? batchResults[0] : batchResults };
        } else {
          // Single DML: pool.query() avoids the MySql wrapper acquire/release overhead.
          const result = await perf.time('rawExecute:pool.query(DML-single)', () =>
            pool!.query(query, parameters[0] ?? [])
          );
          logQuery(invokingResource, query, performance.now() - startTime, parameters[0]);
          if (unpack) {
            const shapeStart = perf.now();
            const shaped = parseResponse(type, result);
            perf.mark('rawExecute:shape(DML-single-unpack)', shapeStart);
            perf.mark('rawExecute:total(DML-single)', totalStart);
            return { result: shaped };
          }
          perf.mark('rawExecute:total(DML-single)', totalStart);
          return { result };
        }
      } else {
        if (parameters.length > 1) {
          // SELECT, multiple param sets: run all concurrently across pool connections.
          // The pool queues internally when all connections are busy — always safe.
          const results = await perf.time('rawExecute:pool.query(SELECT-multi)', () =>
            Promise.all(
              parameters.map(async (values) => {
                const result = await pool!.query(query, values);
                validateResultSet(invokingResource, query, result);
                return result as any[];
              })
            )
          );

          logQuery(invokingResource, query, performance.now() - startTime, parameters);

          if (unpack) {
            // Extract scalar / first-row from each result set
            const shapeStart = perf.now();
            const parsed = results.map((rows) => {
              const row = rows?.[0];
              if (!row) return null;
              return Object.keys(row).length === 1 ? Object.values(row)[0] : row;
            });
            perf.mark('rawExecute:shape(SELECT-multi-unpack)', shapeStart);
            perf.mark('rawExecute:total(SELECT-multi)', totalStart);
            return { result: parsed.length === 1 ? parsed[0] : parsed };
          }

          perf.mark('rawExecute:total(SELECT-multi)', totalStart);
          return { result: results };
        } else {
          // Single SELECT: pool.query() avoids the MySql wrapper overhead.
          const result = (await perf.time('rawExecute:pool.query(SELECT-single)', () =>
            pool!.query(query, parameters[0] ?? [])
          )) as any[];
          logQuery(invokingResource, query, performance.now() - startTime, parameters[0]);
          validateResultSet(invokingResource, query, result);

          if (unpack) {
            const shapeStart = perf.now();
            const row = result?.[0];
            let shaped: unknown;
            if (row && Object.keys(row).length === 1) shaped = Object.values(row)[0];
            else shaped = row ?? null;
            perf.mark('rawExecute:shape(SELECT-single-unpack)', shapeStart);
            perf.mark('rawExecute:total(SELECT-single)', totalStart);
            return { result: shaped };
          }

          perf.mark('rawExecute:total(SELECT-single)', totalStart);
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
