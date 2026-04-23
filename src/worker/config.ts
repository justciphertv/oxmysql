export let mysql_debug: boolean | string[] = false;
export let mysql_slow_query_warning = 200;
export let mysql_ui = false;
export let mysql_log_size = 100;
export let mysql_transaction_isolation_level = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED';
export let convertNamedPlaceholders:
  | null
  | ((query: string, parameters: Record<string, unknown>) => [string, unknown[]]) = null;

// When true, typeCast decodes BIT(n>1) as the full big-endian integer
// rather than only the first byte, and returns `null` for BIT(1) NULL
// rather than the historical `false`. Opt-in via the convar
// `mysql_bit_full_integer` (default false) so 3.1.0 deployments keep
// the pinned behaviour on upgrade. See compat-matrix §4.4.
export let mysql_bit_full_integer = false;

// When true, BIGINT columns and `insertId` values whose magnitude
// exceeds `Number.MAX_SAFE_INTEGER` (2^53 - 1) are returned as a
// decimal string instead of a precision-losing number. Values within
// the safe range continue to return as `number` for backwards
// compatibility. Opt-in via the convar `mysql_bigint_as_string`
// (default false, preserving the 3.1.0 / 3.2.0 pinned lossy behaviour).
// See compat-matrix §4.1 / §4.3.
//
// This flag affects the mariadb pool configuration (`bigIntAsNumber`,
// `insertIdAsNumber`) and therefore only takes effect when the worker
// rebuilds its pool — i.e. on resource (re)start. Changing it with
// `set mysql_bigint_as_string true` at runtime does NOT switch mode
// for an already-running pool; restart the resource.
export let mysql_bigint_as_string = false;

// When true, typeCast parses DATE columns as midnight UTC rather than
// midnight in the Node process's local timezone, making DATE arithmetic
// DST-immune and deployment-independent. Opt-in via
// `mysql_date_as_utc` (default false, preserving the historical local-
// timezone behaviour). See compat-matrix §5. Takes effect on next
// typeCast invocation — no pool rebuild needed.
export let mysql_date_as_utc = false;

// Cached OR of `process.env.OXMYSQL_DIAG === '1'` (evaluated at module
// load) and `!!mysql_debug` (recomputed in updateConfig). typeCast reads
// this on every column decode — having it as a precomputed boolean keeps
// the hot path cheap. Kept in sync with `mysql_debug` through
// updateConfig rather than at first-initialize only.
const DIAG_ENV = process.env.OXMYSQL_DIAG === '1';
export let diag_enabled = DIAG_ENV;

export function updateConfig(config: {
  mysql_debug: boolean | string[];
  mysql_slow_query_warning: number;
  mysql_ui: boolean;
  mysql_log_size: number;
}) {
  mysql_debug = config.mysql_debug;
  mysql_slow_query_warning = config.mysql_slow_query_warning;
  mysql_ui = config.mysql_ui;
  mysql_log_size = config.mysql_log_size;
  // Recompute the cached diag flag whenever config changes; OXMYSQL_DIAG
  // is a static env var so we fold it into the boolean. typeCast reads
  // the resulting live-binding boolean directly without a per-call
  // recomputation.
  diag_enabled = DIAG_ENV || Boolean(config.mysql_debug);
}

export function setIsolationLevel(level: string) {
  mysql_transaction_isolation_level = level;
}

export function setBitFullInteger(enabled: boolean) {
  mysql_bit_full_integer = Boolean(enabled);
}

export function setBigintAsString(enabled: boolean) {
  mysql_bigint_as_string = Boolean(enabled);
}

export function setDateAsUtc(enabled: boolean) {
  mysql_date_as_utc = Boolean(enabled);
}

export interface NamedPlaceholdersCheck {
  /** True when the patched behaviour is confirmed active, or when named-
   *  placeholder support has been explicitly disabled by the user. */
  patched: boolean;
  /** Populated only when `patched === false`. A single-line description
   *  of what the sanity check actually observed, intended for operator
   *  diagnostics. */
  diagnostic?: string;
}

export function initNamedPlaceholders(optionValue: unknown): NamedPlaceholdersCheck {
  // Only disable if the user explicitly wrote namedPlaceholders=false (string) in their
  // connection string. Boolean false is our own internal pool override and should not
  // disable named-placeholder conversion.
  convertNamedPlaceholders = optionValue === 'false' ? null : require('named-placeholders')();

  if (!convertNamedPlaceholders) return { patched: true };
  return checkNamedPlaceholdersPatch();
}

/**
 * The `named-placeholders` module we depend on is pinned at 1.1.3 and
 * carries a local patch (`patches/named-placeholders+1.1.3.patch`) that:
 *   - accepts `@name` in addition to `:name`
 *   - strips a leading `@` / `:` from parameter object keys
 *   - substitutes missing keys with `null` instead of `undefined`
 * If the patch is not applied (patch-package silently no-ops on version
 * mismatch, broken CI, etc.) named-placeholder queries silently produce
 * wrong results — the worst possible failure mode for a data store.
 *
 * Sanity check: convert `SELECT @id` with an `@`-prefixed key and verify
 * the output matches the patched contract. Returns a result shape; the
 * worker acts on it (fatal exit + event + loud console diagnostic).
 */
function checkNamedPlaceholdersPatch(): NamedPlaceholdersCheck {
  let converted: [string, unknown[]];
  try {
    converted = convertNamedPlaceholders!('SELECT @id', { '@id': 42 });
  } catch (err) {
    return {
      patched: false,
      diagnostic: `conversion threw: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  const [sql, params] = converted;
  const ok = typeof sql === 'string' && sql.includes('?') && params?.[0] === 42;
  if (!ok) {
    return {
      patched: false,
      diagnostic:
        `'SELECT @id' with {'@id':42} produced sql=${JSON.stringify(sql)} params=${JSON.stringify(params)}; ` +
        `expected a '?'-bearing sql and params[0] === 42`,
    };
  }
  return { patched: true };
}
