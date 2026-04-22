// Phase 5.1 regression — parent-side WorkerChannel. Exercises the pending
// request book, the exit handler that drains in-flight promises, and the
// opt-in per-request timeout. Uses a fake worker (EventEmitter-like) to
// avoid pulling in the FiveM globals that src/fivem/index.ts requires.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { WorkerChannel, type WorkerLike } from '../src/fivem/channel';

type FakeMessage = { action: string; id?: number; data?: unknown };

class FakeWorker extends EventEmitter implements WorkerLike {
  public sent: FakeMessage[] = [];

  postMessage(message: FakeMessage) {
    this.sent.push(message);
  }

  /** Simulate a reply arriving from the worker side. */
  respond(id: number, payload: unknown) {
    this.emit('message', { action: 'response', id, data: payload });
  }

  exit(code = 1) {
    this.emit('exit', code);
  }
}

describe('cluster 15 — WorkerChannel', () => {
  it('forwards send() as a postMessage and resolves on a matching response', async () => {
    const worker = new FakeWorker();
    const channel = new WorkerChannel(worker);

    const promise = channel.send<{ result: number }>('query', { sql: 'SELECT 1' });

    expect(worker.sent).toHaveLength(1);
    const { id } = worker.sent[0] as FakeMessage;
    expect(typeof id).toBe('number');

    // parent-side message handler would normally call channel.deliver(id, ...)
    channel.deliver(id!, { result: 42 });

    await expect(promise).resolves.toEqual({ result: 42 });
    expect(channel.pendingCount()).toBe(0);
  });

  it('emit() sends a fire-and-forget message with no id', () => {
    const worker = new FakeWorker();
    const channel = new WorkerChannel(worker);

    channel.emit('endTransaction', { connectionId: 7, commit: true });

    expect(worker.sent).toEqual([
      { action: 'endTransaction', data: { connectionId: 7, commit: true } },
    ]);
    // no pending entries because emit is one-way
    expect(channel.pendingCount()).toBe(0);
  });

  it('worker exit drains every pending request with a synthesized error', async () => {
    const worker = new FakeWorker();
    const onError = vi.fn();
    const channel = new WorkerChannel(worker, { onSynthesizedError: onError });

    const p1 = channel.send('query', { sql: 'A' });
    const p2 = channel.send('execute', { sql: 'B' });
    const p3 = channel.send('transaction', {});
    expect(channel.pendingCount()).toBe(3);

    worker.exit(137);

    const results = await Promise.all([p1, p2, p3]);
    for (const r of results) {
      expect(r).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('worker exited (code 137)');
    }

    expect(channel.pendingCount()).toBe(0);
    expect(channel.hasExited()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(3);
    // first call's action should match the first pending entry
    expect(onError.mock.calls[0][0]).toMatchObject({ action: 'query' });
  });

  it('after exit, new send() calls resolve with an error without enqueueing', async () => {
    const worker = new FakeWorker();
    const channel = new WorkerChannel(worker);
    worker.exit(0);

    const lateSize = worker.sent.length;
    const r = await channel.send('query', {});

    expect(worker.sent).toHaveLength(lateSize); // no postMessage attempted
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/has exited/);
  });

  it('per-call timeout synthesizes an error after the window', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onError = vi.fn();
      const channel = new WorkerChannel(worker, { onSynthesizedError: onError });

      const promise = channel.send('query', { sql: 'slow' }, 2500);
      expect(channel.pendingCount()).toBe(1);

      // Nothing has fired yet.
      await vi.advanceTimersByTimeAsync(2499);
      expect(channel.pendingCount()).toBe(1);

      // One more ms past the threshold.
      await vi.advanceTimersByTimeAsync(1);

      const r = await promise;
      expect(r).toHaveProperty('error');
      expect((r as { error: string }).error).toContain("timed out after 2500ms");
      expect(channel.pendingCount()).toBe(0);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'query' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('default timeout applies when no per-call override is given', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const channel = new WorkerChannel(worker, { defaultTimeoutMs: 1000 });

      const promise = channel.send('query', {});
      await vi.advanceTimersByTimeAsync(1000);
      const r = await promise;
      expect((r as { error: string }).error).toMatch(/timed out after 1000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an on-time response cancels the pending timer (no synthesized error)', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const onError = vi.fn();
      const channel = new WorkerChannel(worker, { onSynthesizedError: onError });

      const promise = channel.send('query', {}, 5000);
      const { id } = worker.sent[0] as FakeMessage;
      channel.deliver(id!, { result: 'ok' });

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).resolves.toEqual({ result: 'ok' });
      expect(onError).not.toHaveBeenCalled();
      expect(channel.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale response arriving after timeout is a no-op', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const channel = new WorkerChannel(worker, { defaultTimeoutMs: 500 });

      const promise = channel.send('query', {});
      const { id } = worker.sent[0] as FakeMessage;

      await vi.advanceTimersByTimeAsync(500);
      const r = await promise;
      expect((r as { error: string }).error).toMatch(/timed out/);

      // Late response should not throw or affect pendingCount.
      expect(channel.deliver(id!, { result: 'late' })).toBe(false);
      expect(channel.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
