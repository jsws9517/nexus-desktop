# Harness 加固方案 v2 — 6 项缺陷修复（按优先级排期 + coder/desktop 分工）

> 本文件是 6 项会话体验缺陷的**实现方案 + 排期 + 分工**，基于 2026-11-25 代码核实。
> 与 `harness-p1-roadmap.md`（第一轮加固）互补，不重叠。
> 约束不变：不新增服务、不改 DB schema、以最小改动落在现有架构内。

---

## 总览与排期

| 项 | 缺陷 | 优先级 | 工作量 | 排期 | 分工 | 状态 |
|---|---|---|---|---|---|---|
| H-1 | capability_blocked 无 grant_hint | 🔴 P0 | ~1d | 第 1 天 | desktop | ✅ 完成 |
| H-2 | bg_job 失败无外部通知 | 🔴 P0 | ~0.5d | 第 1 天 | coder + desktop | ✅ 完成 |
| H-3 | 临时文件泄漏（无 tmp_cleanup） | 🔴 P0 | ~1d | 第 2 天 | coder + desktop | ✅ 完成 |
| H-4 | 配置热更新完整性 | 🟡 P1 | ~0.5d | 第 2 天 | coder | ✅ 完成（审计确认无需改动，契约测试锁定） |
| H-5 | 中断传播不完整（sub-agent/ACP） | 🟡 P1 | ~1.5d | 第 3 天 | coder | ✅ 完成（ACP sendTask abortSignal 传播） |
| H-6 | 工具名/能力误判（后端可用性） | 🟡 P1 | ~1d | 第 3-4 天 | coder + desktop | ⬜ 待实现 |

**Day 1 完成：H-1 + H-2。** 下一步：H-3（tmp_cleanup）→ H-4（热更新审计）→ H-5（中断传播）→ H-6（后端标注）。

---

## H-1 capability_blocked 无 grant_hint（P0 / desktop）

### 现状

- `capability-gate.ts` 已有：
  - `classifyToolResult()` 分离 `blocked` / `failed`（:56）
  - `buildDecisionRequest()` 返回 grant / switch_mode / skip 三选项（:85）
  - `buildBlockedSteer()` 注入 "do not work around" 的 steer（:105）
- **缺失**：`grant_hint` 字段 — 被拒时不告知模型**具体授权路径**（哪个 config key、哪个 glob、哪个 mode 允许此操作），导致模型反复用相同参数重试 → sentinel probe-loop 冻结。

### 方案

**修改 `capability-gate.ts`**：

1. **`DecisionRequest` 接口增加 `grant_hint` 字段**

   ```ts
   export interface DecisionRequest {
     type: 'decision_request';
     tool: string;
     command?: string;
     reason: string;
     options: DecisionOption[];
     note: string;
     /** 新增：具体授权路径，告诉模型下次该怎么做。 */
     grant_hint?: GrantHint;
   }

   export interface GrantHint {
     /** 授权方式：改配置 / 切模式 / 一次放行 */
     kind: 'config' | 'switch_mode' | 'one_tap';
     /** 人类可读说明，如 "在 config.json 的 permissions.allow 里加 {\"command\": \"rm -rf\"} 的 glob" */
     instruction: string;
     /** 涉及的具体 config key，如 "permissions.allow[0].command" */
     configKey?: string;
     /** 建议的具体值，如 "rm -rf *" 或 "auto" */
     suggestedValue?: string;
     /** 建议切换到的模式，如 "auto" */
     targetMode?: string;
   }
   ```

2. **`buildDecisionRequest` 增加 `grantHint` 参数**

   签名改为：
   ```ts
   export function buildDecisionRequest(
     tool: string,
     command: string,
     rawReason: string,
     grantHint?: GrantHint,
   ): DecisionRequest
   ```
   当 `grantHint` 提供时，写入 `DecisionRequest.grant_hint`；`note` 文案同步追加 "合法替代路径见 grant_hint"。

3. **`buildBlockedSteer` 增加 `grantHint` 参数**

   在 steer 的 "Rules for the rest of this turn" 后追加：
   ```
   4) 合法路径：见 grant_hint（改 permissions.allow / 切到 auto 模式 / 一次放行）。
      若已走 grant_hint 路径但仍被拒，说明策略更严格，停止重试并报告用户。
   ```

