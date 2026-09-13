# DSH Plugin Adoption Plan — Requirements & Design

> Status: Proposed
> Created: 2026
> Related: [Multi-Agent Parallel Architecture](./multi-agent-parallel-architecture.md) · [Sub-Agent Architecture](./sub-agent-architecture.md) · [Implementation Plan (Multi-Agent Parallel)](./implementation-plan-multi-agent-parallel.md) · [Phase Execution Plan](./phase-execution-plan.md)

---

## 1. Executive Summary

This document specifies the requirements and design for selectively adopting ideas from **five DeepSeek Harness (DSH) ecosystem plugins** into the Nexus-Desktop agent project. Rather than porting code wholesale, the goal is to **borrow proven interaction patterns, capability models, and extension architectures** — each mapped onto Nexus-Desktop's existing Electron/worker/knowledge-graph infrastructure in priority order.

**Adoption verdict (high-level):**

| Priority | Source Plugin | Verdict | Rationale |
|----------|---------------|---------|-----------|
| P0 | Tolten Aegis | **Adopt (full)** | Deepest fit: "project constitution" enforced at every model step, directly complements the planned isolated sub-agent architecture |
| P1 | DSH Better SideBar | **Adopt (full)** | Open sidebar extension API + dedicated sub-agent page aligns with the planned `ParallelExecutionCard` UI |
| P2 | dsh-web (selective) | **Adopt (3 capabilities)** | Usage statistics, per-model capability declaration, task board (deferred) |
| P3 | dsh-TUI (concepts only) | **Adopt (interaction patterns)** | Context progress bar, TPS gauge, double-Esc rewind — renderer-layer only |
| P4 | ModLens | **Adopt (routing strategy only)** | Vision toolchain already exists (`ocr_extract` / `analyze_image`); borrow only the auto-detect-and-route idea |

**Guiding principle:** one thing at a time. P0 + context gauge first, validate value, then proceed. Never adopt all five at once — it would overload both worker processes and context windows.

---

## 2. Background & Rationale

### 2.1 Current State of Nexus-Desktop

- **Runtime**: Electron desktop app; each open tab owns its own `WorkerHost` OS process (see `src/main/session-workers.ts`).
- **Agent core**: `AgentService` runs single-agent, serial tool execution outside plan mode.
- **Knowledge graph**: `~/.nexus/native/data/memory.jsonl`, backed by `remember` / `recall` / `create_entities` / etc.
- **Prompt decoration**: `AgentService` already supports `ctx.prependToSystem()` / `replaceSystemByMarker()` (see the WORK_MARKER work-mode enforcement precedent in `src/agent/service.ts`).
- **Permissions & audit**: path authorizer + audit manager with an `askUser` bridge routed through the UI; auto/unattended modes treat audit gates as auto-approved.
- **MCP**: single main-process hub (`mcp-hub.ts`) proxies MCP tools for all workers (one OS process per MCP server).
- **Planned**: multi-agent parallel architecture (orchestrator + isolated sub-agent sessions) per `multi-agent-parallel-architecture.md`.

### 2.2 Why DSH Plugins Are Relevant

DeepSeek Harness ("Everything is a Plugin") has produced a fast-moving plugin ecosystem with
battle-tested solutions to problems Nexus-Desktop shares: context visibility, rule enforcement,
vision bridging, sidebar extensibility, and usage transparency. All five plugins evaluated here
are open source (MIT or Apache-2.0) and can be studied as reference implementations.

### 2.3 Evaluation Method

