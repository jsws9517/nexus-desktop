# 消费模式开关 + 协议兼容统一（需求方案）

> 覆盖两个体验类 issue。本文件是**设计定稿**，供实施与评审。
> 仓库：`nexus-desktop`（`D:\agent-cli\nexus-desktop`）+ `nexus-coder`（`D:\agent-cli\nexus-coder`）。
> 相关机制：`docs/harness-correction-loop.md`（空转/纠错回路）、`docs/core-desktop-decoupling.md`（overlay/协议）。

---

## 0. 两个问题

1. **消费模式（Issue 1）**：harness 目前对 provider 的**资费方式**（按量 token-plan vs 包月/编码 coding-plan vs 免费 free）无感知。空转阈值、RPM、重试预算、fan-out 上界全部是硬编码或按 baseUrl 家族猜的。需要一个**用户可显式声明、按 provider 记忆**的档位，驱动这套策略。
2. **协议交错（Issue 2）**：`nexusDesktopProtocol` 是单一整数 + 精确等值门禁，且 `nexus-coder` 的 `package.json` 根本没有该字段，`publish-core.mjs` 于是回退用「发布它的那台 desktop 的协议号」盖戳 —— 等于给所有 core 补丁发一张伪造通行证。desktop 还有 25 处 `nexus-coder/dist/src/...` 深导入把 core 内部模块当 base 用。结果：**coder 补丁被 desktop 版本卡住**。

---

## 1. 设计原则

- 数字阈值只进 harness / 配置，**不进模型能改的地方**（沿用 `correction-config.ts` 的不变量：模型不可编辑）。
- 缺省必须**安全**：默认 `token`（最保守），不烧钱。
- **不自动写配置**：推断/建议只做提示，用户显式确认才落盘。
- 复用既有先例：`desktop-state.ts`（desktop 独有配置放 `~/.nexus/desktop.json`，因 core 的 zod 会 strip 未知键）、`/model` `/provider` 斜杠拦截、`forwardTabEvent` 事件透传、`MediaBillingSchema`（`quota`/`metered` 语义）。
- 两条轴分开管理（Issue 2）：**线协议**（worker RPC/事件形状，desktop 拥有）与**导入 API**（deep import，核心应拥有）。

---

# Issue 1 · 消费模式

## 1.1 数据模型（`~/.nexus/desktop.json`）

core 的 `config.json` 被 zod 校验会 strip 未知键（见 `desktop-state.ts:4-6` 注释），所以放在 desktop 独有的 `desktop.json`，不碰 core、不碰协议。

```jsonc
"spendMode": {
  "v": 1,
  "default": "token",                       // 全局默认，设置页可改
  "providers": {
    "zhipu-coding": { "mode": "coding", "host": "open.bigmodel.cn", "updatedAt": "2026-11-14T00:00:00Z" },
    "local-free":   { "mode": "free",   "host": "127.0.0.1",          "updatedAt": "..." }
  }
}
```

### 解析顺序（每轮，跟随当前 session 的 provider override）

```
provider 有条目 && 条目.host === 当前 host   → 条目.mode，来源 = 手动
provider 有条目 && host 不匹配              → default，来源 = 默认（提示「地址已变，暂按默认」）
无条目                                       → default，来源 = 默认
```

**指纹只用 host，不用 model**：同一 coding plan 下切模型（glm-4.6 → 4.5）不该丢状态；host 变了说明换厂商，往 `token` 回退（安全方向），旧条目保留以便改回。
- host 归一化：`new URL(baseUrl).hostname`，去端口/路径/协议，忽略大小写。缺省 baseUrl 的 provider 用 provider 名作 host key。

## 1.2 三档策略（唯一真相源）

`free` 单独成立：钱不是约束，**RPM 才是**（免费额度限速最紧）→ 思考最宽容、限速最保守。

```ts
// src/shared/spend-policy.ts
type SpendMode = 'token' | 'coding' | 'free';

token  → { rpm: 5,  backoffBaseMs: 20_000, backoffCapMs: 120_000, maxRepeat: 6,
           idleThinkingTokens: 2500, fanoutCap: 2, retryBudget: 1, correctionScale: 0.6 }
（token 的 maxRepeat/idle 与 TurnMonitor DEFAULTS（6/2500）完全一致 → 零回退）
coding → { rpm: 30, backoffBaseMs: 10_000, backoffCapMs: 60_000,  maxRepeat: 8,
           idleThinkingTokens: 4000, fanoutCap: 6, retryBudget: 3, correctionScale: 1.0 }
free   → { rpm: 3,  backoffBaseMs: 30_000, backoffCapMs: 180_000, maxRepeat: 8,
           idleThinkingTokens: 4000, fanoutCap: 3, retryBudget: 2, correctionScale: 0.9 }
```

