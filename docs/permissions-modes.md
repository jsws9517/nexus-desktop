# Permission Modes for Tool Authorization

> Scope: how nexus-desktop authorizes tool calls under the three modes
> `prompt` / `auto` / `unattended`. The authoritative policy lives in the
> `nexus-coder` core (`hooks/permissions.js`, `security/unattended-safety.ts`);
> this document covers the desktop bridges and how they interact with it.
> All line references point to the live implementation — `src/agent/service.ts`
> (`src/agent-service.ts` is now a thin re-export facade).

## Mode Selection

The mode is chosen by the user and read by the desktop worker via
`AgentService.getActiveMode()` (`src/agent/service.ts:4867`), which simply
forwards to the core config. Valid values: `prompt | auto | unattended`,
defaulting to `prompt` (`src/shared/permissions-config.ts:10`).

## Authorization Flow

The desktop worker installs one authorization bridge per tool call
(`onPermissionRequest`, `src/agent/service.ts:1453`) that branches on the
active mode:

```
Tool call
   │
   ├─ mode = auto        → direct { verdict: 'allow' }, no card (:1470)
   │
   ├─ mode = unattended  → direct { verdict: 'allow' }, no card (:1470)
   │                       (core safety gate is the sole arbiter, runs earlier)
   │
   └─ mode = prompt      → askPermission() shows one card; user answers
                           y (once) / a (always) / n (deny) (:1477, :5584)
```

Both `auto` and `unattended` are **non-interactive**: this bridge never shows a
card for either. The core reinforces this by skipping batch permission entirely
in unattended (`agent.js`: `needsBatchPermission = mode !== 'unattended'`), so
`onPermissionRequest` is normally not even invoked there — the direct-allow
branch is a defensive guarantee, not the primary path.

Other bridges on the same worker:

- **Path authorization** (`setPermissionPrompter`, `src/agent/service.ts:1417`):
  only `prompt` may show a path card; `auto` / `unattended` silently deny
  out-of-scope paths (`:1419`).
- **Knowledge-graph / `user_info` write audit** (`audit.setAskUser`,
  `src/agent/service.ts:1429`): auto-approved in `auto` / `unattended`, card in
  `prompt`. These are non-destructive preference writes.
- **Builtin sqlite write gate** (`requestWriteApproval`, `src/agent/service.ts:977`):
  pass-through in `auto` / `unattended`, card in `prompt`.
- **Builtin memory / git write tools** (`src/agent/service.ts:995,1006`): card in
  `prompt`, pass-through in `auto` / `unattended` — **except** that the core
  unattended safety gate hard-blocks the destructive subset (see below).

## Mode Comparison

| | prompt (interactive) | auto (automatic) | unattended (no user) |
|---|---|---|---|
| **Shows a permission card** | Yes, per call | No | No — never |
| **Ordinary tools** | Card; user decides | Allow | Allow |
| **High-risk MCP tools** (`delete_*`, `exec*`, `upload_*`, …) | Card; user decides | Whole-server trust `mcp:<server>` required for allowlist auto-approval; otherwise core gate prompts | Trusted server → allow; **untrusted server → silent deny** (core `permissions.js:314-321`) |
| **`exec_command`** | Per-call card | Config-driven (`execPermission`, `safePaths`, overrides); hard commands always denied | Safety gate vets first; hard / inline-eval commands hard-denied; `execPermission` / `safePaths` ignored |
| **Destructive structured writes** (sqlite `execute`, `drop-table`, memory `delete_*`, destructive git mutators) | Card; user decides | Allow | **Hard-denied by core safety gate** (Group A/B/D) |
| **Denied when** | User clicks deny | Tool level=deny; untrusted high-risk MCP; hard command | Safety gate hit; untrusted high-risk MCP; out-of-scope path |

### Unattended safety gate (core, not desktop)

`checkUnattendedGate()` (`node_modules/nexus-coder/dist/src/security/unattended-safety.js`)
runs in the core `preToolUse` hook **before** any batch verdict. It hard-denies,
with an auditable `security_blocked` event:

- **Group A** — destructive database operations: `exec_command` DROP/DELETE
  patterns, plus structured `execute` / `transaction` SQL carrying the same
  patterns, and the `drop-table` tool.