Each plugin was assessed on four axes: **value to the product**, **fit with existing architecture**,
**implementation cost**, and **risk**. Sources cited in [§9 References](#9-references).

---

## 3. P0 — Tolten Aegis: Project Constitution & Knowledge Enforcement

### 3.1 Reference

- **Repository**: https://github.com/EmmanuelMartinez/tolten-aegis
- **License**: MIT
- **Website**: (none) · Author: Ing. Oscar Emmanuel Martínez Galán

### 3.2 Problem It Solves

> "Every project already has a brain: the rules the team agreed on, the skills that encode *how to build*, the MCP servers that expose the app's tools. But your agent **ignores them until you remind it**."

Nexus-Desktop has no mechanism to enforce project-level rules on every model step. The existing
knowledge graph stores *user* facts; it does not carry *project* rules into the agent's system prompt.

### 3.3 Concepts to Borrow

| Aegis Concept | Description | Nexus-Desktop Mapping |
|---|---|---|
| **Constitution injection** | `.agents/rules/DEEPSEEK.md` injected into **every** model step | Reuse `ctx.prependToSystem()` with a dedicated `[Project Constitution]` marker; auto-removed when the rule set is empty |
| **`.agents` directory standard** | One folder per project: `skills/<skill>/SKILL.md`, `rules/DEEPSEEK.md`, `mcp.json` | Adopt the same standard at the project root (see [§3.5](#35-agents-directory-spec)) |
| **Native knowledge tools** | `agents_index`, `agents_read`, `agents_search` callable by the agent | Add three built-in tools registered in `src/tools/index.ts` (see [§3.6](#36-tool-specifications)) |
| **Global + project scopes** | Global config in `~/.dsh/aegis-mcp.json`, project config in `.agents/mcp.json` | Global in `~/.nexus/config.json`; project in `.agents/` under the authorized project root |
| **Constitution fallback chain** | `DEEPSEEK.md` → `CLAUDE.md` → `AGENTS.md` → `.clinerules` → root `AGENTS.md` | Same precedence, evaluated left-to-right, first existing file wins |

### 3.4 Scope & Non-Goals

**In scope**
- Read-only discovery of project `.agents/` (respecting the existing path-authorizer boundary).
- Constitution injection at every model step for **local** sessions.
- Three knowledge tools (`agents_index` / `agents_read` / `agents_search`).
- Project-scoped MCP server loading via `.agents/mcp.json` (merged through the existing main-process hub).

**Out of scope (v1)**
- The "Control Center" M3 panel (deferred to P2 UI phase).
- Live editing of rules from the UI.
- Preset installer (no `.agent-presets` concept in Nexus-Desktop).

### 3.5 `.agents` Directory Spec

```
<project-root>/
└── .agents/
    ├── skills/<skill-name>/SKILL.md   ← optional; how to build X (markdown w/ front-matter)
    ├── rules/DEEPSEEK.md              ← project constitution (highest precedence)
    └── mcp.json                       ← optional; standard { "mcpServers": {...} } format
```

**Constitution fallback chain** (first existing wins):
`rules/DEEPSEEK.md` → `rules/CLAUDE.md` → `rules/AGENTS.md` → root `.clinerules` → root `AGENTS.md` → any `rules/*.md`.

**Security note**: `.agents/rules/*.md` is **system-level instruction input**. It MUST be treated as
untrusted until the user authorizes the directory (path authorizer). Loaded rule text is appended to
the system prompt under a clearly delimited marker so it can be stripped or bisected for audit.
This mirrors the discipline already applied to WORK_MARKER prompt decoration and `remember` writes.

### 3.6 Tool Specifications

```typescript
// src/tools/agents.ts (new)

/**
 * List every skill and rule declared in the current project's .agents directory.
 * Returns a structured index (names, paths, one-line descriptions).
 */
export const AGENTS_INDEX_TOOL: ToolDef = {
  name: 'agents_index',
  description: 'List all skills and rules declared in the project .agents directory.',
  inputSchema: { type: 'object', properties: {} },
};

/**
 * Read any file under .agents/** or the resolved constitution file.
 * Subject to the path authorizer (deny outside authorized roots).
 */
export const AGENTS_READ_TOOL: ToolDef = {
  name: 'agents_read',
  description: 'Read a file from the project .agents directory or the constitution.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path under .agents/' },
    },
    required: ['path'],
  },
};

/**
 * Keyword search over skill/rule content to find which rule covers a topic.
 */
export const AGENTS_SEARCH_TOOL: ToolDef = {
  name: 'agents_search',
  description: 'Search project skills/rules for the rule or skill covering a topic.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
};
```

### 3.7 Constitution Injection Design

```typescript
// src/agent/service.ts (modification sketch)

const CONSTITUTION_MARKER = '[Project Constitution]';

/** Called once per session start (and on .agents change via a watcher). */
private async loadConstitution(cwd: string): Promise<string | null> {
  const file = await resolveConstitutionFile(cwd); // DEEPSEEK.md → CLAUDE.md → ... (see §3.5)
  if (!file) return null;
  return safeReadConstitution(file); // size-capped (e.g. ≤ 32 KB), marker-delimited
}

// Inside chat() / prompt building:
const constitution = await this.loadConstitution(process.cwd());
if (constitution) {
  // Marker delimiters keep it strippable and auditable.
  ctx.prependToSystem(`\n\n${CONSTITUTION_MARKER}\n${constitution}\n${CONSTITUTION_MARKER}\n`);
}
```

**Sub-agent inheritance (multi-agent phase):** because sub-agents run in fully isolated sessions,
the Orchestrator MUST pass the constitution text explicitly in the sub-task prompt (never rely on
implicit filesystem discovery inside the child worker). This matches Aegis's global+project scope
model and keeps isolation guarantees intact.

### 3.8 Acceptance Criteria

- [ ] With `.agents/rules/DEEPSEEK.md` present, every LLM step in a local session includes the rule text.
- [ ] Removing the file (or clearing the marker) removes the text from subsequent steps.
- [ ] `agents_index` / `agents_read` / `agents_search` work within authorized roots; out-of-root paths are denied.
- [ ] Constitution loading honors the path-authorizer grant (unattended-safe, no dead-stdin prompt).
- [ ] Loading a > 32 KB constitution is refused with an explicit error (no silent context bloat).

---

## 4. P1 — DSH Better SideBar: Open Sidebar Extension Base

### 4.1 Reference

- **Repository**: https://github.com/omdsh-dev/DSH-better-sidebar
- **License**: MIT · npm: `dsh-better-sidebar`
- **Dependency**: DSH ≥ 0.1.5-rc.1+

### 4.2 Concepts to Borrow

| Better SideBar Concept | Nexus-Desktop Mapping |
|---|---|
| `registerTab()` / `registerFileViewer()` open API | Renderer sidebar registry + IPC bridge (`ipcMain.handle('sidebar:registerTab', …)`) |
| Built-in pages: file render/edit, terminal, side chat, Git, **sub-agent** | File view → existing code viewer; terminal → new; side chat → new; Git → wrap existing 36 `git_*` tools; **sub-agent page → aggregate `ParallelExecutionCard` view** |
| Extension model decoupled from core chat flow | Sidebar pages live outside the main conversation stream, keeping core context lean |

### 4.3 Sidebar Extension API (v1 Surface)

```typescript
// src/renderer/sidebar/registry.ts (new)

export interface SidebarTabRegistration {
  id: string;                 // stable, e.g. 'sub-agents'
  title: string;
  icon?: string;
  component: React.ComponentType;
  /** Context provided to the page: sessionId, worker status, event bus */
  context: { sessionId: string; subscribe: (fn: (e: AgentEvent) => void) => () => void };
}

export interface SidebarRegistry {
  register(reg: SidebarTabRegistration): void;
  unregister(id: string): void;
  list(): SidebarTabRegistration[];
}
```

### 4.4 Sub-Agent Page (Flagship Use Case)

The sub-agent sidebar page is the **rendering surface for the multi-agent parallel architecture**
(Phase 2/3 of `multi-agent-parallel-architecture.md`). It shows:

- Live task cards (per `SubTaskStatus`: pending / queued / running / succeeded / failed / timeout / cancelled).
- Progress indicators and duration per task.
- Aggregated result view with per-task token usage.
- Drill-down into a finished task's output (markdown rendered).

```tsx
// src/renderer/components/SubAgentSidebarPage.tsx (new)
// Renders <ParallelExecutionCard taskId={..} status={..} output={..} durationMs={..} error={..}/>
// for every task in the active orchestration run, subscribed via the event bus
// ('parallel_start' / 'task_progress' / 'parallel_end').
```

### 4.5 Acceptance Criteria

- [ ] Arbitrary built-in pages register through a single `registerTab` surface.
- [ ] Sub-agent page renders live parallel-execution cards with no blocking of the chat stream.
- [ ] IPC channel is typed end-to-end (shared `SidebarEvent` types between main and renderer).
- [ ] Registry cleanup on tab close (no leaked subscriptions or workers).

---

## 5. P2 — dsh-web: Selective Adoption (3 Capabilities)

### 5.1 Reference

- **Repository**: https://github.com/zhu1090093659/dsh-web
- **Stars**: ~7,500 · **License**: Apache-2.0 · **npm**: `@linxin666/dsh-web-all`
- **Marketplace**: https://dsh-market.com

### 5.2 Capability 1 — Usage Statistics & Token Bank

**Why:** desktop agent users need cost visibility.

| Requirement | Detail |
|---|---|
| Per-session token totals | Accumulate `tokenUsage.{prompt,completion}` (structure already exists in `SubTaskResult` and `ChatResult`) |
| Per-provider / per-model breakdown | Group by `getStatus()` provider+model; persist daily aggregates in `~/.nexus/tasks/outputs` or a small stats table |
| Cost estimate (optional) | Only for providers with known pricing; clearly labeled as estimate |
| UI | Settings → Usage panel (P2 UI phase) |

**Implementation cost: low** (renderer + counters).

### 5.3 Capability 2 — Per-Model Capability Declaration

**Why:** replaces the manual `modelContextLimits` maintenance the compression detector currently complains about.

```jsonc
// ~/.nexus/config.json (extension — backward compatible)
{
  "modelCapabilities": {
    "agnes-2.5-flash": { "contextLimit": 524288, "vision": false, "thinking": true },
    "deepseek-v4-pro":   { "contextLimit": 131072, "vision": false, "thinking": true }
  }
}
```

- Worker `getStatus()` reports capability overrides; renderer model selector surfaces them.
- Compression detector message (≥3 compresses/5 min) is **replaced** by the declared values when present.
- **Lowest-cost fix** for the existing "context limit may not match reality" warning.

**Implementation cost: low** (config read + status propagation).

### 5.4 Capability 3 — Task Board + Cron Scheduling (Deferred)

**Why deferred:** requires the multi-agent parallel architecture to exist first (tasks need a real
agent-run entity). Track in the multi-agent roadmap under Phase 4 "optimization/operations".

| Idea | Notes |
|---|---|
| Kanban columns | todo / in-progress / done / failed (mirrors `SubTaskStatus`) |
| Cron real execution | Host-side scheduler in main process, like dsh-web's Host-triggered runs |
| Session reuse | Reuse idle session if the previous run is still alive (dsh-web feature) |

**Implementation cost: high** → schedule after P0/P1 land.

### 5.5 Explicitly NOT Adopted From dsh-web

| dsh-web Feature | Reason to Skip |
|---|---|
| Mobile remote control | Desktop app; duplication with Todesk remote setup already in use |
| SSH ops panel | Out of product scope (no server-ops use case in Nexus-Desktop) |
| Theme skins | Cosmetic; low ROI for an internal tool |
| DSH Desktop packaging | Nexus-Desktop **is** the desktop app |

---

## 6. P3 — dsh-TUI: Interaction Concepts Only

### 6.1 Reference

- **Repository**: https://github.com/ccch1mneyyy/dsh-TUI
- **Stars**: ~3,000 · **License**: MIT · **npm**: `@deepseek-harness-tui/dsh-tui` · **Site**: https://dshtui.com

### 6.2 Concepts to Borrow (renderer layer only — no terminal UI port)

| Concept | Business Value | Mapping |
|---|---|---|
| **Context progress bar** | Users see context saturation *before* it breaks | Upgrade the compression detector: render a live gauge (green→amber→red) from `ctx.onProgress` + declared `contextLimit` from §5.3 |
| **TPS gauge** | Perceived responsiveness during streaming | Measure token delta / wall time in the streaming path; show in the header of the active tab |
| **Double-Esc rewind** | "Undo" an agent turn back to a prior tool-call boundary | UI affordance over `/revise` + `prepareParentMemory`; add a time-rewind picker in session view |

**Implementation cost: low** (all renderer/UI; zero worker-core changes).

---

## 7. P4 — ModLens: Routing Strategy Only

### 7.1 Reference

- **Repository**: https://github.com/liustack/modlens
- **Stars**: ~4,000 · **License**: MIT · **npm**: `@liustack/modlens`
- **Author ecosystem**: ModSearch (search), AIManager (desktop wrapper), dsh-screenshot

### 7.2 Why Not Adopt the Plugin Body

Nexus-Desktop already ships equivalent vision tooling:
- `ocr_extract` (ds-ocr) — text extraction from images
- `analyze_image` (agnes-2v) — general image understanding
- `read_media_file` — inline media rendering

ModLens's "paste image → structured JSON evidence" is already achievable through this toolchain.

### 7.3 The One Thing Worth Borrowing: Auto-Detect & Route

ModLens auto-discovers text-only provider routes and wraps them (e.g. `DeepSeek-V4 (modlens vision)`),
excluding native-multimodal models. Nexus-Desktop equivalent (small, high-value):

1. In the model selector, mark models whose declared capability is `vision: false` (from §5.3).
2. Inject a one-line system hint on those routes: *"You cannot see images natively; when the user provides an image, use `ocr_extract` or `analyze_image`."*
3. Skip the hint when `vision: true` or unknown (native vision preserved — same conservative rule as ModLens).

**Implementation cost: low** (config read + prompt decoration conditional).

---

## 8. Consolidated Roadmap

| Phase | Window | Deliverables | Dependencies |
|---|---|---|---|
| **P0-Quick Wins** | Week 1 | Aegis constitution injection + `agents_*` tools; context progress bar + TPS; model capability declaration + vision-route hint | None |
| **P1-UX Extensions** | Week 2–3 | Sidebar registry + sub-agent page; usage statistics panel | P0-Quick Wins (constitution passes into sub-tasks) |
| **P2-Parallel Sync** | Week 4–6 | Multi-agent parallel executor (per existing doc); constitution inheritance in sub-agent prompts; task cards live in sidebar | P1-UX Extensions |
| **P3-Operations** | Later | Task board + cron; session archive | P2-Parallel Sync |

### 8.1 Sequencing Rules

1. Land P0 before the parallel architecture — sub-agents inherit the constitution from day one.
2. Land the sidebar regist征 with the parallel UI phase (one renderer effort).
3. Never merge two features that both touch the same prompt-decoration path in one change set
   (constitution, WORK_MARKER, vision hint — keep markers distinct and independently strippable).

### 8.2 Dependency Diagram (ASCII)

```
Week 1 ─ P0-Quick Wins
│         ├─ Aegis constitution injection + agents_* tools
│         ├─ Context progress bar + TPS gauge
│         └─ Model capability declaration + vision-route hint
│                    │
Week 2–3 ─ P1-UX Extensions
│            ├─ Sidebar registry + sub-agent page (needs: constitution for sub-task injection)
│            └─ Usage statistics panel (needs: capability declaration for cost attribution)
│                    │
Week 4–6 ─ P2-Parallel Sync
│            ├─ Multi-agent parallel executor (multi-agent-parallel-architecture.md)
│            ├─ Constitution inheritance in sub-agent prompts (explicit, orchestrator-passed)
│            └─ Task cards live in sidebar page
│                    │
Later ──── P3-Operations
             ├─ Task board + cron scheduler (needs: real task entity from P2)
             └─ Session archive
```

---

## 9. References & Annotations

### 9.1 External Plugin Sources (evaluated 2026)

| # | Plugin | Repository | License | Key Concepts Referenced | Adopted Into |
|---|---|---|---|---|---|
| 1 | Tolten Aegis | https://github.com/EmmanuelMartinez/tolten-aegis | MIT | `.agents` standard; constitution injection per model step; `agents_index/read/search`; global+project MCP scopes; fallback chain `DEEPSEEK.md→CLAUDE.md→AGENTS.md→.clinerules→AGENTS.md` | §3 (P0, full) |
| 2 | DSH Better SideBar | https://github.com/omdsh-dev/DSH-better-sidebar | MIT | Open sidebar API (`registerTab` / `registerFileViewer`); built-in file/terminal/chat/Git/sub-agent pages; extension decoupling from core chat | §4 (P1, full) |
| 3 | dsh-web (aggregation) | https://github.com/zhu1090093659/dsh-web | Apache-2.0 | Task board + cron; per-model capability declaration; usage statistics / token bank; Kanban status model; session reuse | §5 (P2, selective) |
| 4 | dsh-TUI | https://github.com/ccch1mneyyy/dsh-TUI | MIT | Context progress bar; TPS gauge; double-Esc time rewind; streaming thinking display | §6 (P3, concepts) |
| 5 | ModLens | https://github.com/liustack/modlens | MIT | Vision bridge for text-only models; auto-discovery of text-only routes; wrapped model entries (`(modlens vision)`); conservative exclusion of native-vision models | §7 (P4, routing only) |

### 9.2 Ecosystem Landing Pages

- DeepSeek Harness core: https://github.com/deepseek-ai/deepseek-harness ("Everything is a Plugin")
- DSH marketplace (creative workshop): https://dsh-market.com
- DSH plugin search: https://dshfind.com
- ModLens author ecosystem: https://github.com/liustack/modsearch · https://github.com/liustack/aimanager

### 9.3 Nexus-Desktop Internal References

| Document / Module | Used For |
|---|---|
| [Multi-Agent Parallel Architecture](./multi-agent-parallel-architecture.md) | Sub-agent page, parallel execution cards, orchestrator design (§4 here) |
| [Sub-Agent Architecture](./sub-agent-architecture.md) | Worker isolation model; constitution inheritance design (§3.7 here) |
| [Implementation Plan (Multi-Agent Parallel)](./implementation-plan-multi-agent-parallel.md) | Phase timing of the parallel sync |
| `src/agent/service.ts` | `ctx.prependToSystem()` / WORK_MARKER / compression detector hooks (§3.7, §6.2) |
| `src/main/session-workers.ts` | Per-tab worker model; `getStatus` capability reporting (§5.3) |
| `src/tools/index.ts` | Tool registration point for `agents_*` tools (§3.6) |
| `src/renderer/session-view.tsx` | Event handling for `parallel_start` / `task_progress` / `parallel_end` (§4.4) |

### 9.4 Security & Boundary Annotations

1. **Constitution text is system-level instruction input** — never trust it until the containing
   directory is authorized by the path authorizer; keep marker-delimited so it is strippable/auditable.
2. **Rule files apply only to authorized project roots** — the user's known constraint that
   `D:\agent-cli\nexus-coder` is off-limits without authorization is preserved by the existing
   authorizer; `.agents/` discovery never bypasses it.
3. **Sub-agent inheritance must be explicit** — orchestrator passes constitution text in the prompt,
   never implicit filesystem reads inside isolated workers.
4. **Size caps** — constitution ≤ 32 KB; tool outputs follow the existing `MAX_TOOL_RESULT_CHARS` regime.
5. **Marker hygiene** — constitution, WORK_MARKER, and vision hint are three distinct markers;
   replacing one must never remove another.

---

## 10. Metrics & Success Criteria

| Metric | Baseline (today) | Target (post-adoption) |
|---|---|---|
| Rule-following (agreed project rules present in transcript) | Not measured / ad-hoc | 100% of steps contain constitution when present |
| Context overflow warnings | Frequent manual `modelContextLimits` fixes | Declared limits end the "3× compress in 5 min" firefighting |
| Time to understand a rule conflict | Manual re-read of docs | `agents_search` answers in one tool call |
| Parallel-run visibility | N/A (serial) | Full task-card live view in sidebar |
| User-perceived streaming responsiveness | N/A | TPS gauge + context gauge visible |

---

## 11. Testing Strategy

### 11.1 Unit Tests (`node --test`, `test/*.test.mjs`)

| Area | Coverage | File (new) |
|---|---|---|
| Constitution resolution | Fallback chain `DEEPSEEK.md→CLAUDE.md→AGENTS.md→.clinerules→root AGENTS.md`; first-existing-wins; empty `.agents/` returns null | `test/agents-constitution.test.mjs` |
| Size cap | > 32 KB constitution refused with explicit error; no silent truncation | same |
| `agents_*` tools | Index/read/search against a fixture `.agents/` tree; out-of-root path denied by authorizer mock | `test/agents-tools.test.mjs` |
| Capability merge | `modelCapabilities` overlay on defaults; `vision: unknown` stays conservative (native behavior preserved) — mirrors ModLens exclusion rule | `test/model-capabilities.test.mjs` |
| Vision route hint | Hint injected only when `vision: false`; absent for `true`/`unknown` | same |
| TPS / context gauge | Token-delta over wall-time; green→amber→red thresholds from declared `contextLimit` | `test/gauges.test.mjs` |

### 11.2 Integration Tests (RPC smoke, `scripts/smoke-test.mjs` pattern)

- Local session with `.agents/rules/DEEPSEEK.md` → every step's built prompt contains `[Project Constitution]` marker (audit hook assertion).
- Removing the file mid-session → next step's marker absent (watcher path).
- Sub-agent (parallel phase): orchestrator-passed constitution appears exactly once in child prompt; child worker performs no filesystem discovery.
- Sidebar `registerTab` round-trip: main→renderer→main with typed `SidebarEvent`; unregister cleans subscriptions (no leaked listeners after tab close).

### 11.3 Renderer Tests

- Sidebar registry add/remove/list; duplicate `id` rejected.
- Sub-agent page renders `SubTaskStatus` cards from synthetic `task_progress` events.
- Usage panel groups per-provider/per-model aggregates from fixture token counters.

---

## 12. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Constitution rules bloat context (hidden token cost on every step) | Medium | Medium | Hard 32 KB cap + user-visible marker size telemetry in usage panel (§5.2) |
| R2 | Malicious/poisoned rule file instructs agent to exfiltrate data | Low | High | Rules treated as untrusted until directory authorized by path authorizer; marker-delimited for audit/strip (§9.4.1); same discipline as `remember` writes |
| R3 | Sub-agent constitution drift (child ignores or duplicates rules) | Medium | Medium | Orchestrator explicitly passes constitution text; integration test §11.2 asserts exactly-once injection |
| R4 | Sidebar registry leaks subscriptions across tab closes | Medium | Medium | Mandatory unregister on tab close; typed lifecycle events; integration test §11.2 |
| R5 | Wrong declared `contextLimit` silences real compression warnings | Medium | High | Declared values only replace the warning when present; `vision`/`contextLimit` unknown defaults keep current detector behavior; warning still logged on 3×/5 min as fallback |
| R6 | Vision-route hint misfires on natively-vision models | Low | Low | Conservative rule: hint only when capability positively confirms `vision:false` (identical to ModLens §7.3.3) |
| R7 | Adoption scope creep (all five plugins at once) | Medium | High | Sequencing rules §8.1; P0 first, value-gate before P1 |

---

## 13. Change Log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026 | Initial requirements & design (P0–P4 adoption analysis, references §9, security annotations §9.4) |
| 1.1 | 2026 | Added dependency diagram (§8.2), testing strategy (§11), risk register (§12); version bumped |

---

*Document Version: 1.1*
*Last Updated: 2026*
*Borrowed-from: DeepSeek Harness plugin ecosystem (Aegis · Better SideBar · dsh-web · dsh-TUI · ModLens)*