# H-1 实现 Checklist — capability_blocked grant_hint

> 目标：被拒时告知模型**具体授权路径**（改哪个 config key / 切哪个 mode / 一次放行），
> 消除 "模型反复用相同参数重试 → sentinel probe-loop 冻结" 的恶性循环。
> 分工：**全部 desktop 侧**（`nexus-desktop`）。

## 改动清单

### 1. `src/agent/capability-gate.ts`

- [x] 新增 `GrantHint` 接口（`kind: 'config' | 'switch_mode' | 'one_tap'` + `instruction` + 可选 `configKey` / `suggestedValue` / `targetMode`）
- [x] `DecisionRequest` 增加可选 `grant_hint?: GrantHint` 字段
- [x] `buildDecisionRequest` 签名增加可选第 4 参数 `grantHint?: GrantHint`，写入 `DecisionRequest.grant_hint`
- [x] `buildBlockedSteer` 签名增加可选第 2 参数 `grantHints?: GrantHint[]`，steer 文案追加 "合法替代路径" 说明

### 2. `src/agent/service.ts`

- [x] 新增 `buildGrantHint(tool, command, content)` 私有方法：根据被拒工具 + 命令构造 `GrantHint`
  - [x] `exec_command` + 破坏性命令（rm -rf / del /R / format 等）→ `kind: 'config'`, `configKey: 'permissions.allow'`
  - [x] `exec_command` + unattended block → `kind: 'switch_mode'`, `targetMode: 'auto'`
  - [x] `delete_file` / `move_file` / `copy_file` → `kind: 'one_tap'`
  - [x] `acp_route` + "not found" / "not initialized" → `kind: 'config'`, `configKey: 'acp.enabled'`
  - [x] `acp_router` + role not found → `kind: 'config'`, `configKey: '.nexus/agents/<role>/SKILL.md'`
  - [x] `spawn_subagent` + quota/policy → `kind: 'config'`, `configKey: 'subAgents.maxTurns'`
  - [x] 其他 → 返回 undefined（保持现状）
- [x] `noteBlockedAction` 增加可选第 4 参数 `hint?: GrantHint`，传递给 `buildDecisionRequest` 和 `buildBlockedSteer`
- [x] `handleAgentEvent` 的 `tool_result` 路径：调用 `buildGrantHint` 后传入 `noteBlockedAction`
- [x] 维护 `this.blockedHints: GrantHint[]`（turn 级），供 `buildBlockedSteer` 使用

### 3. `src/renderer/renderer.ts`

- [x] `decision_request` case：若 `event.grant_hint` 存在，在 body 里追加 "授权路径：`instruction`" 一行

### 4. 测试 `test/capability-gate.test.mjs`（新建）

- [x] `classifyToolResult` 不变（6 个回归用例）
- [x] `buildDecisionRequest` 带 hint → `DecisionRequest.grant_hint` 存在
- [x] `buildDecisionRequest` 不带 hint → `DecisionRequest.grant_hint` 为 undefined
- [x] `buildBlockedSteer` 带 hints → steer 文案含 "合法替代路径"
- [x] `buildBlockedSteer` 不带 hints → steer 文案不变（回归）
- [x] `buildGrantHint` 各工具场景（7 个用例）

### 5. 回归

- [x] `test/contract.test.mjs` 通过
- [x] `test/correction-gate.test.mjs` 通过
- [x] `npm run test:unit` 全量通过（1078 tests, 1069 pass, 0 fail, 9 skipped）
