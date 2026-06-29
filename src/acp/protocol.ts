import { randomUUID } from 'crypto';
import chalk from 'chalk';

export interface AcpAgent {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
  skillsPath?: string;
}

function isValidAcpEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const hostname = url.hostname;

    // Allow localhost for local ACP agents (user-configured, not user-input)
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Block other private IP ranges to prevent SSRF to unintended LAN services
    if (hostname.startsWith('10.')) return false;
    if (hostname.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;
    if (hostname.startsWith('0.')) return false;

    return true;
  } catch {
    return false;
  }
}

export interface AcpMessage {
  id: string;
  from: string;
  to: string;
  type: 'task' | 'response' | 'broadcast';
  payload: unknown;
  correlationId: string;
  timestamp: number;
}

export interface AcpConfig {
  enabled?: boolean;
  port?: number;
  agents?: AcpAgent[];
}

export class AcpProtocol {
  private agents: Map<string, AcpAgent> = new Map();
  private pendingResponses: Map<string, (msg: AcpMessage) => void> = new Map();
  private enabled = false;
  private port?: number;

  registerAgent(agent: AcpAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregisterAgent(id: string): void {
    this.agents.delete(id);
  }

  listAgents(): AcpAgent[] {
    return Array.from(this.agents.values());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPort(): number | undefined {
    return this.port;
  }

  async start(config?: AcpConfig): Promise<void> {
    if (this.enabled) return;

    this.enabled = true;

    // Register agents from config
    if (config?.agents) {
      for (const agent of config.agents) {
        this.registerAgent(agent);
      }
    }

    // Generate random port if not specified
    this.port = config?.port ?? this.getRandomPort();

    // Placeholder: actual server start would go here (HTTP/stdio/MCP sampling)
    process.stderr.write(chalk.green(`[ACP] Agent-to-agent protocol enabled on port ${this.port}\n`));

    if (this.agents.size > 0) {
      process.stderr.write(chalk.dim(`[ACP] Registered ${this.agents.size} agent(s)\n`));
    }
  }

  async stop(): Promise<void> {
    if (!this.enabled) return;

    // Placeholder: actual server shutdown would go here
    this.enabled = false;
    this.port = undefined;
    process.stderr.write(chalk.gray('[ACP] Protocol stopped\n'));
  }

  private getRandomPort(): number {
    const min = 3000;
    const max = 9000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async sendTask(to: string, payload: unknown, from: string): Promise<AcpMessage> {
    const correlationId = randomUUID();
    const message: AcpMessage = {
      id: randomUUID(),
      from,
      to,
      type: 'task',
      payload,
      correlationId,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(correlationId);
        reject(new Error(`ACP task to ${to} timed out`));
      }, 60000);

      this.pendingResponses.set(correlationId, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.deliver(message).catch((err) => {
        clearTimeout(timeout);
        this.pendingResponses.delete(correlationId);
        reject(err);
      });
    });
  }

  async listTools(agentId: string): Promise<Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>> {
    const msg = await this.sendTask(agentId, { method: 'tools/list' }, 'nexus');
    const payload = msg.payload as { tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> } | undefined;
    return payload?.tools || [];
  }

  async sendResponse(to: string, payload: unknown, correlationId: string, from: string): Promise<void> {
    const message: AcpMessage = {
      id: randomUUID(),
      from,
      to,
      type: 'response',
      payload,
      correlationId,
      timestamp: Date.now(),
    };
    await this.deliver(message);
  }

  receive(message: AcpMessage): void {
    if (message.type === 'response') {
      const handler = this.pendingResponses.get(message.correlationId);
      if (handler) {
        handler(message);
        this.pendingResponses.delete(message.correlationId);
      }
    }
  }

  private async deliver(message: AcpMessage): Promise<void> {
    const agent = this.agents.get(message.to);
    if (!agent) {
      throw new Error(`Agent ${message.to} not found`);
    }

    // HTTP transport with SSRF protection
    if (agent.endpoint.startsWith('http://') || agent.endpoint.startsWith('https://')) {
      if (!isValidAcpEndpoint(agent.endpoint)) {
        throw new Error(`Agent endpoint rejected by SSRF policy: ${agent.endpoint}`);
      }

      const url = agent.endpoint.endsWith('/') ? agent.endpoint : `${agent.endpoint}/`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(`${url}acp/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} from ${agent.name}: ${response.statusText}${body ? ' - ' + body.slice(0, 200) : ''}`);
        }

        // If this was a task, expect a response message in the body
        if (message.type === 'task') {
          try {
            const responseBody = await response.json() as AcpMessage;
            if (responseBody.type === 'response' && responseBody.correlationId === message.correlationId) {
              this.receive(responseBody);
            }
          } catch {
            // Non-JSON response or invalid format — task will timeout
            throw new Error(`Invalid response from ${agent.name}: expected JSON ACP message`);
          }
        }
        return;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Request to ${agent.name} timed out after 30s`);
        }
        throw err;
      }
    }

    // Placeholder: stdio / MCP sampling transport not implemented
    process.stderr.write(`[ACP] Deliver to ${agent.name}: ${message.type}\n`);
  }
}
