# Sub-Agent Architecture + WorkBuddy Work Mode (Planning Archive)

> Status: Finalized. M0 has been implemented per this plan; M1/M2 are placeholders awaiting real-world testing requirements.
> Decision records follow below.

## 1. Objective

Merge Constraint B's "Office Agent Artifact Pipeline" with P2's "Sub-Agent Architecture" into a unified delivery structure:

- **Sub-Agent** = who does the work (LLM task decomposition and parallel execution).
- **WorkBuddy Work Mode** = what is produced (LLM intent → deterministic code → previewable artifact).
- Both are coupled through a **single Artifact protocol**: Sub-Agent is the execution body; Artifact is the shared contract between sub-agents and between sub-agents and the UI.

## 2. Current Baseline (Design Rationale)

- Orchestration: core already has a DAG planning system `/plan → /go → /revise`; desktop implements this via a DAG bridge in `AgentService` (`service.ts:416`), `/go` spawns sub-agent blocks (`service.ts:362-366`), `session-db` has a `task_graphs` table.
- Tool Protocol: `src/tools/types.ts` defines unified `ToolDef / ToolResult / ToolContext / ToolRegistry`; `src/tools/index.ts` uses `TOOL_REGISTRIES` to generate `INTERNAL_TOOLS` (shadow MCP) / `ALL_TOOL_DEFS` (merged into LLM tool list) / `callBuiltinTool` (dispatch).
- Process Model: one `AgentService` worker per tab (`SessionWorkers`) + global worker + pre-warmed spare; `worker-host.ts` supports both stdio and utilityProcess transports.
- IPC: `CHANNELS` constants + `registerIpc(ctx)`; preload exposes ~60 methods; `nexus:tabEvents` for tab-level event flow.
- Rendering: `tsc` compiles ESM TS directly (no webpack); `static/` copied via `copy-assets.mjs` into `dist/static/`; `index.html` is the single-page entry point.
- Testing: `node --test` (`test/*.test.mjs`) + RPC smoke (`scripts/smoke-test.mjs`).

## 3. Layered Architecture (Mapped to This Repo, No New Infrastructure)

```
renderer                          main (Electron)                       worker (Node)
├ Chat UI (existing)              ├ index.ts / registerIpc              ├ agent-worker.ts (existing)
├ Artifact Canvas (new)           ├ SessionWorkers + tabs (existing)    │   └ Main conversation AgentService (existing)
│   └ Type renderer (new)         ├ mcpHub / Spare (existing)           ├ job-worker.ts (M1, lightweight task worker)
└ Preview sandbox (iframe srcdoc) └ TaskWorkers (M1, sub-agent body)    └   └ runSkill (M1)
```

- Skill layer: `src/skills/`, registered as `ToolRegistry` entries within the existing tool loop (LLM triggers via tool calls; core conversation loop unchanged).
- Artifact protocol: `src/shared/artifact.ts` (with validation).
- Rendering layer: `src/renderer/artifacts/` (Canvas + type renderers).
- Task layer (M1): `src/main/task-workers.ts` reuses `WorkerHost` pattern with lightweight `job-worker.ts`.
- Template layer (M2): `src/templates/`, JSON templates; vector retrieval deferred.

Not used: LangGraph / pgvector / BullMQ / E2B / Pyodide. LLM handles planning and content only; all rendering is deterministic code.

## 4. Decision Snapshot

| Item | Decision |
|---|---|
| M0 pipeline | Excel/CSV → `sheet.analyze` → `bi.chart` (Vega-Lite) → preview → export |
| Dependencies | Full acceptance (exceljs / pptxgenjs / docx / vega × 3, pure JS) |
| Rendering | Vega-Lite intermediate representation + custom lightweight table (no AG Grid / ECharts heavy libraries) |
| Cross-process executor | M1 as needed (M0 runs entirely within per-tab worker, deterministic execution) |

## 5. Sub-Agent Execution Model (Graduated)

- **Grade A (M0, reuse)**: main conversation orchestration uses core DAG `/plan /go /revise`; deterministic Skill chain steps run within the per-tab worker (millisecond scale), no new processes.
- **Grade B (M1/M2, on-demand)**: parallel/background heavy work on `job-worker` — lightweight worker entry point (loads only Agent + context, no full initialization), managed by `TaskWorkers` registry, reuses spare resource gates. Main agent calls `task.spawn` (special skill) to trigger; artifacts/progress flow back via `nexus:taskEvents`; cancellation reuses abort semantics.

## 6. Artifact Protocol (`src/shared/artifact.ts`)

