/**
 * Correction-loop configuration.
 *
 * Loaded by the main process (never by the model): the paths, thresholds and
 * budgets below decide when the harness intervenes, so the agent must not be
 * able to edit them from inside a session. A project-level file is deliberately
 * NOT supported — only `~/.nexus/correction.json` and the defaults here.
 *
 * Relationship to the other three budget surfaces (see docs/budgets.md):
 *   - config.json `maxTurns` / `subAgents.maxTurns.<role>` — model-visible
 *     per-chat / per-role turn budgets. The model consumes these and may
 *     read them; they reset every `chat()` cycle.
 *   - desktop.json `spendMode.relax` — host-side relaxation floors applied
 *     for unattended coding runs. Read mtime-cached by the worker; restored
 *     in `finally` after each `runTurn`.
 *   - correction.json (this file) — session-scoped watchdogs + correction
 *     loop budgets + security-sentinel inputs. The only surface that MUST
 *     survive a turn relaxation: `session.maxWallClockMs` (6h) is the
 *     hard upper bound that kills a genuine infinite loop even when
 *     per-turn `maxTurns` is temporarily raised to 200.
 *
 * `immutablePaths` and `networkAllowlist` are loaded into
 * SecuritySentinel at `beginCorrectionTurn()`; the model has no write
 * path to this file, so it cannot widen its own allow-list from
 * inside a session.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskKind } from './progress-ledger.js';

export interface BudgetConfig {
  l1PerTurn: number;
  l2PerTurn: number;
  l3PerTurn: number;
  coolDownStepsAfterL1: number;
}

/**
 * Session-scoped limits. `per-turn` budgets reset 18 times in an 8-hour
 * session; these do not. 0 disables a dimension.
 */
export interface SessionBudgetConfig {
  maxSteps: number;
  maxWallClockMs: number;
  maxNoProgressSteps: number;
  maxRepeatProbes: number;
}

export interface ThresholdConfig {
  loop: { frozenSteps: number; hard: number };
  dilution: { newInfoRate: number; minThinkingTokens: number; zlibRatio: number };
  safety: { probeCountToFreeze: number };
  contract: { maxAntiCheatRetries: number };
}

export interface CorrectionConfig {
  budget: BudgetConfig;
  /** Limits that span the whole session, not one user message. */
  session: SessionBudgetConfig;
  deescalation: { progressRequired: number };
  thresholds: ThresholdConfig;
  taskKindDefaults: Record<TaskKind, { frozenSteps?: number; disabled?: boolean }>;
  /** Paths the agent may never write from inside a session. */
  immutablePaths: string[];
  /** Hosts allowed for network egress without a taint/probe flag. */
  networkAllowlist: string[];
}

export const DEFAULT_CORRECTION_CONFIG: CorrectionConfig = {
  budget: { l1PerTurn: 2, l2PerTurn: 1, l3PerTurn: 1, coolDownStepsAfterL1: 2 },
  session: {
    maxSteps: 0,
    // Wall clock is the hard watchdog for long unattended coding runs: keep it
    // at 6h. It is the ONLY budget that must survive the turn relaxation
    // (session 47f9e6c7, §6.6/§8) — a genuine infinite loop must still be
    // killed eventually.
    maxWallClockMs: 6 * 60 * 60 * 1000,
    // No-progress / repeat-probe counters were the SECOND budget silently
    // killing legitimate long multi-sub-task work (NLP projects, fanout,
    // spawn_subagent): a genuine repair loop emits more than 15 non-progress
    // steps. Relax them generously but keep them finite so a stuck agent is
    // still terminated well before the 6h wall-clock cap.
    maxNoProgressSteps: 40,
    maxRepeatProbes: 20,
  },
  deescalation: { progressRequired: 2 },
  thresholds: {
    loop: { frozenSteps: 4, hard: 10 },
    dilution: { newInfoRate: 0.3, minThinkingTokens: 800, zlibRatio: 0.85 },
    safety: { probeCountToFreeze: 2 },
    contract: { maxAntiCheatRetries: 2 },
  },
  taskKindDefaults: {
    coding: { frozenSteps: 4 },
    research: { frozenSteps: 6 },
    ops: { frozenSteps: 3 },
    chat: { frozenSteps: 4, disabled: true },
  },
  immutablePaths: [
    '.nexus/rules/**',
    '.nexus/config/**',
    'src/agent/**',
    '.git/hooks/**',
    '.github/workflows/**',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '*.audit.*',
  ],
  networkAllowlist: [],
};

