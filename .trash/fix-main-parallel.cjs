const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/main/index.ts';
let s = fs.readFileSync(p, 'utf8');

const old =
  "async function handleParallelRequest(sessionId: string, event: { type: string; prompt: string }): Promise<void> {\r\n" +
  "  const { OrchestratorAgent } = await import('../agent/sub-agent/orchestrator.js');\r\n" +
  "  const { WorkerHost } = await import('./worker-host.js');\r\n" +
  "  const { workerScriptPath } = await import('./session-workers.js');\r\n" +
  "  \r\n" +
  "  // Send progress event to renderer\r\n" +
  "  send(CHANNELS.tabEvent, { sessionId, event: { type: 'parallel_start', sessionId, prompt: event.prompt } });\r\n" +
  "  \r\n" +
  "  try {\r\n" +
  "    const orchestrator = new OrchestratorAgent(\r\n" +
  "      null, // No AgentService in main process - use fallback decomposition\r\n" +
  "      {\r\n" +
  "        workerFactory: (scriptPath: string) => new WorkerHost(scriptPath),\r\n" +
  "        workerScriptPath: workerScriptPath(),\r\n" +
  "      }\r\n" +
  "    );\r\n" +
  "    \r\n" +
  "    const result = await orchestrator.orchestrate(event.prompt, sessionId);";

const neu =
  "async function handleParallelRequest(sessionId: string, event: { type: string; prompt: string }): Promise<void> {\r\n" +
  "  const { OrchestratorAgent } = await import('../agent/sub-agent/orchestrator.js');\r\n" +
  "  const { WorkerHost } = await import('./worker-host.js');\r\n" +
  "  const { workerScriptPath } = await import('./session-workers.js');\r\n" +
  "  const { loadConstitution } = await import('../tools/agents.js');\r\n" +
  "  \r\n" +
  "  // Send progress event to renderer\r\n" +
  "  send(CHANNELS.tabEvent, { sessionId, event: { type: 'parallel_start', sessionId, prompt: event.prompt } });\r\n" +
  "  \r\n" +
  "  try {\r\n" +
  "    // Load the project constitution ONCE here, in the main process, and pass\r\n" +
  "    // the text down into every sub-task prompt (§3.7). The child workers never\r\n" +
  "    // discover the constitution themselves — the Orchestrator passes it down.\r\n" +
  "    let constitutionText: string | null = null;\r\n" +
  "    try {\r\n" +
  "      const { dir } = await sessionWorkers.request<{ dir: string }>(sessionId, 'getDefaultProjectDir');\r\n" +
  "      const loaded = await loadConstitution(dir ?? process.cwd());\r\n" +
  "      if (loaded.reason === 'ok' && loaded.text) constitutionText = loaded.text;\r\n" +
  "    } catch {\r\n" +
  "      // Constitution is best-effort for parallel runs; never block the run.\r\n" +
  "    }\r\n" +
  "\r\n" +
  "    const orchestrator = new OrchestratorAgent(\r\n" +
  "      null, // No AgentService in main process - use fallback decomposition\r\n" +
  "      {\r\n" +
  "        workerFactory: (scriptPath: string) => new WorkerHost(scriptPath),\r\n" +
  "        workerScriptPath: workerScriptPath(),\r\n" +
  "      }\r\n" +
  "    );\r\n" +
  "    \r\n" +
  "    const result = await orchestrator.orchestrate(event.prompt, sessionId, constitutionText ?? undefined);";

const n = s.indexOf(old);
if (n < 0) {
  console.log('pattern not found');
  process.exit(1);
}
s = s.slice(0, n) + neu + s.slice(n + old.length);
fs.writeFileSync(p, s);
console.log('main/index.ts updated');