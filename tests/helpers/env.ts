// Shared environment constants for tests. Values come from the MariaDB
// container defined in tests/compose.yml. Override via env vars to point at
// a different instance.

export const TEST_ENV = {
  host: process.env.MARIADB_HOST ?? '127.0.0.1',
  port: Number(process.env.MARIADB_PORT ?? 33060),
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'oxtest',
  database: process.env.MARIADB_DATABASE ?? 'oxmysql_test',
} as const;

export function buildPoolOptions(overrides: Record<string, unknown> = {}) {
  return {
    host: TEST_ENV.host,
    port: TEST_ENV.port,
    user: TEST_ENV.user,
    password: TEST_ENV.password,
    database: TEST_ENV.database,
    // Matches the mariadb connector's production default. The previous
    // fixture used `4`, which made Phase 1 pool-wait numbers look much
    // worse than any realistic deployment would see (see Phase 2
    // findings in docs/performance-tuning.md). The bench harness still
    // accepts `--connectionLimits=...` to override for contention
    // stress tests.
    connectionLimit: 10,
    connectTimeout: 10_000,
    ...overrides,
  };
}
