import Anthropic from '@anthropic-ai/sdk';
import { Message, ChatChunk, ToolDefinition } from '../types.js';
import { LLMProvider } from './provider.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  readonly name: string;
  readonly model: string;
  private options?: Record<string, unknown>;

  constructor(apiKey: string, model: string, baseUrl?: string, name?: string, options?: Record<string, unknown>) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
    this.name = name || 'anthropic';
    this.model = model;
    this.options = options;
  }

  private get thinkingBudget(): number {
    const raw = this.options?.thinkingBudget;
    return typeof raw === 'number' && raw > 0 ? raw : 0;
  }

  private toAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolCallId || '',
            content: m.content,
          }],
        } as Anthropic.Messages.MessageParam;
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        } as Anthropic.Messages.MessageParam;
      }
      return {
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      } as Anthropic.Messages.MessageParam;
    });
  }

  private toTools(tools?: ToolDefinition[]): Anthropic.Messages.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    }));
  }

  async *chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemContent = systemMessages.length > 0
      ? systemMessages.map(m => m.content).join('\n\n')
      : undefined;
    const anthropicMessages = this.toAnthropicMessages(
      messages.filter((m) => m.role !== 'system')
    );

    const streamOpts: Anthropic.Messages.MessageCreateParams & { stream?: true } = {
      model: this.model,
      max_tokens: this.options?.maxTokens as number || 4096,
      system: systemContent,
      messages: anthropicMessages,
      tools: this.toTools(tools),
    };

    if (this.thinkingBudget) {
      streamOpts.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      } as Anthropic.Messages.MessageCreateParams['thinking'];
    }

    const stream = this.client.messages.stream(streamOpts, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', thinking: event.delta.thinking };
        } else if ((event.delta as { type: string }).type === 'redacted_thinking') {
          yield { type: 'thinking', thinking: '[redacted]' };
        }
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield {
          type: 'tool_call',
          toolCall: {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: event.content_block.input as Record<string, unknown>,
          },
        };
      }
    }
    yield { type: 'done' };
  }

  async complete(messages: Message[]): Promise<string> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemContent = systemMessages.length > 0
      ? systemMessages.map(m => m.content).join('\n\n')
      : undefined;
    const anthropicMessages = this.toAnthropicMessages(
      messages.filter((m) => m.role !== 'system')
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.options?.maxTokens as number || 4096,
      system: systemContent,
      messages: anthropicMessages,
    });

    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