**零回退论证**（对现有用户）：
- 今天 unknown 家族 rpm=5、429 退避 15s/60s → token 档 rpm 5（相同），退避 20s/120s（更保守，不更激进）。
- coding / free 只影响**主动设置**的用户。
- 三档下 `idle` 都只**告警不 abort**（`handleThinkingStall` 现状），不会误杀深度推理。

## 1.3 `/billing` 命令（worker 内拦截）

不叫 `/plan` —— core 已占用 `/plan` + `/go`。

| 输入 | 行为 |
|---|---|
| `/billing` 或 `/billing status` | 显示 provider、生效模式、来源（手动/默认）、策略摘要（RPM / 空转阈值 / fan-out 上限）、host 变更提示 |
| `/billing token` / `coding` / `free` | 写入当前 provider 条目，卡片回一行确认，发 `spend_mode` 事件 |
| `/billing auto` | 删除当前 provider 条目，回落全局默认 |

实现位置：`service.ts` `handleDagCommand` 的 dispatch（`:2850` 附近）加一个 `cmd === 'billing'` 分支 + `handleBillingSlash()`，仿 `handleProviderSlash`（`:2896`）。

## 1.4 首次配置建议（不自动写）

`saveProvider()`（`:4456`）成功后，按 host 家族发一条 `spend_mode_suggest` 事件，渲染器显示一次性可忽略 chip，带「设为 X」按钮（走 `setProviderSpendMode`）：

| host 特征 | 建议 |
|---|---|
| `open.bigmodel.cn` | coding，附注「若为免费额度请设 free」 |
| `apihub.agnes-ai` | coding |
| `opencode.ai/zen` | 只提示「zen 同时提供免费与付费模型，请按模型确认」 |
| `localhost` / `127.0.0.1` / `::1` | coding（本地不计费，30 rpm 实际不构成限制） |
| 其余 | 不提示 |

## 1.5 注入点（6 处，都是现成单点）

| 位置 | 现状 | 改为 |
|---|---|---|
| `service.ts:2022` | `new TurnMonitor()` | `new TurnMonitor({ maxRepeat, idleThinkingTokens })` |
| `service.ts:485` + `:2034` | `rateLimiter.getEffectiveRpm(family)` | 策略 `rpm`（`setCustomRpm` 终于用上，按 provider 名 keyed） |
| `service.ts:493` + `:2035` | `markRateLimited(family)` | `markRateLimited(family, backoffBaseMs, backoffCapMs)` |
| `service.ts:1632-1634` | `configForTaskKind(base, kind)` | 后接 `applySpendScale(cfg, policy.correctionScale)` |
| `service.ts:2180/2582` | `planFanoutClauses` 无上限 | 上界 `policy.fanoutCap` |
| 渲染器 `renderRateLimit`（`:4443`） | 只显示 RPM | 加模式 chip（token/coding/free + 手动/默认） |

`rate-limiter.ts:110-117`：`markRateLimited(family, baseMs?, capMs?)`，把硬编码 15s/60s 变参数（缺省仍是 15s/60s，零回退）。
`correction-config.ts`：新增 `applySpendScale(cfg, scale)`，缩放 L1–L4 预算与 `dilution.minThinkingTokens`，整数预算 `clamp ≥ 1`。

## 1.6 写入路径与缓存

- worker 原子写 `desktop.json`（`tmp + rename`），再发 `{ type: 'spend_mode', provider, mode }`；main 的 `forwardTabEvent`（`main/index.ts:404`）直接透传渲染器。
- `desktop-state.ts` 改成 **mtime 感知**：读缓存前 `stat`，变了就重读。否则 worker 写入后 main 仍返回旧值，设置页显示错误状态。
- 已知可接受竞态：worker（斜杠）与 main（设置页）并发写同一段。两边都是「重读→合并→原子替换」，最坏丢一次并发写；不引入锁。

