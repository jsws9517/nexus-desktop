import { Message } from '../types.js';
import { LLMProvider } from './provider.js';

export class ContextManager {
  private messages: Message[] = [];
  private pinnedIndices: Set<number> = new Set();
  private maxMessages = 50;
  private tokenBudget = 8000;
  private provider?: LLMProvider;

  constructor(options?: { maxMessages?: number; tokenBudget?: number; provider?: LLMProvider }) {
    if (options?.maxMessages) this.maxMessages = options.maxMessages;
    if (options?.tokenBudget) this.tokenBudget = options.tokenBudget;
    this.provider = options?.provider;
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  add(message: Message): void {
    this.messages.push(message);
    this.enforceLimits();
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    this.pinnedIndices.clear();
  }

  pin(index: number): void {
    if (index >= 0 && index < this.messages.length) {
      this.pinnedIndices.add(index);
    }
  }

  unpin(index: number): void {
    this.pinnedIndices.delete(index);
  }

  getTokenCount(): number {
    return this.messages.reduce((sum, m) => {
      return sum + (this.provider?.countTokens(m.content) || Math.ceil(m.content.length / 4));
    }, 0);
  }

  private enforceLimits(): void {
    // First check message count
    while (this.messages.length > this.maxMessages + this.pinnedIndices.size) {
      const firstUnpinned = this.messages.findIndex((_, i) => !this.pinnedIndices.has(i));
      if (firstUnpinned === -1) break;
      this.messages.splice(firstUnpinned, 1);
      // Adjust pinned indices
      const newPinned = new Set<number>();
      for (const idx of this.pinnedIndices) {
        if (idx > firstUnpinned) newPinned.add(idx - 1);
        else if (idx < firstUnpinned) newPinned.add(idx);
      }
      this.pinnedIndices = newPinned;
    }
  }

  async compress(): Promise<void> {
    if (!this.provider || this.messages.length < 10) return;

    const tokenCount = this.getTokenCount();
    if (tokenCount < this.tokenBudget) return;

    // Find oldest non-pinned messages to summarize
    const summarizable: Message[] = [];
    const kept: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.pinnedIndices.has(i) || this.messages[i].role === 'system') {
        kept.push(this.messages[i]);
      } else if (summarizable.length < this.messages.length / 2) {
        summarizable.push(this.messages[i]);
      } else {
        kept.push(this.messages[i]);
      }
    }

    if (summarizable.length < 4) return;

    const summaryPrompt: Message = {
      role: 'user',
      content: `Summarize the following conversation history concisely:\n\n${summarizable
        .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
        .join('\n')}`,
    };

    try {
      const summary = await this.provider.complete([summaryPrompt]);
      this.messages = [
        ...kept.filter((m) => m.role === 'system'),
        { role: 'system', content: `[Previous conversation summary]: ${summary}` },
        ...kept.filter((m) => m.role !== 'system'),
      ];
      this.pinnedIndices.clear();
    } catch {
      // Compression failed, keep original messages
    }
  }

  clear(): void {
    this.messages = [];
    this.pinnedIndices.clear();
  }
}
