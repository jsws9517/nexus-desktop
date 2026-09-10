# P2: Sub-Agent 架构 + WorkBuddy 工作模式（规划存档）

> 状态：已定稿。M0 已按本方案实施；M1/M2 为占位，等待有实测需求后再展开。
> 决策记录见"决策快照"。

## 一、目标

把约束 B 的"办公 Agent 产物管线"与 P2 的"Sub-Agent 架构"合成一套落地结构：

- **Sub-Agent** = 谁去干活（LLM 任务的拆解与并行执行）。
- **WorkBuddy 工作模式** = 干出什么（LLM 意图 → 确定性代码 → 可预览产物）。
- 两者通过**同一个 Artifact 协议**咬合：Sub-Agent 是执行体，Artifact 是它们之间、以及它们与 UI 之间的公共契约。

## 二、现状基座（方案依据）

- 编排：核心已有 DAG 规划系统 `/plan → /go → /revise`，桌面侧在 `AgentService` 以 DAG bridge 实现（`service.ts:416`），`/go` 会派生子 agent 块（`service.ts:362-366`），`session-db` 有 `task_graphs` 表。
- 工具协议：`src/tools/types.ts` 统一 `ToolDef / ToolResult / ToolContext / ToolRegistry`；`src/tools/index.ts` 以 `TOOL_REGISTRIES` 生成 `INTERNAL_TOOLS`（shadow MCP）/`ALL_TOOL_DEFS`（并入 LLM 工具列表）/`callBuiltinTool`（派发）。
- 进程模型：每 tab 一个 `AgentService` worker（`SessionWorkers`）＋全局 worker＋预热 spare；`worker-host.ts` 支持 stdio / utilityProcess 双传输。
- IPC：`CHANNELS` 常量 + `registerIpc(ctx)`；preload 约 60 个方法；`nexus:tabEvents` 为 tab 级事件回流。
- 渲染：`tsc` 直编 ESM TS（无 webpack）；`static/` 经 `copy-assets.mjs` 拷入 `dist/static/`；`index.html` 为单页装载入口。
- 测试：`node --test`（`test/*.test.mjs`）＋ RPC smoke（`scripts/smoke-test.mjs`）。

## 三、分层架构（映射到本仓库，不引重基建）

```
renderer                        main (Electron)                     worker (Node)
├ Chat UI（现有）               ├ index.ts / registerIpc             ├ agent-worker.ts（现有）
├ Artifact Canvas（新）         ├ SessionWorkers+tabs（现有）        │   └ 主对话 AgentService（现有）
│   └ 类型渲染器（新）          ├ mcpHub / Spare（现有）             ├ job-worker.ts（M1，轻量任务 worker）
└ 预览 sandbox(iframe srcdoc)   └ TaskWorkers（M1，sub-agent 执行体）└   └ runSkill（M1）
```

- Skill 层：`src/skills/`，以 `ToolRegistry` 同型接入现有工具循环（LLM 以工具调用触发，不改核心对话循环）。
- Artifact 协议：`src/shared/artifact.ts`（含校验）。
- 渲染层：`src/renderer/artifacts/`（Canvas + 类型渲染器）。
- 任务层（M1）：`src/main/task-workers.ts` 复用 `WorkerHost` 模式的轻量 `job-worker.ts`。
- 模板层（M2）：`src/templates/`，JSON 模板，向量检索押后。

不用：LangGraph / pgvector / BullMQ / E2B / Pyodide。LLM 只做规划与内容，渲染全部走确定性代码。

## 四、决策快照

| 项 | 决策 |
|---|---|
| M0 链路 | Excel/CSV → `sheet.analyze` → `bi.chart`(Vega-Lite) → 预览 → 导出 |
| 依赖 | 全量接受（exceljs/pptxgenjs/docx/vega×3，纯 JS） |
| 渲染 | Vega-Lite 中间表示 + 自研轻表格（不引 AG Grid/ECharts 重型库） |
| 跨进程执行体 | M1 按需再上（M0 全部在 per-tab worker 内确定性执行） |

## 五、Sub-Agent 执行模型（分级）

- **A 级（M0，即复用）**：主对话编排用核心已有 DAG `/plan /go /revise`；Skill 链的确定性步骤就在 per-tab worker 内跑（毫秒级），不新增进程。
- **B 级（M1/M2，按需）**：并行/后台重活上 `job-worker`——轻量 worker 入口（只加载 Agent + 上下文，不挂全量初始化），受 `TaskWorkers` 注册表管理，沿用 spare 的资源门禁。主 agent 调 `task.spawn`（特殊 skill）触发；产物/进度以 `nexus:taskEvents` 回流；取消复用 abort 语义。

## 六、Artifact 协议（`src/shared/artifact.ts`）