## 1.7 IPC 面（设置页需要）

`channels.ts` / `register.ts` / `preload.cts` 增加（沿用 maxTabs 那套写法）：
- `getSpendMode()` → `{ default, providers }`
- `setSpendModeDefault(mode)`
- `setProviderSpendMode(provider, mode | null)`（null = 清除条目；建议 chip 的一键「设为 X」也走它）

## 1.8 边界 / 本期不做

- 按 provider 记忆 + 全局默认；**不做** per-session 差异化、**不做**从 429/402 自动推断（只留「可切到 X」文案位）。
- provider 改名后旧条目成孤儿：设置页标注「未使用」，不自动删。
- CLI / core 侧无此开关（CLI 用户手改 `desktop.json` 也能生效）。

## 1.9 测试

- 纯函数：`resolveSpendPolicy`（命中 / 未命中 / host 失配 / 默认 四路径）、`parseBillingArgs`、`formatBillingStatus`、`suggestForHost`。
- `spend-mode-store`：原子写、mtime 失效、host 变更回落 token。
- 斜杠 e2e：仿 `test/thinking-guard-e2e.test.mjs`，用假 agent 驱动 `/billing coding`，断言写盘 + 发出 `spend_mode`。
- **现有 `turn-monitor` / `thinking-guard-e2e` / `correction-*` 测试零改动**（`DEFAULTS` 与 `DEFAULT_CORRECTION_CONFIG` 不动，策略只以参数注入）。

---

# Issue 2 · 协议兼容统一

## 2.1 现状（三处证据）

1. **门禁是精确等值**：`src/core-overlay/protocol.ts` `isProtocolCompatible` = `core === desktop`，`null`（老 core）放行；`DESKTOP_PROTOCOL_FALLBACK = 3`。
2. **协议号来源被伪造**：`nexus-coder/package.json` 无 `nexusDesktopProtocol`；`publish-core.mjs:209-213` `declaredProtocol ?? envProtocol ?? readDesktopProtocol()`。一个只真正兼容 protocol 2 的 core 被盖成 3（false positive），core 只因 desktop 发新版就判 incompatible（false negative）。
3. **还有一份没人管的契约**：desktop 有 **25 处** `import ... from 'nexus-coder/dist/src/...'`（agent/config/jobs/llm/mcp/security/vault/automation）。这是**编译期接口**，与 worker RPC 无关，却共用同一整数。

两条轴：

| 轴 | 内容 | 归属 | 变更频率 |
|---|---|---|---|
| A 线协议 | `WORKER_METHODS`、`AgentEvent` 形状、工具 schema | desktop | 低 |
| B 导入 API | 那 25 个 deep import 模块 | **当前无人拥有** | 高 |

## 2.2 P0 · 等值改区间（收益最大，约半天）

- **core** 在自己 `package.json` 声明 `nexusDesktopProtocol: { "min": 2, "max": 4 }`（保留整数 → `{min:n,max:n}` 的旧语义）。
- desktop 保持 `nexusDesktopProtocol: 3`（它只说一种线协议）；**兼容判定 = 区间包含**：`core.min <= desktop <= core.max`。
- `publish-core.mjs` **删除回退到 desktop 的分支**：core 未声明就 `throw`。写 `protocolMin` / `protocolMax`（`min===max` 时兼容再写一行 `protocol`）。
- `set-core-version.mjs:87` 精确比对 → 区间包含；`npm view` 返回对象按 `{min,max}` 解析。
- `download.ts` `ManifestEntry` 增加 `protocolMin` / `protocolMax`，保留 `protocol` 读旧产物。
- `manager.ts` `incompatible` 文案区分「core 太旧（max<3）」/「太新（min>3）」。
- **跨仓依赖**：一旦删回退分支，`release.yml` 打包的 npm core 若还没带区间字段会失败 → **core 必须先发带 `{min,max}` 的版本（1.2.7-0），再做 desktop P0**。
- 测试改造（预期内，非回归）：`test/core-protocol.test.mjs` 的 `+1 → false` 改为三条区间断言（`{2,3}` vs 4 → false；`{2,4}` vs 3 → true；`null` → true）；`core-release-flow` / `core-version-select` / `core-download` 补 `protocolMin/Max` 解析用例。

## 2.3 P1 · 给 deep import 一个名字（1–2 天）

