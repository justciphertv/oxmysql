import type { FieldInfo, TypeCastNextFunction, TypeCastFunction, TypeCastResult } from 'mariadb';
import { parentPort } from 'worker_threads';
import { mysql_bit_full_integer } from '../config';

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

/**
 * Decode a BIT(n>1) column buffer as a big-endian integer.
 *
 * Node's `Buffer.readUIntBE` only supports 1..6-byte reads (up to 48
 * bits), so for BIT(49..64) we fall back to a BigInt accumulator. The
 * result is returned as `number` when it fits in
 * `Number.MAX_SAFE_INTEGER` and as `bigint` otherwise. The common cases
 * (BIT(1..48)) always produce a `number`.
 */
function decodeBitFullInteger(buf: Buffer): number | bigint {
  const len = buf.length;
  if (len === 0) return 0;
  if (len <= 6) return buf.readUIntBE(0, len);

  let big = 0n;
  for (const byte of buf) {
    big = (big << 8n) | BigInt(byte);
  }
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

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
    case 'BIT': {
      const buf = column.buffer();

      // BIT(1) — boolean semantics. The flag-on path only differs for
      // NULL: historical defect H6b returned `false` for BIT(1) NULL
      // because `null?.[0] === 1` evaluates to false. When the flag is
      // on we correctly return null instead.
      if (column.columnLength === 1) {
        if (buf === null) return mysql_bit_full_integer ? null : false;
        return buf[0] === 1;
      }

      // BIT(n > 1).
      if (buf === null) return null;

      if (!mysql_bit_full_integer) {
        // 3.1.0 pinned defect H6: return only the first byte. Preserved
        // so a 3.1.0 -> 3.2.0 upgrade with the flag off is byte-for-byte
        // behaviourally identical.
        return buf[0] ?? null;
      }

      // Flag-on: decode the full big-endian integer. Prefer `number` when
      // the value is safely representable (<= Number.MAX_SAFE_INTEGER);
      // only return a bigint when the bit width forces it.
      return decodeBitFullInteger(buf);
    }
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
