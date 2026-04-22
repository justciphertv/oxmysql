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

export function initNamedPlaceholders(optionValue: unknown) {
  // Only disable if the user explicitly wrote namedPlaceholders=false (string) in their
  // connection string. Boolean false is our own internal pool override and should not
  // disable named-placeholder conversion.
  convertNamedPlaceholders = optionValue === 'false' ? null : require('named-placeholders')();
}
