# Desktop module map — panels, execution paths, dead paths

> **Status**: Reference (verified against this tree, 2026-09-26).
> **Scope**: `nexus-desktop`. Core-side DAG / Sub-agent / Jobs responsibilities and
> trigger matrix live in `nexus-coder/docs/architecture-dag-subagent-jobs.md`.
> **Line numbers are pointers, not contracts** — re-verify with grep after any refactor.
>
> ⚠️ The older design docs in this folder
> (`multi-agent-parallel-architecture.md`, `implementation-plan-multi-agent-parallel.md`)
> describe a path that was **never wired** — see §3. They are marked `SUPERSEDED`.

---

## 1. The three sidebar panels and their data sources

| Panel | Data source | Events that re-render it | Written by |
|---|---|---|---|
| **Tasks (“task progress”)** — chat stream right rail | `tasks: Map<taskId, TaskItem>` (`src/renderer/renderer.ts:707`) | `task_graph`, `task_started/completed/failed/interrupted` (`src/renderer/renderer.ts:1419` `handleEvent`, `:3251` `handleTaskEvent`, `:3167` `renderTasks`) | core events only |
| **Sub-Agents** — `src/renderer/sidebar/pages/sub-agents.ts` | `parallelSessions: Map<sessionId, ParallelSession>` (`src/renderer/renderer.ts:718`) | `parallel_start / task_progress / parallel_end / parallel_error` **plus** core `task_graph / task_started / task_completed / task_failed / task_interrupted / subagent_status` (`sub-agents.ts:161`) | (a) desktop `chatParallel`, (b) `mirrorCoreRunToParallel` (`renderer.ts:3306`) for core runs |
| **Jobs** — `src/renderer/sidebar/pages/jobs.ts` | two backends merged: core `bg_` rows (`nexus:coreBgList`, `register.ts:766`) + desktop `bj_` rows (`nexus:bgJobList`, `register.ts:730`) | `bg_job_event / bg_job_progress / bg_job_complete` (`jobs.ts:457`) | core `JobManager`, desktop `BgJobManager` |

Rendering rules worth knowing:

- Sub-Agents cards are sorted by **status**, not by graph order:
  `statusRank` (`sub-agents.ts:27-34`) + sort (`sub-agents.ts:135-139`).
- Sections are keyed by **session**, not by graph: everything mirrored for one
  session id lands in one section (`renderer.ts:3306`), including DAG nodes,
  standalone `spawn_*` runs and quality-gate `qg-*` runs.
- Jobs page renders two sections: `jobsShellSection` (core `bg_`) and
  `jobsSubagentSection` (desktop `bj_`) — `jobs.ts:450-451`.
- Sidebar fan-out: every tab event reaches sidebar subscribers
  (`src/renderer/renderer.ts:2850` / `notifySidebarSubscribers` `:506`).

### Where the panels overlap

- One DAG run shows up **twice**: the Tasks list (core `tasks` map) and the
  Sub-Agents panel (via `mirrorCoreRunToParallel`).
- The Jobs page *claims* to show sub-agents (`jobsSubagentSection`), but that
  section is fed by `bj_` jobs, which today have neither a live creator nor a
  runner (§3) → it renders empty in practice.
- The desktop “parallel” path (§2c) feeds the Sub-Agents panel while being a
  **serial** in-process loop — so “Sub-Agents” does not imply parallel or
  DAG-driven.

---

## 2. Sub-agent execution paths (4) — live / dead verdicts

| # | Path | Trigger | Engine | Persistence | Verdict |
|---|---|---|---|---|---|
| **a** | DAG node | `/go` → `executePlan*` → `DAGScheduler` | `SubAgentWorker` → child `Agent` | `subagent_runs` + `task_graphs` | **live**, dependency-parallel (core) |
| **b** | `spawn_subagent` / `spawn_tester` / … tools | model tool call | `SubAgentWorker` **inline** in the parent turn (`src/…` core `task-tools.ts:297`) | `subagent_runs` + standalone `task_graphs` | **live**, foreground/serial |
| **c** | Desktop heuristic fan-out | `shouldUseParallel(prompt)` (`src/agent/service.ts:897`, called at `:1103`) → `chatParallel` (`src/agent/service.ts:1192`) | **same `AgentService`, serial `for` loop with `await this.runTurn(...)`** (`src/agent/service.ts:1310`) | session metadata only (`parallelExecution`); **no** `subagent_runs`, **no** job row | **live but serial** — no child agent, no dependencies |
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
| `assigned`, `pending` | `pending` | `CORE_TO_PARALLEL_STATUS` (`src/renderer/renderer.ts:3294`) |
| `in_progress`, `running` | `running` | same |
| `completed` | `succeeded` | same |
| `failed` | `failed` | same |
| `interrupted`, `cancelled` | `cancelled` | same |
| `timeout` | `timeout` | same |
| core job `lost` / `killed` | `failed` / `cancelled` | `normalizeJobStatus` (`src/renderer/sidebar/pages/jobs.ts:69`) |
| `bj_` `stale` / `created` | `timeout` / `pending` | same |