4. **`service.ts` 的 `noteBlockedAction` 传递 hint**

   `noteBlockedAction(tool, cmd, content)` 改为 `noteBlockedAction(tool, cmd, content, hint?)`，
   在 `classifyToolResult` 返回 `blocked` 后，根据被拒工具 + 命令构造 hint：
   - `exec_command` + `rm -rf` → `kind: 'config'`, `configKey: 'permissions.allow'`, `suggestedValue: 'rm -rf *'`
   - `delete_file` → `kind: 'one_tap'`, `instruction: '在 permission card 上点 Allow Once（grant）'`
   - `acp_route` + "Agent not found" → `kind: 'config'`, `configKey: 'acp.enabled'`, `suggestedValue: 'true'` + "并确认 engines.json 含对应 agent"
   - 其他 → 不生成 hint（保持现状，`grant_hint` 为 undefined）

   **核心原则**：hint 只给**合法替代路径**，绝不暗示绕过门禁。

5. **renderer 同步**：`renderer.ts` 的 `decision_request` 事件处理里，若 `grant_hint` 存在，在决策卡片下方追加 "授权路径" 一行说明（不阻塞用户操作）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-desktop/src/agent/capability-gate.ts` | `DecisionRequest` + `GrantHint` 类型；`buildDecisionRequest` / `buildBlockedSteer` 签名 |
| `nexus-desktop/src/agent/service.ts` | `noteBlockedAction` 增加 hint 构造 + 传递 |
| `nexus-desktop/src/renderer/renderer.ts` | `decision_request` 事件渲染 `grant_hint` |
| `nexus-desktop/test/capability-gate.test.mjs` | 新增 6 个用例（hint 存在/缺失/各 kind） |

### 验证

- 单测：`classifyToolResult` + `buildDecisionRequest` 带 hint 的 6 场景
- 回归：`test/contract.test.mjs` 的 `CORE_TOOL_NAMES` 不变
- 手动：unattended 模式下 `exec rm -rf /tmp/test` 被拒 → 决策卡片显示 grant_hint "在 permissions.allow 加 glob"

---

## H-2 bg_job 失败无外部通知（P0 / desktop 为主）

### 现状

**coder 侧已有完整通知管道**（`nexus-coder/src/jobs/notify-router.ts`）：
- `dispatchJobNotification` 支持 feishu / telegram / SMTP mail 三通道
- `decideRoute` 根据 `bg.notifyRoute`（auto / channel / mail / off）选路
- `notify-delivery.ts` 实现 IM 投递 + SMTP 发送
- `agent.ts:5766` 在 bg_job 终态时调用 `dispatchJobNotification`
- 失败时输出 `[bg-notify] delivery unavailable: ...` + 修复提示

**但 desktop 侧未接通**：
- desktop 的 `AgentService.attachJobWatcher`（service.ts:2854）挂 `JobWatcher` 时，只传了 `emitOutOfBand`（会话内文本输出）+ `runWakeTurn`（自动续跑）
- **没有把 `dispatchJobNotification` 的结果转发到 UI 或外部渠道** — 用户关掉 Electron 窗口就完全无感知
- `wake.enabled` 默认 ON 但只是"会话内自动续跑"，不是"通知用户"

### 方案

**desktop 侧改动（`nexus-desktop/src/agent/service.ts`）**：

1. **`attachJobWatcher` 增加 `onJobNotification` 回调**

   ```ts
   private attachJobWatcher(mgr: JobManager): void {
     if (this.jobWatcher || !this.agent) return;
     const agent = this.agent;
     const cfg = agent.config.getWakeConfig();
     // ...existing policy construction...
     this.jobWatcher = new JobWatcher({
       manager: mgr,
       emitOutOfBand: (text: string) => { /* existing */ },
       emitCompletedText: false,
       wake: { policy, runWakeTurn: ..., canWake: ... },
       // 新增：job 终态通知回调
       onJobNotification: (result: JobNotificationResult) => {
         this.handleJobNotification(result);
       },
     });
   }
   ```

2. **新增 `handleJobNotification(result)`**

   ```ts
   private handleJobNotification(result: JobNotificationResult): void {
     // 1. 会话内输出（已有）
     this.onEvent?.({ type: 'text', text: result.summary + '\n' });
     // 2. 外部渠道投递（新增）
     if (result.externalDelivered) {
       this.onEvent?.({
         type: 'job_notification',
         jobId: result.jobId,
         kind: result.kind, // 'succeeded' | 'failed' | 'stalled'
         route: result.route, // 'feishu' | 'telegram' | 'mail' | 'none'
         detail: result.detail, // 'feishu:oc_xxx' 或 'user@example.com'
       });
     } else {
       // 外部渠道不可用 → 提示用户配置
       this.onEvent?.({
         type: 'job_notification_unavailable',
         jobId: result.jobId,
         kind: result.kind,
         reason: result.reason, // 'no_route_configured' | 'credential_encrypted' | ...
       });
     }
   }
   ```

3. **事件类型扩展**

   在 `AgentEvent` 联合类型中新增：
   ```ts
   | { type: 'job_notification'; jobId: string; kind: string; route: string; detail?: string }
   | { type: 'job_notification_unavailable'; jobId: string; kind: string; reason: string }
   ```

4. **renderer 渲染**

   - `job_notification` → 绿色/红色系统消息："✅ 后台任务 xxx 完成，已推送至 feishu:oc_xxx"
   - `job_notification_unavailable` → 黄色系统消息："⚠️ 后台任务 xxx 失败，通知渠道不可用：reason。请配置 `nexus config channels notify set`"

**coder 侧改动（`nexus-coder/src/jobs/job-watcher.ts`）**：

5. **`JobWatcher` 构造参数增加 `onJobNotification` 回调**

   ```ts
   export interface JobWatcherOptions {
     manager: JobManager;
     emitOutOfBand: (text: string) => void;
     emitCompletedText?: boolean;
     wake?: {
       policy: JobWakePolicy;
       runWakeTurn: (req: WakeTurnRequest) => void;
       canWake: () => boolean;
     };
     /** 新增：job 终态通知（含外部渠道投递结果） */
     onJobNotification?: (result: JobNotificationResult) => void;
   }
   ```

6. **`JobManager` 终态事件里调用 `dispatchJobNotification` 后，把结果传给 `onJobNotification`**

   当前 `agent.ts:5766` 已经在 bg_job 终态时调用 `dispatchJobNotification`。
   需要把 `DispatchResult` 透传到 `JobWatcher` 的 `onJobNotification` 回调，
   并附带 `summary.text`（已有的终态摘要）。

   **改动位置**：`agent.ts` 的 bg_job 终态监听器（~:5760）：
   ```ts
   void dispatchJobNotification(...).then((res) => {
     // 现有：失败时输出 [bg-notify] 提示
     if (!res.ok) { /* existing hint */ }
     // 新增：透传给 JobWatcher 的 onJobNotification
     this.bgJobManager?.getWatcher?.()?.notifyJobTerminal(job, summary, res);
   });
   ```

   或者更简洁：`JobWatcher` 自己监听 `JobManager` 的终态事件，内部调用 `dispatchJobNotification` 并触发 `onJobNotification`。
   这样 desktop 不需要改 `agent.ts`，只在 `JobWatcher` 里加一层。

   **推荐方案**：`JobWatcher` 增加 `onJobNotification` 参数，由 desktop 注入；
   `JobWatcher` 在 job 终态时自己调 `dispatchJobNotification`（需要 `ConfigManager` 引用，
   从 `manager.config` 拿）+ 触发回调。这样 `agent.ts` 不改，coder 侧改动集中在 `job-watcher.ts`。

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-coder/src/jobs/job-watcher.ts` | 构造参数增加 `onJobNotification`；终态时调 `dispatchJobNotification` + 触发回调 |
| `nexus-coder/src/jobs/notify-router.ts` | 无改动（已有） |
| `nexus-desktop/src/agent/service.ts` | `attachJobWatcher` 传 `onJobNotification`；`handleJobNotification` 方法 |
| `nexus-desktop/src/shared/types.ts`（或 `AgentEvent` 定义处） | 新增 2 个事件类型 |
| `nexus-desktop/src/renderer/renderer.ts` | 渲染 `job_notification` / `job_notification_unavailable` |
| `nexus-desktop/test/job-notify.test.mjs` | 新增 4 个用例（success delivery / unavailable / stalled / channel down） |

