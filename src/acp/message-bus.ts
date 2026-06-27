import { AcpMessage } from './protocol.js';

type MessageHandler = (message: AcpMessage) => void;

export class MessageBus {
  private handlers: Map<string, MessageHandler[]> = new Map();

  subscribe(agentId: string, handler: MessageHandler): () => void {
    const list = this.handlers.get(agentId) || [];
    list.push(handler);
    this.handlers.set(agentId, list);
    return () => {
      const updated = (this.handlers.get(agentId) || []).filter((h) => h !== handler);
      this.handlers.set(agentId, updated);
    };
  }

  publish(message: AcpMessage): void {
    if (message.to === '*') {
      for (const handlers of this.handlers.values()) {
        for (const h of handlers) h(message);
      }
    } else {
      const handlers = this.handlers.get(message.to) || [];
      for (const h of handlers) h(message);
    }
  }
}
