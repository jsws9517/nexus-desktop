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

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question(`\n\x1b[33m⚠ Security: Agent is requesting access to read/write:\n  ${path}\nAllow? (y=once, a=always, n=deny): \x1b[0m`, resolve);
  });
  rl.close();

  const choice = answer.trim().toLowerCase();
  if (choice === 'y' || choice === 'a') {
    alreadyConfirmed.add(path);
    const newEntry: AuthorizationEntry = {
      path: normalize(path),
      grantedAt: Date.now(),
      expiresAt: choice === 'a' ? null : Date.now() + AUTH_DURATION_MS,
    };
    const updated = loadAuthorizations();
    const idx = updated.findIndex(e => normalize(e.path).toLowerCase() === normalized);
    if (idx >= 0) updated[idx] = newEntry;
    else updated.push(newEntry);
    saveAuthorizations(updated);
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

export async function authorizePath(absPath: string): Promise<boolean> {
  const allowed = [
    process.cwd().toLowerCase(),
    ...getAuthorizedRoots().map(r => normalize(r).toLowerCase()),
  ];

  const normalized = normalize(absPath).toLowerCase();
  for (const root of allowed) {
    if (normalized.startsWith(root)) return true;
  }

  return promptUser(absPath);
}