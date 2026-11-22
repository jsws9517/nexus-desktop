# Agent Turn / Token / Time Budgets — Where Each Knob Lives

> Scope: nexus-desktop turn / token / time budgets across the four
> config surfaces. Module keywords: **agent lifecycle, turn budget,
> token budget, watchdog, relaxation floor, sub-agent role budget,
> session watchdog, ACP turn absolute deadline**.
>
> Goal: a single page that answers "which file do I edit to change X?"
> so a user (or a future architect) does not have to spelunk through
> four config surfaces to find out.
>
> Related: `docs/permissions-modes.md` (permission levels),
> `docs/harness-correction-loop.md` (correction-loop internals).

## The four budget surfaces

| Surface | File | Loaded by | Model-editable? | Resets |
|---|---|---|---|---|
| Per-chat turn budget | `~/.nexus/config.json` → `maxTurns` (top-level) | core `ConfigManager` at Agent construction | yes | every `chat()` cycle |
| Per-role sub-agent budget | `~/.nexus/config.json` → `subAgents.maxTurns.<role>` | core `ConfigManager.getSubAgentMaxTurns(role)` | yes | every sub-agent spawn |
| Unattended-coding relaxation floors | `~/.nexus/desktop.json` → `spendMode.relax.{turns,subAgentTurns}` | desktop `desktop-config.ts` (mtime-cached) | yes | per `runTurn` (restored in `finally`) |
| Session-scoped watchdogs + correction budgets | `~/.nexus/correction.json` → `session.*` / `budget.*` / `thresholds.*` / `immutablePaths` / `networkAllowlist` | desktop `correction-config.ts` per `beginCorrectionTurn` | **no** | session-scoped (never per-turn) |

## Why four surfaces, not one

The split is intentional, not historical drift:

1. **config.json is model-editable** — the core zod schema
   validates it and the agent's own tools can read (and in
   auto/permit mode, write) fields in it. Anything that must be
   **trusted** (turn budgets that the model itself consumes,
   sub-agent role budgets) belongs here because the model already
   operates under those limits; moving them elsewhere would give
   the model a way to raise its own ceiling.

2. **desktop.json is main-process-only** — the worker reads it
   mtime-cached; the model never touches it. The relaxation floors
   (`spendMode.relax`) live here because they are a **host
   policy** ("how much do I let a single run stretch") not a
   model-visible budget. Raising the floor only happens when the
   user (or the `/billing` slash command) writes the value; the
   model can read the effective floor via `/billing status` but
   cannot persist a change.

3. **correction.json is the safety net that must outlive a
   single turn.** `session.maxWallClockMs` (6h) is the hard
   watchdog that survives unattended-coding relaxation — relaxing
   the per-turn `maxTurns` from 25 to 200 does **not** disable
   the 6h wall-clock cap, so a genuine infinite loop still gets
   killed. `immutablePaths` / `networkAllowlist` are the
   security-sentinel inputs: the model must never be able to
   rewrite its own allow-list from inside a session. Both
   properties require a file the model has no write access to.

The four files therefore partition cleanly:

```
model-visible budgets        → config.json       (maxTurns, subAgents)
host-side relaxation policy  → desktop.json      (spendMode.relax)
safety-net / session caps    → correction.json   (session.*, immutablePaths, ...)
```

## Concept overlap and how to read it

The two "turn" concepts that often get confused:

- **`maxTurns` (per-chat)** — how many LLM turns a single
  `agent.chat()` call may make before the harness calls
  `turns-exhausted`. Reset to 0 at the start of every chat
  cycle. Default 25; configurable 1–1000 via
  `nexus config agent maxturns set <n>`.

- **`session.maxSteps` / `session.maxWallClockMs`
  (per-session)** — how many model *steps* (a step = one tool
  call or one LLM call) the whole session may accumulate before
  the `SessionBudget` fires a breach. Never reset per turn.
  Default: `maxSteps: 0` (disabled), `maxWallClockMs: 6h`
  (hard watchdog), `maxNoProgressSteps: 40`, `maxRepeatProbes: 20`.

