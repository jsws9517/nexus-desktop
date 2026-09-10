/**
 * Re-export facade (P1 module standardization).
 *
 * The AgentService implementation + shared bridge types now live in
 * src/agent/ (service.ts, types.ts, topic.ts, config-read.ts). This file stays
 * as a thin re-export so existing importers (agent-worker.ts, main/index.ts,
 * worker-host.ts, session-workers.ts, scripts/test-regenerate-guards.mjs) are
 * untouched and the compiled dist/agent-service.js path is preserved.
 */
export * from './agent/index.js';