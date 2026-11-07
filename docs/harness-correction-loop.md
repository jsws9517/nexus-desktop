# Harness 纠偏闭环方案（Progress Ledger + 分级纠正 + 安全哨兵 + 产出契约）

> 面向 Nexus Desktop（`D:\agent-cli\nexus-desktop`）。
> 目标：在现有 harness 上，对“推理注水 / 原地绕圈 / 突破安全壁垒 / 走捷径无产出”四类问题做**及时纠正**（不是事后止损）。
>
> 方案原则：
> - 单一事实源（Progress Ledger），四个信号共用一个账本。
> - 确定性信号优先，LLM 评审只做第二层且必须给出结构化证据。
> - 主执行器 = `enqueueSteer`（无损、安全点注入），`abort` 只作最后一档。
> - 误杀代价 > 多跑几步代价；只有高置信 + 零进展才允许 L4。

---

## 0. 现状盘点（为什么现在做不到"及时纠正"）

| 能力 | 现有实现 | 缺口 |
|---|---|---|
| 思考空转 | `src/agent/turn-monitor.ts`（噪声过滤、重复 delta、idle token 预算） | idle 仅告警；只识别“连续完全相同”，识别不了“换句话重复” |
| 动作绕圈 | `src/agent/repetition-monitor.ts`（text / tool_seq / fail_seq） | 只识别“序列相等”，识别不了“换了参数再试一次但状态没变” |
| 止损 | `src/agent/service.ts: handleAgentEvent → agent.abort()` | abort 只止损，不纠偏，丢整轮工作 |
| 用户介入 | `enqueueSteer` + rollback 安全点（`docs/intent-recognition-rollback.md`） | 目前只有用户能触发，未被 harness 用作自动纠正通道 |
| 安全 | `path-authorizer` + `onPermissionRequest` 权限桥 | 偏“拦参数”，不识别“越权意图 / 被注入后反复试探” |
| 收尾 | 提示词一句 “Never stall”（`service.ts:219`） | 无硬校验；模型说完成即完成 |

**核心缺口**：没有“进展”的唯一定义，三个 monitor 各自维护计数器，无法回答“这一步到底有没有推进”，因此只能二值处理（放过 / abort）。

---

## 1. 架构总览

```
                 ┌─────────────────────────────┐
                 │   Model step / Tool call     │
                 └──────────────┬──────────────┘
                                  │
                                  ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  PROGRESS LEDGER  (src/agent/progress-ledger.ts, 新增)       │
        │  - step 记录: fingerprint / actions / outcome / evidence     │
        │  - 信号供体:                                                │
        │      · TurnMonitor        → 注水信号 (thinking 熵/转换率)    │
        │      · RepetitionMonitor  → 绕圈信号 (tool_seq/fail_seq)    │
        │      · SecuritySentinel   → 越权信号 (意图/污点/试探计数)    │
        │      · DeliverableContract→ 捷径信号 (验收项/反作弊)        │
        └──────────────┬───────────────────────────────────────────────┘
                       ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  CORRECTION CONTROLLER (src/agent/correction-controller.ts)  │
        │  五档阶梯 L0..L4 + 干预预算 + 降级条件                        │
        │  决策输出: SteerMessage / 工具收窄 / Rollback / Abort+证据包  │
        └──────┬───────────────────────────────────────┬───────────────┘
               ▼                                        ▼
   ┌───────────────────────────┐            ┌─────────────────────────┐
   │  EXECUTORS                │            │  UI: 干预事件 + 证据包    │
   │  · agent.enqueueSteer     │            │  （可见、可接管、可回滚） │
   │  · tool whitelist 收窄    │            └─────────────────────────┘
   │  · checkpoint rollback    │
   │  · agent.abort()  [L4]    │
   └───────────────────────────┘
```

---

## 2. Progress Ledger：单一事实源

### 2.1 数据模型

