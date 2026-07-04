import { Message } from '../types.js';
import { LLMProvider } from './provider.js';

export class ContextManager {
  private messages: Message[] = [];
  private pinnedIndices: Set<number> = new Set();
  private maxMessages = 200;
  private tokenBudget = 8000;
  private maxContextTokens = 8192;
  private provider?: LLMProvider;

  constructor(options?: { maxMessages?: number; tokenBudget?: number; maxContextTokens?: number; provider?: LLMProvider }) {
    if (options?.maxMessages) this.maxMessages = options.maxMessages;
    if (options?.tokenBudget) this.tokenBudget = options.tokenBudget;
    if (options?.maxContextTokens) this.maxContextTokens = options.maxContextTokens;
    this.provider = options?.provider;
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  setMaxContextTokens(max: number): void {
    this.maxContextTokens = max;
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
    while (this.messages.length > this.maxMessages + this.pinnedIndices.size) {
      const firstUnpinned = this.messages.findIndex((_, i) => !this.pinnedIndices.has(i));
      if (firstUnpinned === -1) break;

      let removeCount = 1;

      // If removing an assistant message with toolCalls, also remove the paired tool messages
      // to preserve the required sequence for OpenAI/Anthropic APIs.
      const msg = this.messages[firstUnpinned];
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.id));
        let i = firstUnpinned + 1;
        while (i < this.messages.length) {
          const next = this.messages[i];
          if (next.role !== 'tool' || !next.toolCallId) break;
          if (!toolCallIds.has(next.toolCallId)) break;
          removeCount++;
          i++;
        }
      }

      this.messages.splice(firstUnpinned, removeCount);

      // Adjust pinned indices
      const newPinned = new Set<number>();
      for (const idx of this.pinnedIndices) {
        if (idx > firstUnpinned) newPinned.add(idx - removeCount);
        else if (idx < firstUnpinned) newPinned.add(idx);
      }
      this.pinnedIndices = newPinned;
    }
  }

  /** Find the nearest safe split index: a chain boundary where no tool_call chain is broken. */
  private findSafeSplitIndex(target: number): number {
    if (target <= 0) return 0;
    if (target >= this.messages.length) return this.messages.length;

    // A safe split point is where:
    // - The message at split is a user or system message (start of a new chain)
    // - OR the message before split is NOT an assistant with pending tool_calls
    // Search outward from target to find nearest safe boundary
    for (let offset = 0; offset < this.messages.length; offset++) {
      // Check behind target first (prefer earlier split to keep more context)
      const behind = target - offset;
      if (behind >= 0 && this.isChainBoundary(behind)) return behind;

      // Check ahead of target
      const ahead = target + offset;
      if (ahead <= this.messages.length && this.isChainBoundary(ahead)) return ahead;
    }
    return target;
  }

  /** Check if splitting before index `i` is safe (no orphaned tool messages). */
  private isChainBoundary(i: number): boolean {
    // Splitting at index i means messages[0..i-1] go to left, messages[i..] go to right
    if (i <= 0 || i >= this.messages.length) return true;

    // The message at i-1 (last of left partition) must not be an assistant with
    // tool_calls whose tool responses are in the right partition
    const prev = this.messages[i - 1];
    if (prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) {
      // Check if any of its tool responses are in the right partition
      const right = this.messages.slice(i);
      const toolCallIds = new Set(prev.toolCalls.map((tc) => tc.id));
      const hasOrphanedTools = right.some(m => m.role === 'tool' && m.toolCallId && toolCallIds.has(m.toolCallId));
      if (hasOrphanedTools) return false;
    }

    // The message at i (first of right partition) must not be a tool message
    // whose assistant with tool_calls is in the left partition
    const next = this.messages[i];
    if (next.role === 'tool' && next.toolCallId) {
      // Search left partition for the assistant that owns this tool_call
      for (let j = i - 1; j >= 0; j--) {
        const m = this.messages[j];
        if (m.role === 'assistant' && m.toolCalls) {
          const owns = m.toolCalls.some(tc => tc.id === next.toolCallId);
          if (owns) return false; // left has assistant, right has its tool — broken chain
          break; // different assistant, stop searching
        }
        if (m.role === 'user') break; // reached a user boundary, tool is orphaned anyway
      }
    }

    return true;
  }

  async compress(): Promise<void> {
    if (!this.provider || this.messages.length < 10) return;

    // Loop: keep compressing until we're under budget or can't compress further
    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const tokenCount = this.getTokenCount();
      if (tokenCount < this.maxContextTokens) return;

      const beforeCount = this.messages.length;

      // Find safe split point that doesn't break tool_call chains
      const targetSplit = Math.floor(this.messages.length / 2);
      const safeSplit = this.findSafeSplitIndex(targetSplit);

      // Partition: summarize [0..safeSplit-1], keep [safeSplit..end]
      const summarizable: Message[] = [];
      const kept: Message[] = [];
      for (let i = 0; i < this.messages.length; i++) {
        if (i < safeSplit && !this.pinnedIndices.has(i) && this.messages[i].role !== 'system') {
          summarizable.push(this.messages[i]);
        } else {
          kept.push(this.messages[i]);
        }
      }

      if (summarizable.length < 4) break;

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
        break; // Compression failed, stop trying
      }

      // Safety: if no messages were removed, stop to avoid infinite loop
      if (this.messages.length >= beforeCount) break;
    }
  }

  clear(): void {
    this.messages = [];
    this.pinnedIndices.clear();
  }
}