### 验证

- 单测：`JobWatcher.onJobNotification` 在 succeeded/failed/stalled 三种终态触发
- 回归：`test/job-wake.test.mjs` 6 场景不变
- 手动：配好 feishu channel + `bg_job launch` 一个必然失败的命令 → 关闭 Electron → 收到飞书推送

---

## H-3 临时文件泄漏（P0 / coder + desktop）

### 现状

- `src/tools/agents.ts`（:375）文档约定 "scratch/temp/draft files go under `.nexus/trash/`"
- **无任何 `tmp_cleanup` 工具**
- 无 session_end 自动清理钩子
- `delete_file` 默认 Deny（unattended hard-block）— 即使模型想清理也要被拦

### 方案

**coder 侧（`nexus-coder/src/mcp/builtin-tools.ts`）**：

1. **新增 `tmp_cleanup` 工具**

   ```ts
   {
     name: 'tmp_cleanup',
     description: 'Clean up temporary/scratch files. Targets .nexus/trash/ and session scratch dirs. ' +
       'In unattended mode this is auto-approved (non-destructive: only removes files older than 24h in .nexus/trash/). ' +
       'In prompt mode, requires user confirmation. Returns count of files removed and total space freed.',
     inputSchema: {
       type: 'object',
       properties: {
         target: {
           type: 'string',
           description: 'What to clean: "trash" (default, .nexus/trash/), "scratch" (session scratch dir), "all" (both)',
           enum: ['trash', 'scratch', 'all'],
         },
         olderThanHours: {
           type: 'number',
           description: 'Only remove files older than N hours. Default 24. Set 0 to remove all.',
         },
         dryRun: {
           type: 'boolean',
           description: 'Preview only — list files that would be removed without actually removing them. Default false.',
         },
       },
       required: ['target'],
     },
     async execute(args, ctx): Promise<ToolResult> {
       // 实现：
       // 1. 解析 target → 路径（.nexus/trash/ 在项目根，scratch 在会话目录）
       // 2. 若 dryRun=true，返回文件列表 + 总大小
       // 3. 若 unattended 模式，自动放行（非破坏性：只删 .nexus/trash/ 下 > 24h 的文件）
       // 4. 若 prompt 模式，走权限确认
       // 5. 执行删除，返回 { removed: N, freedBytes: X }
     },
   }
   ```

