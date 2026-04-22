import { Worker } from 'worker_threads';
import path from 'path';
import type { CFXCallback, CFXParameters, TransactionQuery } from '../types';
import ghmatti from '../compatibility/ghmattimysql';
import mysqlAsync from '../compatibility/mysql-async';
import { WorkerChannel } from './channel';
import('../update');

// ─── Worker setup ────────────────────────────────────────────────────────────

const resourceName = GetCurrentResourceName();
const resourcePath = GetResourcePath(resourceName);
const worker = new Worker(path.join(resourcePath, 'dist/worker.js'));

// Opt-in per-request timeout. 0 = feature disabled, every request stays
// pending until answered (matches the pre-Phase-5 contract pinned in
// compat-matrix §10.3). When set, a request that has not received a
// response in this many ms resolves with an `{ error }` payload and emits
// an `oxmysql:error` event with `phase: 'timeout'`.
const mysql_request_timeout_ms = GetConvarInt('mysql_request_timeout_ms', 0);

const channel = new WorkerChannel(worker, {
  defaultTimeoutMs: mysql_request_timeout_ms,
  onSynthesizedError: ({ action, reason }) => {
    console.error(reason);
    try {
      emit('oxmysql:error', { phase: 'timeout', action, message: reason });
    } catch {
      /* ignore — emit may be unavailable if resource is mid-shutdown */
    }
  },
});

function sendToWorker<T = any>(action: string, data: any): Promise<T> {
  return channel.send<T>(action, data);
}

function emitToWorker(action: string, data?: any): void {
  channel.emit(action, data);
}

// ─── Logger state (requires FiveM APIs) ──────────────────────────────────────

interface QueryData {
  date: number;
  query: string;
  executionTime: number;
  slow?: boolean;
}

const logStorage: Record<string, QueryData[]> = {};

let mysql_ui = false;
let mysql_log_size = 100;
let mysql_slow_query_warning = 200;
let isReady = false;

let loggerService = GetConvar('mysql_logger_service', '');
let loggerResource = '';

if (loggerService) {
  if (loggerService.startsWith('@')) {
    const [resource, ...pathParts] = loggerService.slice(1).split('/');
    if (resource && pathParts) {
      loggerResource = resource;
      loggerService = pathParts.join('/');
    }
  } else loggerService = `logger/${loggerService}`;
}

const logger: (data: { level: string; resource: string; message: string; metadata?: any }) => void =
  (loggerService && new Function(LoadResourceFile(loggerResource || resourceName, `${loggerService}.js`))()) ||
  (() => {});

// ─── Worker message handler ───────────────────────────────────────────────────

worker.on('message', (message: { action: string; id?: number; data: any }) => {
  const { action, id, data } = message;

  if (action === 'response' && id !== undefined) {
    channel.deliver(id, data);
    return;
  }

  switch (action) {
    case 'print':
      console.log(...data);
      break;

    case 'scheduleTick':
      ScheduleResourceTick(resourceName);
      break;

    case 'dbVersion':
      isReady = true;
      break;

    case 'logQuery': {
      if (!mysql_ui) break;

      const { invokingResource, query, executionTime, slow } = data;

      if (!logStorage[invokingResource]) logStorage[invokingResource] = [];
      else if (logStorage[invokingResource].length > mysql_log_size) logStorage[invokingResource].splice(0, 1);

      logStorage[invokingResource].push({ query, executionTime, date: Date.now(), slow });
      break;
    }

    case 'triggerEvent':
      TriggerEvent(data.event, data.payload);
      break;

    case 'callLogger':
      logger(data);
      break;
  }
});

worker.on('error', (err) => {
  console.error('oxmysql worker error:', err);
  try {
    emit('oxmysql:error', {
      phase: 'worker',
      message: err instanceof Error ? err.message : String(err),
    });
  } catch {
    /* ignore */
  }
});

worker.on('exit', (code) => {
  // The WorkerChannel's own exit handler drains pending requests with
  // synthesized errors. This listener is only for operator-visible logging
  // so the failure mode is obvious in the FXServer console.
  console.error(
    `^1[oxmysql] worker exited (code ${code}). All in-flight queries rejected. ` +
      `Restart the resource to re-spawn the worker.^0`,
  );
  try {
    emit('oxmysql:error', { phase: 'worker-exit', code });
  } catch {
    /* ignore */
  }
});

// ─── Config ───────────────────────────────────────────────────────────────────

