/**
 * Unified Artifact protocol for the P2 WorkBuddy pipeline.
 *
 * Every office skill (src/skills/*) returns a structured Artifact rather than
 * raw text, so the renderer can preview it, templates can restyle it, and a
 * later sub-agent layer can hand it off between processes. The artifact rides
 * the existing tool-result channel as a JSON envelope inside ToolResult.content
 * (see toArtifactContent / parseArtifactContent) — the core chat loop and the
 * ToolResult contract stay untouched.
 */

export const ARTIFACT_VERSION = 1 as const;

export const ARTIFACT_TYPES = [
  'sheet',
  'chart',
  'ppt',
  'docx',
  'markdown',
  'html',
  'image',
  'csv',
  'dataframe',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = ['draft', 'partial', 'done', 'error'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_ORIGINS = ['user', 'main', 'task'] as const;
export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

export interface ArtifactMeta {
  sessionId: string;
  skill: string;
  origin: ArtifactOrigin;
}

/** Where an artifact's binary payload lives, when it has one (M1+). */
export interface ArtifactRef {
  kind: 'inline' | 'base64' | 'file';
  path?: string;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  version: number;
  status: ArtifactStatus;
  meta: ArtifactMeta;
  /** Structured, type-specific content (rows / vega spec / slides / …). */
  body: unknown;
  refs?: ArtifactRef[];
  error?: string;
  /** Incremental update channel (partial → done). */
  patch?: Partial<Artifact>;
}

export interface ArtifactEnvelope {
  __artifactVersion: typeof ARTIFACT_VERSION;
  artifact: Artifact;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Structured validation; returns a human-readable reason, or null when valid. */
export function validateArtifact(a: unknown): string | null {
  if (!isRecord(a)) return 'artifact must be an object';
  const { id, type, title, version, status, meta } = a;
  if (typeof id !== 'string' || id.length === 0) return 'artifact.id must be a non-empty string';
  if (!ARTIFACT_TYPES.includes(type as ArtifactType))
    return `artifact.type must be one of: ${ARTIFACT_TYPES.join(', ')}`;
  if (typeof title !== 'string') return 'artifact.title must be a string';
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return 'artifact.version must be a positive integer';
  if (!ARTIFACT_STATUSES.includes(status as ArtifactStatus))
    return `artifact.status must be one of: ${ARTIFACT_STATUSES.join(', ')}`;
  if (!isRecord(meta)) return 'artifact.meta must be an object';
  if (typeof meta.skill !== 'string' || meta.skill.length === 0)
    return 'artifact.meta.skill must be a non-empty string';
  if (typeof meta.sessionId !== 'string') return 'artifact.meta.sessionId must be a string';
  if (!ARTIFACT_ORIGINS.includes(meta.origin as ArtifactOrigin))
    return `artifact.meta.origin must be one of: ${ARTIFACT_ORIGINS.join(', ')}`;
  if (a.error !== undefined && typeof a.error !== 'string') return 'artifact.error must be a string';
  if (a.refs !== undefined) {
    if (!Array.isArray(a.refs)) return 'artifact.refs must be an array';
    for (const r of a.refs) {
      if (!isRecord(r) || !['inline', 'base64', 'file'].includes(String(r.kind)))
        return 'artifact.refs[] must be { kind: inline | base64 | file, path?: string }';
      if (r.path !== undefined && typeof r.path !== 'string')
        return 'artifact.refs[].path must be a string';
    }
  }
  return null;
}

/** True when `x` is a structurally-valid Artifact. */
export function isArtifact(x: unknown): x is Artifact {
  return validateArtifact(x) === null;
}

/** Serialize an artifact into a ToolResult.content envelope. */
export function toArtifactContent(artifact: Artifact): string {
  return JSON.stringify({ __artifactVersion: ARTIFACT_VERSION, artifact });
}

/**
 * Parse a tool-result string into its embedded artifact, or null when the
 * content is not an artifact envelope (plain tool output, other JSON, …).
 */
export function parseArtifactContent(content: string): Artifact | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  if (content.charCodeAt(0) !== 0x7b /* '{' */) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return null;
    if (parsed.__artifactVersion !== ARTIFACT_VERSION) return null;
    const artifact: unknown = parsed.artifact;
    if (validateArtifact(artifact) !== null) return null;
    return artifact as Artifact;
  } catch {
    return null;
  }
}