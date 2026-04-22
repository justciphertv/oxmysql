import type { FieldInfo, TypeCastNextFunction, TypeCastFunction, TypeCastResult } from 'mariadb';

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
    case 'BLOB':
      if ((column as any).collation?.index === BINARY_COLLATION_INDEX) {
        const value = column.buffer();
        if (value === null) return null;
        // number[] spread for Lua compatibility; single cast contained here
        return [...value] as unknown as TypeCastResult;
      }
      return column.string();
    // Explicit JSON column type. MySQL 8 reports JSON columns with
    // FieldType.JSON (245) and the connector's decoder for that field
    // type ignores `autoJsonMap` — only `jsonStrings: true` keeps it
    // unparsed. Adding an explicit case here makes the string-contract
    // hold unconditionally regardless of the connector's future default
    // behaviour or server-vendor differences (MariaDB usually reports
    // JSON columns as BLOB/LONGTEXT which the case above handles).
    case 'JSON': {
      const value = column.string();
      return value === null ? null : value;
    }
    default:
      return next();
  }
};
