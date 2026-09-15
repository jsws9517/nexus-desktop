/**
 * P1 — Sidebar Extension API (borrowed from DSH Better SideBar).
 *
 * See docs/dsh-plugin-adoption-plan.md §4. This Nexus-Desktop port maps the
 * plan's React-based surface onto the project's vanilla-DOM renderer:
 *
 *   plan §4.3 React type              → this DOM mapping
 *   ─────────────────────────────────    ────────────────────────────────────
 *   component: React.ComponentType    → mount(ctx): () => void  (DOM factory)
 *   context.sessionId                 → ctx.sessionId
 *   context.subscribe(fn)→() => void  → ctx.subscribe(event) → unsubscribe
 *
 * The "component" contract is a pure DOM construction: `mount` receives a
 * container element + context, appends its UI, and returns a dispose function
 * that MUST release every subscription and DOM node it created. The registry
 * guarantees dispose is called exactly once when a tab is opened, closed, or
 * replaced — no leaked subscriptions or workers (§4.5).
 *
 * The registry is intentionally framework-free and dependency-injected so it
 * stays unit-testable in `node --test` (no DOM needed for registry logic;
 * page modules test the DOM path with a minimal fake container).
 */

import type { AgentEvent } from '../../agent/types.js';

/** Context handed to a sidebar page at mount time. */
export interface SidebarContext {
  /** The session whose events drive this page ('' = default session). */
  sessionId: string;
  /** Live accessor for the CURRENT active session — pages use this to stay
   *  bound to the focused workspace even after the user switches tabs. */
  getActiveSessionId?(): string;
  /** Live parallel-execution state (same Map renderer.ts maintains). */
  getParallelSessions(): ReadonlyMap<string, ParallelSessionView>;
  /** Recycle finished sessions (TTL sweep + hard cap). Optional guard for
   *  pages built against older contexts. */
  pruneParallelSessions?(ttlMs?: number): number;
  /** Force-close stale parallel runs (per-task timeout + dead-batch sweep) so a
   *  task card never sits in "running" forever. Optional — pages may call it
   *  from their own render/timer loop to self-heal. */
  forceCloseStaleTasks?(): void;
  /** Subscribe to the agent event bus; returns an unsubscribe function. */
  subscribe(fn: (event: AgentEvent) => void): () => void;
}

/** Minimal structural view of a parallel execution session (avoids importing renderer.ts). */
export interface ParallelTaskView {
  description?: string;
  status: string;
  output?: string;
  durationMs?: number;
  error?: string;
}

export interface ParallelSessionView {
  sessionId: string;
  prompt: string;
  startTime: number;
  tasks: ReadonlyMap<string, ParallelTaskView>;
}

/** A registrable sidebar tab. Title/icon are read once at registration. */
export interface SidebarTabRegistration {
  /** Stable id, e.g. 'sub-agents'. Duplicate ids are rejected. */
  id: string;
  title: string;
  icon?: string;
  /**
   * Build the page UI into `container` and return a dispose function.
   * The registry stores the returned dispose and calls it on close/replace.
   */
  mount(container: HTMLElement, ctx: SidebarContext): () => void;
}

/** Optional hook invoked when the registry itself is torn down. */
export type SidebarRegistryDispose = () => void;

export interface SidebarRegistry {
  register(reg: SidebarTabRegistration): void;
  unregister(id: string): boolean;
  list(): SidebarTabRegistration[];
  get(id: string): SidebarTabRegistration | undefined;
  /** Remove every registration and dispose any mounted page. Returns count removed. */
  clear(): number;
}