```ts
export type ArtifactType =
  | 'sheet' | 'chart' | 'ppt' | 'docx' | 'markdown'
  | 'html' | 'image' | 'csv' | 'dataframe';

export interface Artifact {
  id: string;                 // 稳定 id，供回滚/增量
  type: ArtifactType;
  title: string;
  version: number;            // "把第 3 页改成…" 增量指令
  status: 'draft' | 'partial' | 'done' | 'error';
  meta: { sessionId: string; skill: string; origin: 'user' | 'main' | 'task' };
  body: unknown;              // 按 type 的结构化内容（rows/spec/slides/…）
  refs?: Array<{ kind: 'inline' | 'base64' | 'file'; path?: string }>;
  patch?: Partial<Artifact>;  // 增量通道（partial→done）
}
export function validateArtifact(a: unknown): string | null;
```

- 传输：Skill 结果以 JSON envelope（`{"__artifactVersion":1,"artifact":{...}}`）编码进 `ToolResult.content`，核心循环与 `ToolResult` 契约零改动；`parseArtifactContent()` 供 worker 与 renderer 共用。
- 持久化：确定性代码生成的二进制落 `~/.nexus/artifacts/<id>/`；`content.json` 存结构化 body。导出 = `nexus:saveArtifact`（dialog.saveDialog → 从缓存拷贝目标文件）＋ 现有 revealFile。
- 回滚：`version` 链；`patch` 流式 partial→done。

## 七、Skill 体系（M0）

`src/skills/`，每个 Skill 为 `ToolRegistry` 同型注册表，`call` 返回 Artifact envelope：

| Skill | 依赖 | 说明 |
|---|---|---|
| `sheet.read` / `sheet.analyze` | exceljs / 自写 CSV | 概览、列统计、透视——确定性；`sheet.read` 设尺寸/行数上限防 zip-bomb |
| `bi.chart` | vega-lite(worker 校验) | LLM 产 Vega-Lite spec → 白名单结构校验 + `compile()` 兜底 → Artifact `chart` |
| `doc.generate`（M1） | docx | 大纲 → docx → 缩略图 |
| `ppt.render`（M1） | pptxgenjs | 大纲 → 页面 → 缩略图 |
| `html.render`（M0/M1） | — | 网络安全沙箱预览 |

接入点：`src/tools/index.ts` 把 `SKILL_REGISTRIES` 并入 `TOOL_REGISTRIES`（shadow/defs/dispatch 同一套）。Skill 名进 `INTERNAL_TOOLS` 屏蔽同名 MCP。

## 八、渲染层 / WorkBuddy UI（M0-M1）

- M0 以**消息流内联卡片**呈现预览（`src/renderer/artifacts/artifact-view.ts`）：从 tool 输出解析 envelope（确定性、重载可还原），flow 事件与历史行共用同一入口；独立 Canvas 侧栏面板推迟到 M1。
- 渲染器按 `type` 分发：`chart` → vega-embed（vendored static bundle，`window.vegaEmbed`，导出走 `view.toCanvas()`+save dialog）；`sheet`/`csv`/`dataframe` → 自研表格 `table-view.ts`（导出 CSV）；`ppt`/`docx`（M1）→ 缩略图；`html` → iframe `srcdoc` + `sandbox`（沿用 will-navigate/setWindowOpenHandler 加固）。
- 导出：`nexus:saveArtifact`（dialog.saveDialog，renderer 传 base64/文本字节）+ revealFile。
- i18n 词条进 `renderer/i18n.ts`（`STR`，过 `check-i18n`）。
- 渲染性能：vega-embed 只随产物按需创建；表格先基础上限渲染。

## 九、依赖策略

- M0：`exceljs`、`vega-lite`（worker 侧）＋ vendored `vega`/`vega-lite`/`vega-embed` 前端包（`node_modules/**/*.min.js` → `static/`，index.html `<script>` 引入，避免无 webpack 打包负担，与 static 管线一致）。
- M1：`pptxgenjs`、`docx`。
- 全纯 JS，不动 better-sqlite3 ABI，无 electron-rebuild。

## 十、里程碑与验证

- **M0（已实施）**：Artifact 协议 + `src/skills/`（sheet.read/analyze、bi.chart）+ renderer 内联产物卡片（表格/Vega 图/导出）+ `nexus:saveArtifact` + 单测与 smoke 扩展。两个 feat commit。
- **M1**：`ppt.render`/`doc.generate` + 导出完善 + `job-worker` 跨进程执行体（并行/取消）。
- **M2**：模板注册（`src/templates/` JSON 占位符注入）+ 增量编辑 + 回滚链。
- **M3（默认不做）**：向量模板检索、BI 看板多图联动。

验证：`node --test`（`test/artifact.test.mjs`、`test/skills.test.mjs`）＋ `npm run test:smoke` 扩展 skill 断言。

## 十一、风险与护栏

- LLM 直产 spec → 白名单结构校验 + `vega-lite.compile()` 双保险。
- xlsx 恶意文件 → `sheet.read` 尺寸/行数上限。
- 包体 → tsc 直编管线不变，前端仅 static vendored 引入。
- 沙箱安全 → iframe `sandbox` + CSP，代码执行（M1）走独立 job-worker。