2. **权限层适配**（`hooks/permissions.ts`）

   - `tmp_cleanup` 加入 `DRY_RUN_FILE_TOOLS` 同类白名单：`dryRun=true` 时直接放行
   - `unattended` 模式下 `tmp_cleanup` 的 `target: 'trash'` 且 `olderThanHours >= 1` 时自动放行（非破坏性清理，不碰 tracked 文件）
   - `target: 'all'` 或 `olderThanHours: 0` 即使在 unattended 下也需确认（可能误删用户 scratch）

3. **session_end 钩子（可选，Phase 2）**

   在 `Agent` 的 `onSessionEnd` 里（或 desktop 的 `chat()` 结束路径），
   若配置 `tmp_cleanup.autoOnSessionEnd = true`，自动调一次 `tmp_cleanup(target='trash', olderThanHours=0)`。
   **Phase 2 再做，Phase 1 只加工具不自动触发。**

**desktop 侧（`nexus-desktop/src/tools/`）**：

4. **工具路由**（`routing.ts`）

   为 `tmp_cleanup` 增加路由关键词：
   ```ts
   tmp_cleanup: { group: 'fs', keywords: ['清理', 'cleanup', '临时文件', 'trash', '删除临时', 'clean up temp'] },
   ```

5. **工具声明**（`types.ts` 或对应 tool 注册处）

   确保 `tmp_cleanup` 出现在 desktop 的工具列表里（从 core `BUILTIN_TOOLS` 导入）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-coder/src/mcp/builtin-tools.ts` | 新增 `tmp_cleanup` 工具定义 + 实现 |
| `nexus-coder/src/hooks/permissions.ts` | 权限白名单 + unattended 放行规则 |
| `nexus-coder/src/contract.ts` | `CORE_TOOL_NAMES` 加 `tmp_cleanup` |
| `nexus-desktop/src/tools/routing.ts` | 路由关键词 |
| `nexus-desktop/test/contract.test.mjs` | 契约更新 |
| `nexus-coder/tests/mcp/tmp-cleanup.test.ts` | 6 个用例（trash/scratch/all/dry_run/unattended/prompt） |

### 验证

- 单测：`tmp_cleanup(target='trash')` 删除 `.nexus/trash/` 下 > 24h 的文件；`dryRun=true` 不实际删除
- 回归：`test/contract.test.mjs` 通过
- 手动：在 `.nexus/trash/` 放几个测试文件 → 调 `tmp_cleanup` → 确认删除 + 返回 count

---

## H-4 配置热更新完整性（P1 / coder）

### 现状

- `ConfigManager.reload()`（config/index.ts:1619）：`this.config = this.load()` + `this.base = structuredClone(this.config)` — **完整重读磁盘，无缓存残留**
- `reloadMailAndBg()`（:3026）：窄域重载，只替换 `mail` + `bg` 两个顶层字段
- desktop `reloadConfig`（service.ts:5429）：调 `agent.config.reload?.()`

**潜在坑**：`reload()` 重读整个 config，但 **getter 方法返回的是 `this.config` 的字段引用**（如 `getPlatforms()` 返回 `this.config.platforms`）。
如果某个 subsystem 在构造时缓存了 `config.getPlatforms()` 的**引用**（而非每次调 getter），reload 后它仍指向旧对象。

### 方案

**coder 侧**：

1. **审计 getter 缓存风险**

   在 `ConfigManager` 里加一个 `version` 计数器（`reload()` / `reloadMailAndBg()` 时 +1）。
   在 `getPlatforms()` / `getMail()` / `getBgConfig()` 等高频 getter 里返回**当前版本的引用**：
   ```ts
   getPlatforms(): PlatformsConfig {
     // 确保返回的是 this.config.platforms（活引用），不是构造时的快照
     return this.config.platforms ?? {};
   }
   ```
   如果已有 getter 是活引用（直接读 `this.config.xxx`），则无需改。
   关键检查：有没有 `private _cachedPlatforms = this.getPlatforms()` 这类构造时缓存。

2. **contract test**

   ```ts
   test('reload() clears all in-memory state', () => {
     const cfg = new ConfigManager(testDir);
     const originalPlatforms = cfg.getPlatforms();
     // 修改磁盘
     writeFileSync(join(testDir, 'config.json'), JSON.stringify({ ...original, platforms: { telegram: [...] } }));
     cfg.reload();
     // 断言：getPlatforms() 返回新值，不是旧引用
     assert.notEqual(cfg.getPlatforms(), originalPlatforms);
     assert.deepEqual(cfg.getPlatforms().telegram, [...]);
   });
   ```

3. **`reloadMailAndBg` 的窄域一致性**

   确认 `reloadMailAndBg` 不会留下 `mail` / `bg` 之外的过期引用。
   如果某 subsystem 缓存了 `config.getMail()` 的引用（非活 getter），reloadMailAndBg 后它拿到旧值。
   修复：让所有 mail/bg 相关 getter 走活引用（`this.config.mail ?? {}` 而非 `this._mail`）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-coder/src/config/index.ts` | 审计 + 修复非活引用 getter；增加 `version` 计数器（可选，用于调试） |