```ts
// src/agent/progress-ledger.ts（新增）
export type Outcome = 'progress' | 'neutral' | 'regress';

export interface LedgerStep {
  seq: number;                  // 本轮内的第 N 个 step
  at: number;                   // Date.now()
  model: string;
  fingerprint: string;          // 状态指纹（见 2.2）
  actions: Array<{ tool: string; argsHash: string }>;
  outcome: Outcome;
  evidence: string[];           // 可解释证据，供 UI 展示与 steer 注入
  thinkingTokens: number;
  textTokens: number;
  toolOutcomes: Array<{ tool: string; ok: boolean; failKey?: string }>;
}

export interface ProgressLedgerOptions {
  /** 任务类型，决定阈值分档 */
  taskKind: 'coding' | 'research' | 'ops' | 'chat';
  /** fingerprint 中保留最近多少次工具结果 hash */
  fingerprintWindowSize?: number;
  /** 连续 fingerprint 不变多少步算“冻结” */
  frozenSteps?: number;
}
```

### 2.2 状态指纹（解决“换了参数但原地绕圈”）

```ts
function buildFingerprint(state: {
  touchedFiles: Array<{ path: string; mtimeMs: number; size: number }>;
  recentToolResultHashes: string[];   // 最近 K 次工具结果 hash
  openTodoItems: string[];            // 当前计划/todo
  testStatus?: 'pass' | 'fail' | 'unknown';
}): string
```

实现要点：
- `touchedFiles` 取自 `path-authorizer` 记录 + 文件系统 stat，限定在授权根内。
- `recentToolResultHashes` 用 fnv-1a 32bit 即可，避免大结果重哈希。
- `openTodoItems` 从会话内最近一次 LLM 产出的“计划”结构里抽取（若模型没给，则空数组）。
- **progress 判定（只有以下几类算 progress）**：
  - 新增/修改文件且 diff 非空
  - 测试由 fail → pass
  - 构建/命令状态跃迁（exit code 变化）
  - 验收项被满足（见 §5）
  - 获取了此前不存在的外部事实（新增工具结果 hash，且该 hash 未在历史出现过）
  - **读重复内容、复述计划、纯自我总结 = neutral**

### 2.3 四个信号源（都喂给 Ledger，不再各自 abort）

| 信号 | 来源 | 判定 |
|---|---|---|
| `thinking_dilution` | TurnMonitor | `newInfoRate < 0.3` 或 `zlibRatio > 0.85` 或 `conversionRate < 0.05` |
| `loop_no_progress` | Ledger fingerprint | 连续 N 步 `outcome ∈ {neutral}` 且 fingerprint 不变且 `actions>0` |
| `safety_probe` | SecuritySentinel（§4） | 越权意图 / 污点传播 / 试探计数 |
| `shortcut_suspect` | DeliverableContract（§5） | 验收项未满足但声明完成 / 反作弊命中 |

### 2.4 注水指标（具体化）

```
newInfoRate      = 1 − overlap_8gram(当前 thinking 片段, 历史 thinking ∪ 工具结果文本)
zlibRatio        = len(gzip(thinkingBuffer)) / len(thinkingBuffer)   // 越高越低熵
conversionRate   = progressEvents_sinceLastProgress / (thinkingTokens / 1000)
```

- 默认阈值：`newInfoRate < 0.30` 且 `thinkingTokens > 800` → 触发 L1。
- `zlibRatio` 仅作“低熵”辅助证据，单独不触发（避免误杀正当长推理）。
- `conversionRate` 低而 `progressEvents>0` 不算注水（长但有效）。

### 2.5 绕圈指标（具体化）

```
frozenSteps       = 连续 fingerprint 不变的步数
churnRatio        = 同文件重复读次数 / 总动作数
queryRepetition   = 同一搜索 query 归一化后在 5 步内出现 ≥ 3 次
failSeqRetry      = RepetitionMonitor 的 fail_seq，但把“重试 1 次”也算进去（原来只有 3 次连续失败）
```

- 默认：`frozenSteps ≥ 4 且 actions>0` → L1；`frozenSteps ≥ 7` → L2；`frozenSteps ≥ 10` → L3。

---

## 3. 分级纠正（Correction Controller）

