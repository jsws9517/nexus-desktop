# MCP 工具授权的权限分级 / Permission Modes for MCP Tool Authorization

> 范围：本文档描述桌面端（nexus-desktop）在 `prompt` / `auto` / `unattended` 三类权限模式下如何放行 MCP 工具调用。仅引用桌面仓库实现（`src/agent-service.ts` 等），不覆盖 coder 核心内部实现。
> Scope: This document describes how the desktop (nexus-desktop) authorizes MCP tool calls under the three permission modes `prompt` / `auto` / `unattended`. It references only desktop-repo implementation (e.g. `src/agent-service.ts`), not the coder core internals.

## 模式切换 / Mode Selection

权限模式由用户设定，桌面 worker 通过 `AgentService.getActiveMode()` 读取（`src/agent-service.ts:1240`）。支持的值：`prompt | auto | unattended`，默认 `prompt`。

The permission mode is set by the user and read by the desktop worker via `AgentService.getActiveMode()` (`src/agent-service.ts:1240`). Valid values: `prompt | auto | unattended`, defaulting to `prompt`.

## 授权执行链路 / Authorization Flow

桌面 worker 对每个工具调用建立一个授权桥（`onPermissionRequest`，`src/agent-service.ts:400`），按模式分流：

The desktop worker installs an authorization bridge per tool call (`onPermissionRequest`, `src/agent-service.ts:400`) that branches on the active mode.

```
工具调用 (tool call)
   │
   ├─ mode = auto       → 直接 { verdict: 'allow' }，不弹卡（agent-service.ts:408）
   │                      (auto: allow without prompt)
   │
   ├─ mode = prompt     → 通过 askPermission() 弹一张授权卡，用户回答 y(单次) / a(始终) / n(拒绝)
   │                      (prompt: show one card, answer y/a/n — agent-service.ts:415)
   │
   └─ mode = unattended → 不调用本桥；由 worker 挂载的其他闸门兜底
                          (unattended: this bridge is bypassed; other worker gates apply)
```

补充桥接：知识图谱写（`remember`/`user_info` 等）走独立的 `audit.setAskUser` 桥（`src/agent-service.ts:376`）；
内置 sqlite / memory 写工具另有桌面自定义批准门（见下文「桌面特有闸门」）。

Additional bridge: knowledge-graph writes (`remember`/`user_info` …) go through a separate `audit.setAskUser` bridge (`src/agent-service.ts:376`); builtin sqlite / memory write tools have their own desktop approval gates (see "Desktop-specific gates" below).

## 三类模式对照表 / Mode Comparison Table

| | prompt（交互）<br/>interactive | auto（自动）<br/>auto | unattended（无人值守）<br/>unattended |
|---|---|---|---|
| **是否弹授权卡**<br/>Shows a permission card | ✅ 每回合弹一张<br/>Every turn, one card | ❌ 不弹，直接 allow<br/>None, direct allow | ❌ 不弹<br/>None |
| **普通 MCP 工具**（如 pyright_status）<br/>Ordinary MCP tools (e.g. pyright_status) | 弹卡，由用户决定<br/>Card, user decides | 自动放行<br/>Auto-allowed | 自动放行<br/>Auto-allowed |
| **高风险 MCP 工具**（delete_*/exec*/…）<br/>High-risk MCP tools (delete_*/exec*/…) | 弹卡，由用户决定<br/>Card, user decides | 需整服务器进入 mcpAllowlist（`mcp:<server>`）方可静默放行，否则弹卡<br/>Needs whole-server trust in mcpAllowlist to auto-allow, else card | 服务器在 mcpAllowlist（`mcp:<server>`）→ 放行；否则直接拒绝<br/>Trusted server → allow; otherwise deny |
| **拒绝场景**<br/>Denied when | 用户点拒绝(n)<br/>User clicks deny (n) | 工具在 config 中被等级 deny；未受信任的高风险 MCP 工具<br/>Tool level=deny in config; untrusted high-risk MCP tool | 命中无人值守安全闸门（破坏性 DB/批量/无 git 保护写）；未受信任的高风险 MCP 工具<br/>Unattended safety gate hit (destructive DB/batch/ungit-checkpointed write); untrusted high-risk MCP tool |

### 例外说明（桌面特有） / Desktop-specific exceptions

- 内置 sqlite / memory / git **写**工具：`prompt` 下弹卡（与 core 行为一致）；`auto` 与 `unattended` 直通（`src/agent-service.ts:276,289,299`）。git 写集含 commit/stage/reset/push/checkout/merge/rebase 等 26 个变更类工具。

  Builtin sqlite / memory / git **write** tools: card in `prompt`; pass-through in `auto` and `unattended` (`src/agent-service.ts:276,289,299`). The git write set covers 26 mutating tools (commit/stage/reset/push/checkout/merge/rebase …).

