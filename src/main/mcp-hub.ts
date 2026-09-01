/**
 * Shared MCP (Model Context Protocol) hub owned by the main process.
 *
 * A single `ClientManager` instance holds all MCP server connections. Every
 * worker (global + per-session tab) proxies tool discovery and calls through
 * this hub via IPC (`sendMcp` -> `mcpRequest` -> hub) so that each configured
 * MCP server spawns only ONE OS child process regardless of how many tabs are
 * open.  No code inside `node_modules/` is modified; this works through the
 * core's public `ClientManager` export.
 */

import { logger } from '../shared/logger.js';

// nexus-coder exports ClientManager (src/mcp/client-manager.js) and
// ConfigManager (src/config/index.js). Both are plain JS classes with no
// native bindings; safe to import in the main (Electron) process.
import { ClientManager } from 'nexus-coder/dist/src/mcp/client-manager.js';
import { ConfigManager } from 'nexus-coder/dist/src/config/index.js';

const log = (msg: string): void => logger.info(`[mcp-hub] ${msg}`);
const warn = (msg: string): void => logger.warn(`[mcp-hub] ${msg}`);

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server?: string;
}

export interface McpServerInfo {
  name: string;
  autoStart: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}

class McpHubImpl {
  private manager = new ClientManager();
  private cfgManager: ConfigManager | null = null;
  private ready: Promise<void> | null = null;
  private enabled = true;

  /** Ensure a ConfigManager has been created (reads ~/.nexus/config.json). */
  private getConfig(): ConfigManager {
    if (!this.cfgManager) this.cfgManager = new ConfigManager();
    return this.cfgManager;
  }

  /**
   * Connect all auto-start MCP servers. Safe to call more than once; the
   * core's `connectServer` is idempotent per server name.
   */
  async ensureConnected(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.doConnect();
    return this.ready;
  }

  private async doConnect(): Promise<void> {
    this.manager.silent = true;
    const cfg = this.getConfig().get();
    const entries = Object.entries(cfg.mcpServers ?? {})
      .filter(([, s]) => s.autoStart !== false);
    if (entries.length === 0) return;
    const t0 = Date.now();
    const results = await Promise.allSettled(
      entries.map(async ([name, srv]) => {
        try {
          await this.manager.connectServer(name, srv);
        } catch (e) {
          warn(`connect "${name}" failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    log(`${ok}/${entries.length} servers connected in ${Date.now() - t0}ms`);
  }

  /**
   * Return MCP-only tool definitions (no builtin tools). Each tool carries a
   * `server` tag so callers can distinguish MCP from builtin. Empty before
   * `ensureConnected()` resolves.
   */
  getTools(): McpToolDef[] {
    // `getAllTools()` returns builtin + MCP; builtin tools do NOT have `server`.
    return this.manager.getAllTools()
      .filter((t: McpToolDef) => !!t.server)
      .map((t: McpToolDef) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, server: t.server }));
  }

  async callTool(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
    await this.ensureConnected();
    const res = await this.manager.callTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: res.content ?? '', isError: res.isError };
  }

  status(): { enabled: boolean; servers: Array<{ name: string; toolCount: number; status: string }> } {
    return {
      enabled: this.enabled,
      servers: (this.manager.listConnections() as Array<{ name: string; toolCount: number; status: string }>)
        .map((c) => ({ name: c.name, toolCount: c.toolCount, status: c.status })),
    };
  }

  servers(): McpServerInfo[] {
    const cfg = this.getConfig().get();
    const connected = new Map<string, { toolCount: number }>(
      (this.manager.listConnections() as Array<{ name: string; toolCount: number }>)
        .map((c) => [c.name, { toolCount: c.toolCount }]),
    );
    const errors = new Map<string, { error?: string }>(
      (this.manager.getServerErrors?.() as Array<{ name: string; error?: string }> ?? [])
        .map((e) => [e.name, { error: e.error }]),
    );
    return Object.entries(cfg.mcpServers ?? {}).map(([name, s]: [string, { autoStart?: boolean }]) => ({
      name,
      autoStart: s.autoStart !== false,
      connected: connected.has(name),
      toolCount: connected.get(name)?.toolCount ?? 0,
      error: errors.get(name)?.error,
    }));
  }

  async setServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    await this.ensureConnected();
    const connected = (this.manager.listConnections() as Array<{ name: string }>)
      .some((c) => c.name === name);
    if (enabled && !connected) {
      const cfg = this.getConfig().get();
      const srv = cfg.mcpServers?.[name];
      if (!srv) return { ok: false, error: `MCP server "${name}" not configured` };
      await this.manager.connectServer(name, srv);
      return { ok: true };
    } else if (!enabled && connected) {
      await this.manager.disconnect(name);
      return { ok: true };
    }
    return { ok: true };
  }

  async setEnabled(on: boolean): Promise<{ ok: boolean; error?: string }> {
    if (on === this.enabled) return { ok: true };
    try {
      if (on) {
        const cfg = this.getConfig().get();
        await this.manager.connectAll(cfg.mcpServers ?? {});
      } else {
        await this.manager.disconnect();
      }
      this.enabled = on;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Central dispatch for worker -> main MCP requests. */
  async handle(op: string, params?: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'connect':
        await this.ensureConnected();
        return this.status();
      case 'getTools':
        await this.ensureConnected();
        return this.getTools();
      case 'callTool': {
        const name = typeof params?.name === 'string' ? params.name : '';
        return this.callTool(name, params?.args);
      }
      case 'status':
        return this.status();
      case 'servers':
        return this.servers();
      case 'setServer': {
        const name = typeof params?.name === 'string' ? params.name : '';
        return this.setServer(name, params?.enable === true);
      }
      case 'setEnabled':
        return this.setEnabled(params?.enable === true);
      default:
        throw new Error(`Unknown MCP hub op: ${op}`);
    }
  }
}

// Singleton in the main process.
export const mcpHub = new McpHubImpl();
