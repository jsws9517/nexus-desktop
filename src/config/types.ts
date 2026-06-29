import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'custom']),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  options: z.record(z.unknown()).optional(),
});

export const ServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
});

export const AcpAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  capabilities: z.array(z.string()),
  skillsPath: z.string().optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()).optional(),
  })).optional(),
});

export const AcpConfigSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().optional(),
  agents: z.array(AcpAgentSchema).optional(),
  skillsPath: z.string().optional(),
});

export const ConfigSchema = z.object({
  activeProvider: z.string(),
  providers: z.record(ProviderConfigSchema),
  mcpServers: z.record(ServerConfigSchema).optional(),
  acp: AcpConfigSchema.optional(),
  promptName: z.string().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
