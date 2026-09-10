# Permission Modes for MCP Tool Authorization

> Scope: This document describes how nexus-desktop authorizes MCP tool calls under the three permission modes `prompt` / `auto` / `unattended`. References only desktop-repo implementation (`src/agent-service.ts` etc.); does not cover coder core internals.

## Mode Selection

The permission mode is set by the user and read by the desktop worker via `AgentService.getActiveMode()` (`src/agent-service.ts:1240`). Valid values: `prompt | auto | unattended`, defaulting to `prompt`.

## Authorization Flow

The desktop worker installs an authorization bridge per tool call (`onPermissionRequest`, `src/agent-service.ts:400`) that branches on the active mode:

```
Tool call
   │
   ├─ mode = auto       → direct { verdict: 'allow' }, no card (agent-service.ts:408)
   │
   ├─ mode = prompt     → askPermission() shows one card; user answers y (once) / a (always) / n (deny)
   │                      (agent-service.ts:415)
   │
   └─ mode = unattended → this bridge is bypassed; other worker gates apply
```

Additional bridge: knowledge-graph writes (`remember` / `user_info` …) go through a separate `audit.setAskUser` bridge (`src/agent-service.ts:376`); builtin sqlite / memory write tools have their own desktop approval gates (see "Desktop-specific Gates" below).

## Mode Comparison

| | prompt (interactive) | auto (automatic) | unattended (no user) |
|---|---|---|---|
| **Shows a permission card** | ✅ One card per turn | ❌ None, direct allow | ❌ None |
| **Ordinary MCP tools** (e.g. `pyright_status`) | Card; user decides | Auto-allowed | Auto-allowed |
| **High-risk MCP tools** (`delete_*/exec*/…`) | Card; user decides | Needs whole-server trust in `mcpAllowlist` (`mcp:<server>`) to auto-allow; else card | Trusted server → allow; otherwise deny |
| **Denied when** | User clicks deny (n) | Tool level=deny in config; untrusted high-risk MCP tool | Unattended safety gate hit (destructive DB / batch / ungit-checkpointed write); untrusted high-risk MCP tool |

### Desktop-specific Exceptions

- Builtin sqlite / memory / git **write** tools: card in `prompt`; pass-through in `auto` and `unattended` (`src/agent-service.ts:276,289,299`). The git write set covers 26 mutating tools (commit / stage / reset / push / checkout / merge / rebase …).
- Builtin `fetch` / `time` are read-only (no write gate): `fetch` performs network access honoring robots.txt (from `src/main/fetch-tools.ts`, aligned with mcp-server-fetch); `time` is pure computation (`src/main/time-tools.ts`, aligned with mcp-server-time).
- Knowledge-graph write bridge (`audit.setAskUser`): auto-approved in `auto` / `unattended`, card in `prompt` (`src/agent-service.ts:376-387`).
- Not applicable to the AIAC panel: the `auto` branch **skips** the bridge and returns `allow`, deferring to downstream builtin policy.

## One-time vs Persistent Authorization

- Both buttons `y` (once) and `a` (always) only authorize the **current turn** in this desktop bridge; `a` does not persist across turns / sessions (`src/agent-service.ts:418-421`).

- The real persistence mechanism is the `permissions.mcpAllowlist` config field, whose entries are whole-server trust `mcp:<server>` or an exact tool name. This field is not currently exposed in the desktop UI and must be edited in config directly.

- `exec_command` writes session-level approval records (path authorization can persist within a session via `GLOBAL_SCOPE`), but does **not** cover MCP tool authorization.

## Key Configuration

| Field | Purpose | Exposed in Desktop UI |
|---|---|---|
| `permissions.mode` | prompt / auto / unattended | ✅ |
| `permissions.mcpAllowlist` | MCP persistent allowlist: `mcp:<server>` (whole server) or exact tool name | ❌ |
| `permissions.allowlist` | General tool allowlist (`"*"` or exact name) | ❌ |
| `permissions.execPermission` | exec_command level determination | ❌ |
| `permissions.safePaths` | exec_command directory allowlist in auto mode | ❌ |
| `permissions.safetyRules` | unattended safety gate parameters (destructive / batch / no-git write) | ❌ |

## High-Risk MCP Tool Naming

When an MCP tool name matches a high-risk prefix (`delete/remove/drop/truncate/exec/run_command/upload/destroy`, etc., per core `HIGH_RISK_MCP_PATTERNS`), `auto` / `unattended` will not silently allow it based on `allowlist` alone — the owning server must be whole-server trusted via `mcp:<server>`. The `pyright_*` tools (status / diagnostics / hover / format) are not high-risk, so they auto-allow in `auto` / `unattended` and prompt in `prompt`.

## Desktop Code Reference

| Capability | Location |
|---|---|
| Mode read `getActiveMode()` | `src/agent-service.ts:1240` |
| Tool authorization bridge `onPermissionRequest` | `src/agent-service.ts:400` |
| Authorization card `askPermission()` | `src/agent-service.ts:1523` |
| Knowledge-graph write bridge `audit.setAskUser` | `src/agent-service.ts:376` |
| sqlite write approval gate | `src/agent-service.ts:273-280` |
| memory write approval gate | `src/agent-service.ts:289-296` |
| git write approval gate | `src/agent-service.ts:300-308` |
| Authorization answer handling (y/a/n) | `src/agent-service.ts:415-421` |