### 3.1 五档阶梯

| 档位 | 动作 | 触发 | 可逆 |
|---|---|---|---|
| L0 | 只记账 | 每步 | — |
| L1 | 定向 steer 注入（带证据） | 单指标越线、置信中 | 是 |
| L2 | 收窄动作空间（工具白名单/只读/强制先出计划） | L1 后 3 步内仍无 progress | 是 |
| L3 | 回滚到上个 checkpoint + 重规划 | 连续两档无效，或 fingerprint 冻结 ≥ 10 | 是（保留快照） |
| L4 | 终止 + 证据包 + 转人工 | 高置信 + 零进展，或 safety_probe 命中 | 否 |

### 3.2 执行器映射

| 档位 | 执行器 | 现有 API |
|---|---|---|
| L1 | `agent.enqueueSteer(steerText)` | `docs/intent-recognition-rollback.md` 的 steer 通道；在 `runLlmTurn` 顶部注入，保证 `tool_use/tool_result` 配对 |
| L2 | `setToolWhitelist(tools[])` + 注入“先出计划”的 steer | 新增 `CorrectionController.narrowTools()`；whitelist 在 `getToolsForContext` 处生效 |
| L3 | checkpoint 回滚（已有 rollback 安全点）+ 注入重规划 steer | `rollbackAtSafePoint()` + `enqueueSteer()` |
| L4 | `agent.abort()` + 生成 `CorrectionEvidence` | 已有 abort |

### 3.3 干预预算与降级

```ts
interface Budget {
  l1PerTurn: number;        // 默认 2
  l2PerTurn: number;        // 默认 1
  l3PerTurn: number;        // 默认 1
  coolDownStepsAfterL1: number; // L1 后最少 2 步才允许再次 L1
}

interface Deescalation {
  progressRequired: number; // L1 之后连续 2 个 progress step → 回 L0
}
```

约束：
- **干预预算**：L1 每轮最多 2 次、L2 每轮最多 1 次；超预算直接升级，不再“唠叨”。
- **降级**：纠正后连续 2 个 progress step 回 L0。
- **不对称成本**：只有“高置信 + 零进展”才允许 L4；安全类命中 `safety_probe` 直接 L4（安全不对称：漏放代价 > 误杀）。

### 3.4 L1 steer 文本模板（具象）

```
<harness_correction kind="${kind}" severity="medium">
过去 ${steps} 步：${evidenceSummary}。
当前判定：${judgment}。
要求你：
1) 明确陈述当前假设（一句话）
2) 指出缺失信息/缺失证据
3) 给出一条不同于最近 ${N} 步的新路径
不要重复已执行的动作。
</harness_correction>
```

示例（绕圈）：

```
<harness_correction kind="loop_no_progress">
过去 5 步指纹未变。你在重复读 src/a.ts（已读 4 次），
且 3 次 exec_command 均为同一失败类 "exec-failed"。
停止重试。请：
1) 你当前假设是什么（一句话）
2) 哪条信息/证据缺失
3) 换一条路径（不得再读 src/a.ts 的第 1-40 行）
</harness_correction>
```

示例（注水）：

```
<harness_correction kind="thinking_dilution">
最近 1200 thinking token 的新信息率 0.18（8-gram 与历史重合 82%），
且无工具调用。请把推理压缩成 ≤ 200 token 的要点，
然后直接给工具调用或结论。
```

### 3.5 L2 工具收窄策略

```ts
function narrowFor(kind: 'loop_no_progress' | 'thinking_dilution',
                   ledger: ProgressLedger): NarrowPlan {
  // loop_no_progress: 保留 read/glob/grep/edit/write/execute，禁用 exec_command 的失败类
  // thinking_dilution: 注入“先行动”指令 + 禁用 sequential_think（防止继续长思考）
  // 强制项: 下一 step 必须产出 ≤ 5 行的“下一步计划”
}
```

### 3.6 L3 回滚点

