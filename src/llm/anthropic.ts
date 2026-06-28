import Anthropic from '@anthropic-ai/sdk';
import { Message, ChatChunk, ToolDefinition } from '../types.js';
import { LLMProvider } from './provider.js';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  readonly name = 'anthropic';
  readonly model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
    this.model = model;
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
    const anthropicMessages = this.toAnthropicMessages(
      messages.filter((m) => m.role !== 'system')
    );
    const systemMessage = messages.find((m) => m.role === 'system');

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: systemMessage?.content,
      messages: anthropicMessages,
      tools: this.toTools(tools),
    }, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
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
    const anthropicMessages = this.toAnthropicMessages(
      messages.filter((m) => m.role !== 'system')
    );
    const systemMessage = messages.find((m) => m.role === 'system');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemMessage?.content,
      messages: anthropicMessages,
    });

    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