- core 新增 `src/desktop-api.ts`，re-export desktop 需要的 25 个模块的符号（agent/config/jobs/llm/mcp/security/vault/automation）。构建产物 `dist/src/desktop-api.js` + `.d.ts`。
- core **不加 `exports` 字段**：一旦加，`nexus-coder/dist/src/...` 全被封死，desktop 3 和 `scripts/load-test.mjs:68` 立刻编译失败。用「约定 + 文档」，不用 exports 强制。
- desktop 25 处 import 改为 `nexus-coder/dist/src/desktop-api.js`（facade 物理位置在 dist 里；不加 root shim，避免 npm files / overlay / base 三处打包漂移）；`scripts/load-test.mjs:68` 同步。
- overlay 的 `resolve-hook.ts` 天然支持（按 `nexus-coder/<rel>` 映射到 overlay 目录）。
- **两条保留深路径的例外**（有明确理由，注释在调用处）：
  - `automation-runner.ts` 的 store/runner **动态** import：隔离 native better-sqlite3（main 进程必须能在 binding 损坏时继续启动），走 facade 会把整张图耦合进这个容错路径；
  - `doctor/dependency-doctor.js`（动态 + try/catch 优雅降级）与 `config/web.js`（`createRequire.resolve` 取路径，非符号导入）。
- 一次协议 bump `3 → 4`。平滑迁移：P0↔P1 之间发的 core 用 `{min:2,max:4}` + 同时含 deep 模块与 facade，desktop 3/4 都能装。
- **overlay 完整性门禁**（关键风险）：`resolve-hook` 在 overlay 缺文件时会回退 base → 老 overlay 没有 `desktop-api.js` 时 desktop 会静默加载 base、overlay 失效。`core-overlay/manager.ts` 激活前必须校验 overlay 含 `dist/src/desktop-api.js`，否则拒绝并回退；boot 门禁（`main/index.ts`）对遗留无声明（null → legacy 放行）的 overlay 同样校验。老 overlay 是 `{min:2,max:3}`，desktop 4 天然不兼容，区间门禁先挡住，完整性门禁兜底。

## 2.4 P2 · 契约可校验（1 天）

落地为「core 侧无依赖契约 + desktop 侧校验测试」两段，**不**替换 `ipc-validation.ts`——它的字段级 spec（类型/可选性/上限）仍是 desktop 单侧所有，只有「方法名单」「事件名」「工具名」这三份跨仓库事实抽到 core。

**core 侧**（`nexus-coder/src/contract.ts`，纯数据、零 import）：
- `AGENT_EVENT_TYPES`：core 在 `agent.onEvent` 上发的全部事件类型（遍历 `agent.ts` / `task-tools.ts` / `sub-agent-worker.ts` 的 `onEvent` 调用收集，含 orchestrator/task 家族）。
- `WORKER_METHODS`：desktop agent-worker 对 main 暴露的 RPC 方法名单（与 desktop `ipc-validation.ts` 的 `WORKER_METHODS` spec map 的键一致；字段 spec 本身不下放）。
- `CORE_TOOL_NAMES`：core 三层工具名（agent-layer / task-spawn-ACP / builtin）。
- 三者经 `desktop-api.ts` facade 的 value export 透出（`export { AGENT_EVENT_TYPES, WORKER_METHODS, CORE_TOOL_NAMES } from './contract.js'`），于是快照与契约同走一条稳定表面。

**desktop 侧**（`test/contract.test.mjs`，5 个测试）：
1. facade 的三份契约是「非空、无重复、全字符串」数组；
2. **事件覆盖**：`handleAgentEvent` 用 `event.type === 'x'` 分支处理的集合 + 一份**逐条注明理由**的 `KNOWN_PASSTHROUGH`（UI 透传、JobWatcher 自有、task 家族卡片等）必须覆盖 `AGENT_EVENT_TYPES` 全部；反向再断言 passthrough 列表里没有「已被处理」或「core 已不发」的过期项——防止列表本身漂移；
3. **RPC 名单**：desktop `WORKER_METHODS` spec map 的键与 core `WORKER_METHODS` 双向全等（core 加方法 → desktop 红；desktop 加方法 → 提示补进 `contract.ts`）；
4. **工具名**：desktop 硬编码的 `DELEGATION_TOOLS` 全部落在 `CORE_TOOL_NAMES`，外加 4 个「提示词里让模型直呼」的 canary 名（`generate_image` / `generate_video` / `media_task` / `bg_job`）；
5. **facade 符号快照**：`Object.keys(await import('nexus-coder/dist/src/desktop-api.js'))` 的运行时 value 表面钉死在 `test/fixtures/desktop-api-snapshot.json`（type-only re-export 编译期抹除，不入快照）。core 无意删符号 → 此测试红，且 desktop 的 TS import 同步编译报错。