| `nexus-coder/tests/config/reload-integrity.test.ts` | 新增 contract test（reload 后所有 getter 返回新值） |

### 验证

- 单测：修改磁盘 config → `reload()` → 断言 `getPlatforms()` / `getMail()` / `getBgConfig()` / `getSubAgentMaxTurns()` 全部返回新值
- 回归：`nexus-coder` 全量测试不挂

---

## H-5 中断传播不完整（P1 / coder）

### 现状

**已处理**：
- `Agent.abort(interrupter)`（agent.ts:2088）：`abortController.abort()` + `requestTaskInterrupt(interrupter)`
- `requestTaskInterrupt`（:2134）：`taskAbortController.abort()` + emit text "[task] interrupt requested"
- 每个 DAG 节点 / quality gate / spawn_subagent 的 `externalSignal` 指向 `taskAbortController.signal`，
  子进程的 abortController 已 wire 进去 → **DAG 层的 sub-agent 中断传播是完整的**

**缺失**：
- **ACP 命名 agent（`acp_route`）的中断传播未确认**：`acp_route` 调 `acp.sendTask(targetAgent, { prompt }, 'nexus', emitProgress)`（builtin-tools.ts:2461），
  如果 ACP 子进程正在跑，`agent.abort()` 是否也会 kill ACP 子进程？
  从代码看，`abort()` 只 abort 了 `abortController` + `taskAbortController`，
  **没有对 ACP 子进程发 SIGTERM / 关闭 stdin**
- **desktop fan-out 层**（service.ts:3206/:3247）：`stopRequested` 检查已覆盖，
  但 sub-task 内部的 `acp_route` 调用如果正在等 ACP 响应，desktop 侧无 kill 路径

### 方案

**coder 侧**：

1. **`Agent.abort()` 增加 ACP 清理路径**

   ```ts
   abort(interrupter: RunInterrupter = 'esc'): void {
     this.abortedByUser = true;
     this.abortController.abort();
     this.busy = false;
     abortInteractivePrompt('abort');
     this.requestTaskInterrupt(interrupter);
     // 新增：中断 ACP 命名 agent
     this.interruptAcpAgents(interrupter);
   }

   private interruptAcpAgents(interrupter: RunInterrupter): void {
     if (!this.acp) return;
     // 1. 关闭活跃 ACP 会话的 stdin（让子进程退出）
     this.acp.interruptAll?.(interrupter);
     // 2. 发 out-of-band 通知
     this.onEvent?.({
       type: 'text',
       text: `\n[acp] ${interrupter === 'user' ? 'user' : interrupter} interrupt — ACP agent(s) signalled to stop\n`,
     });
   }
   ```