- checkpoint = 上一个 `outcome === 'progress'` 的 step 对应的 session 快照。
- 回滚在 `runLlmTurn` 顶部（与 rollback 安全点一致），保留 `tool_use/tool_result` 配对。
- 回滚后立即注入“重规划” steer，并重置 Ledger 的 frozenSteps。

### 3.7 L4 证据包

```ts
interface CorrectionEvidence {
  reason: 'loop_no_progress' | 'thinking_dilution' | 'safety_probe' | 'shortcut_suspect';
  ledgerTail: LedgerStep[];         // 最近 10 步
  fingerprints: string[];
  deniedActions: Array<{ tool: string; argsHash: string; denyReason: string }>;
  usage: TurnUsage;
  userMessage: string;             // 给 UI 的一句话诊断
}
```

---

## 4. 安全哨兵（SecuritySentinel）

### 4.1 三类判定

**(a) 意图探测计数**
- 同一能力类别被拒 ≥ 2 次（越界路径 / 提权 / 写保护文件 / 网络 egress 到未授权 host）→ 冻结为只读 + 显式告警。
- 计数按“能力类别”而非“单个工具名”（避免枚举绕过）。

**(b) 污点传播（prompt-injection defense）**
- 工具结果（仓库文件、网页、issue 正文、stdout）标记为 `untrusted`。
- **同一 step 内由 untrusted 内容引出的特权动作**（写、exec、网络、提权）一律降级为需人工确认。
- 实现：在 `onToolResult` 打污点标签；在 `onPermissionRequest` 前查“本 step 的触发源是否含 untrusted”。

**(c) 不可变策略区**
- agent 会话内强制只读：`.nexus/rules/**`、harness 配置、纠偏阈值、审计日志。
- 检测器与被检测者隔离：检测器读 config，模型写不到。
- 日志 append-only；检测器配置在 main 进程加载，不随仓库走。

### 4.2 与现有 permission 桥的关系

```
tool call
  → SecuritySentinel.evaluate()
      → safety_probe?  (试探计数 / 污点 / 保护路径 / 提权 / 网络 egress)
          → hit: 直接冻结 + L4 证据包，不再弹卡片
          → miss: 走现有 onPermissionRequest / path-authorizer 流程
```

要点：
- 哨兵在权限桥**之前**跑；命中后不再给模型“再试一次”的机会。
- 保护路径集合（默认，可配置，且模型改不到）：
  ```
  .nexus/rules/**
  .nexus/config/**
  harness config (src/agent/**)
  .git/hooks/**
  CI 配置 (.github/workflows/**, .gitlab-ci.yml, Jenkinsfile)
  审计日志 (*.audit.*)
  ```

### 4.3 触发即 L4 的场景

- 写 `.nexus/rules/` 或 harness config
- 提权动作（`chmod +s`、`sudo`、修改 `PATH`、安装 root 包）
- 网络 egress 到“本 step 首次出现”的 host 且携带凭证
- 能力类别连续被拒 ≥ 2 次
- untrusted 触发源 + 特权动作 同 step

---

## 5. 产出契约（DeliverableContract）

### 5.1 验收项模型

```ts
export type Acceptance =
  | { kind: 'file_exists'; path: string; nonEmpty?: boolean }
  | { kind: 'test_pass';   cmd: string; expectExit: 0 }
  | { kind: 'exit_zero';   cmd: string }
  | { kind: 'diff_contains'; path: string; pattern: string }
  | { kind: 'artifact';    path: string }
  | { kind: 'citation';    min: number }
  | { kind: 'numeric';     expr: string; expect?: number; op?: '>=' | '<=' | '==' };

export interface DeliverableContract {
  items: Acceptance[];
  source: 'parsed_from_user' | 'derived_from_plan';
  lastVerifiedAt?: number;
}
```

### 5.2 解析来源

- `parsed_from_user`：开工时把用户请求解析为可验证项（文件存在/测试通过/命令退出码/数字指标/artifact/引用）。
- `derived_from_plan`：从模型自己的“计划”里抽验收项；若两者都空，则记 `inferred_baseline`（至少要求：diff 非空 + 无新 TODO + 无未实现 stub）。

### 5.3 收尾验证

