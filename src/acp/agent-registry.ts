import { AcpAgent } from './protocol.js';

export class AgentRegistry {
  private agents: Map<string, AcpAgent> = new Map();

  register(agent: AcpAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  get(id: string): AcpAgent | undefined {
    return this.agents.get(id);
  }

  list(): AcpAgent[] {
    return Array.from(this.agents.values());
  }

  findByCapability(capability: string): AcpAgent[] {
    return this.list().filter((a) => a.capabilities.includes(capability));
  }
}