They are **orthogonal**: a high `maxTurns` + a low
`session.maxWallClockMs` means "give each chat cycle plenty of
turns, but the whole session still has to finish within the
wall-clock cap." That combination is exactly what unattended
coding wants: the 200-turn relaxation raises `maxTurns` for the
duration of one `runTurn()`, but the 6h wall-clock watchdog in
`correction.json` still fires if the run genuinely stalls.

## Default values (quick reference)

| Knob | Default | Where to override |
|---|---|---|
| `maxTurns` (main chat) | 25 | `config.json` top-level `maxTurns` (1–1000) |
| `subAgents.maxTurns.general` | 8 | `config.json.subAgents.maxTurns.general` |
| `subAgents.maxTurns.tester` | 4 | `config.json.subAgents.maxTurns.tester` |
| `subAgents.maxTurns.committer` | 4 | `config.json.subAgents.maxTurns.committer` |
| `subAgents.maxTurns.office` | 12 | `config.json.subAgents.maxTurns.office` |
| `subAgents.maxTurns.skill-fixer` | 8 | `config.json.subAgents.maxTurns.skill-fixer` |
| `subAgents.maxTurns.tdd` | 10 | `config.json.subAgents.maxTurns.tdd` |
| Unattended-coding parent floor | 200 | `desktop.json` `spendMode.relax.turns` |
| Unattended-coding sub-agent floor | 60 | `desktop.json` `spendMode.relax.subAgentTurns` |
| `session.maxWallClockMs` | 6h | `correction.json` `session.maxWallClockMs` |
| `session.maxNoProgressSteps` | 40 | `correction.json` `session.maxNoProgressSteps` |
| `session.maxRepeatProbes` | 20 | `correction.json` `session.maxRepeatProbes` |
| `budget.l1PerTurn` / `l2PerTurn` / `l3PerTurn` | 2 / 1 / 1 | `correction.json` `budget.*` (scaled by spend-mode) |
| `thresholds.loop.frozenSteps` | 4 | `correction.json` `thresholds.loop.frozenSteps` (overridden per task-kind) |
| `acp.timeouts.turnAbsoluteMs` | 20 min | `config.json` `acp.timeouts.turnAbsoluteMs` (env override `NEXUS_TURN_ABSOLUTE_MS`) |

## Code reference

- `src/agent/service.ts` — `runTurn()` (relaxation + restore),
  `beginCorrectionTurn()`, `getSessionBudget()`,
  `getTurnRelaxationFloors()`
- `src/agent/correction-config.ts` — `CorrectionConfig` shape,
  `DEFAULT_CORRECTION_CONFIG`, `loadCorrectionConfig()`,
  `applySpendScale()`, `configForTaskKind()`
- `src/agent/session-budget.ts` — `SessionBudget` class,
  breach kinds (`steps` / `wall_clock` / `no_progress` /
  `repeat_probe`), `formatBudgetSteer()`
- `src/shared/spend-policy.ts` — `SpendPolicy.relaxedTurns` /
  `relaxedSubAgentTurns`, `SpendModeOverride`,
  `resolveRelaxedTurns()`, `resolveRelaxedSubAgentTurns()`
- `src/agent/desktop-config.ts` — `readSpendModeOverride()`
  (worker-side reader for `desktop.json` `spendMode.relax`)
- core `ConfigManager` — `getMaxTurns()` / `getSubAgentMaxTurns()`
  / `getAcpTimeouts()` (turn budget, sub-agent budget, ACP
  timeout surfaces all on the core side)

## How to change a budget (cheat sheet)

- "My chat keeps hitting the 25-turn ceiling" →
  `nexus config agent maxturns set 50`
- "My sub-agent (tester) gives up too early" →
  `nexus config agent subagents set tester 8`
- "I want unattended coding to run longer" →
  edit `~/.nexus/desktop.json` `spendMode.relax.turns` (and
  `subAgentTurns` for sub-agents). Takes effect on the NEXT
  `runTurn` — no worker restart.
- "I want the whole session to stop after 3 hours instead of 6"
  → edit `~/.nexus/correction.json`
  `session.maxWallClockMs: 10800000`.
- "My ACP remote turn stalls for 40 minutes and never gets
  killed" → `nexus config acp timeout set turnAbsoluteMs
  1800000` (30 min). Env override
  `NEXUS_TURN_ABSOLUTE_MS` wins over config.