- 在“完成”态前逐条断言；任一未满足 → **拒绝进入完成态**，把失败项作为 L1 steer 注回去。
- 验证器必须机器可执行，不用 LLM 主观判断。

### 5.4 反作弊检查（布尔断言）

| 检查 | 判定 |
|---|---|
| `tests_only_change` | 测试/断言被改，实现文件 diff 为空 |
| `assertion_deleted` | 删除了断言/加了 `skip`/`xit`/`xfail` |
| `stub_as_impl` | 新增 `TODO`/`not implemented`/mock 且被当实现用 |
| `narration_without_action` | 最后一条消息声称“已完成”，同 step 无工具调用 |
| `pushback_to_user` | 把本可自执行的命令推给用户（提示词已有 "Never stall"，但无硬校验） |
| `empty_diff_claims` | 报告有结论但 diff 为空 |
| `report_without_artifact` | 声称“已生成”但无 artifact 路径或文件不存在 |

### 5.5 失败处理

- 任一命中 → 拒绝完成 + L1 steer（带命中的检查名与证据）。
- 连续 2 轮命中同一项 → 升级 L2（收窄为“必须补实现/必须跑测试”）。
- 仍无 progress → L3 回滚到开工前 checkpoint 重新规划。

---

## 6. 代码落点（具象化）

| 新/改 | 路径 | 责任 |
|---|---|---|
| 进度账本 | `src/agent/progress-ledger.ts` | 单事实源；fingerprint；progress 判定 |
| 纠偏控制器 | `src/agent/correction-controller.ts` | L0..L4 策略表；预算；降级；steer 文本生成 |
| 安全哨兵 | `src/agent/security-sentinel.ts` | 意图/污点/试探；不可变策略区 |
| 产出契约 | `src/agent/deliverable-contract.ts` | 验收项解析/断言/反作弊 |
| 挂钩 | `src/agent/service.ts handleAgentEvent` | onStepEnd / onToolEnd 喂 Ledger；`tool_call_start` 上跑哨兵并缓存判决 |
| 挂钩 | `src/agent/service.ts finishCorrectionStep` | step 结束时取信号并执行纠正 |
| 挂钩 | `src/agent/service.ts earlyInit` | 注册 core `preToolUse`（执行前硬拦）与 `onTurnEnd`（完成闸门） |
| 执行器 | `agent.enqueueSteer`（已有） | L1/L2/L3 注入 + 完成闸门 steer |
| 执行器 | `agent.abort()`（已有） | 仅 L4 |
| 工具收窄 | 在 `getToolsForContext` 处生效（core） | L2 |
| 现有 monitor | `TurnMonitor` / `RepetitionMonitor` 保留 | 改为向 Ledger 供信号，不再各自 abort |
| UI | 干预事件 + 证据包 + 接管/回滚按钮 | 可观察、可接管 |

### 6.1 关键接口（具象签名）

```ts
// progress-ledger.ts
class ProgressLedger {
  constructor(opts: ProgressLedgerOptions);
  recordStep(step: Omit<LedgerStep, 'seq' | 'fingerprint'>): LedgerStep;
  buildFingerprint(state: FingerprintState): string;
  classifyOutcome(prev: LedgerStep | null, cur: LedgerStep): Outcome;
  signals(): Array<{ kind: SignalKind; severity: number; evidence: string[] }>;
}

// correction-controller.ts
class CorrectionController {
  constructor(ledger: ProgressLedger, executors: Executors, cfg: CorrectionConfig);
  onStepEnd(step: LedgerStep): CorrectionAction | null;
  onTurnEnd(contract: DeliverableContract): CorrectionAction | null;
  apply(action: CorrectionAction): void;
  evidencePack(): CorrectionEvidence | null;
}

// security-sentinel.ts
class SecuritySentinel {
  evaluate(ctx: { tool: string; args: unknown; stepHasUntrustedSource: boolean }):
    { ok: boolean; probe?: ProbeType; reason?: string };
  frozenCategory(): CapabilityCategory | null;
}

// deliverable-contract.ts
class DeliverableContract {
  parse(userReq: string): DeliverableContract;
  verify(sessionId: string): { passed: boolean; failed: Array<{ item: Acceptance; why: string }> };
  antiCheatChecks(diff: GitDiff, transcript: Message[]): Array<CheatFinding>;
}
```