function parseUri(connectionString: string) {
  const match = connectionString.match(
    new RegExp(
      '^(?:([^:/?#.]+):)?(?://(?:([^/?#]*)@)?([\\w\\d\\-\\u0100-\\uffff.%]*)(?::([0-9]+))?)?([^?#]+)?(?:\\?([^#]*))?$'
    )
  ) as RegExpMatchArray;

  if (!match) throw new Error(`mysql_connection_string structure was invalid (${connectionString})`);

  const authTarget = match[2] ? match[2].split(':') : [];

  return {
    user: authTarget[0] || undefined,
    password: authTarget[1] || undefined,
    host: match[3],
    port: parseInt(match[4]),
    database: match[5]?.replace(/^\/+/, ''),
    ...(match[6] &&
      match[6].split('&').reduce<Record<string, string>>((acc, param) => {
        const [key, value] = param.split('=');
        if (key && value) acc[key] = value;
        return acc;
      }, {})),
  };
}

function buildConnectionOptions() {
  const mysql_connection_string = GetConvar('mysql_connection_string', '');

  const raw: Record<string, any> = mysql_connection_string.includes('mysql://')
    ? parseUri(mysql_connection_string)
    : mysql_connection_string
        .replace(/(?:host(?:name)|ip|server|data\s?source|addr(?:ess)?)=/gi, 'host=')
        .replace(/(?:user\s?(?:id|name)?|uid)=/gi, 'user=')
        .replace(/(?:pwd|pass)=/gi, 'password=')
        .replace(/(?:db)=/gi, 'database=')
        .split(';')
        .reduce<Record<string, string>>((acc, param) => {
          const [key, value] = param.split('=');
          if (key) acc[key] = value;
          return acc;
        }, {});

  for (const key of ['ssl']) {
    if (typeof raw[key] === 'string') {
      try {
        raw[key] = JSON.parse(raw[key]);
      } catch {
        console.log(`^3Failed to parse property ${key} in configuration!^0`);
      }
    }
  }

  // Preserve the user's namedPlaceholders preference (string 'false' means they opted out)
  // before we set namedPlaceholders:false on the pool to disable mariadb's own handling.
  const userNamedPlaceholders = raw.namedPlaceholders;

  return {
    connectTimeout: 60000,
    bigIntAsNumber: true,
    ...raw,
    namedPlaceholders: false, // disable mariadb's built-in handling; we do it ourselves
    _userNamedPlaceholders: userNamedPlaceholders,
  };
}

