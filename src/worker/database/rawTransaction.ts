import { getConnection } from './connection';
import { logError, logger, logQuery } from '../logger';
import type { CFXParameters, TransactionQuery } from '../../types';
import { parseTransaction } from '../utils/parseTransaction';
import { performance } from 'perf_hooks';
import { profileBatchStatements, runProfiler } from '../profiler';
import { triggerFivemEvent } from '../utils/events';
import * as perf from '../utils/perf';

/** Maximum rows per COM_STMT_BULK_EXECUTE call — avoids connector-level failures with very large packets. */
const BATCH_CHUNK_SIZE = 1000;

const transactionErrorMessage = (queries: { query: string; params?: CFXParameters }[], parameters: CFXParameters) =>
  `${queries.map((query) => `${query.query} ${JSON.stringify(query.params || [])}`).join('\n')}\n${JSON.stringify(
    parameters
  )}`;

/** Returns true for statements that are safe to send via the binary prepared-statement
 *  protocol used by batch(). SELECT-like statements can hit ER_UNSUPPORTED_PS (1295). */
const isDML = (query: string) => /^(INSERT|UPDATE|DELETE|REPLACE)\s/i.test(query.trimStart());

type TxGroup = { query: string; paramSets: CFXParameters[] };

/** Group consecutive transactions that share the same SQL so batch() can be used. */
function groupTransactions(transactions: { query: string; params?: CFXParameters }[]): TxGroup[] {
  const groups: TxGroup[] = [];
  for (const t of transactions) {
    const last = groups[groups.length - 1];
    if (last && last.query === t.query) {
      last.paramSets.push(t.params ?? []);
    } else {
      groups.push({ query: t.query, paramSets: [t.params ?? []] });
    }
  }
  return groups;
}

export const rawTransaction = async (
  invokingResource: string,
  queries: TransactionQuery,
  parameters: CFXParameters
): Promise<{ result: boolean } | { error: string }> => {
  let transactions;

  try {
    transactions = parseTransaction(queries, parameters);
  } catch (err: any) {
    return { error: logError(invokingResource, err) };
  }

  const totalStart = perf.now();
  // `getConnection` already records its own `getConnection:pool.getConnection`
  // phase. A second timer wrapping the same `await getConnection()` measures
  // exactly the same span within timing noise (~5us differences observed in
  // Phase 2 sweeps) — drop it to keep the perf report uncluttered.
  using connection = await getConnection();

  if (!connection) return { error: `${invokingResource} was unable to acquire a database connection.` };

  let response = false;

  try {
    const hasProfiler = await runProfiler(connection, invokingResource);
    await perf.time('rawTransaction:beginTransaction', () => connection.beginTransaction());

    if (!hasProfiler) {
      // Fast path: group consecutive same-SQL entries and use batch() for DML groups
      const groups = groupTransactions(transactions);

      for (const group of groups) {
        const startTime = performance.now();

        if (group.paramSets.length > 1 && isDML(group.query)) {
          for (let offset = 0; offset < group.paramSets.length; offset += BATCH_CHUNK_SIZE) {
            const chunk = group.paramSets.slice(offset, offset + BATCH_CHUNK_SIZE);
            try {
              await perf.time('rawTransaction:batch(DML-chunk)', () =>
                connection.batch(group.query, chunk)
              );
            } catch {
              // COM_STMT_BULK_EXECUTE failed (e.g. protocol/connectivity error).
              // Fall back to individual text-protocol queries so the transaction can still succeed.
              for (const params of chunk) {
                await perf.time('rawTransaction:query(DML-fallback)', () =>
                  connection.query(group.query, params)
                );
              }
            }
          }
          logQuery(invokingResource, group.query, performance.now() - startTime, group.paramSets);
        } else {
          for (const params of group.paramSets) {
            const t = performance.now();
            await perf.time('rawTransaction:query(ungrouped)', () =>
              connection.query(group.query, params)
            );
            logQuery(invokingResource, group.query, performance.now() - t, params);
          }
        }
      }
    } else {
      // Profiler path: individual queries with profiling
      const transactionsLength = transactions.length;

      for (let i = 0; i < transactionsLength; i++) {
        const transaction = transactions[i];
        await connection.query(transaction.query, transaction.params);

        if ((i > 0 && i % 100 === 0) || i === transactionsLength - 1) {
          await profileBatchStatements(connection, invokingResource, transactions, null, i < 100 ? 0 : i);
        }
      }
    }

    await perf.time('rawTransaction:commit', () => connection.commit());
    perf.mark('rawTransaction:total', totalStart);

    response = true;
  } catch (err: any) {
    try {
      await connection.rollback();
    } catch {
      // rollback failed — connection is likely dead; mark it for destruction
      connection.failed = true;
    }

    const errMessage = err.sql || transactionErrorMessage(transactions, parameters);
    const msg = `${invokingResource} was unable to complete a transaction!\n${errMessage}\n${err.message}`;

    triggerFivemEvent('oxmysql:transaction-error', {
      query: errMessage,
      parameters: parameters,
      message: err.message,
      err: err,
      resource: invokingResource,
    });

    if (typeof err === 'object' && err.message) delete err.sqlMessage;

    logger({
      level: 'error',
      resource: invokingResource,
      message: msg,
      metadata: err,
    });

    return { error: msg };
  }

  return { result: response };
};