`TERMINAL_TASK_STATUS = {succeeded, failed, timeout, cancelled}`
(`src/renderer/renderer.ts`) is the single “don't downgrade” guard used by both
the parallel sweeper and `mirrorCoreRunToParallel`.

---

## 5. Boundary with the core

| Bridge | Location | What crosses it |
|---|---|---|
| DAG bridge | `src/agent/service.ts:1582 handleDagCommand` → `runPlanWithLoop` (`:1853`) | desktop `/go` input → core `executePlan*` |
| Event stream | core `Agent.onEvent` → `AgentService` → worker → `SessionWorkers.onEvent` → `forwardTabEvent` → renderer (`applyTabEvent`, `src/renderer/renderer.ts:2850`) | `task_*`, `subagent_status`, `bg_job_event` |
| Run mirroring | `mirrorCoreRunToParallel` (`src/renderer/renderer.ts:3306`) | core runs → `parallelSessions` so the Sub-Agents panel sees them |
| Direct DB reads | `src/session-db.ts` (sessions/messages + `task_graphs`) and `listSessions` served from main (`src/ipc/register.ts:118`) | read-only, no event |
| Job control IPC | `nexus:coreBgList/Kill/Tail/Remove` (`src/ipc/register.ts:766`, `src/preload.cts:126`) | routed to the owning tab's worker |

---

## 6. Known gap — the Sub-Agents panel does **not** follow DAG dependencies

Execution *is* dependency-parallel in the core
(`DAGScheduler`, `nexus-coder/src/task/dag-scheduler.ts:163-166`), but the panel
is a flat status-sorted card list:

1. **The event contract carries no dependencies.** `Agent.emitTaskGraph` emits
   only `id / description / role / status / error`
   (`nexus-coder/src/agent.ts:4407-4416`); `TaskNode.dependencies` never leaves
   the core.
2. **The mirror drops structure.** `mirrorCoreRunToParallel`
   (`src/renderer/renderer.ts:3306`) stores `description/status/error/duration/output`
   only — not even `graphId`, so multiple graphs of one session merge into one
   section.
3. **Rendering sorts by status, not topology.** `statusRank`
   (`src/renderer/sidebar/pages/sub-agents.ts:27`) + sort (`:135-139`) erases
   layer order.
4. **The card model cannot express “waiting on”** — `ParallelExecutionCard`
   takes `taskId/description/status/output/durationMs/error` only, so
   *blocked-pending* and *unlocked-pending* are indistinguishable.
5. **A serial path shares the same panel.** Path (c) in §2 has no DAG at all,
   yet emits `parallel_*` / `task_progress` into the same map.

For contrast: the chat-side Tasks list iterates `tasks` in insertion order
(`src/renderer/renderer.ts:3167`), which *is* `graph.nodes` order — closer to a
topological read, still without dependency edges.

### Candidate fixes (deliberately **not** done in this pass)

| Level | Change | Scope |
|---|---|---|
| **L0** | Group by `graphId`, keep `graph.nodes` insertion order, use the graph root request as the section title | desktop only (`renderer.ts`, `sub-agents.ts`) |
| **L1** | Add `dependencies: string[]` (optional `level`) to the `task_graph` payload, mirror it, render `⏳ waiting on A,B` | core `emitTaskGraph` + desktop mirror + card |
| **L2** | Emit level boundaries from `DAGScheduler`, render swimlanes; decide whether path (c) keeps sharing the panel | core scheduler + desktop UI |

---

## 7. Known rough edges (unchanged, documented)

1. `bj_` registry with no runner and no exposed creator (§3).
2. Path (c) is named “parallel” but is serial and shares its panel with real
   sub-agent runs (§2).
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
