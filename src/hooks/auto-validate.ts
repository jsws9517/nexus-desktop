import { execSync } from 'child_process';
import { extname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { HookContext } from './types.js';
import { ConfigManager } from '../config/index.js';

interface ValidationConfig {
  onFileWrite?: string[];
  onTaskComplete?: string[];
  autoFix?: boolean;
}

const DEFAULT_CONFIG: ValidationConfig = {
  onFileWrite: [],
  onTaskComplete: [],
  autoFix: false,
};

function loadConfig(cwd: string): ValidationConfig {
  const configPath = resolve(cwd, '.nexus', 'validate.json');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

const JS_TS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function getValidationCommands(filePath: string, config: ValidationConfig): string[] {
  const ext = extname(filePath);
  if (!JS_TS_EXTS.has(ext)) return [];

  const commands: string[] = [];
  if (config.onFileWrite) {
    commands.push(...config.onFileWrite);
  } else {
    // Sensible defaults based on project setup
    if (hasPackageScript('lint')) commands.push('npm run lint -- --quiet');
    if (hasPackageScript('typecheck')) commands.push('npm run typecheck');
    // Wire npm test into the default validation set when the quality gate is on
    const qualityGate = new ConfigManager().getQualityGate();
    if (qualityGate.autoTest && hasPackageScript('test')) commands.push('npm run test');
  }
  return commands;
}

let _pkgScripts: Set<string> | null = null;
function hasPackageScript(name: string): boolean {
  if (_pkgScripts === null) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
      _pkgScripts = new Set(Object.keys(pkg.scripts || {}));
    } catch {
      _pkgScripts = new Set();
    }
  }
  return _pkgScripts.has(name);
}

export function createAutoValidateHook(config?: ValidationConfig) {
  const cfg = config || loadConfig(process.cwd());

  return async (ctx: HookContext): Promise<void> => {
    if (ctx.toolCall?.name !== 'file_write' && ctx.toolCall?.name !== 'file_edit') return;

    const filePath = String(ctx.toolCall.arguments?.path || '');
    if (!filePath) return;

    const commands = getValidationCommands(filePath, cfg);
    for (const cmd of commands) {
      try {
        execSync(cmd, {
          cwd: process.cwd(),
          timeout: 15000,
          stdio: 'pipe',
          encoding: 'utf-8',
        });
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr || '';
        const stdout = (err as { stdout?: string }).stdout || '';
        const output = (stderr || stdout).slice(0, 500);
      }
    }
  };
}
