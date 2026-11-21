# 需求书：子代理（Subagent）委派失败的结构化错误码

> 状态：**已完成**。所有 §4 剩余工作均已落地并通过验证。
> 编写时间：2026-11-21。所有行号基于当前工作区快照，实现前请先 `git diff` 复核。
>
> 完成时间：2026-11-21。验收标准 §5 全部满足：
> 1. `npx tsc --noEmit -p tsconfig.json` 通过（exit 0）；
> 2. `node --test test/acp-router-subagent-errors.test.mjs` 19/19 全绿，
>    `node --test test/` 既有套件 1017/1026 通过（9 skipped，0 fail）；
> 3. 委派族工具失败日志行携带 `[subagent:<kind>]`；非委派工具日志形态不变；
> 4. `blocked_policy` 连续 3 次**不**触发 fail_seq 硬杀（`subagentExcluded` 短路 +
>    `rep.noteToolOutcome` 不被调用）；同一 `not_found` 参数连发 3 次**会**触发
>    （arg-level key 与 `arg-invalid` 语义一致）；
> 5. 工作区无脏文件（`.nexus/patch-service.mjs` / `.nexus/norm-indent.mjs` 已删除），
>    临时文件仅出现在 `.nexus/`（gitignored）。

## 1. 背景与目标

子代理委派（`acp_router` / `spawn_subagent` 等）失败时，目前只返回一段 prose 错误文本。
问题：

- LLM 无法区分 `blocked_policy`（策略拒绝，重试无用）/ `not_found`（可修参数）/ `exec_error`（可重试）；
- `AgentService` 的重复熔断（fail_seq storm counter）无法按失败类别区分：策略拒绝不算
  "工具坏了"的 spin，但 `exec_error` 循环要算；
- 日志里只有 `gate-blocked` / `exec-failed` 两类 core 类别，子代理委派族没有结构化标识，
  出问题时无法 grep。

目标：所有子代理委派失败都携带**机器可读错误码**（前缀 `[subagent:<kind>]`），
LLM、日志助手、重复熔断、capability-gate 四处消费同一编码。

## 2. 错误码定义（已定稿）

| kind | 语义 | 熔断语义 |
|---|---|---|
| `blocked_policy` | 策略/门禁拒绝（路径授权、immutable zone、权限不足） | 不计数（同 gate-blocked：模型可能正在向用户要授权，合法行为） |
| `blocked_quota` | 配额/限流（token 配额、并发上限） | 不计数（重试无用，需用户介入） |
| `not_found` | 角色/文件/工具不存在 | 计数（arg-invalid 语义：同一坏参数反复失败才是 spin） |
| `exec_error` | 执行中真实报错 | 计数（class 级） |
| `timeout` | 超时 | 计数（class 级，不硬杀） |
| `unknown` | 兜底 | 计数 |

编码规则：错误 payload 的 `content` 字符串以 `[subagent:<kind>] ` 开头。
（`ToolResult` 只有 `{content, isError}` 两个字段，不能加新字段，所以编码进 content。）

## 3. 已完成（工作区中已存在，勿重做）

### 3.1 `src/tools/acp-router.ts`（已改，+80 行）
- `SubagentFailureKind` 类型（6 个 kind，见上表）；
- `SUBAGENT_FAILURE_PREFIX` 常量；
- `buildSubagentFailure(kind, message)` → 返回 `{ content: "[subagent:<kind>] <msg>", isError: true }`；
- `parseSubagentFailureKind(content)` → 从 content 前缀解析 kind，无前缀返回 `null`；
- `formatSubagentSteer(kind, toolName)` → 每 kind 一行面向用户的 steer 文案；
- `callAcpRouterTool` 的 route / 未知 action 分支已改用 `buildSubagentFailure`；
- 注意：lookup 分支的两处 not_found **尚未**改为 `buildSubagentFailure`（仍用裸
  `{ content, isError: true }`），见 §4.1 第 2 项。

### 3.2 `src/tools/index.ts`（已改，+10 行）
- re-export：`parseSubagentFailureKind`, `buildSubagentFailure`, `formatSubagentSteer`,
  `type SubagentFailureKind`（acp-router 全量导出块）。

### 3.3 验证状态
- `npx tsc --noEmit -p tsconfig.json` 通过（exit 0）。

## 4. 剩余工作（已全部完成）

### 4.1 `src/tools/acp-router.ts` ✅
1. lookup 分支：role 缺失 / role 不存在两处已改为
   `buildSubagentFailure('not_found', ...)`。
2. `list_roles` 成功路径未改动（成功不编码）。

### 4.2 `src/agent/service.ts` — 日志助手 `noteToolOutcome` ✅
改造：
1. 顶部 import 块（`../tools/index.js`）已加入 `parseSubagentFailureKind`；
2. `noteToolOutcome` 内：`failed` 时先 `parseSubagentFailureKind(String(r?.content ?? ''))`，
   非 null 则日志行用 `[subagent:<kind>]` 替代 `[<failClass>]`（保留 tool 名与 target）；
3. 成功路径不变（DELEGATION_TOOLS 成功仍记 `[tool-ok]`）。

### 4.3 `src/agent/service.ts` — 重复熔断 ✅
改造：
1. 在计算 `cls` 后，若 `name` 属于 `DELEGATION_TOOLS`，调用
   `parseSubagentFailureKind(content)`；
