import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'custom']),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  model: z.string(),
  maxContextTokens: z.number().optional(),
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

export const AcpTimeoutConfigSchema = z.object({
  /** Per-chunk idle timeout (ms) for LLM streams; a stalled stream is aborted. */
  chunkIdleMs: z.number().int().positive().optional(),
  /** Turn deadline timeout (ms) for remote/ACP channels (process exits on expiry). */
  watchdogRemoteMs: z.number().int().positive().optional(),
  /** Heartbeat interval (ms) — periodic session/update ping so the transport
   *  (cc-connect) knows the agent is alive during long-running tasks. */
  heartbeatMs: z.number().int().positive().optional(),
});

export const AcpConfigSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().optional(),
  agents: z.array(AcpAgentSchema).optional(),
  skillsPath: z.string().optional(),
  timeouts: AcpTimeoutConfigSchema.optional(),
});

export const VisionProviderConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  model: z.string(),
});

export const QualityGateConfigSchema = z.object({
  autoTest: z.boolean().optional(),
  autoCommit: z.boolean().optional(),
});

/**
 * Permission whitelist (白名单) — lets the user pre-approve a set of tools so
 * the agent never prompts for them during a session. Useful for "edit mode"
 * where write_file / edit_file / etc. should run without confirmation.
 */
export const PermissionsConfigSchema = z.object({
  /** Tools that are auto-approved (never prompt). `*` = all tools. */
  allowlist: z.array(z.string()).optional(),
  /** 'auto' = honor the allowlist; 'prompt' = always ask (default). */
  mode: z.enum(['prompt', 'auto']).optional(),
  /**
   * Path whitelist for exec_command. When a command's effective working
   * directory resolves under one of these paths, exec is auto-approved
   * (without prompting) — as long as the command is not dangerous.
   * '~' expands to the user home; '.' / empty means the agent's start cwd.
   */
  safePaths: z.array(z.string()).optional(),
  /**
   * MCP whitelist. Entries auto-approve MCP tools without prompting:
   *   'mcp:*'            — all MCP tools from every server
   *   'mcp:<server>'     — all tools from a specific MCP server (e.g. mcp:thinking)
   *   '<toolName>'       — a specific tool by its exact name (e.g. sequentialthinking)
   */
  mcpAllowlist: z.array(z.string()).optional(),
});

export const PERMISSION_PRESETS: Record<string, { allowlist: string[]; description: string }> = {
  edit: {
    allowlist: [
      'read_file', 'file_read', 'read_text_file', 'read_multiple_files',
      'read_files', 'search_files', 'grep', 'glob', 'list_files',
      'list_directory', 'directory_tree', 'get_file_info',
      'write_file', 'file_write', 'edit_file', 'file_edit',
      'create_file', 'append_file', 'create_directory',
      'move_file', 'rename', 'copy_file',
    ],
    description: '白名单模式：允许所有读写文件工具，无需反复确认',
  },
};

export const ConfigSchema = z.object({
  activeProvider: z.string(),
  providers: z.record(ProviderConfigSchema),
  mcpServers: z.record(ServerConfigSchema).optional(),
  acp: AcpConfigSchema.optional(),
  promptName: z.string().optional(),
  modelContextLimits: z.record(z.number()).optional(),
  nativeInstalled: z.array(z.string()).optional(),
  language: z.enum(['en', 'zh-CN']).optional(),
  activeVisionProvider: z.string().optional(),
  visionProviders: z.record(VisionProviderConfigSchema).optional(),
  visionMode: z.enum(['local-first', 'cloud-first', 'local-only', 'cloud-only']).optional(),
  qualityGate: QualityGateConfigSchema.optional(),
  permissions: PermissionsConfigSchema.optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type AcpConfig = z.infer<typeof AcpConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
