/**
 * L5: worker-scoped cache for the side-chat AgentService.
 *
 * The old sideChat handler paid a `new AgentService() + init()` — a FULL core
 * re-init (agent construction, MCP hub connect, skills load, ACP start) — on
 * every side-chat message. That per-request stall is the "sudden interrupt"
 * behind side chat: each message re-booted the whole engine, and the
 * per-request service also only ever saw the LAST user message, so side chat
 * had no multi-turn memory.
 *
 * Now: one side service is created lazily (single-flight), reused for the
 * worker's lifetime, and a failed init is NOT cached so the next request
 * retries. Isolation semantics are preserved — the side service is a SEPARATE
 * AgentService with its own context/session, so it never touches the owning
 * tab's session store or busy state and side chat stays usable while the real
 * session is mid-turn.
 */
import type { AgentService } from '../agent-service.js';

/**
 * The renderer replays the FULL side transcript on every request. The model
 * sees everything up to (excluding) the last user message as history —
 * `chat()` appends the last user message itself. This is what gives side chat
 * multi-turn memory. Loose: no user message at all (or only one) → no history.
 */
export function historyBeforeLastUser(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
}

export class SideServiceCache {
  private service: AgentService | null = null;
  private pending: Promise<AgentService> | null = null;

  constructor(
    private readonly factory: () => AgentService,
    private readonly init: (service: AgentService) => Promise<void>,
  ) {}

  /** The shared side service. The first call pays init(); later calls are free. */
  get(): Promise<AgentService> {
    if (this.service) return Promise.resolve(this.service);
    if (!this.pending) {
      this.pending = (async () => {
        const s = this.factory();
        await this.init(s);
        this.service = s;
        this.pending = null;
        return s;
      })().catch((err) => {
        // A failed init must not poison the cache — the next request retries.
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }
}
