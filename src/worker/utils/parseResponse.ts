import type { QueryResponse, QueryType } from '../../types';
import type { UpsertResult } from 'mariadb';
import { bigintToSafeNumberOrString } from './typeCast';

export const parseResponse = (type: QueryType, result: QueryResponse): unknown => {
  switch (type) {
    case 'insert': {
      const insertId = (result as UpsertResult)?.insertId;
      if (insertId == null) return null;
      // With `mysql_bigint_as_string` on the pool yields `insertId` as a
      // BigInt; convert to `number` when safely representable, fall
      // back to decimal string when not. Flag-off retains the
      // historical `Number(...)` cast — `insertId` is already a number
      // in that mode, and large values quietly truncate (pinned by
      // tests/05-numeric.test.ts).
      if (typeof insertId === 'bigint') return bigintToSafeNumberOrString(insertId);
      return Number(insertId);
    }

    case 'update': {
      const affectedRows = (result as UpsertResult)?.affectedRows;
      if (affectedRows == null) return null;
      // Defensive: the `affectedRows` counter is unlikely to exceed
      // Number.MAX_SAFE_INTEGER, but if the pool switches to BigInt mode
      // we still want the documented `number` return shape. Safe to
      // cast because an UPDATE touching > 2^53 rows is not a realistic
      // FiveM workload.
      return typeof affectedRows === 'bigint' ? Number(affectedRows) : Number(affectedRows);
    }

    case 'single':
      return (result as Record<string, unknown>[])?.[0] ?? null;

    case 'scalar': {
      const row = (result as Record<string, unknown>[])?.[0];
      return (row && Object.values(row)[0]) ?? null;
    }

    default:
      return result ?? null;
  }
};
