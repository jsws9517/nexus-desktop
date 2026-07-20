import OpenAI from 'openai';
import { Message, ChatChunk, ToolDefinition } from '../types.js';
import { LLMProvider } from './provider.js';
import { withChunkTimeout, IdleTimeoutError } from './chunk-timeout.js';
import { getChunkIdleTimeoutMs } from './timeout-config.js';

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  readonly name: string;
  readonly model: string;

  constructor(apiKey: string, model: string, baseUrl?: string, name?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    this.name = name || 'openai';
    this.model = model;
  }

  private toOpenAIMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId || '',
          content: m.content,
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return {
        role: m.role,
        content: m.content,
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
  }

  private toTools(tools?: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as OpenAI.FunctionParameters,
      },
    }));
  }

  async *chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    try {
      yield* withChunkTimeout(this.chatStreaming(messages, tools, signal), getChunkIdleTimeoutMs(), signal);
    } catch (err) {
      if ((err instanceof Error && err.name === "AbortError") || signal?.aborted) throw err;
      if (err instanceof IdleTimeoutError) throw err;
      yield* this.chatNonStreaming(messages, tools, signal);
    }
  }

  private async *chatStreaming(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      tools: this.toTools(tools),
      stream: true,
    }, { signal });

    // Track partial tool calls across chunks (OpenAI streams tool args incrementally)
    const pendingTools: Map<number, PendingToolCall> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // DeepSeek-style reasoning_content: yield as thinking chunk to keep
      // the chunk idle timer alive during long thinking phases.
      const rc = (delta && 'reasoning_content' in delta) ? (delta as Record<string, unknown>).reasoning_content : undefined;
      if (typeof rc === 'string' && rc.length > 0) {
        yield { type: 'thinking', thinking: rc };
      }

      if (delta?.content) {
        // Flush any pending tool calls before yielding text
        for (const [, pt] of pendingTools) {
          const args = this.tryParseArgs(pt.argsBuffer);
          if (args !== undefined) {
            yield { type: 'tool_call', toolCall: { id: pt.id, name: pt.name, arguments: args } };
          }
        }
        pendingTools.clear();
        yield { type: 'text', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const existing = pendingTools.get(index);

          if (tc.id && tc.function?.name) {
            // New tool call
            pendingTools.set(index, {
              id: tc.id,
              name: tc.function.name,
              argsBuffer: tc.function.arguments || '',
            });
          } else if (existing && tc.function?.arguments) {
            // Append to existing tool call arguments
            existing.argsBuffer += tc.function.arguments;
          }
        }
      }

      // When a chunk has neither content, reasoning_content, nor tool_calls, flush pending tools
      if (!delta?.content && rc === undefined && !delta?.tool_calls) {
        for (const [, pt] of pendingTools) {
          const args = this.tryParseArgs(pt.argsBuffer);
          if (args !== undefined) {
            yield { type: 'tool_call', toolCall: { id: pt.id, name: pt.name, arguments: args } };
          }
        }
        pendingTools.clear();
      }
    }

    // Flush any remaining pending tools at stream end
    for (const [, pt] of pendingTools) {
      const args = this.tryParseArgs(pt.argsBuffer);
      if (args !== undefined) {
        yield { type: 'tool_call', toolCall: { id: pt.id, name: pt.name, arguments: args } };
      }
    }
    pendingTools.clear();

    yield { type: 'done' };
  }

  private async *chatNonStreaming(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      tools: this.toTools(tools),
      stream: false,
    }, { signal });

    const choice = response.choices[0];
    const content = choice?.message?.content;
    const toolCalls = choice?.message?.tool_calls;

    if (signal?.aborted) return;

    if (content) {
      for (let i = 0; i < content.length; i++) {
        if (signal?.aborted) return;
        yield { type: "text", text: content[i] };
        if (i % 3 === 2) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    if (toolCalls) {
      for (const tc of toolCalls) {
        if (signal?.aborted) return;
        if (!("function" in tc)) continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch {}
        yield { type: "tool_call", toolCall: { id: tc.id, name: tc.function.name, arguments: args } };
      }
    }

    yield { type: "done" };
  }

  private tryParseArgs(buffer: string): Record<string, unknown> | undefined {
    if (!buffer) return undefined;
    try {
      return JSON.parse(buffer) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async complete(messages: Message[], timeoutMs = 120_000): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toOpenAIMessages(messages),
      }, { signal: controller.signal });
      return response.choices[0]?.message?.content || '';
    } finally {
      clearTimeout(timer);
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
