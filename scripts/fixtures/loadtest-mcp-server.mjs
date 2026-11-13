#!/usr/bin/env node
/**
 * Deterministic fixture MCP server (MCP stdio JSON-RPC, hand-rolled — no
 * @modelcontextprotocol/sdk dependency) used by the CICD load test
 * (scripts/load-test.mjs) to exercise the real built-in-tool + MCP
 * coordination path without external npx/network fetches.
 *
 * It is launched by the production MCP hub (dist/main/mcp-hub.js ->
 * ClientManager.connectServer) exactly like any configured mcpServers entry:
 *   "loadtest": { "command": "node", "args": ["<repo>/scripts/fixtures/loadtest-mcp-server.mjs"], "autoStart": true }
 *
 * Tools (all pure functions of their arguments — deterministic, instant):
 *   loadtest_echo { message: string }  -> "echo:<message>"
 *   loadtest_add  { a: number, b: number } -> JSON { a, b, sum }
 *   loadtest_now  {}                   -> JSON { iso, marker }
 *
 * Protocol notes:
 *  - Newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio framing).
 *  - `initialize` echoes back the client-requested protocolVersion (the MCP
 *    spec's "accept" behavior — always satisfies the client SDK).
 *  - Notifications (no `id`, e.g. `notifications/initialized`) get no reply.
 */

import process from 'node:process';
import readline from 'node:readline';

const SERVER_INFO = { name: 'nexus-loadtest-mcp', version: '1.0.0' };

const TOOLS = [
  {
    name: 'loadtest_echo',
    description:
      'Load-test fixture tool: echoes the input message back prefixed with "echo:". ' +
      'Use to verify the MCP transport end-to-end. Not a production tool.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The string to echo back' },
      },
      required: ['message'],
    },
  },
  {
    name: 'loadtest_add',
    description:
      'Load-test fixture tool: returns the sum of two numbers as a JSON object { a, b, sum }. ' +
      'Use to verify MCP argument (de)serialization. Not a production tool.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend' },
        b: { type: 'number', description: 'Second addend' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'loadtest_now',
    description:
      'Load-test fixture tool: returns the current UTC time as an ISO-8601 string in JSON { iso, marker }. ' +
      'Use as a lightweight liveness probe. Not a production tool.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/** @returns {{ result?: unknown, error?: { code: number, message: string } } | null} null = no reply (notification). */
function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      };

    case 'tools/list':
      return { result: { tools: TOOLS } };

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      switch (name) {
        case 'loadtest_echo': {
          const message =
            typeof args.message === 'string' ? args.message : JSON.stringify(args.message ?? null);
          return { result: textResult(`echo:${message}`) };
        }
        case 'loadtest_add': {
          const a = Number(args.a);
          const b = Number(args.b);
          if (!Number.isFinite(a) || !Number.isFinite(b)) {
            return { result: textResult('loadtest_add: "a" and "b" must be numbers', true) };
          }
          return { result: textResult(JSON.stringify({ a, b, sum: a + b })) };
        }
        case 'loadtest_now':
          return {
            result: textResult(JSON.stringify({ iso: new Date().toISOString(), marker: 'loadtest-now-ok' })),
          };
        default:
          return { error: { code: -32602, message: `unknown tool "${String(name)}"` } };
      }
    }

    case 'ping':
      return { result: {} };

    default:
      break;
  }

  // Notifications carry no id and get no reply (MCP spec).
  if (id === undefined) return null;
  return { error: { code: -32601, message: `method not found: ${String(method)}` } };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // never crash the pipe on garbage
  }
  if (!msg || typeof msg !== 'object' || !msg.method) return;
  const reply = handleRequest(msg);
  if (reply && msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
