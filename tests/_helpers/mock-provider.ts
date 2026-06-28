import { LLMProvider } from '../../src/llm/provider.js';
import { Message, ChatChunk, ToolDefinition, ToolResult } from '../../src/types.js';

interface MockResponse {
  chunks: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }>;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  private responses: MockResponse[] = [];
  private callIndex = 0;
  private callLog: Message[][] = [];

  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
    this.callIndex = 0;
    this.callLog = [];
  }

  getCallLog(): Message[][] {
    return this.callLog;
  }

  async *chat(messages: Message[], _tools?: ToolDefinition[]): AsyncIterable<ChatChunk> {
    this.callLog.push([...messages]);
    const response = this.responses[this.callIndex++] || { chunks: [] };
    for (const chunk of response.chunks) {
      yield chunk as ChatChunk;
    }
    yield { type: 'done' };
  }

  async complete(messages: Message[]): Promise<string> {
    this.callLog.push([...messages]);
    const response = this.responses[this.callIndex++];
    if (!response) return '';
    return response.chunks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

/**
 * 创建一个预配置的 MockProvider，模拟多轮 tool call 场景：
 * 第1轮：assistant 请求调用 test_tool
 * 第2轮：assistant 在收到 tool result 后给出最终答案
 */
export function createMultiTurnMockProvider(): {
  provider: MockProvider;
  toolResults: Map<string, ToolResult>;
} {
  const provider = new MockProvider();
  const toolResults = new Map<string, ToolResult>();

  provider.setResponses([
    {
      chunks: [
        { type: 'text', text: 'I will call the tool.' },
        {
          type: 'tool_call',
          toolCall: { id: 'tc-1', name: 'test_tool', arguments: { query: 'hello' } },
        },
      ],
    },
    {
      chunks: [
        { type: 'text', text: 'The tool returned: mock-result' },
      ],
    },
  ]);

  toolResults.set('tc-1', { content: 'mock-result' });

  return { provider, toolResults };
}