2. **`AcpProtocol` 增加 `interruptAll` 方法**（`acp/protocol.ts`）

   ```ts
   interruptAll(reason: string): void {
     for (const session of this.activeSessions.values()) {
       session.interrupt?.(reason); // 关闭 stdin / 发 SIGTERM / 标记 aborted
     }
   }
   ```

   具体实现取决于 ACP 子进程管理方式（spawn + pipe / RPC / socket）：
   - 如果是 spawn：`child.kill('SIGTERM')` + `stdin.end()`
   - 如果是 RPC：发 `cancel` 消息给对端
   - 标记 `session.aborted = true`，后续 `sendTask` 返回 "interrupted"

3. **`acp_route` 工具增加 abort signal 感知**

   在 `builtin-tools.ts` 的 `acp_route.execute` 里，
   把 `ctx?.abortSignal`（或 `agent.abortController.signal`）传给 `acp.sendTask`，
   当 signal abort 时立即返回 `{ content: 'ACP delegation interrupted', isError: true }`。

   ```ts
   const msg = await acp.sendTask(targetAgent!, { prompt }, 'nexus', emitProgress, ctx?.abortSignal);
   // sendTask 内部：signal.aborted → 抛 AbortError → 这里 catch 返回 interrupted
   ```

4. **sub-agent 状态标记**

   在 `requestTaskInterrupt` 的 text 输出里，把 "interrupting running sub-agents now"
   改为更精确的状态标记：
   ```ts
   this.onEvent?.({
     type: 'text',
     text: `\n[task] interrupt requested (${interrupter}) — active sub-agents: ${activeCount} (signalled to stop); no new nodes will start.\n`,
   });
   ```
   并 emit 一个 `subagent_interrupted` 事件（带 count），desktop 可渲染。

**desktop 侧**：

