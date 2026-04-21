// Vitest globalSetup: runs ONCE before the test suite starts.
//
// Responsibilities:
//   1. Wait for the MariaDB container exposed in tests/compose.yml to be
//      ready for connections.
//   2. Reset the test database schema from tests/fixtures/schema.sql.
//
// It intentionally does NOT bring up or tear down Docker. The developer or
// CI step is expected to run `docker compose -f tests/compose.yml up -d`
// before `vitest` and tear down afterwards. Keeping compose orchestration
// outside this file means tests can also run against a pre-existing MariaDB
// (e.g. a dev workstation's own server) without Docker.

import { createConnection } from 'mariadb';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_ENV } from './env';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function waitForServer(timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const conn = await createConnection({
        host: TEST_ENV.host,
        port: TEST_ENV.port,
        user: TEST_ENV.user,
        password: TEST_ENV.password,
        connectTimeout: 2000,
      });
      await conn.end();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `Timed out waiting for MariaDB at ${TEST_ENV.host}:${TEST_ENV.port}. ` +
      `Last error: ${(lastErr as Error)?.message ?? String(lastErr)}. ` +
      `Did you run \`docker compose -f tests/compose.yml up -d\`?`,
  );
}

async function applySchema() {
  const conn = await createConnection({
    host: TEST_ENV.host,
    port: TEST_ENV.port,
    user: TEST_ENV.user,
    password: TEST_ENV.password,
    multipleStatements: true,
  });

  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_ENV.database}\``);
    await conn.query(`USE \`${TEST_ENV.database}\``);
    const schema = readFileSync(join(__dirname, '..', 'fixtures', 'schema.sql'), 'utf8');
    await conn.query(schema);
  } finally {
    await conn.end();
  }
}

export async function setup() {
  await waitForServer();
  await applySchema();
}

export async function teardown() {
  // No-op. Container lifecycle lives outside vitest.
}
