import { randomUUID } from 'crypto';

export interface AcpAgent {
  id: string;
  name: string;
  endpoint: string;
  capabilities: string[];
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

export class AcpProtocol {
  private agents: Map<string, AcpAgent> = new Map();
  private pendingResponses: Map<string, (msg: AcpMessage) => void> = new Map();

  registerAgent(agent: AcpAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregisterAgent(id: string): void {
    this.agents.delete(id);
  }

  listAgents(): AcpAgent[] {
    return Array.from(this.agents.values());
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
    // Placeholder: actual delivery via MCP sampling or HTTP in future
    const agent = this.agents.get(message.to);
    if (!agent) {
      throw new Error(`Agent ${message.to} not found`);
    }
    // Delivery implementation depends on transport (stdio / HTTP / MCP sampling)
    console.log(`[ACP] Deliver to ${agent.name}:`, message.type);
  }
}
