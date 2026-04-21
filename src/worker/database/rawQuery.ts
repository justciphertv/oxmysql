import { parseArguments } from '../utils/parseArguments';
import { parseResponse } from '../utils/parseResponse';
import { logQuery, logError } from '../logger';
import type { CFXParameters, QueryType } from '../../types';
import { getConnection } from './connection';
import { awaitPool, pool } from './pool';
import { mysql_debug } from '../config';
import { performance } from 'perf_hooks';
import validateResultSet from '../utils/validateResultSet';
import { runProfiler } from '../profiler';

export const rawQuery = async (
  type: QueryType,
  invokingResource: string,
  query: string,
  parameters: CFXParameters
): Promise<{ result: any } | { error: string }> => {
  try {
    [query, parameters] = parseArguments(query, parameters);
  } catch (err: any) {
    return { error: logError(invokingResource, err, query, parameters) };
  }

  try {
    // Callers may dispatch queries before initialize has finished the first
    // successful handshake — qbx_core / ox_doorlock etc. run schema
    // migrations at resource start without waiting for MySQL.awaitConnection.
    // Block here so the fast path does not dereference a null pool.
    await awaitPool();

    if (!mysql_debug) {
      // Fast path: call pool.query() directly — same text protocol as connection.query()
      // but avoids acquiring/wrapping/releasing a dedicated PoolConnection.
      const startTime = performance.now();
      const result = await pool!.query(query, parameters);
      logQuery(invokingResource, query, performance.now() - startTime, parameters);
      validateResultSet(invokingResource, query, result);
      return { result: parseResponse(type, result) };
    }

    // Profiler path — needs a dedicated connection to run SET profiling statements.
    using connection = await getConnection();

    if (!connection) return { error: `${invokingResource} was unable to acquire a database connection.` };

    await runProfiler(connection, invokingResource);
    const startTime = performance.now();
    const result = await connection.query(query, parameters);

    const profiler = (await connection.query(
      'SELECT FORMAT(SUM(DURATION) * 1000, 4) AS `duration` FROM INFORMATION_SCHEMA.PROFILING'
    )) as any[];

    if (profiler[0]) logQuery(invokingResource, query, parseFloat(profiler[0].duration), parameters);
    else logQuery(invokingResource, query, performance.now() - startTime, parameters);

    validateResultSet(invokingResource, query, result);
    return { result: parseResponse(type, result) };
  } catch (err: any) {
    return { error: logError(invokingResource, err, query, parameters, true) };
  }
};
