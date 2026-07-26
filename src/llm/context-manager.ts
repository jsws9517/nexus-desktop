import { Message } from '../types.js';
import { LLMProvider } from './provider.js';

export enum CompactStrategy {
  Truncate = 'truncate',
  Summarize = 'summarize',
  Snapshot = 'snapshot',
}

export interface CompactMetadata {
  strategy: CompactStrategy;
  originalTokens: number;
  compactedTokens: number;
  preservedMessages: number;
  summary: string;
  round: number;
}

export class ContextManager {
  private messages: Message[] = [];
  private pinnedIndices: Set<number> = new Set();
  private maxMessages = 200;
  private tokenBudget = 8000;
  private maxContextTokens = 8192;
  private provider?: LLMProvider;
  onProgress?: (message: string) => void;
  private compressionTimeoutMs = 120_000;
  private compressionRound = 0;
  lastCompactMetadata?: CompactMetadata;

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

  /** Prepend text to the first system message (or prepend a new one if none exists) */
  prependToSystem(text: string): void {
    const idx = this.messages.findIndex(m => m.role === 'system');
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], content: this.messages[idx].content + '\n' + text };
    } else {
      this.messages.unshift({ role: 'system', content: text });
    }
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

  private static readonly MAX_COMPRESS_DEPTH = 10;

  async compress(depth = 0): Promise<void> {
    if (this.messages.length < 4) return;
    if (depth >= ContextManager.MAX_COMPRESS_DEPTH) return;

    this.compressionRound++;
    const round = this.compressionRound;

    let strategy: CompactStrategy;
    if (round <= 2) {
      strategy = CompactStrategy.Summarize;
    } else if (round <= 4) {
      strategy = CompactStrategy.Truncate;
    } else {
      strategy = CompactStrategy.Snapshot;
    }

    const originalTokens = this.getTokenCount();
    if (originalTokens < this.maxContextTokens) {
      this.compressionRound = 0;
      return;
    }

    const beforeCount = this.messages.length;

    switch (strategy) {
      case CompactStrategy.Summarize:
        await this.compressViaSummarize();
        break;
      case CompactStrategy.Truncate:
        await this.compressViaTruncate();
        break;
      case CompactStrategy.Snapshot:
        await this.compressViaSnapshot();
        break;
    }

    const compactedTokens = this.getTokenCount();
    this.lastCompactMetadata = {
      strategy,
      originalTokens,
      compactedTokens,
      preservedMessages: this.messages.length,
      summary: `Compressed ${beforeCount} → ${this.messages.length} messages (${strategy})`,
      round,
    };

    if (this.messages.length >= beforeCount && beforeCount > 0) {
      this.compressionRound = Math.max(0, this.compressionRound - 1);
    }

    // One-line summary showing net compression result
    const saved = originalTokens - compactedTokens;
    if (depth === 0 && saved > 0) {
      process.stderr.write(`[compress] ${originalTokens}→${compactedTokens} tok, -${saved} tok (${strategy})\n`);
    }

    // Recurse if still over budget (with depth limit as safety valve)
    if (this.getTokenCount() > this.maxContextTokens) {
      await this.compress(depth + 1);
    }
  }

  private async compressViaSummarize(): Promise<void> {
    // Find a split point that protects tool results from being summarized.
    // Tool results (role: 'tool') contain file read data that the LLM
    // would otherwise re-request after compression, creating a read loop.
    const targetSplit = Math.floor(this.messages.length / 2);
    // Prefer a split at or before the first 'tool' message so tool results
    // land in the kept (right) section rather than the summarizable (left).
    const firstToolIdx = this.messages.findIndex(m => m.role === 'tool');
    const adjustedTarget = firstToolIdx >= 0 ? Math.min(targetSplit, firstToolIdx) : targetSplit;
    const safeSplit = this.findSafeSplitIndex(adjustedTarget);

    const summarizable: Message[] = [];
    const kept: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (i < safeSplit && !this.pinnedIndices.has(i) && this.messages[i].role !== 'system') {
        summarizable.push(this.messages[i]);
      } else {
        kept.push(this.messages[i]);
      }
    }

    if (summarizable.length < 4) return;

    this.onProgress?.(`Summarizing context (round ${this.compressionRound})...`);

    // Include full content of tool results so the LLM can properly
    // incorporate file data into the summary rather than truncating it.
    const summaryPrompt: Message = {
      role: 'user',
      content: `Summarize the following conversation history concisely:\n\n${summarizable
        .map((m) => `${m.role}: ${m.content.slice(0, m.role === 'tool' ? 2000 : 500)}`)
        .join('\n')}`,
    };

    try {
      if (!this.provider) return;
      const summary = await this.provider.complete([summaryPrompt], this.compressionTimeoutMs);
      this.messages = [
        ...kept.filter((m) => m.role === 'system'),
        { role: 'system', content: `[Previous conversation summary]: ${summary}` },
        ...kept.filter((m) => m.role !== 'system'),
      ];
      this.pinnedIndices.clear();
    } catch {
      // Compression failed, fall back to truncation
      await this.compressViaTruncate();
    }
  }

  private async compressViaTruncate(): Promise<void> {
    this.onProgress?.(`Truncating context (round ${this.compressionRound})...`);

    const MAX_KEEP = Math.max(6, Math.ceil(this.messages.length * 0.4));
    const safeSplit = this.findSafeSplitIndex(this.messages.length - MAX_KEEP);

    const kept: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      // Preserve tool result messages (file reads, etc.) even when old,
      // otherwise the LLM will re-request the data after compression.
      if (i >= safeSplit || this.pinnedIndices.has(i) || this.messages[i].role === 'system' || this.messages[i].role === 'tool') {
        kept.push(this.messages[i]);
      }
    }

    if (kept.length < 4) {
      const tail = this.messages.slice(-4);
      const systems = this.messages.filter(m => m.role === 'system');
      this.messages = [...systems, ...tail];
    } else {
      this.messages = kept;
    }
    this.pinnedIndices.clear();
  }

  private async compressViaSnapshot(): Promise<void> {
    this.onProgress?.(`Snapshotting context (round ${this.compressionRound})...`);

    // Priority: keep system messages, pinned items, tool results, and recent turns
    const systems = this.messages.filter(m => m.role === 'system');
    const pinned = this.messages.filter((_, i) => this.pinnedIndices.has(i));
    // Preserve tool results so file data survives snapshot compression
    const toolResults = this.messages.filter(m => m.role === 'tool');
    const recent = this.messages.slice(-4);

    // Generate a summary of the full context for the snapshot
    const summarizable = this.messages
      .filter(m => m.role !== 'system' && m.role !== 'tool')
      .slice(0, -4);

    if (summarizable.length > 4 && this.provider) {
      try {
        const snapshotPrompt: Message = {
          role: 'user',
          content: `Capture key decisions, code patterns, and conclusions from this conversation:\n\n${summarizable
            .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
            .join('\n')}`,
        };
        const snapshot = await this.provider.complete([snapshotPrompt], this.compressionTimeoutMs);
        this.messages = [
          ...systems,
          ...pinned,
          ...toolResults,
          ...recent,
          { role: 'system', content: `[Knowledge snapshot]: ${snapshot}` },
        ];
      } catch {
        this.messages = [...systems, ...pinned, ...toolResults, ...recent];
      }
    } else {
      this.messages = [...systems, ...pinned, ...toolResults, ...recent];
    }
    this.pinnedIndices.clear();
  }

  clear(): void {
    this.messages = [];
    this.pinnedIndices.clear();
  }
}
