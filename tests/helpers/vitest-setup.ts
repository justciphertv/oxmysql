// Vitest global-scope setup: wires up the `worker_threads` mock before any
// test file is imported. Declared via `setupFiles` in vitest.config.ts.

import { vi } from 'vitest';
import { parentPortStub } from './parent-port-mock';

vi.mock('worker_threads', async () => {
  const actual = await vi.importActual<typeof import('worker_threads')>('worker_threads');
  return {
    ...actual,
    parentPort: parentPortStub,
  };
});