function readConfig() {
  mysql_ui = GetConvar('mysql_ui', 'false') === 'true';
  mysql_slow_query_warning = GetConvarInt('mysql_slow_query_warning', 200);

  let mysql_debug: boolean | string[] = false;
  try {
    const debug = GetConvar('mysql_debug', 'false');
    mysql_debug = debug === 'false' ? false : JSON.parse(debug);
  } catch {
    mysql_debug = true;
  }

  mysql_log_size = mysql_debug ? 10000 : GetConvarInt('mysql_log_size', 100);

  emitToWorker('updateConfig', { mysql_debug, mysql_slow_query_warning, mysql_ui, mysql_log_size });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const isolationLevelMap: Record<number, string> = {
  1: 'REPEATABLE READ',
  2: 'READ COMMITTED',
  3: 'READ UNCOMMITTED',
  4: 'SERIALIZABLE',
};

const isolationLevel = GetConvarInt('mysql_transaction_isolation_level', 2);
const mysql_transaction_isolation_level = `SET TRANSACTION ISOLATION LEVEL ${
  isolationLevelMap[isolationLevel] ?? 'READ COMMITTED'
}`;

const connectionOptions = buildConnectionOptions();

// Extract and remove the sentinel before sending options to the mariadb pool.
const { _userNamedPlaceholders: userNamedPlaceholders, ...poolOptions } = connectionOptions;

worker.postMessage({
  action: 'initialize',
  data: {
    connectionOptions: poolOptions,
    mysql_transaction_isolation_level,
    mysql_debug: false,
    namedPlaceholders: userNamedPlaceholders,
  },
});

readConfig();
setInterval(readConfig, 1000);

// ─── oxmysql_debug command ────────────────────────────────────────────────────

RegisterCommand(
  'oxmysql_debug',
  (source: number, args: string[]) => {
    if (source !== 0) return console.log('^3This command can only be run server side^0');

    const current = GetConvar('mysql_debug', 'false');
    let arr: string[] = current === 'false' ? [] : JSON.parse(current);

    switch (args[0]) {
      case 'add':
        arr.push(args[1]);
        SetConvar('mysql_debug', JSON.stringify(arr));
        return console.log(`^3Added ${args[1]} to mysql_debug^0`);

      case 'remove': {
        const idx = arr.indexOf(args[1]);
        if (idx === -1) return;
        arr.splice(idx, 1);
        SetConvar('mysql_debug', arr.length === 0 ? 'false' : JSON.stringify(arr));
        return console.log(`^3Removed ${args[1]} from mysql_debug^0`);
      }

      default:
        return console.log(`^3Usage: oxmysql add|remove <resource>^0`);
    }
  },
  true
);

// ─── mysql UI command & NUI handlers ─────────────────────────────────────────

const sortQueries = (queries: QueryData[], sort: { id: 'query' | 'executionTime'; desc: boolean }) => {
  const sorted = [...queries].sort((a, b) => {
    switch (sort.id) {
      case 'query':
        return a.query > b.query ? 1 : -1;
      case 'executionTime':
        return a.executionTime - b.executionTime;
      default:
        return 0;
    }
  });
  return sort.desc ? sorted.reverse() : sorted;
};

RegisterCommand(
  'mysql',
  (source: number) => {
    if (!mysql_ui) return;

    if (source < 1) {
      console.log('^3This command cannot run server side^0');
      return;
    }

    let totalQueries = 0;
    let totalTime = 0;
    let slowQueries = 0;
    const chartData: { labels: string[]; data: { queries: number; time: number }[] } = { labels: [], data: [] };

    for (const resource in logStorage) {
      const queries = logStorage[resource];
      let totalResourceTime = 0;

      totalQueries += queries.length;
      totalTime += queries.reduce((t, q) => t + q.executionTime, 0);
      slowQueries += queries.reduce((s, q) => s + (q.slow ? 1 : 0), 0);
      totalResourceTime += queries.reduce((t, q) => t + q.executionTime, 0);
      chartData.labels.push(resource);
      chartData.data.push({ queries: queries.length, time: totalResourceTime });
    }

    emitNet(`oxmysql:openUi`, source, {
      resources: Object.keys(logStorage),
      totalQueries,
      slowQueries,
      totalTime,
      chartData,
    });
  },
  true
);

onNet(
  `oxmysql:fetchResource`,
  (data: {
    resource: string;
    pageIndex: number;
    search: string;
    sortBy?: { id: 'query' | 'executionTime'; desc: boolean }[];
  }) => {
    if (typeof data.resource !== 'string' || !IsPlayerAceAllowed(source as unknown as string, 'command.mysql')) return;

    if (data.search) data.search = data.search.toLowerCase();

    const resourceLog = data.search
      ? logStorage[data.resource].filter((q) => q.query.toLowerCase().includes(data.search))
      : logStorage[data.resource];

    if (!resourceLog) return;

    const sort = data.sortBy && data.sortBy.length > 0 ? data.sortBy[0] : false;
    const startRow = data.pageIndex * 10;
    const queries = sort
      ? sortQueries(resourceLog, sort).slice(startRow, startRow + 10)
      : resourceLog.slice(startRow, startRow + 10);
    const pageCount = Math.ceil(resourceLog.length / 10);

    let resourceTime = 0;
    let resourceSlowQueries = 0;

    for (const q of resourceLog) {
      resourceTime += q.executionTime;
      if (q.slow) resourceSlowQueries++;
    }

    emitNet(`oxmysql:loadResource`, source, {
      queries,
      pageCount,
      resourceQueriesCount: resourceLog.length,
      resourceSlowQueries,
      resourceTime,
    });
  }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setCallback(
  parameters?: CFXParameters | CFXCallback,
  cb?: CFXCallback
): [CFXParameters, CFXCallback | undefined] {
  if (cb && typeof cb === 'function') return [parameters as CFXParameters, cb];
  if (parameters && typeof parameters === 'function') return [[], parameters as CFXCallback];
  return [parameters as CFXParameters, undefined];
}

function invokeCb(
  response: { result: any } | { error: string },
  cb: CFXCallback | undefined,
  isPromise: boolean | undefined,
  invokingResource: string
) {
  if ('error' in response) {
    if (cb && isPromise) {
      try {
        cb(null, response.error);
      } catch {}
    } else {
      console.error(response.error);
    }
    return;
  }

  if (!cb) return;

  try {
    cb(response.result);
  } catch (err) {
    console.error('Error in callback for resource', invokingResource, ':', err);

    if (typeof err === 'string') {
      if (err.includes('SCRIPT ERROR:')) return console.log(err);
      console.log(`^1SCRIPT ERROR in invoking resource ${invokingResource}: ${err}^0`);
    }
  }
}

// ─── MySQL export object ──────────────────────────────────────────────────────

const MySQL = {} as Record<string, Function>;

MySQL.isReady = () => isReady;

MySQL.awaitConnection = async () => {
  while (!isReady) await new Promise((r) => setTimeout(r, 0));
  return true;
};

MySQL.query = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('query', { type: null, invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.single = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('query', { type: 'single', invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.scalar = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('query', { type: 'scalar', invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.update = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('query', { type: 'update', invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.insert = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('query', { type: 'insert', invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.transaction = (
  queries: TransactionQuery,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('transaction', { invokingResource, queries, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

let startTransactionWarned = false;
MySQL.startTransaction = async (
  transactions: (queryFn: (sql: string, values: CFXParameters) => Promise<any>) => Promise<boolean>,
  invokingResource = GetInvokingResource()
) => {
  if (!startTransactionWarned) {
    startTransactionWarned = true;
    console.warn(`MySQL.startTransaction is "experimental" and may receive breaking changes.`);
  }

  const beginResult = await sendToWorker<{ connectionId: number } | { error: string }>('beginTransaction', {
    invokingResource,
  });

  if ('error' in beginResult) {
    console.error(beginResult.error);
    return false;
  }

  const { connectionId } = beginResult;
  let commit = false;
  let closed = false;

  const timeout = setTimeout(() => {
    closed = true;
    emitToWorker('endTransaction', { connectionId, commit: false });
  }, 30000);

  try {
    const queryFn = async (sql: string, values: CFXParameters) => {
      if (closed) throw new Error('Transaction has timed out after 30 seconds.');

      const result = await sendToWorker<{ result: any } | { error: string }>('transactionQuery', {
        invokingResource,
        connectionId,
        sql,
        values,
      });

      if ('error' in result) throw new Error(result.error);
      return result.result;
    };

    const outcome = await transactions(queryFn);
    commit = outcome !== false;
  } catch (err: any) {
    commit = false;
    console.error(`${invokingResource} startTransaction failed: ${err.message}`);
  } finally {
    if (!closed) {
      clearTimeout(timeout);
      emitToWorker('endTransaction', { connectionId, commit });
    }
  }

  return commit;
};

MySQL.prepare = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('execute', { invokingResource, query, parameters: params, unpack: true }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.rawExecute = (
  query: string,
  parameters: CFXParameters,
  cb: CFXCallback,
  invokingResource = GetInvokingResource(),
  isPromise?: boolean
) => {
  const [params, callback] = setCallback(parameters, cb);
  sendToWorker('execute', { invokingResource, query, parameters: params }).then((response) =>
    invokeCb(response, callback, isPromise, invokingResource)
  );
};

MySQL.store = (query: string, cb: Function) => {
  cb(query);
};

MySQL.execute = MySQL.query;
MySQL.fetch = MySQL.query;

// ─── Export registration ──────────────────────────────────────────────────────

function provide(resource: string, method: string, cb: Function) {
  on(`__cfx_export_${resource}_${method}`, (setCb: Function) => setCb(cb));
}

for (const key in MySQL) {
  const exp = MySQL[key];

  const async_exp = (query: string, parameters: CFXParameters, invokingResource = GetInvokingResource()) => {
    return new Promise((resolve, reject) => {
      MySQL[key](
        query,
        parameters,
        (result: unknown, err: string) => {
          if (err) return reject(new Error(err));
          resolve(result);
        },
        invokingResource,
        true
      );
    });
  };

  global.exports(key, exp);
  global.exports(`${key}_async`, async_exp);
  global.exports(`${key}Sync`, async_exp);

  let alias = (ghmatti as any)[key];
  if (alias) {
    provide('ghmattimysql', alias, exp);
    provide('ghmattimysql', `${alias}Sync`, async_exp);
  }

  alias = (mysqlAsync as any)[key];
  if (alias) {
    provide('mysql-async', alias, exp);
  }
}
