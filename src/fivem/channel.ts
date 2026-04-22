// WorkerChannel — the parent-side pending-request book for a single worker.
//
// Extracted from the top of src/fivem/index.ts so it can be unit-tested
// against a fake worker (any EventEmitter-like object with `postMessage` and
// `on`/`off`) without pulling in the FiveM globals. Behaviour that used to
// live inline is preserved byte-for-byte here; the new pieces this module
// adds are:
//   - `exit` handler that rejects every still-pending request with an
//     error-shaped payload so callers no longer hang forever when the
//     worker process dies.
//   - Optional per-request timeout. When `timeoutMs > 0` is passed (or a
//     default is configured), a pending request that has not received its
//     response within the window resolves with an error payload. Opt-in so
//     the matrix-pinned behaviour (queries stay pending until answered) is
//     preserved when the feature is off.
//
// The channel never rejects a promise — callers consume
// `{ result } | { error: string }` shapes uniformly, matching the existing
// worker contract. This keeps `invokeCb` and all the `'error' in result`
// checks unchanged.

export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message' | 'error' | 'exit', listener: (payload: any) => void): unknown;
  off?(event: 'message' | 'error' | 'exit', listener: (payload: any) => void): unknown;
}

export interface ChannelOptions {
  /** When > 0, every request started via `send` that does not complete in
   *  this many milliseconds resolves with an `{ error }` payload. Per-call
   *  timeouts passed to `send()` override this default. */
  defaultTimeoutMs?: number;
  /** When set, this is invoked every time a pending request is settled by
   *  the exit handler or by a timeout. Useful for surfacing telemetry via
   *  the FiveM `oxmysql:error` channel. */
  onSynthesizedError?: (err: { action: string; reason: string }) => void;
}

type PendingEntry = {
  action: string;
  settle: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export class WorkerChannel {
  private worker: WorkerLike;
  private pending = new Map<number, PendingEntry>();
  private nextId = 0;
  private exited = false;
  private options: Required<Pick<ChannelOptions, 'defaultTimeoutMs'>> &
    Pick<ChannelOptions, 'onSynthesizedError'>;

  constructor(worker: WorkerLike, options: ChannelOptions = {}) {
    this.worker = worker;
    this.options = {
      defaultTimeoutMs: options.defaultTimeoutMs ?? 0,
      onSynthesizedError: options.onSynthesizedError,
    };

    worker.on('exit', (code: number) => this.handleExit(code));
  }

  /** Fire-and-forget message. Matches the pre-Phase-5 `emitToWorker`. */
  emit(action: string, data?: unknown) {
    if (this.exited) return;
    this.worker.postMessage({ action, data });
  }

  /** Request-response message. Returns a promise that always resolves; on
   *  worker exit, synthesized timeout, etc. it resolves with an
   *  `{ error: string }` payload matching the worker-side error shape. */
  send<T = unknown>(action: string, data: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve) => {
      if (this.exited) {
        resolve({ error: `oxmysql worker has exited; ${action} was not dispatched` } as T);
        return;
      }

      const id = this.nextId++;
      const effectiveTimeout = timeoutMs ?? this.options.defaultTimeoutMs;

      const entry: PendingEntry = {
        action,
        settle: resolve as (v: unknown) => void,
        timer: null,
      };

      if (effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          const live = this.pending.get(id);
          if (!live) return;
          this.pending.delete(id);
          const reason = `oxmysql request '${action}' timed out after ${effectiveTimeout}ms`;
          this.options.onSynthesizedError?.({ action, reason });
          live.settle({ error: reason });
        }, effectiveTimeout);
      }

      this.pending.set(id, entry);
      this.worker.postMessage({ action, id, data });
    });
  }

  /** Called from the main worker.on('message') handler when a response
   *  arrives. Returns true if the response matched a pending entry. */
  deliver(id: number, payload: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.settle(payload);
    return true;
  }

  /** Diagnostic — primarily for tests. */
  pendingCount(): number {
    return this.pending.size;
  }

  hasExited(): boolean {
    return this.exited;
  }

  private handleExit(code: number) {
    this.exited = true;
    const reason = `oxmysql worker exited (code ${code})`;
    const entries = [...this.pending.entries()];
    this.pending.clear();

    for (const [, entry] of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      this.options.onSynthesizedError?.({ action: entry.action, reason });
      entry.settle({ error: reason });
    }
  }
}