5. **`AgentService.abort()` 补充**

   当前 `abort()`（service.ts:4011）已调 `agent?.abort?.('user')` + `releasePendingPermissions`。
   增加：
   ```ts
   abort(): void {
     this.stopRequested = true;
     this.agent?.abort?.('user');
     this.releasePendingPermissions([...this.pendingPermissions.keys()], 'aborted', 'aborted');
     // 新增：标记活跃 sub-agent 为 interrupted（UI 侧）
     this.emitSubagentInterrupted();
   }
   ```

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-coder/src/agent.ts` | `abort()` 增加 `interruptAcpAgents`；`requestTaskInterrupt` 增强状态标记 |
| `nexus-coder/src/acp/protocol.ts` | 新增 `interruptAll(reason)` 方法 |
| `nexus-coder/src/mcp/builtin-tools.ts` | `acp_route` 传 abort signal；`acp_router` 同样 |
| `nexus-desktop/src/agent/service.ts` | `abort()` 增加 `emitSubagentInterrupted` |
| `nexus-desktop/src/shared/types.ts` | 新增 `subagent_interrupted` 事件类型 |
| `nexus-coder/tests/acp/interrupt-propagation.test.ts` | 4 个用例（abort kills ACP / DAG 节点 / quality gate / acp_route in-flight） |
| `nexus-desktop/test/abort-propagation.test.mjs` | 2 个用例（fan-out stop + sub-agent interrupted） |

### 验证

- 单测：启动 ACP agent → `agent.abort()` → 确认 ACP 子进程退出（`child.killed === true`）
- 单测：DAG 有 3 个并发节点 → `requestTaskInterrupt` → 3 个节点全部 `interrupted`
- 回归：`test/job-wake.test.mjs` 不变；`test/contract.test.mjs` 通过
- 手动：跑 `acp_route` 委派 claude → 中途按 Stop → 确认 claude 子进程被 kill + 会话标记 interrupted

---

## H-6 工具名/能力误判（P1 / coder + desktop）

### 现状

- `routing.ts` 有 `acp_router` / `acp_route` / `spawn_subagent` 的路由关键词，
  但 **工具声明里未标注 `backend` 类型**（ACP / local / MCP）
- 模型不知道：
  - ACP 是否已注册（`agent.ensureAcpRegistered()` 是否成功）
  - `engines.json` 里有没有 `claude` / `kimi` / `qwen` / `opencode`
  - 某个 MCP server 是否在线
- `acp_route` 在 ACP 未启动时返回 "ACP protocol not initialized"（builtin-tools.ts:2428），
  模型只能靠 trial-and-error 发现

### 方案

**coder 侧**：

1. **工具声明增加 `backend` 字段**

   在 `ToolDef` 接口（或 `MCP_TOOL_DEFS` 的类型）里加：
   ```ts
   backend?: 'local' | 'acp' | 'mcp' | 'builtin';
   /** 运行时可用性探测（可选） */
   availabilityCheck?: () => { available: boolean; reason?: string };
   ```

   对 `acp_route`：
   ```ts
   {
     name: 'acp_route',
     backend: 'acp',
     description: 'Delegate a task to an ACP-connected agent (kimi, qwen, opencode, claude). ...',
     // 运行时描述（动态生成）：
     dynamicDescription: (ctx) => {
       const acp = ctx.agent?.acp;
       const agents = acp?.listAgents?.() ?? [];
       const available = agents.map(a => a.id).join(', ');
       if (!acp) return '... (ACP not initialized — this tool will fail)';
       if (!available) return '... (no agents registered in engines.json — this tool will fail)';
       return `... (available agents: ${available})`;
     },
     inputSchema: { ... },
     async execute(args, ctx) { ... }
   }
   ```

2. **`buildToolDefinitions` 时注入运行时状态**

   在 `Agent` 构造工具列表时（`agent.ts` 的 `buildTools` / `getToolDefinitions` 路径），
   如果某工具有 `dynamicDescription`，调用它生成**当前状态的描述**：
   ```ts
   const desc = typeof def.dynamicDescription === 'function'
     ? def.dynamicDescription(ctx)
     : def.description;
   ```
   这样模型在每次 tool call 前看到的描述里已经包含了 "available agents: claude, kimi" 或 "ACP not initialized"。

3. **工具描述里的可用性标注**

   对 `acp_router`：
   ```
   'Route a sub-task to a named agent role. Roles defined under .nexus/agents/<name>/SKILL.md. ' +
   '(Currently N roles available: <list or "none — create a role first">)'
   ```

   对 MCP 工具：
   ```
   'MCP tool: <name>. Server status: online/offline. ' +
   '(If offline, the tool will fail with "server not running". Restart the MCP server first.)'
   ```

4. **`spawn_subagent` 标注后端**

   ```ts
   {
     name: 'spawn_subagent',
     backend: 'builtin',
     description: 'Spawn a local sub-agent (no external process). ' +
       'Always available when the agent runtime is up.',
   }
   ```

**desktop 侧**：

5. **工具路由增加 `backend` 感知**（`routing.ts`）

   ```ts
   // 当 ACP 不可用时，降低 acp_route 的路由权重（不直接移除，避免模型误判）
   acp_route: {
     group: 'acp',
     backend: 'acp', // 新增
     keywords: [...],
   },
   ```
   在 `tool-relevance.ts` 的打分里，`backend` 不匹配的（ACP 未注册）降权 50%。

6. **`DELEGATION_TOOLS` 增加可用性注释**（service.ts:250）

   ```ts
   const DELEGATION_TOOLS = [
     'acp_route',      // backend: acp — requires ACP registration + engines.json
     'acp_router',     // backend: local — requires .nexus/agents/<name>/SKILL.md
     'spawn_subagent', // backend: builtin — always available
     ...
   ];
   ```

7. **renderer 侧工具卡片**

   在工具调用的 UI 卡片里，若 `backend` 字段存在，显示小标签：
   - `acp` → "外部"（蓝色）
   - `local` → "本地"（绿色）
   - `builtin` → "内置"（灰色）
   - `mcp` → "MCP"（紫色）

   若工具描述里含 "(ACP not initialized)"，卡片显示黄色警告条。

### 改动文件

| 文件 | 改动 |
|---|---|
| `nexus-coder/src/mcp/builtin-tools.ts` | `acp_route` / `acp_router` 加 `backend` + `dynamicDescription` |
| `nexus-coder/src/acp/router.ts` | `routeTask` 返回值增加 `availableAgents` 列表 |
| `nexus-coder/src/agent.ts` | `buildToolDefinitions` 注入 `dynamicDescription` |
| `nexus-desktop/src/tools/routing.ts` | `acp_route` 加 `backend` 字段 |
| `nexus-desktop/src/tools/tool-relevance.ts` | 打分时 `backend` 不匹配降权 |
| `nexus-desktop/src/agent/service.ts` | `DELEGATION_TOOLS` 注释增强 |
| `nexus-desktop/src/renderer/renderer.ts` | 工具卡片 backend 标签 |
| `nexus-coder/tests/tools/backend-annotation.test.ts` | 4 个用例（acp 可用/不可用/agent 缺失/MCP offline） |
| `nexus-desktop/test/tool-relevance.test.mjs` | 2 个用例（backend 降权） |

### 验证

- 单测：ACP 未注册 → `acp_route` 的 `dynamicDescription` 含 "(ACP not initialized)"
- 单测：`engines.json` 无 `claude` → 描述含 "(available agents: kimi, qwen, opencode)"
- 回归：`test/contract.test.mjs` + `test/tool-relevance.test.mjs` 通过
- 手动：关闭 ACP → 跑一个需要 `acp_route` 的提示词 → 模型看到 "(ACP not initialized)" 后不调用该工具，改用 `spawn_subagent`

---

## 排期甘特图

```
Day 1 ────────────────────────────────────────
  H-1 (desktop):  grant_hint 类型 + buildDecisionRequest + noteBlockedAction + renderer
  H-2 (coder):    JobWatcher.onJobNotification + dispatchJobNotification 接通
  H-2 (desktop):  handleJobNotification + 事件类型 + renderer