### 6.2 挂钩示例

```ts
// service.ts: handleAgentEvent 内，tool 结果处
if (event.type === 'tool_result' && this.activeLedger) {
  const step = this.activeLedger.recordStep({
    model: this.activeMonitor!.model,
    actions: this.toolCallsAcc.map(a => ({ tool: a.name, argsHash: fnv1a(JSON.stringify(a.args)) })),
    toolOutcomes: /* from event */,
    thinkingTokens: this.activeMonitor!.thinkingEstimate,
    textTokens: estimateTokens(this.activeMonitor!.textChars),
  });
  const action = this.correction.onStepEnd(step);
  if (action) this.correction.apply(action);
}
```

---

## 7. 配置与阈值（集中、不在仓库、模型改不到）

```jsonc
// 由 main 进程加载；路径示例：~/.nexus/correction.json
{
  "budget": { "l1PerTurn": 2, "l2PerTurn": 1, "l3PerTurn": 1, "coolDownStepsAfterL1": 2 },
  "deescalation": { "progressRequired": 2 },
  "thresholds": {
    "loop":      { "frozenSteps": 4, "hard": 10 },
    "dilution":  { "newInfoRate": 0.30, "minThinkingTokens": 800, "zlibRatio": 0.85 },
    "safety":    { "probeCountToFreeze": 2 },
    "contract":  { "maxAntiCheatRetries": 2 }
  },
  "taskKindDefaults": {
    "coding":   { "frozenSteps": 4 },
    "research": { "frozenSteps": 6 },
    "ops":      { "frozenSteps": 3 },
    "chat":     { "disabled": true }
  },
  "immutablePaths": [
    ".nexus/rules/**",
    ".nexus/config/**",
    "src/agent/**",
    ".git/hooks/**",
    ".github/workflows/**",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    "*.audit.*"
  ]
}
```

---

## 8. 分期与验收指标

| 阶段 | 内容 | 关键验收 |
|---|---|---|
| **P0（1–2 周）** | Ledger + L1/L2 + 把 abort 降级为 L4；TurnMonitor/RepetitionMonitor 改为信号供体 | 无效 token 占比 ↓；误杀率 ≤ 基线；L1 注入可见 |
| **P1（2–3 周）** | 产出契约 + 反作弊 + 安全哨兵 + 不可变策略区 | 验收通过率 ↑；注入攻击拦截率；试探冻结数 |
| **P2（3–4 周）** | L3 回滚重规划；阈值自适应；跨会话统计；UI 干预时间线 | 首次纠正成功率 ↑；人工接管率 ↓；fingerprint 冻结分布 |

### 8.1 核心指标（必须一起看，单看会被“多跑几步”刷分）

- 无效 token 占比：`neutral thinking tokens / total thinking tokens`
- 首次纠正成功率：L1/L2 后 2 步内出现 progress 的比例
- 误杀率：在“本应有 progress”的会话中被 L3/L4 命中
- 验收通过率：`DeliverableContract.verify` 通过
- 安全拦截/漏放：`safety_probe` 命中 / 漏放（对一组注入攻击测试集）
- 人工接管率：L4 证据包后用户实际接管

### 8.2 回归测试（必带）

- 确定性 fixture：
  - 绕圈 fixture：5 步 fingerprint 不变，断言 L1 触发、L2 触发、L3 触发。
  - 注水 fixture：zlibRatio 0.9 且无工具调用，断言 L1 触发；同内容但 progressEvents>0 不触发。
  - 安全 fixture：连续 2 次越界路径，断言冻结只读 + L4 证据包。
  - 反作弊 fixture：只改测试 + 实现 diff 为空，断言拒绝完成 + L1。
  - 误杀 fixture：长推理但每步 progress，断言不触发任何 L。