- **Group B** — batch / iterative deletes (`rm -rf`, etc.) and knowledge-graph
  `delete_entities` / `delete_relations` / `delete_observations`.
- **Group C** — single calls targeting an excessive number of files.
- **Group D** — git history / working-tree rewriting (`git_reset`,
  `git_discard_changes`, `git_revert`, `git_rebase`, …) without a checkpoint.
- **Group E** — hard commands and inline `python -c` / `node -e` eval.

These are deterministic denials: there is no interactive override in
unattended mode. The equivalent operations in `auto` are either allowed or
promptable, which is why unattended can feel "smaller" even though its
non-destructive autonomous surface is the same.

### Desktop-specific notes

- Builtin `fetch` / `time` are read-only (no write gate): `fetch` honors
  robots.txt; `time` is pure computation.
- Knowledge-graph write bridge (`audit.setAskUser`): auto-approved in
  `auto` / `unattended`, card in `prompt` (`src/agent/service.ts:1429-1440`).
- The git write set (`src/main/git-internal.ts:166-193`) covers 26 mutating
  tools; the destructive subset is gated by core safety rules in unattended.
- Not applicable to the AIAC panel: the `auto` branch skips the bridge and
  returns `allow`, deferring to downstream builtin policy.

## One-time vs Persistent Authorization

- Both `y` (once) and `a` (always) authorize only the **current decision** in
  this desktop bridge; `a` does not persist across calls here
  (`src/agent/service.ts:1477-1483`). Core `promptUser` caching is keyed by
  canonical tool name per session, so approving one alias covers its siblings.
- Persistent trust is `permissions.mcpAllowlist`: `mcp:<server>` (whole server)
  or an exact tool name. An exact name never unlocks a high-risk tool; only
  whole-server trust does. This field is not exposed in the desktop UI and must
  be edited in config directly.
- `exec_command` writes session-level approval records; path authorization can
  persist within a session via `GLOBAL_SCOPE`. Neither covers MCP tool
  authorization.

## Key Configuration

| Field | Purpose | Exposed in Desktop UI |
|---|---|---|
| `permissions.mode` | prompt / auto / unattended | Yes |
| `permissions.mcpAllowlist` | MCP persistent allowlist: `mcp:<server>` or exact tool name | No |
| `permissions.allowlist` | General tool allowlist (`"*"` or exact name) | No |
| `permissions.execPermission` | exec_command level determination (`auto` only) | No |
| `permissions.safePaths` | exec_command directory allowlist in `auto` | No |
| `permissions.safetyRules` | unattended safety gate parameters (DB / batch / git checkpoint) | No |

## High-Risk MCP Tool Naming

When an MCP tool name matches a high-risk prefix (`delete/remove/drop/truncate/
exec/run_command/upload/destroy`, etc., per core `HIGH_RISK_MCP_PATTERNS`),
an `allowlist` entry alone is **not** enough in `auto` / `unattended` — the
owning server must be whole-server trusted via `mcp:<server>`. In `auto` the
fallback is an interactive card; in `unattended` it is a silent deny because no
interactive channel exists. The `pyright_*` tools (status / diagnostics /
hover / format) are not high-risk, so they auto-allow in `auto` / `unattended`
and prompt in `prompt`.

## Code Reference

| Capability | Location |
|---|---|
| Mode read `getActiveMode()` | `src/agent/service.ts:4867` |
| Tool authorization bridge `onPermissionRequest` | `src/agent/service.ts:1453` |
| Authorization card `askPermission()` | `src/agent/service.ts:5584` |
| Path authorization prompter | `src/agent/service.ts:1417` |
| Knowledge-graph write bridge `audit.setAskUser` | `src/agent/service.ts:1429` |
| sqlite write approval gate | `src/agent/service.ts:977` |
| memory / git write gate | `src/agent/service.ts:995,1006` |
| Authorization answer handling (y/a/n) | `src/agent/service.ts:1480-1483` |
| Unattended safety gate (core) | `nexus-coder/src/security/unattended-safety.ts` |
| Core permission hook / allowlist branch | `nexus-coder/src/hooks/permissions.ts` |