**漂移即红**：core 加事件 / 加 RPC / 改工具名，若忘了同步 `contract.ts`，desktop 的这组测试在下次 `npm test` 就挂，而不是在某个用户的会话里炸。

## 2.5 附带必做 · 依赖中性检查

overlay 只换 `dist`，`src/bootstrap/resolve-hook.ts` 明确：overlay 文件的 bare specifier 一律从 **base app 的 node_modules** 解析（`nextResolve(specifier, { parentURL: baseParent })`）→ core 补丁**不能新增 desktop 没装的 npm 依赖**，否则用户更新后运行期 `ERR_MODULE_NOT_FOUND`。

`scripts/publish-core.mjs` 落地为发布前**硬门禁**（`dependencyNeutralityOffenders`，命中即 `process.exit(1)`，本地/CI 一致）：
- 扫描器 `collectBareSpecifiers` 是一个小状态机（code / 单引号 / 双引号 / 模板串+`${}` / 行注释 / 块注释），只捕获**真实代码**里 `from '…'` / `import('…')` / `require('…')` 的 bare 字面量，**跳过字符串/模板串/注释里内嵌的 import 语法**——这点很关键，因为 office-write 技能把 `import { Document } from 'docx'` 这类脚本以模板字符串的形式内置在 `dist/src/config/native.js` 里，naive 正则会把它们误判成顶层依赖。
- 基线 = desktop `package.json` 的 `dependencies` + `devDependencies` + node 内建 + `CORE_BUNDLE_ALLOWLIST`（core 自管的包：npm 随 nexus-coder 传递安装进 desktop node_modules 的 `@anthropic-ai/sdk` / `openai` / `tiktoken` / `@modelcontextprotocol/sdk` / `@larksuiteoapi/node-sdk` / `@huggingface/transformers`，以及 CLI 侧只静态出现不进 desktop 运行图形的 `chalk` / `commander` / `zod` / `qrcode` / `https-proxy-agent`，再有 office-native 技能自带 node_modules 的 `docx` / `pptxgenjs` / `pdfkit` / `pdf-parse`）。
- 任何超集包 → 列出「包名 + 首次出现的文件」，提示「加进 desktop package.json 或 ALLOWLIST（并注明理由）」后拒发。
- 脚本加了 `isDirectRun` 守卫 + 导出 `collectBareSpecifiers` / `dependencyNeutralityOffenders`，`test/core-dependency-neutral.test.mjs` 单挑扫描器正/负路径（含「字符串里的 import 不算」「未知包必拒」「当前 dist 零违规」三条）。

---

## 3. 实施顺序与交付物

```
① Issue 1 消费模式        纯 desktop，~1.5 天，独立可发
② Issue 2 P0 协议区间     core 先发 1.2.7-0（带 {min,max}）+ desktop 半天
③ Issue 2 P1 facade       1–2 天，protocol 3→4 + overlay 完整性门禁
④ Issue 2 P2 契约         1 天
⑤ 依赖中性检查            并入 publish-core（② 或 ④）
```

**Issue 1 与 Issue 2 完全解耦**（Issue 1 零 core 改动、零协议变更），可先独立发版。

## 4. 风险清单

- `publish-core.mjs` 删回退分支后，`release.yml` 依赖 npm 上的 core；**core 的 `package.json` 改动必须先于 desktop P0 合入并发版**，否则 release 直接失败。
- `test/core-protocol.test.mjs` 已把「精确相等」写死，P0 必改这些断言（方案一部分，非测试退化）；保留一条 `null → 放行` 用例，否则老产物被判死。
- `desktop.json` 双写者（worker + main）存在已知可接受竞态，最坏丢一次并发写。
- `desktop-state` 加 mtime 感知后，所有读路径的缓存语义变化需回归。
