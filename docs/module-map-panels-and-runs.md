# Desktop module map — panels, execution paths, tool selection

> **Status**: Reference (re-verified against this tree, 2026-10-04).
> **Scope**: `nexus-desktop`. Core-side DAG / Sub-agent / Jobs responsibilities and
> trigger matrix live in `nexus-coder/docs/architecture-dag-subagent-jobs.md`.
> **Line numbers are pointers, not contracts** — re-verify with grep after any refactor.
>
> ⚠️ The older design docs in this folder
> (`multi-agent-parallel-architecture.md`, `implementation-plan-multi-agent-parallel.md`,
> `phase-execution-plan.md`) describe a path that was **never wired** — see §3. They
> are marked `SUPERSEDED`.

---

## 1. The three sidebar panels and their data sources

| Panel | Data source | Events that re-render it | Written by |
|---|---|---|---|
| **Tasks ("task progress")** — chat stream right rail | `tasks: Map<taskId, TaskItem>` (`src/renderer/renderer.ts:745`) | `task_graph`, `task_started/completed/failed/interrupted` — dispatched at `renderer.ts:1599` / `:1609` into `handleTaskEvent` (`:3488`), rendered by `renderTasks` (`:3404`) | core events only |
| **Sub-Agents** — `src/renderer/sidebar/pages/sub-agents.ts` | `subAgentRuns: Map<runKey, SubAgentRun>` (`src/renderer/renderer.ts:773`) — runs keyed per RUN (`dag:<graphId>`, `standalone:<sessionId>`, `fanout:<sessionId>`) so a single session can host all three kinds at once | `fanout_start / fanout_task_progress / fanout_end / fanout_error` **plus** core `task_graph / task_started / task_completed / task_failed / task_interrupted / subagent_status` plus the synthesized `subagent_task_progress` (`sub-agents.ts:233`) | (a) desktop `chatFanout` (`service.ts:1297`), (b) `mirrorCoreRun` (`renderer.ts:3543`) for core DAG / standalone runs |
| **Jobs** — `src/renderer/sidebar/pages/jobs.ts` | core `bg_` rows only (`nexus:coreBgList`, `src/ipc/register.ts:716`) | `bg_job_event` (`jobs.ts:215`) | core `JobManager` |

Rendering rules worth knowing:

- The Sub-Agents page renders **one labelled section per run kind** (`SECTION_ORDER = ['dag','standalone','fanout']`, `sub-agents.ts:48`) with a group header and count; runs within a section are newest-first.
- **DAG runs render in graph topological order** (`taskOrder`, captured verbatim from the `task_graph` event) so a dependency chain reads top-to-bottom. Non-DAG runs sort running-first (`statusRank`).
- The **in-chat fan-out card** (`renderFanoutCard`, `renderer.ts:3651`) shows ONLY the desktop fan-out batch (`fanout:<sessionId>`), never a core DAG or standalone run.
- The Jobs page renders a single `jobsShellSection` (`jobs.ts:352`) fed by `bg_job_event` plus a 10 s poll.
- Sidebar fan-out: every tab event reaches sidebar subscribers (`src/renderer/renderer.ts:508` `notifySidebarSubscribers`, entered from `applyTabEvent` `:3061`).

### Where the panels overlap

- A DAG run shows up **twice**: the Tasks list (core `tasks` map) and the Sub-Agents panel (via `mirrorCoreRun`).
- A desktop fan-out batch shows up **twice**: the in-chat `fan-out execution card` and the Sub-Agents panel.
- The Jobs page shows only shell processes (`bg_`). Agent runs are **not** a Jobs-page concern — the `bj_` section that used to claim otherwise was removed (§3).

---

## 2. Sub-agent execution paths (3) — all live