```ts
export type ArtifactType =
  | 'sheet' | 'chart' | 'ppt' | 'docx' | 'markdown'
  | 'html' | 'image' | 'csv' | 'dataframe';

export interface Artifact {
  id: string;                 // stable id for rollback / incremental
  type: ArtifactType;
  title: string;
  version: number;            // supports incremental instructions like "change page 3 to…"
  status: 'draft' | 'partial' | 'done' | 'error';
  meta: { sessionId: string; skill: string; origin: 'user' | 'main' | 'task' };
  body: unknown;              // structured content per type (rows/spec/slides/…)
  refs?: Array<{ kind: 'inline' | 'base64' | 'file'; path?: string }>;
  patch?: Partial<Artifact>;  // incremental channel (partial→done)
}
export function validateArtifact(a: unknown): string | null;
```

- Transport: Skill results encoded as JSON envelope (`{"__artifactVersion":1,"artifact":{...}}`) inside `ToolResult.content`; zero changes to core loop or `ToolResult` contract; `parseArtifactContent()` shared between worker and renderer.
- Persistence: deterministic-code-generated binaries land in `~/.nexus/artifacts/<id>/`; `content.json` stores the structured body. Export = `nexus:saveArtifact` (dialog.saveDialog → copy from cache to target file) + existing `revealFile`.
- Rollback: `version` chain; `patch` streaming partial→done.

## 7. Skill System (M0)

`src/skills/`, each Skill is a `ToolRegistry`-style registry; `call` returns an Artifact envelope:

| Skill | Dependencies | Notes |
|---|---|---|
| `sheet.read` / `sheet.analyze` | exceljs / custom CSV | Overview, column statistics, pivot — deterministic; `sheet.read` enforces size/row caps to prevent zip-bombs |
| `bi.chart` | vega-lite (worker-side validation) | LLM produces Vega-Lite spec → allowlist structural validation + `compile()` fallback → Artifact `chart` |
| `doc.generate` (M1) | docx | Outline → docx → thumbnail |
| `ppt.render` (M1) | pptxgenjs | Outline → slides → thumbnail |
| `html.render` (M0/M1) | — | Secure sandboxed preview (iframe srcdoc) |

Integration point: `src/tools/index.ts` merges `SKILL_REGISTRIES` into `TOOL_REGISTRIES` (shadow/defs/dispatch in one place). Skill names enter `INTERNAL_TOOLS` to block same-name MCP tools.

## 8. Rendering Layer / WorkBuddy UI (M0–M1)

- M0 renders as **inline cards in the message stream** (`src/renderer/artifacts/artifact-view.ts`): parses envelope from tool output (deterministic, restorable on reload), flow events and history rows share the same entry point; standalone Canvas sidebar panel deferred to M1.
- Renderers dispatch by `type`: `chart` → vega-embed (vendored static bundle, `window.vegaEmbed`, export via `view.toCanvas()` + save dialog); `sheet`/`csv`/`dataframe` → custom table `table-view.ts` (export CSV); `ppt`/`docx` (M1) → thumbnails; `html` → iframe `srcdoc` + `sandbox` (reuses will-navigate / setWindowOpenHandler hardening).
- Export: `nexus:saveArtifact` (dialog.saveDialog, renderer sends base64 / text bytes) + `revealFile`.
- i18n entries in `renderer/i18n.ts` (`STR`, passes `check-i18n`).
- Rendering performance: vega-embed only instantiates per artifact; table uses capped-row rendering.

## 9. Dependency Strategy

- M0: `exceljs`, `vega-lite` (worker side) + vendored `vega`/`vega-lite`/`vega-embed` frontend bundles (`node_modules/**/*.min.js` → `static/`, `index.html` `<script>` imports, avoids webpack bundling overhead, consistent with static pipeline).
- M1: `pptxgenjs`, `docx`.
- All pure JS; no better-sqlite3 ABI changes; no electron-rebuild.

## 10. Milestones and Verification

- **M0 (implemented)**: Artifact protocol + `src/skills/` (sheet.read/analyze, bi.chart) + renderer inline artifact cards (table / Vega chart / export) + `nexus:saveArtifact` + unit tests and smoke extensions. Two feat commits.
- **M1**: `ppt.render` / `doc.generate` + export improvements + `job-worker` cross-process executor (parallel / cancel).
- **M2**: Template registry (`src/templates/` JSON placeholder injection) + incremental editing + rollback chain.
- **M3 (default: skip)**: Vector template retrieval, BI dashboard multi-chart coordination.

Verification: `node --test` (`test/artifact.test.mjs`, `test/skills.test.mjs`) + `npm run test:smoke` with extended Skill assertions.

## 11. Risks and Guardrails

- LLM direct spec output → allowlist structural validation + `vega-lite.compile()` double insurance.
- Malicious xlsx files → `sheet.read` size/row caps.
- Bundle size → tsc compilation pipeline unchanged; frontend only adds static vendored imports.
- Sandbox security → iframe `sandbox` + CSP; code execution (M1) runs in isolated `job-worker`.
