import readline from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';
import { AgentService } from './agent-service.js';
import type { AgentEvent } from './agent-service.js';

type WorkerRequest =
  | { id: number; method: 'init'; params?: { cwd?: string } }
  | { id: number; method: 'chat'; params: { input: string } }
  | { id: number; method: 'abort' }
  | { id: number; method: 'startSession'; params?: { name?: string; sessionId?: string } }
  | { id: number; method: 'listSessions' }
  | { id: number; method: 'getMessages'; params: { sessionId: string } }
  | { id: number; method: 'deleteSession'; params: { id: string } }
  | { id: number; method: 'renameSession'; params: { id: string; name: string } }
  | { id: number; method: 'getConfig' }
  | { id: number; method: 'getProviders' }
  | { id: number; method: 'getStatus' }
  | { id: number; method: 'switchProvider'; params: { name: string } }
  | { id: number; method: 'switchModel'; params: { modelId: string } }
  | { id: number; method: 'saveProvider'; params: { name: string; fields: Record<string, unknown> } }
  | { id: number; method: 'setCwd'; params: { cwd: string } }
  | { id: number; method: 'resolvePermission'; params: { id: string; answer: string } }
  | { id: number; method: 'setMcpEnabled'; params: { enabled: boolean } }
  | { id: number; method: 'getMcpStatus' }
  | { id: number; method: 'getMcpServers' }
  | { id: number; method: 'setMcpServer'; params: { name: string; enabled: boolean } }
  | { id: number; method: 'shutdown' };

/** JSON-RPC transport. stdio (dev/system node) or parentPort (Electron utilityProcess). */
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
  send({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

const service = new AgentService();
service.onEvent = (event: AgentEvent) => send({ type: 'event', event });
service.onPermission = (req) => { tracePerm(`askPermission id=${req.id}`); send({ type: 'permission', ...req }); };
service.onLog = (level, message) => send({ type: 'log', level, message });

function writeDiag(data: unknown): void {
  try {
    writeFileSync('C:/Users/pgw/AppData/Local/Temp/opencode/init-diag.json', JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}
function tracePerm(msg: string): void {
  try {
    appendFileSync('C:/Users/pgw/AppData/Local/Temp/opencode/perm.log', `${Date.now()} ${msg}\n`, 'utf-8');
  } catch {}
}
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
    // utilityProcess (packaged) delivers the request object directly via parentPort.
    req = line as unknown as WorkerRequest;
    if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return;
  }
  try {
    switch (req.method) {
      case 'init':
        try {
          const t0 = Date.now();
          await service.init(req.params?.cwd);
          writeDiag({ ok: true, ms: Date.now() - t0, cwd: service.getCwd() });
          respond(req.id, { ok: true, cwd: service.getCwd() });
        } catch (e) {
          writeDiag({ ok: false, ms: -1, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
          respondError(req.id, e);
        }
        break;
      case 'chat':
        await service.chat(req.params.input);
        respond(req.id);
        break;
      case 'abort':
        service.abort();
        respond(req.id);
        break;
      case 'startSession':
        respond(req.id, await service.startSession(req.params?.name, req.params?.sessionId));
        break;
      case 'listSessions':
        respond(req.id, await service.listSessions());
        break;
      case 'getMessages':
        respond(req.id, await service.getMessages(req.params.sessionId));
        break;
      case 'deleteSession':
        await service.deleteSession(req.params.id);
        respond(req.id);
        break;
      case 'renameSession':
        await service.renameSession(req.params.id, req.params.name);
        respond(req.id);
        break;
      case 'getConfig':
        respond(req.id, service.getConfig());
        break;
      case 'getProviders':
        respond(req.id, service.getProviders());
        break;
      case 'getStatus':
        respond(req.id, {
          cwd: service.getCwd(),
          busy: service.busy,
          provider: service.getActiveProvider(),
          model: service.getActiveModel(),
        });
        break;
      case 'switchProvider':
        await service.switchProvider(req.params.name);
        respond(req.id);
        break;
      case 'switchModel':
        respond(req.id, await service.switchModel(req.params.modelId));
        break;
      case 'saveProvider':
        service.saveProvider(req.params.name, req.params.fields);
        respond(req.id);
        break;
      case 'setCwd':
        await service.setCwd(req.params.cwd);
        respond(req.id, { cwd: service.getCwd() });
        break;
      case 'resolvePermission':
        tracePerm(`resolvePermission id=${req.params.id} answer=${req.params.answer}`);
        await service.resolvePermission(req.params.id, req.params.answer);
        respond(req.id);
        break;
      case 'setMcpEnabled':
        respond(req.id, await service.setMcpEnabled(req.params.enabled));
        break;
      case 'getMcpStatus':
        respond(req.id, service.getMcpStatus());
        break;
      case 'getMcpServers':
        respond(req.id, service.getMcpServers());
        break;
      case 'setMcpServer':
        respond(req.id, await service.setMcpServer(req.params.name, req.params.enabled));
        break;
      case 'shutdown':
        await service.shutdown();
        respond(req.id);
        process.exit(0);
        break;
      default:
        respondError((req as { id: number }).id, `Unknown method: ${(req as { method: string }).method}`);
    }
  } catch (e) {
    respondError((req as { id: number }).id, e);
  }
}

if (useParentPort) {
  const pp = (process as unknown as { parentPort: { on: (ev: 'message', cb: (e: { data: string }) => void) => void } }).parentPort;
  pp.on('message', (e) => {
    void handleRequest(e.data);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void handleRequest(line);
  });
}

process.on('uncaughtException', (err) => {
  send({ type: 'log', level: 'error', message: err.stack ?? err.message });
});