| # | Path | Trigger | Engine | Persistence | Verdict |
|---|---|---|---|---|---|
| **a** | DAG node | `/go` → `handleDagCommand` (`src/agent/service.ts:1703`) → `runPlanWithLoop` (`:2038`) → core `executePlan*` → `DAGScheduler` | `SubAgentWorker` → child `Agent` | `subagent_runs` + `task_graphs` | **live**, dependency-parallel (core) |
| **b** | `spawn_subagent` / `spawn_tester` / … tools | model tool call | `SubAgentWorker` **inline** in the parent turn (core `task-tools.ts` `handleSpawnSubagent`) | `subagent_runs` + standalone `task_graphs` | **live**, foreground/serial |
| **c** | Desktop heuristic fan-out | `shouldUseFanout(prompt)` (`service.ts:939`, called at `:1207`) → `chatFanout` (`service.ts:1297`) | **same `AgentService`, serial `for` loop with `await this.runTurn(...)`** | session metadata only (`fanoutExecution`); **no** `subagent_runs`, **no** job row | **live but serial** — no child agent, no dependencies |

Dispatch order matters for path (b): the core runs `skills.callTool` → `executeTaskTool` → `mcp.callTool`
(`nexus-coder/dist/src/agent.js`, "1. Check local skills first" / "1.5 Check task tools"). `spawn_subagent`
is therefore handled entirely inside the core and **never reaches the desktop's patched `mcp.callTool`** —
the desktop only observes the resulting `task_*` events. `acp_router` is **not** a fourth path either:
`callAcpRouterTool` with `action=route` only *returns* the resolved role config as JSON; it does not
dispatch. Registry entry at `src/tools/index.ts:47`.

---

## 3. Removed: the `bj_` desktop sub-agent job chain

Commit `c911e71` ("refactor(desktop): draw the core/desktop boundary and delete the dead paths")
deleted this chain outright — 2,574 deletions. It is recorded here because older revisions of this doc
and the `SUPERSEDED` design docs still describe it as live-but-broken; **none of it exists any more.**

| Former link | Removed |
|---|---|
| `src/agent/sub-agent/{orchestrator,executor,decomposer,metrics,tool-categories,types}.ts` | file gone |
| `src/main/bg-job-manager.ts` (`BgJobManager.create`, the 5-minute `stale` decay) | file gone |
| `routeViaAcp` worker method + `nexus:routeViaAcp` channel | 0 hits in `src/` |
| `nexus:runSubAgent` channel + `runSubAgent` worker method | 0 hits in `src/` |
| `nexus:bgJobCreate` handler | 0 hits in `src/` |
| `handleParallelRequest` / `parallel_request` / `OrchestratorAgent` | 0 hits in `src/` |
| `jobsSubagentSection` in the Jobs page | 0 hits in `src/` |
| `handleParallelRequest` entry in `src/main/index.ts` | 0 hits in `src/` |

`bj_` job ids: 0 hits in `src/`. The Jobs page is now single-semantics (core shell jobs).

---

## 4. Per-round tool selection

The core assembles each round's tool list and then applies a **binary keyword filter**: a tool survives
only if a token derived from the user message appears verbatim in its `name + description`
(`nexus-coder/src/agent.ts getToolsForContext`). Two properties of that filter are corrected on the
desktop side, in `AgentService.applyMcpProxy` (`src/agent/service.ts:363`, patch at `:459`).

**False negatives.** Descriptions are English; keywords taken from a Chinese prompt are CJK bigrams, which
can never substring-match them. The tool silently vanishes with no log line. This is the same defect that
made `spawn_subagent` unusable (fixed in `nexus-coder` `a5e8869`) and it applied to `agents_index/read/search`
and `acp_router` too — which additionally lacked a `server` tag and so could not be rescued at all.

**No ranking.** Survivors were unordered and uncapped, so every always-tagged main-process tool and every
installed skill rode along each round.

