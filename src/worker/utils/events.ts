import { parentPort } from 'worker_threads';
import * as perf from './perf';

// These helpers are called from the worker's hot paths and must tolerate
// the edge case where `parentPort` is null — that happens when the worker
// modules are imported outside a Worker context (benchmark harness, CLI
// tooling, unit tests that stub parentPort). Without the guards below,
// `parentPort!.postMessage` throws TypeError and kills whatever is
// driving the import. Tests installed a vi.mock of the module; this guard
// is a cheaper equivalent for everything else.

export function print(...args: any[]) {
  parentPort?.postMessage({ action: 'print', data: args });
}

export function scheduleTick() {
  parentPort?.postMessage({ action: 'scheduleTick' });
}

export function triggerFivemEvent(event: string, payload: any) {
  parentPort?.postMessage({ action: 'triggerEvent', data: { event, payload } });
}

export function sendLogQuery(
  invokingResource: string,
  query: string,
  executionTime: number,
  parameters: any[] | undefined,
  slow: boolean
) {
  parentPort?.postMessage({ action: 'logQuery', data: { invokingResource, query, executionTime, parameters, slow } });
}

export function callLogger(level: string, resource: string, message: string, metadata?: any) {
  parentPort?.postMessage({ action: 'callLogger', data: { level, resource, message, metadata } });
}

export function sendResponse(id: number, data: any) {
  // Instrumentation: isolate the cost of the `postMessage` call itself so
  // Phase 3 channel analysis can distinguish structured-clone overhead
  // from handler work. Zero-cost when OXMYSQL_PERF_TRACE is unset.
  if (!perf.enabled()) {
    parentPort?.postMessage({ action: 'response', id, data });
    return;
  }
  const start = perf.now();
  parentPort?.postMessage({ action: 'response', id, data });
  perf.mark('channel:worker.postResponse', start);
}
