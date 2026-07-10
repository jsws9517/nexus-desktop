import { Message, ChatChunk, ToolDefinition } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { decryptApiKey } from '../security/env-key-encrypt.js';

export interface LLMProvider {
  readonly name: string;
  readonly model: string;

  chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<ChatChunk>;
  complete(messages: Message[]): Promise<string>;
  countTokens(text: string): number;
}

export function createProvider(type: string, apiKey: string, model: string, baseUrl?: string, options?: Record<string, unknown>, name?: string): LLMProvider {
  const decrypted = decryptApiKey(apiKey);
  if (type === 'anthropic') {
    return new AnthropicProvider(decrypted, model, baseUrl, name, options);
  }
  // openai and custom both use OpenAI-compatible SDK (most custom APIs are OpenAI-compatible)
  if (type === 'openai' || type === 'custom') {
    return new OpenAIProvider(decrypted, model, baseUrl, name);
  }
  throw new Error(`Unsupported provider type: ${type}`);
}
