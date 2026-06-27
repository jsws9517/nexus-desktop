import OpenAI from 'openai';
import { Message, ChatChunk, ToolDefinition } from '../types.js';
import { LLMProvider } from './provider.js';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  readonly name = 'openai';
  readonly model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
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

  async *chat(messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      tools: this.toTools(tools),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id || `call_${Date.now()}`,
                name: tc.function.name,
                arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
              },
            };
          }
        }
      }
    }
    yield { type: 'done' };
  }

  async complete(messages: Message[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.toOpenAIMessages(messages),
    });
    return response.choices[0]?.message?.content || '';
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
