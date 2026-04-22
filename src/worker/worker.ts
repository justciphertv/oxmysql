import { parentPort } from 'worker_threads';
import { updateConfig, setIsolationLevel, initNamedPlaceholders } from './config';
import { createConnectionPool, pool } from './database/pool';
import { rawQuery } from './database/rawQuery';
import { rawExecute } from './database/rawExecute';
import { rawTransaction } from './database/rawTransaction';
import { beginTransaction, runTransactionQuery, endTransaction } from './database/startTransaction';
import { print, sendResponse } from './utils/events';
import { sleep } from './utils/sleep';
import type { QueryType, TransactionQuery, CFXParameters } from '../types';

// All worker-side dispatch errors are surfaced as:
//   - an `{ error }` response to the originating request (if it had an id)
//   - a print() diagnostic to the FXServer console
// The worker itself is NOT allowed to crash out of this handler. Historically
// a bad payload or unexpected throw inside any case arm tore down the worker,
// after which every subsequent query hung forever on the parent side. The
// parent's exit handler (Phase 5.1) now drains pending on exit, but
// preventing the crash in the first place is the better primitive: it keeps
// the resource functional for every non-poisoned request.

export async function handleIncoming(message: {
  action: string;
  id?: number;
  data: any;
}) {
  const { action, id, data } = message ?? ({} as { action: string; id?: number; data: any });

  try {
    await dispatch(action, id, data);
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    try {
      print(`^1[oxmysql worker] dispatch failed for action='${action}': ${reason}^0`);
    } catch {
      /* parentPort may be unavailable if we are mid-shutdown */
    }
    if (id !== undefined) {
      try {
        sendResponse(id, { error: `oxmysql worker dispatch failed: ${reason}` });
      } catch {
        /* same guard as above */
      }
    }
  }
}

parentPort!.on('message', handleIncoming);

async function dispatch(action: string, id: number | undefined, data: any) {
  switch (action) {
    case 'initialize': {
      const { connectionOptions, mysql_transaction_isolation_level, mysql_debug, namedPlaceholders } = data;

      setIsolationLevel(mysql_transaction_isolation_level);
      // Use the user's original value, not connectionOptions.namedPlaceholders which is
      // always boolean false (set to disable mariadb's own handling in favour of ours).
      initNamedPlaceholders(namedPlaceholders);

      updateConfig({
        mysql_debug,
        mysql_slow_query_warning: 200,
        mysql_ui: false,
        mysql_log_size: 100,
      });

      // Retry pool creation until successful
      while (!pool) {
        await createConnectionPool(connectionOptions);
        if (!pool) await sleep(30000);
      }

      break;
    }

    case 'updateConfig': {
      updateConfig(data);
      break;
    }

    case 'query': {
      const { type, invokingResource, query, parameters } = data as {
        type: QueryType;
        invokingResource: string;
        query: string;
        parameters: CFXParameters;
      };

      const result = await rawQuery(type, invokingResource, query, parameters);
      sendResponse(id!, result);
      break;
    }

    case 'execute': {
      const { invokingResource, query, parameters, unpack } = data as {
        invokingResource: string;
        query: string;
        parameters: CFXParameters;
        unpack?: boolean;
      };

      const result = await rawExecute(invokingResource, query, parameters, unpack);
      sendResponse(id!, result);
      break;
    }

    case 'transaction': {
      const { invokingResource, queries, parameters } = data as {
        invokingResource: string;
        queries: TransactionQuery;
        parameters: CFXParameters;
      };

      const result = await rawTransaction(invokingResource, queries, parameters);
      sendResponse(id!, result);
      break;
    }

    case 'beginTransaction': {
      const { invokingResource } = data as { invokingResource: string };
      const result = await beginTransaction(invokingResource);
      sendResponse(id!, result);
      break;
    }

    case 'transactionQuery': {
      const { invokingResource, connectionId, sql, values } = data as {
        invokingResource: string;
        connectionId: number;
        sql: string;
        values: CFXParameters;
      };

      const result = await runTransactionQuery(invokingResource, connectionId, sql, values);
      sendResponse(id!, result);
      break;
    }

    case 'endTransaction': {
      const { connectionId, commit } = data as { connectionId: number; commit: boolean };
      await endTransaction(connectionId, commit);
      break;
    }
  }
}
