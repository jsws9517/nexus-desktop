import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, normalize } from 'path';
import { createInterface } from 'readline';

interface AuthorizationEntry {
  path: string;
  grantedAt: number;
  expiresAt: number | null;
}

const AUTH_DIR = join(homedir(), '.nexus');
const AUTH_PATH = join(AUTH_DIR, 'path-auth.json');
const AUTH_DURATION_MS = 24 * 60 * 60 * 1000;

const alreadyConfirmed = new Set<string>();

/**
 * Injected question function for prompting the user.
 * When set, used instead of creating a second readline on process.stdin
 * (which conflicts with the main chat readline).
 */
let _permissionPrompter: ((question: string) => Promise<string>) | null = null;

export function setPermissionPrompter(fn: (question: string) => Promise<string>): void {
  _permissionPrompter = fn;
}

function loadAuthorizations(): AuthorizationEntry[] {
  if (!existsSync(AUTH_PATH)) return [];
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveAuthorizations(entries: AuthorizationEntry[]): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(entries, null, 2));
}

function isGranted(absPath: string): boolean {
  const normalized = normalize(absPath).toLowerCase();
  const now = Date.now();
  const entries = loadAuthorizations();
  const valid = entries.filter(e => e.expiresAt === null || e.expiresAt > now);
  if (valid.length !== entries.length) saveAuthorizations(entries);
  return valid.some(e => normalized.startsWith(normalize(e.path).toLowerCase()));
}

async function promptUser(path: string): Promise<boolean> {
  if (alreadyConfirmed.has(path)) return true;

  const normalized = normalize(path).toLowerCase();
  const entries = loadAuthorizations();
  const existing = entries.find(e => normalize(e.path).toLowerCase() === normalized);
  if (existing && (existing.expiresAt === null || existing.expiresAt > Date.now())) {
    alreadyConfirmed.add(path);
    return true;
  }

  const filename = path.split(/[\\/]/).pop() || path;
  const question = `\x1b[33m⚠ Security: read/write "${filename}"? [y] once  [a] always  [n] deny \x1b[0m`;
  const answer = _permissionPrompter
    ? await _permissionPrompter(question)
    : await new Promise<string>(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, resolve);
        rl.on('close', () => resolve(''));
      });

  const choice = answer.trim().toLowerCase();
  if (choice === 'y' || choice === 'a') {
    alreadyConfirmed.add(path);
    if (choice === 'a') {
      // "always" persists across sessions
      const newEntry: AuthorizationEntry = {
        path: normalize(path),
        grantedAt: Date.now(),
        expiresAt: null,
      };
      const updated = loadAuthorizations();
      const idx = updated.findIndex(e => normalize(e.path).toLowerCase() === normalized);
      if (idx >= 0) updated[idx] = newEntry;
      else updated.push(newEntry);
      saveAuthorizations(updated);
    }
    // "once" (y) is in-memory only — cleared on process exit
    return true;
  }
  return false;
}

export function getAuthorizedRoots(): string[] {
  return loadAuthorizations()
    .filter(e => e.expiresAt === null || e.expiresAt > Date.now())
    .map(e => e.path);
}

export function clearAuthorizations(): void {
  writeFileSync(AUTH_PATH, '[]');
  alreadyConfirmed.clear();
}

/**
 * Check if path is in an already-allowed directory WITHOUT prompting.
 * If the path is not yet authorized, returns false — caller should use tool-level
 * permission system (with visible tool call) instead of a silent prompt.
 */
export function checkPathAllowed(absPath: string): boolean {
  const normalized = normalize(absPath).toLowerCase();
  const roots = [
    process.cwd().toLowerCase(),
    ...getAuthorizedRoots().map(r => normalize(r).toLowerCase()),
    ...[...alreadyConfirmed].map(r => normalize(r).toLowerCase()),
  ];
  for (const root of roots) {
    if (normalized.startsWith(root)) return true;
  }
  return false;
}

/** Batch pre-authorize a root path for the current process without prompting.
 *  All sub-paths under `root` will be auto-allowed. */
export function preAuthorizeRoot(root: string): void {
  const normalized = normalize(resolve(root));
  alreadyConfirmed.add(normalized);
}

export async function authorizePath(absPath: string): Promise<boolean> {
  if (checkPathAllowed(absPath)) return true;
  return promptUser(absPath);
}