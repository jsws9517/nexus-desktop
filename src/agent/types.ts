/** Shared types of the desktop agent bridge. */

/** Loose event shape forwarded from the core to the UI bridge. */
export type AgentEvent = { type: string } & Record<string, unknown>;

export interface PermissionRequest {
  id: string;
  question: string;
}

export interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
}