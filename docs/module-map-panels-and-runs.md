# Desktop module map — panels, execution paths, dead paths

> **Status**: Reference (verified against this tree, 2026-09-26).
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
| **Tasks ("task progress")** — chat stream right rail | `tasks: Map<taskId, TaskItem>` (`src/renderer/renderer.ts:707`) | `task_graph`, `task_started/completed/failed/interrupted` (`src/renderer/renderer.ts:1419` `handleEvent`, `:3251` `handleTaskEvent`, `:3167` `renderTasks`) | core events only |
| **Sub-Agents** — `src/renderer/sidebar/pages/sub-agents.ts` | `subAgentRuns: Map<runKey, SubAgentRun>` (`src/renderer/renderer.ts:702`) — runs keyed per RUN (`dag:<graphId>`, `standalone:<sessionId>`, `fanout:<sessionId>`) so a single session can host all three kinds at once | `fanout_start / fanout_task_progress / fanout_end / fanout_error` **plus** core `task_graph / task_started / task_completed / task_failed / task_interrupted / subagent_status` plus the synthesized `subagent_task_progress` (`sub-agents.ts:224`) | (a) desktop `chatFanout` (`service.ts:1103`), (b) `mirrorCoreRun` (`renderer.ts:3347`) for core DAG / standalone runs |
| **Jobs** — `src/renderer/sidebar/pages/jobs.ts` | core `bg_` rows only (`nexus:coreBgList`, `register.ts:766`) — desktop `bj_` chain is dead-end (§3) | `bg_job_event` (`jobs.ts:457`) | core `JobManager` |

Rendering rules worth knowing:

- The Sub-Agents page renders **one labelled section per run kind** (`SECTION_ORDER = ['dag','standalone','fanout']`) with a group header and count; runs within a section are newest-first.
- **DAG runs render in graph topological order** (`taskOrder`, captured verbatim from the `task_graph` event) so a dependency chain reads top-to-bottom. Non-DAG runs sort running-first (`statusRank`).
- The **in-chat fan-out card** (`renderFanoutCard`, `renderer.ts:3396`) shows ONLY the desktop fan-out batch (`fanout:<sessionId>`), never a core DAG or standalone run — a bug that existed before P4b has been fixed.
- Jobs page: only the core `jobsShellSection` renders today; the `jobsSubagentSection` is always empty because the `bj_` chain is dead (§3).
- Sidebar fan-out: every tab event reaches sidebar subscribers (`src/renderer/renderer.ts:2850` / `notifySidebarSubscribers` `:506`).

### Where the panels overlap

- A DAG run shows up **twice**: the Tasks list (core `tasks` map) and the Sub-Agents panel (via `mirrorCoreRun`).
- A desktop fan-out batch shows up **twice**: the in-chat `fanout-execution-card` and the Sub-Agents panel.
- The Jobs page *appears* to show sub-agents via `jobsSubagentSection`, but that section is fed by `bj_` jobs, which today have neither a live creator nor a runner (§3) → it renders empty in practice.

---

## 2. Sub-agent execution paths (4) — live / dead verdicts

| # | Path | Trigger | Engine | Persistence | Verdict |
|---|---|---|---|---|---|
| **a** | DAG node | `/go` → `executePlan*` → `DAGScheduler` | `SubAgentWorker` → child `Agent` | `subagent_runs` + `task_graphs` | **live**, dependency-parallel (core) |
| **b** | `spawn_subagent` / `spawn_tester` / … tools | model tool call | `SubAgentWorker` **inline** in the parent turn (`src/…` core `task-tools.ts:297`) | `subagent_runs` + standalone `task_graphs` | **live**, foreground/serial |
| **c** | Desktop heuristic fan-out | `shouldUseFanout(prompt)` (`src/agent/service.ts:897`, called at `:1103`) → `chatFanout` (`src/agent/service.ts:1192`) | **same `AgentService`, serial `for` loop with `await this.runTurn(...)`** (`src/agent/service.ts:1310`) | session metadata only (`fanoutExecution`); **no** `subagent_runs`, **no** job row | **live but serial** — no child agent, no dependencies |
| **d** | Main-process orchestrator | `OrchestratorAgent.orchestrate` (`src/main/index.ts:366`) inside `handleParallelRequest` (`src/main/index.ts:326`) | `SubAgentExecutor.executeParallel` (`src/agent/sub-agent/executor.ts:46`) → `worker.request('runSubAgent', …)` (`executor.ts:126`) | would register `bj_` jobs (`src/agent/sub-agent/orchestrator.ts:84`) | **dead**: nothing emits `parallel_request` (the type exists only at `src/agent/types.ts:22`) and `handleParallelRequest` has no call site |

`acp_router` is **not** a fifth path: `callAcpRouterTool` with `action=route`
only *returns* the resolved role config as JSON
(`src/tools/acp-router.ts:202`, comment `:217`); it does not dispatch. The tool
registry entry is `src/tools/index.ts:39`.

---

## 3. The `bj_` (desktop sub-agent job) chain is dead end-to-end

| Link | Evidence | State |
|---|---|---|
| Creator ① | `acp_router(action=route)` returns config only (`src/tools/acp-router.ts:202-240`) | never creates |
| Creator ② | worker method `routeViaAcp` (`src/agent-worker.ts:435`) — declared at `src/ipc/channels.ts:84`, validated at `src/shared/ipc-validation.ts:126`, **no call site, no `ipcMain.handle`** | dead |
| Creator ③ | `nexus:bgJobCreate` handler exists (`src/ipc/register.ts:706`) but `src/preload.cts:118-125` exposes only `bgJobList/Query/Cancel/Remove` | unreachable from renderer |
| Runner | `BgJobManager.create()` only records `status:'queued'` (`src/main/bg-job-manager.ts:128`); no code path ever sets `running` or executes `prompt`. Status transitions are called only from `orchestrator.ts:115-133` (dead) and `register.ts:756` (`nexus:bgJobProgress`, not exposed in preload) | never runs |
| Decay | 5 min without update → `stale` (`src/main/bg-job-manager.ts:107`, applied `:318`) | silently expires |

