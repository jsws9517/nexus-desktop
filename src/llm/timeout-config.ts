/**
 * Runtime-resolvable timeout settings with three layers of precedence:
 *   1. Environment variable (operator override, highest priority)
 *   2. Config file value (set via `nexus config timeout ...`, persisted)
 *   3. Built-in default
 *
 * The CLI/Agent populates the config layer at startup (see applyConfigTimeouts),
 * so the LLM providers and the turn watchdog can read a single source of truth
 * without importing ConfigManager (avoids circular deps).
 */

const ENV = {
  chunkIdle: 'NEXUS_CHUNK_IDLE_TIMEOUT_MS',
  watchdogRemote: 'NEXUS_WATCHDOG_REMOTE_MS',
  heartbeat: 'NEXUS_HEARTBEAT_INTERVAL_MS',
};

const DEFAULTS = {
  chunkIdleMs: 60_000,
  watchdogRemoteMs: 90_000,
  heartbeatMs: 30_000,
};

/** Config-file layer (set from ~/.nexus/config.json at startup). */
let configLayer: {
  chunkIdleMs?: number;
  watchdogRemoteMs?: number;
  heartbeatMs?: number;
} = {};

export function applyConfigTimeouts(cfg: {
  chunkIdleMs?: number;
  watchdogRemoteMs?: number;
  heartbeatMs?: number;
}): void {
  configLayer = { ...cfg };
}

function envMs(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getChunkIdleTimeoutMs(): number {
  return envMs(ENV.chunkIdle) ?? configLayer.chunkIdleMs ?? DEFAULTS.chunkIdleMs;
}

/** Turn deadline for remote/ACP channels (the only remaining watchdog after
 *  the agent.chat() turn watchdog was removed as redundant with the ACP
 *  server's handleSessionPrompt deadline). */
export function getTurnDeadlineMs(): number {
  return envMs(ENV.watchdogRemote) ?? configLayer.watchdogRemoteMs ?? DEFAULTS.watchdogRemoteMs;
}

/** Heartbeat interval (ms) — periodic ping sent during ACP turns so
 *  cc-connect knows the agent is alive during long-running tool calls
 *  or slow model responses. */
export function getHeartbeatIntervalMs(): number {
  return envMs(ENV.heartbeat) ?? configLayer.heartbeatMs ?? DEFAULTS.heartbeatMs;
}