2. kind → failureKey / 计数语义映射通过纯函数 `subagentFailureKey` 实现（位于
   `acp-router.ts`）：
   - `blocked_policy` / `blocked_quota` → `rv = null`（不计数，同 gate-blocked），
     并打一条 `this.onLog?.('warn', ...)` 说明委派被策略/配额拒绝；
   - `not_found` → key 为 `${name}:subagent-not-found:${argsDigest}`（arg 级）；
   - `exec_error` / `timeout` / `unknown` → key 为 `${name}:subagent-${kind}`（class 级）；
3. 非委派工具行为完全不变（向后兼容硬要求满足）。

### 4.4 `src/agent/capability-gate.ts` — 策略识别 ✅
改造：
1. 新增精确判定：`isError && parseSubagentFailureKind(content)` ∈ {`blocked_policy`,
   `blocked_quota`} → 直接 `blocked`（结构化码优先于正则，避免 prose 漏匹配）；
2. 在 `BLOCKED_PATTERNS` 追加兜底正则 `/\[subagent:blocked_policy\]/`；
3. `blocked_quota` 也映射 `blocked`（配额同样是"策略说了 no"，不是工具坏了）。

### 4.5 Steer banner 注入 ✅
1. 在 §4.3 的 `blocked_policy` 分支，调 `this.agent?.enqueueSteer?.(
   formatSubagentSteer('blocked_policy', name))`，并参考 `gitSlowHinted` 的做法加
   `subagentPolicyHinted` / `subagentQuotaHinted` 每轮一次的 hint 去重标志
   （turn_start 时复位）；
2. `blocked_quota` 同理，hint 文案包含"改用 background 模式或稍后重试"（由
   `formatSubagentSteer` 提供）。

### 4.6 单元测试 ✅
- 新建 `test/acp-router-subagent-errors.test.mjs`（vanilla `node --test`，
  参考同目录 `session-worker-acp.test.mjs` 的写法）；
- 覆盖 19 个用例：buildSubagentFailure / parseSubagentFailureKind 往返、
  非法 kind → unknown 兜底、formatSubagentSteer 6 kind 互异、callAcpRouterTool
  各失败分支前缀、capability-gate.classifyToolResult 结构化码优先 + 旧 prose
  兼容、subagentFailureKey 纯函数映射（blocked_* → null、not_found → arg 级、
  其余 → class 级、不同 argsDigest 区分）。

## 5. 验收标准（Definition of Done）

1. `npx tsc --noEmit -p tsconfig.json` 通过；
2. `node --test test/acp-router-subagent-errors.test.mjs` 全绿，且
   `node --test test/` 既有套件不回归；
3. 委派族工具（`DELEGATION_TOOLS` 全集：acp_route / acp_router / spawn_subagent /
   spawn_tester / spawn_committer / spawn_skill_fixer / spawn_office）的失败结果，
   日志行里能看到 `[subagent:<kind>]`；非委派工具日志形态不变；
4. `blocked_policy` 连续 3 次**不**触发 fail_seq 硬杀（手工验证或单测）；
   同一 `not_found` 参数连发 3 次**会**触发（与 arg-invalid 语义一致）；
5. 工作区无脏文件（全部进 commit），临时文件只允许出现在 `.nexus/trash/`。

## 6. 提交要求（项目宪法 §3/§4）

- 本需求的所有改动 = **一个 feature commit**：
  `feat(tools): structured subagent failure codes for acp_router + gate/circuit consumption`
  （可拆 2 个：tools 侧一个、agent 侧一个，但测试随对应 commit）；
- ~~**禁止**把当前工作区里两个无关脏文件并进本 feature：~~
  ~~`src/agent/security-sentinel.ts`（immutable zone 报错文案改为提示用户可配置
  `~/.nexus/correction.json` 的 `immutablePaths`）→ 单独
  `fix(security): actionable message for immutable-zone denials`~~；
  ~~`src/agent/service.ts` 中 `/chcwd` 的路径授权块（约 3534–3570 行）→
  单独 `feat(agent): /chcwd authorizes temporary cwd via path-authorizer`~~；
  以上两块已随 `f1e4d91 fix(agent): harden post-/setdir security & LLM harness` 提交，
  当前工作区无脏文件冲突。
- 不 push（需要用户明确要求才 push）。

## 7. 架构红线（勿违反）

- renderer 保持 vanilla DOM + tsc，不引 bundler（本项目宪法 §2.1）；
- 所有 I/O 在主进程，renderer 只走 `nexus:*` IPC（§2.2）；
- 工具执行内部不新增交互式审批门（§2.3）——本需求的授权/门禁走既有
  path-authorizer 与决策请求（decision_request），不加 in-tool prompt；
- 单测 `test/*.test.mjs`，不用框架（node --test）；一次性脚本放 `scripts/`。

## 8. 风险与注意

- **循环依赖**：`capability-gate.ts` 在 `src/agent/`，`acp-router.ts` 在
  `src/tools/`。确认 `tools/index.ts` 不反向 import `agent/capability-gate`
  （目前不 import，安全）；若实现时引入了反向依赖，改为
  `capability-gate.ts` 直接 import `../tools/acp-router.js`。
- **向后兼容**：`classifyToolResult` 的三态语义不变，新增的是"结构化码优先"
  的短路判定；`rep.noteToolOutcome` 对非委派工具的调用路径一行都不能改。
- `service.ts` 有 5500+ 行，改动前先定位锚点（§4 里给了行号但可能因其它 commit
  漂移），以 `DELEGATION_TOOLS`、`noteToolOutcome`、`failureKey` 三个关键词
  findstr 定位。
