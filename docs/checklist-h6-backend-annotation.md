# H-6 实现 Checklist — 工具名/能力误判（后端可用性标注）

> 目标：模型在 tool call 前即可看到后端可用性状态（ACP 未初始化 / 无 agents / MCP offline），
> 不再靠 trial-and-error 发现。routing 层对不可用后端降权。
> 分工：**coder 侧** 工具声明 + 动态描述；**desktop 侧** 路由降权。

## 改动清单

### coder 侧（`nexus-coder`）

- [x] `src/types.ts`：`ToolDefinition` 增加 `backend?: 'local' | 'acp' | 'mcp' | 'builtin'`
- [x] `src/mcp/types.ts`：`BuiltinTool` 增加 `backend` + `dynamicDescription` 字段
- [x] `src/mcp/builtin-tools.ts`（`acp_route`）：
  - [x] `backend: 'acp'`
  - [x] `dynamicDescription(ctx)`：
    - 无 acp → "ACP not initialized — this tool will fail. Use spawn_subagent instead."
    - acp 无 agents → "No agents registered in engines.json — this tool will fail."
    - 有 agents → "Available agents: kimi, claude, ..."
- [x] `src/task/task-tools.ts`（`spawn_subagent`）：`backend: 'builtin'`
- [x] `src/agent.ts`（`getToolsForContext`）：
  - [x] 遍历 tools 数组，对 `BUILTIN_TOOLS` 中有 `dynamicDescription` 的工具，
    调用 `dynamicDescription({ agent: this })` 替换 `tool.description`
  - [x] 导入 `BUILTIN_TOOLS`
- [x] `src/mcp/client-manager.ts`（`getAllTools`）：
  - [x] builtin tools 注入 `backend: t.backend ?? 'local'`
  - [x] MCP tools 注入 `backend: 'mcp'`

### desktop 侧（`nexus-desktop`）

- [x] `src/tools/routing.ts`：
  - [x] `ToolRouting` 增加 `backend?` 字段
  - [x] `acp_route` 路由条目加 `backend: 'acp'`
- [x] `src/tools/tool-relevance.ts`：
  - [x] 新增 `W_BACKEND_DEMOTION = 0.5` 常量
  - [x] `scoreTool` 末尾：若 `description` 含 "ACP not initialized" / "No agents registered" / "will fail"，
    score × 0.5

### 测试

- [x] `test/backend-annotation.test.mjs`（新建，6 用例）：
  - [x] `acp_route` 有 `backend: 'acp'` + `dynamicDescription`
  - [x] dynamicDescription: ACP 未初始化 → "ACP not initialized"
  - [x] dynamicDescription: agents 可用 → "Available agents: ..."
  - [x] dynamicDescription: 无 agents → "No agents registered"
  - [x] `spawn_subagent` 有 `backend: 'builtin'`
  - [x] relevance scoring: "will fail" 描述降权

### 回归

- [x] `nexus-coder` mcp tests：90 pass / 0 fail / 1 skipped
- [x] `nexus-desktop` npm run test:unit：1098 tests / 1089 pass / 0 fail