Consequence: `jobsSubagentSection` (`src/renderer/sidebar/pages/jobs.ts:451`)
is an always-empty section backed by a registry that nothing feeds.

Also unreachable (declared but never exposed or handled):
`nexus:runSubAgent` (`src/ipc/channels.ts:62`) and the worker method
`runSubAgent` (`src/agent-worker.ts:351`).

---

## 4. Status vocabulary mapping

| Core / desktop raw status | Normalized (`SubTaskStatus`) | Where |
|---|---|---|
| `assigned`, `pending` | `pending` | `CORE_TO_RUN_STATUS` (`src/renderer/renderer.ts:3300`) |
| `in_progress`, `running` | `running` | same |
| `completed` | `succeeded` | same |
| `failed` | `failed` | same |
| `interrupted`, `cancelled` | `cancelled` | same |
| `timeout` | `timeout` | same |
| core job `lost` / `killed` | `failed` / `cancelled` | `normalizeJobStatus` (`src/renderer/sidebar/pages/jobs.ts:69`) |
| `bj_` `stale` / `created` | `timeout` / `pending` | same |

`TERMINAL_TASK_STATUS = {succeeded, failed, timeout, cancelled}`
(`src/renderer/renderer.ts`) is the single "don't downgrade" guard used by both
the run sweep and `mirrorCoreRun`.

---

## 5. Boundary with the core

| Bridge | Location | What crosses it |
|---|---|---|
| DAG bridge | `src/agent/service.ts:1582 handleDagCommand` → `runPlanWithLoop` (`:1853`) | desktop `/go` input → core `executePlan*` |
| Event stream | core `Agent.onEvent` → `AgentService` → worker → `SessionWorkers.onEvent` → `forwardTabEvent` → renderer (`applyTabEvent`, `src/renderer/renderer.ts:2850`) | `task_*`, `subagent_status`, `bg_job_event` |
| Run mirroring | `mirrorCoreRun` (`src/renderer/renderer.ts:3347`) | core runs → `subAgentRuns` so the Sub-Agents panel sees them |
| Direct DB reads | `src/session-db.ts` (sessions/messages + `task_graphs`) and `listSessions` served from main (`src/ipc/register.ts:118`) | read-only, no event |
| Job control IPC | `nexus:coreBgList/Kill/Tail/Remove` (`src/ipc/register.ts:766`, `src/preload.cts:126`) | routed to the owning tab's worker |

---

## 6. Sub-Agents panel — structure (P4b resolved most open gaps)

The panel groups runs into three labelled sections (`SECTION_ORDER = ['dag','standalone','fanout']`) with a header per kind:

1. **Task graph** — DAG runs keyed by `graphId`; tasks render in the graph's own topological order (`taskOrder`, from the `task_graph` event), not by status.
2. **Standalone** — a single `spawn_subagent` outside any graph.
3. **Fan-out** — a desktop fan-out batch (one prompt → N serial sub-tasks), sorted running-first.

Within each section, runs are newest-first by `startTime`. A session can host all three kinds at once; scoping to the active workspace tab filters by `sessionId`.

What the panel **does not yet** express:

- **Dependencies**. The `task_graph` event omits `dependencies` per node (`TaskNode.dependencies` stays in the core). A *blocked-pending* and an *unlocked-pending* look identical on the card. Fixing this requires a core change (`emitTaskGraph` → add optional `level`).
- **Fan-out / standalone share the same panel**. Path (c) in §2 has no DAG at all, yet renders alongside real sub-agent runs. That is intentional (the desktop UI surface unifies all sub-agent activity) but worth calling out.

For contrast: the chat-side Tasks list iterates `tasks` in insertion order
(`src/renderer/renderer.ts:3167`), which *is* `graph.nodes` order — closer to a
topological read, still without dependency edges.

### Previously-open gaps (now resolved)

| Before P4b | After P4b |
|---|---|
| All runs keyed by `sessionId` — multiple DAGs in one session merged into one section | Runs keyed by `dag:<graphId>` / `standalone:<sid>` / `fanout:<sid>` — multiple concurrent graphs separate cleanly |
| Cards sorted by `statusRank` everywhere — erased graph topology | DAG runs honour `taskOrder` (graph nodes order); non-DAG runs still sort running-first |
| Core DAG / standalone runs leaked into the in-chat fan-out transcript card | `renderFanoutCard` now looks up the run by its `fanout:` key, so only real desktop batches appear there |

---

## 7. Known rough edges (unchanged, documented)

1. `bj_` registry with no runner and no exposed creator (§3).
2. Path (c) is named "fan-out" but is serial and shares its panel with real
   sub-agent runs (§2). (The rename from "parallel" to "fan-out" in P4a corrected
   the lie; the structural sharing remains by design.)
3. Jobs page mixes two semantics under one heading: shell processes (`bg_`) and
   agent runs (`bj_`) — `jobs.ts:450-451`.
4. Stale design docs in this folder describe the unwired orchestrator path; see
   the `SUPERSEDED` markers.

---

## 8. Related documents

- `nexus-coder/docs/architecture-dag-subagent-jobs.md` — core responsibilities,
  trigger matrix, event contract, persistence.
- `docs/sub-agent-architecture.md` — historical planning archive (WorkBuddy /
  artifact protocol).
- `docs/dsh-plugin-adoption-plan.md §4.4` — where the Sub-Agents page came from.