| Piece | Location | Role |
|---|---|---|
| Routing table | `src/tools/routing.ts:156` `TOOL_ROUTING`, applied by `:168 applyRouting` | Maps every tool name — the desktop `ALL_TOOL_DEFS`, the 48 injected git/memory/fetch/time tools, and whatever MCP servers advertise — to a `group`, `readOnly`, and author-supplied `keywords`. Each entry carries **Chinese** trigger words: an author term is the only signal that can match a prompt in its own script. |
| Scored selector | `src/tools/tool-relevance.ts:186 selectTools` | Replaces match-with-scoring. Similarity is character-bigram Jaccard (language-agnostic, lifted from the core's `acp/bridge/intent.ts`). Applied per round, since the core re-enters `runLlmTurn` after every batch of tool results. |
| Relevance floor | `tool-relevance.ts:86 ESSENTIAL_TOOLS` | Mirrors the core's `essentialTools` bypass list. `test/tool-relevance.test.mjs` parses `essentialTools` out of the shipped core and asserts full coverage — the two lists must not drift. |
| Thresholds | `tool-relevance.ts:66 SIMILARITY_KEEP`, `:73 MIN_KEPT`, `:79 MAX_KEPT` | Each signal is thresholded **separately**. An aggregate `score > 0` rule was tried and rejected: it kept 96 of 102 tools for a code-fix prompt, because a weighted negligible similarity is still positive and Jaccard leaks at the low end on short mixed CJK/ASCII strings. |
| Skills progressive disclosure | `src/tools/skills-disclosure.ts:158`, registry at `src/tools/index.ts:49` | `skills_index` / `skills_search` / `skills_load` replace the flat per-skill tools with three constant-size stubs. `skills_load` delegates to the core's `callTool` so the `<skill-instructions>` prompt-injection boundary is not forked. Flat skill tools are hidden via `skillToolNames` (`:77`) — safe, because the core runs `skills.callTool` ahead of every other dispatcher and matches on skill name, so a direct call still executes. |
| Model-widenable | `src/tools/refresh-tools.ts:55 ToolRefreshQueue`, registry at `src/tools/index.ts:50` | `refresh_tools` lets the model re-select its own toolset. Bounded queue; applied to the next round, then cleared (`service.ts:486`). |
| Usage memory | `service.ts:326`, recorded at `:329 noteToolUse` | Names already invoked this session score as a prior, so a tool that worked stays reachable after the user's focus moves on. Per-session and in-memory — **there is no cross-session learning**. |

Measured on 22 installed skills: ~2.9k tokens of tool schemas per round → ~700–1030, with the
intent-matching tool ranked first.

**Removed:** the `[Work Mode: Skill Enforcement]` block, which regex-matched the user message for
`/\.(csv|xlsx?|tsv)\b/i` or `/分析|统计|图表|chart|analyze|data|visualiz/i` and force-injected a
"you MUST call `sheet.read` / NEVER narrate" system block. `sheet.*` / `bi.chart` are now surfaced by
routing keywords, and the behavioural half of the rule moved into those tools' own descriptions rather
than a hardcoded prompt. `test/tool-relevance.test.mjs` asserts both halves.

Plan mode and role-scoped sub-agent allowlists short-circuit to the core's list untouched — those are
deliberate restrictions, not oversights.

---

## 5. Status vocabulary mapping

| Core / desktop raw status | Normalized (`SubTaskStatus`) | Where |
|---|---|---|
| `assigned`, `pending` | `pending` | `CORE_TO_RUN_STATUS` (`src/renderer/renderer.ts:3531`) |
| `in_progress`, `running` | `running` | same |
| `completed` | `succeeded` | same |
| `failed` | `failed` | same |
| `interrupted`, `cancelled` | `cancelled` | same |
| `timeout` | `timeout` | same |
| core job `lost` / `killed` | `failed` / `cancelled` | `normalizeJobStatus` (`src/renderer/sidebar/pages/jobs.ts:58`) |

`TERMINAL_TASK_STATUS = {succeeded, failed, timeout, cancelled}`
(`src/renderer/renderer.ts`) is the single "don't downgrade" guard used by both
the run sweep and `mirrorCoreRun`.

---

## 6. Boundary with the core

| Bridge | Location | What crosses it |
|---|---|---|
| DAG bridge | `src/agent/service.ts:1703 handleDagCommand` → `runPlanWithLoop` (`:2038`) | desktop `/go` input → core `executePlan*` |
| Tool dispatch | `src/agent/service.ts:363 applyMcpProxy` | desktop `ALL_TOOL_DEFS` into `mcp.getAllTools`; hub MCP calls back out; `getToolsForContext` overridden for selection (§4) |
| Event stream | core `Agent.onEvent` → `AgentService` → worker → `SessionWorkers.onEvent` → `forwardTabEvent` → renderer (`applyTabEvent`, `src/renderer/renderer.ts:3061`) | `task_*`, `subagent_status`, `bg_job_event` |
| Run mirroring | `mirrorCoreRun` (`src/renderer/renderer.ts:3543`) | core runs → `subAgentRuns` so the Sub-Agents panel sees them |
| Direct DB reads | `src/session-db.ts` (sessions/messages + `task_graphs`) and `listSessions` served from main (`src/ipc/register.ts:210`) | read-only, no event |
| Job control IPC | `nexus:coreBgList/Kill/Tail/Remove` (`src/ipc/register.ts:716`, `src/preload.cts:126`) | routed to the owning tab's worker |
| Core config UI | `nexus:openConfigWeb` (`src/preload.cts:94`) | the desktop reaches core settings (including `acp`) only through the core's own web UI |

---

## 7. Sub-Agents panel — structure

The panel groups runs into three labelled sections (`SECTION_ORDER = ['dag','standalone','fanout']`, `sub-agents.ts:48`) with a header per kind:

1. **Task graph** — DAG runs keyed by `graphId`; tasks render in the graph's own topological order (`taskOrder`, from the `task_graph` event), not by status.
2. **Standalone** — a single `spawn_subagent` outside any graph.
3. **Fan-out** — a desktop fan-out batch (one prompt → N serial sub-tasks), sorted running-first.

Within each section, runs are newest-first by `startTime`. A session can host all three kinds at once; scoping to the active workspace tab filters by `sessionId`.

What the panel **does not** express:

- **Dependencies**. The `task_graph` event omits `dependencies` per node (`TaskNode.dependencies` stays in the core). A *blocked-pending* and an *unlocked-pending* look identical on the card. Fixing this requires a core change (`emitTaskGraph` → add optional `level`).
- **Fan-out / standalone share the same panel**. Path (c) in §2 has no DAG at all, yet renders alongside real sub-agent runs. Intentional — the desktop UI surface unifies all sub-agent activity — but worth calling out.

For contrast: the chat-side Tasks list iterates `tasks` in insertion order
(`renderTasks`, `src/renderer/renderer.ts:3404`), which *is* `graph.nodes` order — closer to a
topological read, still without dependency edges.

---

## 8. Known rough edges

1. Path (c) is named "fan-out" but is serial and shares its panel with real
   sub-agent runs (§2).
2. `ESSENTIAL_TOOLS` is 41 names, which is the ~700-token floor per round. Trimming it would trade the
   never-hide-a-tool guarantee for tokens — an intentional call, currently left untrimmed pending
   real-traffic measurement (§4).
3. Tool usage memory is per-session and in-memory only; cross-session learning would need a
   `session-db.ts` schema change.
4. Stale design docs in this folder describe the removed orchestrator path; see
   the `SUPERSEDED` markers and §3.

---

## 9. Related documents

- `nexus-coder/docs/architecture-dag-subagent-jobs.md` — core responsibilities,
  trigger matrix, event contract, persistence.
- `docs/sub-agent-architecture.md` — historical planning archive (WorkBuddy /
  artifact protocol).
- `docs/dsh-plugin-adoption-plan.md §4.4` — where the Sub-Agents page came from.
- `docs/one-time-attachment-rag-plan.md` — plan for the standalone per-session
  one-time RAG on attachments (independent of the common `+` attach flow).