export function correctionConfigPath(home = homedir()): string {
  return join(home, '.nexus', 'correction.json');
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Merge only known fields; unknown JSON keys are ignored (never trusted). */
export function mergeCorrectionConfig(
  base: CorrectionConfig,
  patch: DeepPartial<CorrectionConfig> | null | undefined,
): CorrectionConfig {
  if (!patch) return cloneConfig(base);
  const out = cloneConfig(base);

  if (patch.budget) {
    out.budget = {
      l1PerTurn: clampInt(patch.budget.l1PerTurn, base.budget.l1PerTurn, 0, 10),
      l2PerTurn: clampInt(patch.budget.l2PerTurn, base.budget.l2PerTurn, 0, 10),
      l3PerTurn: clampInt(patch.budget.l3PerTurn, base.budget.l3PerTurn, 0, 10),
      coolDownStepsAfterL1: clampInt(
        patch.budget.coolDownStepsAfterL1,
        base.budget.coolDownStepsAfterL1,
        0,
        20,
      ),
    };
  }
  if (patch.session) {
    out.session = {
      maxSteps: clampInt(patch.session.maxSteps, base.session.maxSteps, 0, 100_000),
      maxWallClockMs: clampInt(
        patch.session.maxWallClockMs,
        base.session.maxWallClockMs,
        0,
        72 * 60 * 60 * 1000,
      ),
      maxNoProgressSteps: clampInt(
        patch.session.maxNoProgressSteps,
        base.session.maxNoProgressSteps,
        1,
        500,
      ),
      maxRepeatProbes: clampInt(
        patch.session.maxRepeatProbes,
        base.session.maxRepeatProbes,
        1,
        500,
      ),
    };
  }
  if (patch.deescalation) {
    out.deescalation = {
      progressRequired: clampInt(
        patch.deescalation.progressRequired,
        base.deescalation.progressRequired,
        1,
        10,
      ),
    };
  }
  if (patch.thresholds) {
    const t = patch.thresholds;
    if (t.loop) {
      out.thresholds.loop = {
        frozenSteps: clampInt(t.loop.frozenSteps, base.thresholds.loop.frozenSteps, 1, 50),
        hard: clampInt(t.loop.hard, base.thresholds.loop.hard, 1, 100),
      };
    }
    if (t.dilution) {
      out.thresholds.dilution = {
        newInfoRate: clampNum(t.dilution.newInfoRate, base.thresholds.dilution.newInfoRate, 0, 1),
        minThinkingTokens: clampInt(
          t.dilution.minThinkingTokens,
          base.thresholds.dilution.minThinkingTokens,
          100,
          100_000,
        ),
        zlibRatio: clampNum(t.dilution.zlibRatio, base.thresholds.dilution.zlibRatio, 0, 1),
      };
    }
    if (t.safety) {
      out.thresholds.safety = {
        probeCountToFreeze: clampInt(
          t.safety.probeCountToFreeze,
          base.thresholds.safety.probeCountToFreeze,
          1,
          10,
        ),
      };
    }
    if (t.contract) {
      out.thresholds.contract = {
        maxAntiCheatRetries: clampInt(
          t.contract.maxAntiCheatRetries,
          base.thresholds.contract.maxAntiCheatRetries,
          0,
          10,
        ),
      };
    }
  }
  if (Array.isArray(patch.immutablePaths)) {
    out.immutablePaths = patch.immutablePaths
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
  }
  if (Array.isArray(patch.networkAllowlist)) {
    out.networkAllowlist = patch.networkAllowlist
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim().toLowerCase());
  }
  return out;
}

/** Load `~/.nexus/correction.json`; never throws, never fetches. */
export function loadCorrectionConfig(home = homedir()): CorrectionConfig {
  const path = correctionConfigPath(home);
  if (!existsSync(path)) return cloneConfig(DEFAULT_CORRECTION_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DeepPartial<CorrectionConfig>;
    return mergeCorrectionConfig(DEFAULT_CORRECTION_CONFIG, raw);
  } catch {
    return cloneConfig(DEFAULT_CORRECTION_CONFIG);
  }
}

/** Apply a task-kind frozen-step override without mutating the base config. */
export function configForTaskKind(base: CorrectionConfig, kind: TaskKind): CorrectionConfig {
  const out = cloneConfig(base);
  const override = base.taskKindDefaults[kind];
  if (override?.frozenSteps !== undefined) {
    out.thresholds.loop.frozenSteps = override.frozenSteps;
  }
  return out;
}

/**
 * Scale the correction-loop SPEND knobs for a spend mode. Multiplies the
 * per-turn L1–L4 budgets and the dilution floor; a mode with a scale < 1 (the
 * frugal `token` tier) spends less on retries/corrections. Loop-detection
 * thresholds and de-escalation progress are NOT spend — they stay put.
 * Positive integer budgets never drop below 1 (a zero budget is only kept
 * when the base was already 0).
 */
export function applySpendScale(base: CorrectionConfig, scale: number): CorrectionConfig {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const out = cloneConfig(base);
  const spendInt = (b: number): number => (b === 0 ? 0 : Math.max(1, Math.round(b * s)));
  out.budget.l1PerTurn = spendInt(base.budget.l1PerTurn);
  out.budget.l2PerTurn = spendInt(base.budget.l2PerTurn);
  out.budget.l3PerTurn = spendInt(base.budget.l3PerTurn);
  out.budget.coolDownStepsAfterL1 = spendInt(base.budget.coolDownStepsAfterL1);
  out.thresholds.dilution.minThinkingTokens = Math.max(
    100,
    Math.min(100_000, Math.round(base.thresholds.dilution.minThinkingTokens * s)),
  );
  return out;
}

function cloneConfig(c: CorrectionConfig): CorrectionConfig {
  return {
    budget: { ...c.budget },
    session: { ...c.session },
    deescalation: { ...c.deescalation },
    thresholds: {
      loop: { ...c.thresholds.loop },
      dilution: { ...c.thresholds.dilution },
      safety: { ...c.thresholds.safety },
      contract: { ...c.thresholds.contract },
    },
    taskKindDefaults: JSON.parse(JSON.stringify(c.taskKindDefaults)) as CorrectionConfig['taskKindDefaults'],
    immutablePaths: [...c.immutablePaths],
    networkAllowlist: [...c.networkAllowlist],
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}
