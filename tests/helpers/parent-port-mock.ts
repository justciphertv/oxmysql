// Stub implementation of `worker_threads.parentPort` used by tests that import
// worker modules directly instead of spawning a Worker. Every message the
// worker would have sent to the FiveM parent is captured here so tests can
// assert on the exact action payloads (print, triggerEvent, logQuery,
// callLogger, response, etc.).
//
// Install this via `vi.mock('worker_threads', ...)` inside test files that
// import worker internals. See tests/helpers/vitest-setup.ts.

export type CapturedMessage = { action: string; id?: number; data?: any };

export class CapturedMessages {
  all: CapturedMessage[] = [];

  push(msg: CapturedMessage) {
    this.all.push(msg);
  }

  reset() {
    this.all.length = 0;
  }

  byAction(action: string) {
    return this.all.filter((m) => m.action === action);
  }

  find(predicate: (m: CapturedMessage) => boolean) {
    return this.all.find(predicate);
  }
}

export const captured = new CapturedMessages();

export const parentPortStub = {
  postMessage(msg: CapturedMessage) {
    captured.push(msg);
  },
  on() {},
  off() {},
  removeListener() {},
};
