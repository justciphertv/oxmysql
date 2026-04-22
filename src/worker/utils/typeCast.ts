import type { FieldInfo, TypeCastNextFunction, TypeCastFunction, TypeCastResult } from 'mariadb';
import { parentPort } from 'worker_threads';

/**
 * MariaDB/MySQL reserve collation id 63 for the `binary` collation. The
 * connector itself uses the same signal (`col.collation.index === 63`) to
 * decide whether a BLOB/TEXT column carries binary bytes or textual data
 * (see node_modules/mariadb/lib/cmd/decoder/text-decoder.js). Use the same
 * check here — the column `flags & 0x80` ("BINARY" column flag) is set for
 * a wider set of columns, including JSON which is internally stored with
 * the `utf8mb4_bin` collation. Treating those as binary and returning a
 * number[] produced "got table" errors when the Lua side tried to
 * json.decode() what upstream oxmysql always delivered as a string.
 */
const BINARY_COLLATION_INDEX = 63;

// One-shot diagnostic: for the first N columns of each unique (type, columnType)
// combination, print the decision typeCast made plus the runtime type of the
// value it returns. Dedupes after the first hit so the server log is not
// flooded. Toggled on automatically when mysql_debug is truthy; also always
// on when OXMYSQL_DIAG=1 in the environment.
const seen = new Set<string>();
function diag(
  column: FieldInfo,
  branch: string,
  value: unknown,
  extra?: Record<string, unknown>,
) {
  const key = `${column.type}|${(column as any).columnType}|${branch}`;
  if (seen.has(key)) return;
  seen.add(key);

  const preview =
    typeof value === 'string'
      ? `string(${value.length}) ${JSON.stringify(value.slice(0, 60))}`
      : Array.isArray(value)
        ? `array(len=${value.length}) first=${JSON.stringify(value.slice(0, 4))}`
        : value === null
          ? 'null'
          : typeof value === 'object'
            ? `object keys=${Object.keys(value as object).slice(0, 6).join(',')}`
            : `${typeof value} ${JSON.stringify(value)}`;

  try {
    parentPort?.postMessage({
      action: 'print',
      data: [
        `^6[typeCast-diag]^0 name=${(column as any).name?.()} type=${column.type} ` +
          `columnType=${(column as any).columnType} colLen=${(column as any).columnLength} ` +
          `collation=${JSON.stringify((column as any).collation)} branch=${branch} ` +
          `returns=${preview}` +
          (extra ? ` ${JSON.stringify(extra)}` : ''),
      ],
    });
  } catch {
    /* parentPort not available in tests — fall through silently */
  }
}

const DIAG_ENABLED = () =>
  process.env.OXMYSQL_DIAG === '1' ||
  // Lazy so we pick up mysql_debug convar changes at runtime without
  // adding a circular import — we read from config module only when needed.
  (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mysql_debug } = require('../config');
      return !!mysql_debug;
    } catch {
      return false;
    }
  })();

/**
 * mariadb-compatible typecasting (mysql-async compatible).
 * Binary BLOBs are returned as number[] (spread from Buffer) for Lua serialization.
 */
export const typeCast: TypeCastFunction = (column: FieldInfo, next: TypeCastNextFunction): TypeCastResult => {
  switch (column.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE': {
      const value = column.string();
      return value ? new Date(value).getTime() : null;
    }
    case 'DATE': {
      const value = column.string();
      return value ? new Date(value + ' 00:00:00').getTime() : null;
    }
    case 'TINY':
      return column.columnLength === 1 ? column.string() === '1' : next();
    case 'BIT':
      return column.columnLength === 1 ? column.buffer()?.[0] === 1 : (column.buffer()?.[0] ?? null);
    case 'TINY_BLOB':
    case 'MEDIUM_BLOB':
    case 'LONG_BLOB':
    case 'BLOB': {
      const isBinary = (column as any).collation?.index === BINARY_COLLATION_INDEX;
      if (isBinary) {
        const buf = column.buffer();
        const arr = buf === null ? null : ([...buf] as unknown as TypeCastResult);
        if (DIAG_ENABLED()) diag(column, 'BLOB-binary', arr);
        return arr;
      }
      const str = column.string();
      if (DIAG_ENABLED()) diag(column, 'BLOB-text', str);
      return str;
    }
    // Explicit JSON column type. MySQL 8 reports JSON columns with
    // FieldType.JSON (245) and the connector's decoder for that field
    // type ignores `autoJsonMap` — only `jsonStrings: true` keeps it
    // unparsed. Adding an explicit case here makes the string-contract
    // hold unconditionally regardless of the connector's future default
    // behaviour or server-vendor differences (MariaDB usually reports
    // JSON columns as BLOB/LONGTEXT which the case above handles).
    case 'JSON': {
      const value = column.string();
      if (DIAG_ENABLED()) diag(column, 'JSON', value);
      return value === null ? null : value;
    }
    default: {
      const result = next();
      if (DIAG_ENABLED()) diag(column, 'default-next', result);
      return result;
    }
  }
};