- 内置 fetch / time 为只读能力（无写门）：`fetch` 会访问网络并遵循 robots.txt，`time` 纯计算；两者在 `prompt` 下均不弹卡。

  Builtin `fetch` / `time` are read-only (no write gate): `fetch` performs network access honoring robots.txt (from `src/main/fetch-tools.ts`, aligned with mcp-server-fetch); `time` is pure computation (`src/main/time-tools.ts`, aligned with mcp-server-time).

- 知识图谱写桥（`audit.setAskUser`）：`auto` / `unattended` 自动批准（返回 `'y'`），`prompt` 弹卡（`src/agent-service.ts:376-387`）。

  Knowledge-graph write bridge (`audit.setAskUser`): auto-approved in `auto`/`unattended`, card in `prompt` (`src/agent-service.ts:376-387`).

- AIAC 面板不适用：`auto` 分支会**跳过**授权桥返回 `allow`，交由后续内置策略处理。

  Not applicable to the AIAC panel: the `auto` branch **skips** the bridge and returns `allow`, deferring to downstream builtin policy.

## 单次 vs 持久授权 / One-time vs Persistent Authorization

- 授权卡按钮 `y`（单次 / once）与 `a`（始终 / always）在这个桌面桥里**都只放行当前这一回合**，`a` 并不跨回合/跨会话持久生效（`src/agent-service.ts:418-421`）。

  Both buttons `y` (once) and `a` (always) only authorize the **current turn** in this desktop bridge; `a` does not persist across turns/sessions (`src/agent-service.ts:418-421`).

- 持久化的真正手段是写配置 `permissions.mcpAllowlist`，其条目格式为整服务器信任 `mcp:<server>` 或精确工具名。该字段在桌面 UI 中当前未暴露，需直接编辑配置。

  The real persistence mechanism is the `permissions.mcpAllowlist` config field, whose entries are whole-server trust `mcp:<server>` or an exact tool name. This field is not currently exposed in the desktop UI and must be edited in config directly.

- `exec_command` 落盘会话级审批记录（`GLOBAL_SCOPE` 路径授权可达会话内持久），但**不**覆盖 MCP 工具授权。

  `exec_command` writes session-level approval records (path authorization can persist within a session via `GLOBAL_SCOPE`), but does **not** cover MCP tool authorization.

## 关键配置项 / Key Configuration

| 配置字段<br/>Field | 作用<br/>Purpose | 桌面 UI 是否暴露<br/>Exposed in desktop UI |
|---|---|---|
| `permissions.mode` | prompt / auto / unattended | ✅ |
| `permissions.mcpAllowlist` | MCP 持久白名单：`mcp:<server>` 整服务器 or 精确工具名 | ❌ 未暴露 |
| `permissions.allowlist` | 通用工具白名单（`"*"` 或精确名） | ❌ |
| `permissions.execPermission` | exec_command 判定分级 | ❌ |
| `permissions.safePaths` | exec_command 在 auto 模式下的目录白名单 | ❌ |
| `permissions.safetyRules` | unattended 安全闸门参数（破坏性/批量/无 git 写） | ❌ |

## 高风险 MCP 工具命名 / High-Risk MCP Tool Naming

MCP 工具名命中高风险前缀（`delete/remove/drop/truncate/exec/run_command/upload/destroy` 等，见 core 的 `HIGH_RISK_MCP_PATTERNS`）时，`auto`/`unattended` 不会仅凭 `allowlist` 静默放行——需要所在服务器通过 `mcp:<server>` 整服务器信任。`pyright_*`（status/diagnostics/hover/format）均非高风险，因此在 `auto`/`unattended` 下自动放行、`prompt` 下弹卡。

When an MCP tool name matches a high-risk prefix (`delete/remove/drop/truncate/exec/run_command/upload/destroy`, etc., per the core `HIGH_RISK_MCP_PATTERNS`), `auto`/`unattended` will not silently allow it just from `allowlist` — the owning server must be whole-server trusted via `mcp:<server>`. The `pyright_*` tools (status/diagnostics/hover/format) are not high-risk, so they auto-allow in `auto`/`unattended` and prompt in `prompt`.

## 桌面代码引用 / Desktop Code Reference

| 能力 Capability | 位置 Location |
|---|---|
| 模式读取 `getActiveMode()` | `src/agent-service.ts:1240` |
| 工具授权桥 `onPermissionRequest` | `src/agent-service.ts:400` |
| 授权卡 `askPermission()` | `src/agent-service.ts:1523` |
| 知识图谱写桥 `audit.setAskUser` | `src/agent-service.ts:376` |
| sqlite 写批准门 | `src/agent-service.ts:273-280` |
| memory 写批准门 | `src/agent-service.ts:289-296` |
| git 写批准门 | `src/agent-service.ts:300-308` |
| 授权答案处理（y/a/n） | `src/agent-service.ts:415-421` |
