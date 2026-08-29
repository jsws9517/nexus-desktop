/**
 * Constants shared across the main process, the agent worker and the renderer.
 *
 * Single source of truth for values that were previously duplicated (and drifted)
 * in main/index.ts, agent-service.ts, agent-worker.ts and renderer.ts. Pure
 * data/functions only — importable from both Node (main/worker) and the browser
 * (renderer, which is bundled as plain ESM with no Node APIs).
 */

/** Mask shown for any non-empty API key. */
export const KEY_MASK = '••••••••••••';

/** Worker blocks (sub-agent dispatch) start with these markers. They are skipped
 *  from display AND from regenerate()'s user index, so the desktop's numbering
 *  matches the core's. Mirrors core resumeMessages()/sub-agent worker prompts. */
export const WORKER_MARKERS = ['[Project Directory]', '[Original Request]', '[Prior Task Results]', '[Role:'];

export function isWorkerPrompt(m: { role?: string; content?: unknown }): boolean {
  if (m.role !== 'user') return false;
  const head = String(m.content ?? '').slice(0, 200);
  return WORKER_MARKERS.some((mk) => head.includes(mk));
}

export function isWorkerBlockText(text: string): boolean {
  const head = String(text ?? '').slice(0, 200);
  return WORKER_MARKERS.some((mk) => head.includes(mk));
}

/** Methods that are safe before MCP/skills finish connecting (phase-1 read-only). */
export const EARLY_METHODS = new Set<string>([
  'listSessions', 'getMessages', 'getConfig', 'getProviders', 'getStatus',
  'getPermissions', 'getSpeechVisionConfig', 'getSessionStats',
  'getMcpServers', 'getMcpStatus', 'startSession',
  'getSlashLog', 'getSlashLogPath',
  'setCwd', 'getDefaultProjectDir', 'getSessionMetadata',
]);