Day 2 ────────────────────────────────────────
  H-3 (coder):    tmp_cleanup 工具 + 权限白名单 + contract
  H-3 (desktop):  路由关键词 + 工具声明
  H-4 (coder):    配置热更新审计 + contract test

Day 3 ────────────────────────────────────────
  H-5 (coder):    ACP interruptAll + acp_route abort signal + requestTaskInterrupt 增强
  H-5 (desktop):  abort() 补充 + 事件类型

Day 3-4 ──────────────────────────────────────
  H-6 (coder):    backend 字段 + dynamicDescription + buildToolDefinitions
  H-6 (desktop):  路由降权 + 工具卡片标签

Day 4 ────────────────────────────────────────
  全量回归 + 手动验证 + 文档更新
```

---

## 回归基线

- `nexus-coder`：`tests/jobs/*` + `tests/security/*` + `tests/mcp/*` + `tests/acp/*` + `tests/config/*` → 全量
- `nexus-desktop`：`npm run test:unit` → 844 tests 全量
- 新增测试文件：
  - `nexus-desktop/test/capability-gate.test.mjs`（H-1，6 用例）
  - `nexus-desktop/test/job-notify.test.mjs`（H-2，4 用例）
  - `nexus-coder/tests/mcp/tmp-cleanup.test.ts`（H-3，6 用例）
  - `nexus-coder/tests/config/reload-integrity.test.ts`（H-4，3 用例）
  - `nexus-coder/tests/acp/interrupt-propagation.test.ts`（H-5，4 用例）
  - `nexus-coder/tests/tools/backend-annotation.test.ts`（H-6，4 用例）
  - `nexus-desktop/test/abort-propagation.test.mjs`（H-5，2 用例）
  - `nexus-desktop/test/tool-relevance.test.mjs`（H-6，2 用例，追加）

**总计新增 ~31 个测试用例。**

---

## 风险与回退

| 项 | 风险 | 回退方案 |
|---|---|---|
| H-1 | `grant_hint` 文案误导模型走错误路径 | hint 字段可选（undefined 时行为不变），`buildBlockedSteer` 的 steer 文案不变 |
| H-2 | 外部推送在用户未配置 channel 时静默失败 | `job_notification_unavailable` 事件明确告知 reason + 修复命令，不静默 |
| H-3 | `tmp_cleanup` 误删用户 scratch | 默认 `olderThanHours=24` + `dryRun` 预演 + unattended 下 `target=all` 仍需确认 |
| H-4 | getter 活引用假设错误 | 只加 contract test，不改 getter 实现（除非 test 抓到非活引用） |
| H-5 | ACP kill 路径不完整（某些 ACP 实现不支持 SIGTERM） | `interruptAll` 是 best-effort，失败不阻断 abort；标记 "ACP interrupt: best-effort" |
| H-6 | `dynamicDescription` 每次 tool call 前重算，性能开销 | 缓存 ACP agent 列表（mtime 检查 engines.json），5 秒 TTL |

---

## 验收标准

- [ ] H-1：unattended 模式 `exec rm -rf` 被拒 → 决策卡片显示 grant_hint + steer 含合法替代路径
- [ ] H-2：配好 feishu + `bg_job launch` 失败命令 → 关闭 Electron → 收到飞书推送
- [ ] H-3：`.nexus/trash/` 有测试文件 → `tmp_cleanup` 删除 + 返回 count；`dryRun=true` 不实际删除
- [ ] H-4：修改磁盘 config → `reload()` → 所有 getter 返回新值（contract test 通过）
- [ ] H-5：`acp_route` 委派 claude → 中途 Stop → claude 子进程被 kill + 会话标记 interrupted
- [ ] H-6：关闭 ACP → `acp_route` 描述含 "(ACP not initialized)" → 模型改走 `spawn_subagent`