- 与 `test/*.test.mjs`（vanilla node test）同风格。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| L1 注入本身变噪 | 干预预算 + coolDown；steer 文本 < 200 token |
| fingerprint 误判（大 diff 被 hash 成“变”） | fingerprint 只看 touched 文件集合 + 结果 hash，不 diff 全树 |
| 误杀正当长思考 | 不对称成本原则：只有“高置信 + 零进展”才 L4；降级回 L0 |
| 模型改阈值绕过 | 不可变策略区 + main 进程加载 + 模型写不到 |
| 提示注入 | 污点传播；untrusted 源同 step 特权动作必须人工 |
| 用户疲劳点“允许” | 试探计数 → 冻结只读，不再弹窗 |
| 单指标被“多跑几步”刷分 | 多指标联动 + 首次纠正成功率 + 误杀率双看 |

---

## 10. 一句话总结

> 现有 harness 有“体温计”（TurnMonitor/RepetitionMonitor），缺“病历 + 处方 + 复诊”。
> 把三个 monitor 合并成**进度账本**；把 `abort` 的二值反应换成**五档 steer 阶梯**；安全从“拦参数”前移到**识意图 + 断污点 + 试探冻结**；用**产出契约**给“完成”一个可机器判定的定义。
> 合起来，才是“及时纠正”而不是“及时止损”。

---

## 11. 实现状态（2026-11，P0 + P1 已落地）

### 11.1 已交付文件

| 模块 | 路径 | 说明 |
|---|---|---|
| 进度账本 | `src/agent/progress-ledger.ts` | 状态指纹、progress/neutral/regress 分类、注水与绕圈信号（含 8-gram novelty / gzip 低熵） |
| 纠偏控制器 | `src/agent/correction-controller.ts` | L1–L4 阶梯、干预预算、冷却、升级、降级、证据包 |
| 安全哨兵 | `src/agent/security-sentinel.ts` | 不可变策略区、提权模式、污点传播、按能力计数的试探冻结 |
| 产出契约 | `src/agent/deliverable-contract.ts` | 验收项解析/校验 + 7 类反作弊检查 |
| 配置 | `src/agent/correction-config.ts` | 默认值 + `~/.nexus/correction.json` 深度合并（未知字段忽略） |
| 接线 | `src/agent/service.ts` | `beginCorrectionTurn` / `handleAgentEvent` / `finishCorrectionStep` / `finalizeCorrectionTurn` / `handleSentinelDecision` |

### 11.2 实际接线点

- **每个 user turn 开始**：`runTurn()` → `beginCorrectionTurn(input)` 创建 Ledger / Sentinel / Controller / Contract，并调用 `controller.resetTurn()` 清空预算与工具策略。
- **每个 core 事件**：`handleAgentEvent()`
  - `thinking` → 累计到 `stepThinking`（噪声已过滤）
  - `text` → 累计到 `stepText`
  - `tool_call_start` → **先过 SecuritySentinel**（fatal 直接 L4 + abort），再记录动作；写工具记录目标路径
  - `tool_result` → 记录成功/失败、结果文本、污点标记（network / 外部 MCP）、写后文件状态
  - `turn_start` → 清空 step 累积器
  - `turn_end` → `finishCorrectionStep()`：写 ledger、取信号、注入 shortcut 信号、执行纠正
- **工具收窄**：`getToolsForContext` 末尾按 `ToolPolicy` 过滤（`readOnly` / `denyTools`）；过滤后为空则 **fail-open**，不会把 turn 弄死。
- **turn 结束**：`finalizeCorrectionTurn()` 跑契约校验 + 反作弊，发出 `contract_verdict` 事件；未通过时再尝试一次 steer（若 turn 已结束则只留事件与日志，绝不静默成功）。
- **事件面**：新增 `correction`、`security_probe`、`contract_verdict` 三类事件，UI 可直接消费。

### 11.3 关键行为细节

