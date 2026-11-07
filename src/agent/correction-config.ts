/**
 * Correction-loop configuration.
 *
 * Loaded by the main process (never by the model): the paths, thresholds and
 * budgets below decide when the harness intervenes, so the agent must not be
 * able to edit them from inside a session. A project-level file is deliberately
 * NOT supported — only `~/.nexus/correction.json` and the defaults here.
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

export interface ThresholdConfig {
  loop: { frozenSteps: number; hard: number };
  dilution: { newInfoRate: number; minThinkingTokens: number; zlibRatio: number };
  safety: { probeCountToFreeze: number };
  contract: { maxAntiCheatRetries: number };
}

export interface CorrectionConfig {
  budget: BudgetConfig;
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

function cloneConfig(c: CorrectionConfig): CorrectionConfig {
  return {
    budget: { ...c.budget },
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
