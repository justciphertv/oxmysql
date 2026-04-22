import type { PoolConnection } from 'mariadb';
import { scheduleTick } from '../utils/events';
import { sleep } from '../utils/sleep';
import { pool } from './pool';
import type { CFXParameters } from '../../types';

(Symbol as any).dispose ??= Symbol('Symbol.dispose');

export const activeConnections: Record<number, MySql> = {};

export class MySql {
  id: number;
  connection: PoolConnection;
  transaction?: boolean;
  failed?: boolean;

  /** Set by `endTransaction` when it begins tearing a transaction down.
   *  Once true, `runTransactionQuery` callers refuse to start new work on
   *  this connection even if the map still lists it. This closes audit
   *  item M1: the parent-side 30s timeout races its own in-flight
   *  transactionQuery messages, and without this flag the worker would
   *  begin a fresh query on the connection mid-rollback. */
  closed = false;

  /** Count of connector-level operations currently executing on this
   *  MySql wrapper. `waitUntilIdle()` resolves once this drops to zero so
   *  `endTransaction` can safely commit/rollback without overlapping a
   *  still-running query. */
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(connection: PoolConnection) {
    if (!connection.threadId) {
      throw new Error('Connection must have a threadId');
    }

    this.id = connection.threadId;
    this.connection = connection;
    activeConnections[this.id] = this;
  }

  async query(query: string, values: CFXParameters = []) {
    scheduleTick();
    return await this.track(() => this.connection.query(query, values));
  }

  async execute(query: string, values: CFXParameters = []) {
    scheduleTick();
    // Use query() (text protocol) to avoid ER_UNSUPPORTED_PS on SELECT/LIMIT queries
    return await this.track(() => this.connection.query(query, values));
  }

  async batch(query: string, values: CFXParameters[]) {
    scheduleTick();
    return await this.track(() => this.connection.batch(query, values));
  }

  private async track<T>(op: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await op();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.idleWaiters.length > 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  /** Resolves once no connector-level operation is in flight on this
   *  wrapper. `endTransaction` awaits this before committing / rolling
   *  back so it cannot overlap an existing `runTransactionQuery`. */
  async waitUntilIdle(): Promise<void> {
    if (this.inFlight === 0) return;
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  beginTransaction() {
    this.transaction = true;
    return this.connection.beginTransaction();
  }

  rollback() {
    delete this.transaction;
    return this.connection.rollback();
  }

  commit() {
    delete this.transaction;
    return this.connection.commit();
  }

  [Symbol.dispose]() {
    if (this.transaction && !this.failed) this.commit();

    delete activeConnections[this.id];
    // Destroy tainted connections instead of returning them to the pool.
    // This prevents a dead/corrupted connection from being reused by subsequent queries.
    if (this.failed) {
      this.connection.destroy();
    } else {
      this.connection.release();
    }
  }
}

export async function getConnection(connectionId?: number) {
  while (!pool) await sleep(0);

  return connectionId ? activeConnections[connectionId] : new MySql(await pool!.getConnection());
}
