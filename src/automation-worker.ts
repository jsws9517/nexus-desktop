// T6 automation worker — headless agent execution for scheduled runs.
//
// This is a thin WorkerHost entry that the AutomationRunner spawns per-run.
// It runs in its own process (dev: child node; packaged: utilityProcess) and
// is NOT registered in SessionWorkers, so it never appears in the tab table,
// never counts toward getMaxTabs, and never affects the resource monitor.
//
// Protocol: stdio JSON-RPC (dev) or parentPort JSON (packaged), identical to
// agent-worker.ts. Methods:
//   earlyInit({ cwd })   — construct the Agent (fast path)
//   init({ cwd })        — full init (MCP/skills)
//   chat({ input })      — run one agent turn (the automation prompt)
//   startSession()       — create a new session id
//   setAutomationProfile({ profile }) — pin office tools for the run's rounds
//   getStatus()          — provider/model/busy
//   shutdown             — flush + exit
//
// The automation profile is enforced in-process by the desktop's AgentService
// via the `setAutomationProfile` RPC: while the profile is active, every
// round's tool selection pins the deterministic office tool families
// (AUTOMATION_OFFICE_PINS in src/tools/tool-relevance.ts) so a headless run
// never loses the office read/write tools its one-shot prompt depends on.
// The runner (src/main/automation-runner.ts) sends it right after
// startSession, with the automation's stored `profile` value.
// (A full per-profile tool ALLOWLIST — e.g. hard-denying exec_command in
// unattended runs — is the planned follow-up: the core's
// buildAutomationToolWhitelist (nexus-coder/src/automation/profile.ts) is
// ready for it. This wiring lands the non-breaking half: office tools stay
// reachable.)

import './bootstrap/register.js';
import readline from 'node:readline';
import { AgentService } from './agent-service.js';
import type { AgentEvent } from './agent-service.js';
import { logger } from './shared/logger.js';

type WorkerRequest =
  | { id: number; method: 'earlyInit'; params?: { cwd?: string } }
  | { id: number; method: 'init'; params?: { cwd?: string; deferMcp?: boolean } }
  | { id: number; method: 'initAcp' }
  | { id: number; method: 'chat'; params: { input: string } }
  | { id: number; method: 'startSession'; params?: { name?: string; sessionId?: string } }
  | { id: number; method: 'setAutomationProfile'; params?: { profile?: string } }
  | { id: number; method: 'getStatus' }
  | { id: number; method: 'shutdown' };

const useParentPort = !!(process as unknown as { parentPort?: { postMessage: (m: unknown) => void } })
  .parentPort;

function send(msg: unknown): void {
  if (useParentPort) {
    (process as unknown as { parentPort: { postMessage: (m: unknown) => void } }).parentPort.postMessage(msg);
  } else {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

function respond(id: number, data?: unknown): void {
  send({ type: 'result', id, ok: true, data });
}

function respondError(id: number, error: unknown): void {
  send({
    type: 'result',
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
  });
}

const service = new AgentService();
service.onEvent = (event: AgentEvent) => send({ type: 'event', event });
service.onLog = (level, message) => send({ type: 'log', level, message });

// Worker -> main request channel (shared MCP hub proxy — same as agent-worker).
type McpOp = 'getTools' | 'callTool' | 'status' | 'servers' | 'setServer' | 'setEnabled';
let mcpNextId = 1e9;
const mcpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function sendMcp(op: McpOp, params?: Record<string, unknown>): Promise<unknown> {
  const id = mcpNextId++;
  send({ type: 'mcpRequest', id, op, data: params ?? {} });
  return new Promise((resolve, reject) => {
    mcpPending.set(id, { resolve, reject });
  });
}

function resolveMcpResult(msg: {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
}): void {
  if (msg.id == null) return;
  const p = mcpPending.get(msg.id);
  if (!p) return;
  mcpPending.delete(msg.id);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || 'MCP proxy request failed'));
}

service.onMcpRequest = (op, params) =>
  sendMcp(op as McpOp, params).catch((e) => {
    logger.debug(`mcp proxy "${op}" failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  });

let earlyPromise: Promise<void> | null = null;
let earlyDone = false;
let initPromise: Promise<void> | null = null;
let initDone = false;

async function handleRequest(line: string | Record<string, unknown>): Promise<void> {
  let req: WorkerRequest;
  if (typeof line === 'string') {
    if (!line.trim()) return;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
  } else {
    req = line as unknown as WorkerRequest;
    if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return;
  }

  if (req.method === 'earlyInit') {
    try {
      earlyPromise = service.earlyInit((req as { params?: { cwd?: string } }).params?.cwd);
      await earlyPromise;
      earlyDone = true;
      respond(req.id, { ok: true, cwd: service.getCwd() });
    } catch (e) {
      earlyDone = false;
      respondError(req.id, e);
    }
    return;
  }

  if (req.method === 'init') {
    try {
      if (earlyPromise !== null) await earlyPromise.catch(() => {});
      initPromise = service.init((req as { params?: { cwd?: string } }).params?.cwd);
      await initPromise;
      initDone = true;
      respond(req.id, { ok: true, cwd: service.getCwd() });
    } catch (e) {
      initDone = false;
      respondError(req.id, e);
    }
    return;
  }

  if (req.method === 'chat') {
    if (initPromise !== null && !initDone) await initPromise.catch(() => {});
    try {
      await service.chat((req as { params: { input: string } }).params.input);
      respond(req.id, { ok: true });
    } catch (e) {
      respondError(req.id, e);
    }
    return;
  }

  if (req.method === 'startSession') {
    try {
      const sid = await service.startSession(
        (req as { params?: { name?: string } }).params?.name,
        (req as { params?: { sessionId?: string } }).params?.sessionId,
      );
      respond(req.id, { sessionId: sid });
    } catch (e) {
      respondError(req.id, e);
    }
    return;
  }

  if (req.method === 'setAutomationProfile') {
    try {
      const profile = (req as { params?: { profile?: string } }).params?.profile ?? null;
      service.setAutomationProfile(profile);
      respond(req.id, { ok: true, profile });
    } catch (e) {
      respondError(req.id, e);
    }
    return;
  }

  if (req.method === 'getStatus') {
    respond(req.id, {
      cwd: service.getCwd(),
      busy: service.busy,
      provider: service.getActiveProvider(),
      model: service.getActiveModel(),
    });
    return;
  }

  if (req.method === 'shutdown') {
    try {
      await service.shutdown();
    } catch {}
    respond(req.id, { ok: true });
    process.exit(0);
    return;
  }

  respondError(req.id, `Unknown method: ${req.method}`);
}

if (useParentPort) {
  const pp = (process as unknown as { parentPort: { on: (ev: 'message', cb: (e: { data: unknown }) => void) => void } })
    .parentPort;
  pp.on('message', (e) => {
    const d = e.data as unknown;
    if (d && typeof d === 'object' && 'type' in d) {
      const msg = d as { type?: string; id?: number; ok?: boolean; data?: unknown; error?: string };
      if (msg.type === 'mcpResult') {
        resolveMcpResult(msg);
        return;
      }
    }
    void handleRequest(d as string | Record<string, unknown>);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { type?: string };
      if (msg.type === 'mcpResult') {
        resolveMcpResult(msg as { id?: number; ok?: boolean; data?: unknown; error?: string });
        return;
      }
    } catch { /* not JSON — fall through */ }
    void handleRequest(line);
  });
}

process.on('uncaughtException', (err) => {
  send({ type: 'log', level: 'error', message: err.stack ?? err.message });
});