- **不可变策略区只拦写、不拦读**：agent 仍可读 `.nexus/rules/NEXUS.md`，但不能写。
- **污点来源仅限 network / 外部 MCP**：避免“读文件 + 写文件”同 step 被误判；注入攻击的主要入口是外部内容。
- **命令类验收默认 `skipped`**：`verifyContract` 不自行执行 shell；只有调用方显式提供 `run()` 才会跑命令。这是故意的安全边界。
- **无 git diff 时 `diffKnown=false`**：worker 内没有可信 diff，`tests_only_change` / `assertion_deleted` / `stub_as_impl` / `empty_diff_claims` / `report_without_artifact` 跳过，而不是猜测；`narration_without_action` / `pushback_to_user` 仍然生效。
- **L1 冷却与预算**：默认每轮 L1 ≤ 2、L2 ≤ 1、L3 ≤ 1，L1 后至少隔 2 步；低置信超预算时**抑制**而不是升级，高置信（≥0.7）才继续爬梯。
- **降级**：连续 `deescalation.progressRequired`（默认 2）个 progress step → 清空等级并 `setToolPolicy(null)`。

### 11.4 测试

| 测试 | 覆盖 |
|---|---|
| `test/progress-ledger.test.mjs` | 8-gram novelty、gzip 比率、outcome 分类、绕圈阈值、注水阈值、progress 重置 |
| `test/security-sentinel.test.mjs` | 能力分类、不可变区、提权模式、污点、试探冻结、路径/命令/URL 提取、** glob |
| `test/deliverable-contract.test.mjs` | 契约解析、6 类验收校验、7 类反作弊、完成声明否定、提示格式化 |
| `test/correction-controller.test.mjs` | L1–L4、预算、冷却、升级、降级、证据包、安全优先 |
| `test/correction-e2e.test.mjs` | 真实 `AgentService.handleAgentEvent` 链路：L1 steer、升级、不可变区 fatal、污点 fatal |
| `test/correction-gate.test.mjs` | core hook 注册、`preToolUse` 消费缓存的 sentinel 判决、完成闸门的拒绝/放行/不声明/预算耗尽 |

### 11.5 完成闸门（已落地）

第一版只在 turn 结束后发 `contract_verdict`，属于“事后记账”。现在把闸门前移到 core 的 `end_turn` 之前：

- core 侧 `Hooks.onTurnEnd` 的返回值从 `void` 扩展为 `TurnEndVerdict`：`void` / `'allow'` 保持旧行为，`{ verdict: 'continue', reason, steer?, gate? }` 表示拒绝完成。
- 拒绝后 core **不发** `turn_end`，把 `steer` 通过 `enqueueSteer` 排进安全点通道，再跑一轮 LLM；同时发出 `completion_gate` 事件（`gate` / `reason` / `attempt` / `exhausted`）。
- 拒绝次数由 `maxCompletionGates`（默认 3）按 chat 周期封顶，超限时发 `exhausted: true` 并放行，避免坏 hook 烧光 turn 预算。
- 只拦“干净完成”：`unverified` / `arg_storm` / `tool_use` 路径不走闸门，它们本身已带终态结论。
- desktop 侧 `evaluateCompletionGate()` 的保守条件：必须声明完成、请求解析出至少一个验收项、只校验文件系统可验证项（不跑 shell）、只有 high 严重度反作弊命中才拦、并受 `thresholds.contract.maxAntiCheatRetries` 约束。
- 被拒绝的完成被视为一个 step 边界（无 `turn_end`），以 `classify` 模式喂给 ledger，使“反复声明完成但交付物缺失”在进度账本里表现为无进展。

### 11.6 尚未落地（P2 及以后）

1. **可信 git diff provider**：把 `diffKnown` 打开，启用全部反作弊检查。
2. **UI 干预时间线**：把 `correction` / `security_probe` / `contract_verdict` / `completion_gate` 渲染成可展开、可接管、可回滚的卡片。
3. **命令类验收的执行器**：在明确授权（单独配置开关 + 用户确认）后才允许 `verifyContract` 跑测试命令。
4. **跨会话统计**：首次纠正成功率、误杀率、安全拦截/漏放率。

