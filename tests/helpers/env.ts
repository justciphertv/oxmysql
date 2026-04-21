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
    connectionLimit: 4,
    connectTimeout: 10_000,
    ...overrides,
  };
}
