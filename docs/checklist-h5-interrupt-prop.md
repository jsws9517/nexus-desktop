# H-5 实现 Checklist — 中断传播（ACP 子代理）

> 目标：`agent.abort()` 时，正在运行的 ACP 委托（acp_route）立即 reject，
> 不再后台空转到 timeout。sub-agent DAG 路径已有正确传播，无需改动。
> 分工：**coder 侧** 改 AcpProtocol + builtin-tools + agent.ts。

## 现状分析

| 路径 | 中断传播 | 状态 |
|---|---|---|
| sub-agent DAG (`task-tools.ts`) | `ctx.agent.getTaskAbortSignal()` → `SubAgentWorker.execute()` → `child.chat(prompt, combinedSignal)` | ✅ 已有 |
| quality gate (`task-tools.ts`) | `parentAgent.getTaskAbortSignal()` → `SubAgentWorker` | ✅ 已有 |
| sub-agent worker (`sub-agent-worker.ts`) | `combineSignals(options.abortSignal, options.nodeAbortSignal)` | ✅ 已有 |
| **ACP delegation** (`acp_route` tool) | `acp.sendTask(target, payload, 'nexus', onChunk)` — **无 abortSignal** | ❌ 缺口 |
| **ACP delegation** (`agent.ts` 内部路由) | `this.acp.sendTask(target, payload, 'nexus')` — **无 abortSignal** | ❌ 缺口 |

## 改动清单

### coder 侧（`nexus-coder`）

- [x] `src/acp/protocol.ts`：
  - [x] `sendTask()` options 增加 `abortSignal?: AbortSignal`
  - [x] 已 aborted → 立即 reject `'ACP task to X aborted before dispatch'`
  - [x] 未 aborted → 监听 `abort` 事件，fire 时 reject `'ACP task to X cancelled by user interrupt'`
  - [x] 清理 pendingResponses + 超时 timer

- [x] `src/mcp/builtin-tools.ts`（`acp_route` tool）：
  - [x] `sendTask()` 调用增加 `abortSignal: agent.getTaskAbortSignal()`
  - [x] catch 块区分 cancel vs failure：cancel → 非错误 info 消息；failure → `isError: true`

- [x] `src/agent.ts`（内部 ACP 路由）：
  - [x] 主 `sendTask()` 调用增加 `abortSignal: this.getTaskAbortSignal()`
  - [x] fallback 并行 `sendTask()` 同样传 `abortSignal`

### 测试

- [x] `test/interrupt-prop.test.mjs`（新建，3 用例）：
  - [x] 已 aborted → 立即 reject
  - [x] 中途 fire → reject（不挂起）
  - [x] 无 abortSignal → 不 reject（回归）

### 回归

- [x] `nexus-coder` ACP tests（acp.test.ts + acp-tools.test.ts + acp-delegation-failure.test.ts）：69 pass / 0 fail
- [x] `nexus-desktop` npm run test:unit：1092 tests / 1083 pass / 0 fail
