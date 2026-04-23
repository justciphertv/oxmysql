import { parentPort } from 'worker_threads';
import { updateConfig, setIsolationLevel, initNamedPlaceholders, setBitFullInteger } from './config';
import { createConnectionPool, pool } from './database/pool';
import { rawQuery } from './database/rawQuery';
import { rawExecute } from './database/rawExecute';
import { rawTransaction } from './database/rawTransaction';
import { beginTransaction, runTransactionQuery, endTransaction } from './database/startTransaction';
import { print, sendResponse, triggerFivemEvent } from './utils/events';
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

parentPort?.on('message', handleIncoming);

// Tracks whether a prior `initialize` is still in its retry loop. A
// second initialize that arrives while the first is mid-connect must be
// ignored — otherwise two concurrent retry loops would race for the
// same pool variable and produce duplicate banner + event output.
let initializing = false;

async function dispatch(action: string, id: number | undefined, data: any) {
  switch (action) {
    case 'initialize': {
      const {
        connectionOptions,
        mysql_transaction_isolation_level,
        mysql_debug,
        namedPlaceholders,
        mysql_bit_full_integer,
      } = data;

      if (initializing) {
        print(
          `^3[oxmysql] ignoring duplicate initialize message while connection is still being established^0`,
        );
        break;
      }

      // Re-applying the mutable config fields is always safe: later
      // calls with different values take effect immediately. This is
      // what lets the FiveM side re-send initialize after a resource
      // reload without triggering a full re-connect cycle.
      setIsolationLevel(mysql_transaction_isolation_level);
      // Use the user's original value, not connectionOptions.namedPlaceholders which is
      // always boolean false (set to disable mariadb's own handling in favour of ours).
      const npCheck = initNamedPlaceholders(namedPlaceholders);
      if (!npCheck.patched) {
        // The named-placeholders patch is missing and the resource would
        // silently misbind queries on every named placeholder. Fail loud
        // and fail fast rather than corrupt consumer data.
        print(`^1[oxmysql] FATAL: named-placeholders patch is not applied.^0`);
        print(`^1  ${npCheck.diagnostic}^0`);
        print(
          `^1  Fix: re-run 'bun install' (or 'npm install') from the oxmysql resource directory so patch-package re-applies patches/named-placeholders+1.1.3.patch.^0`,
        );
        triggerFivemEvent('oxmysql:error', {
          phase: 'init',
          message: 'named-placeholders patch is not applied',
          diagnostic: npCheck.diagnostic,
        });
        // Exit so the parent's exit handler drains pending requests with
        // a clear error rather than letting every subsequent named-
        // placeholder query return wrong data.
        process.exit(1);
      }
      setBitFullInteger(mysql_bit_full_integer === true);

      updateConfig({
        mysql_debug,
        mysql_slow_query_warning: 200,
        mysql_ui: false,
        mysql_log_size: 100,
      });

      if (pool) {
        // Already connected — config re-applied above, no need to
        // re-enter the retry loop. Audit M14.
        break;
      }

      // Retry pool creation until successful. Every failed attempt emits
      // visible telemetry so operators can see why the server is stuck and
      // an oxmysql:error event so monitoring resources can react. The retry
      // interval is tunable via mysql_init_retry_ms; default preserves the
      // pre-Phase-5.3 30s cadence.
      const retryIntervalMs = Math.max(1_000, Number(data?.mysql_init_retry_ms) || 30_000);
      let attempt = 0;
      initializing = true;
      try {
        while (!pool) {
          attempt += 1;
          await createConnectionPool(connectionOptions);
          if (pool) break;

          print(
            `^3[oxmysql] connection attempt ${attempt} failed; retrying in ${retryIntervalMs / 1000}s^0`,
          );
          triggerFivemEvent('oxmysql:error', {
            phase: 'init',
            attempt,
            retryIntervalMs,
            message: `connection attempt ${attempt} failed`,
          });

          await sleep(retryIntervalMs);
        }
      } finally {
        initializing = false;
      }

      if (attempt > 1) {
        print(`^2[oxmysql] connection established on attempt ${attempt}^0`);
        triggerFivemEvent('oxmysql:ready', { phase: 'init', attempt });
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
      const result = await endTransaction(connectionId, commit);
      // Parent may send `endTransaction` either as a fire-and-forget
      // message (no id) or as a request expecting the result payload
      // (id set) when the mysql_start_transaction_propagate_errors
      // convar is enabled. Respond only if the parent is listening.
      if (id !== undefined) sendResponse(id, result);
      break;
    }

    case 'shutdown': {
      // Flush the pool so no half-open connections linger on the server.
      // Exit explicitly so FXServer's worker.terminate() fallback (2s
      // grace window) only fires if pool.end() stalls.
      try {
        await pool?.end();
      } catch {
        /* pool may already be torn down */
      }
      process.exit(0);
      // Unreachable — process.exit(0) terminates the worker — but the
      // explicit return makes it obvious to reviewers and linters that
      // this case does not fall through to whatever might be appended
      // after it in future edits.
      return;
    }
  }
}
