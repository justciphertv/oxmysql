import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/vitest-setup.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Run tests serially on a single worker so the MariaDB fixture is not
    // stressed by parallel connection storms. Individual tests can still
    // issue concurrent queries inside a test.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
