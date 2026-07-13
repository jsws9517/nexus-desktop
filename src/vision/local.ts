import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Prefer the .py file in the source tree (works when running from dist/ too)
const SRC_PATH = resolve(__dirname, '..', '..', '..', 'src', 'vision', 'local_vision.py');
const DIST_PATH = resolve(__dirname, 'local_vision.py');
const SCRIPT_PATH = existsSync(SRC_PATH) ? SRC_PATH : (existsSync(DIST_PATH) ? DIST_PATH : SRC_PATH);

let proc: ChildProcess | null = null;
let modelLoading = false;
let loadError: string | null = null;
let ready = false;
let pendingResolves: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map();

function startProcess(): void {
  if (proc || modelLoading) return;
  modelLoading = true;

  const pythonBin = process.env.LLMA_VISION_PYTHON || 'python';
  proc = spawn(pythonBin, [SCRIPT_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';

  proc.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.content !== undefined) {
          handleResponse(msg);
        } else if (msg.error) {
          handleError(msg);
        }
      } catch {
        if (line.includes('ready')) {
          ready = true;
          modelLoading = false;
        } else if (line.includes('Loading')) {
          process.stderr.write(`[local-vision] ${line}\n`);
        }
      }
    }
  });

  proc.stderr!.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) process.stderr.write(`[local-vision] ${text}\n`);
  });

  proc.on('exit', (code) => {
    ready = false;
    modelLoading = false;
    if (code !== 0 && !loadError) {
      loadError = `Process exited with code ${code}`;
    }
    proc = null;
    for (const [id, p] of pendingResolves) {
      p.reject(new Error('Local vision process died'));
    }
    pendingResolves.clear();
  });
}

function handleResponse(msg: any): void {
  for (const [id, p] of pendingResolves) {
    p.resolve(msg);
    pendingResolves.delete(id);
    break;
  }
}

function handleError(msg: any): void {
  for (const [id, p] of pendingResolves) {
    p.reject(new Error(msg.error));
    pendingResolves.delete(id);
    break;
  }
}

async function waitForReady(timeoutMs = 120000): Promise<void> {
  if (ready) return;
  if (loadError) throw new Error(`Local vision failed to load: ${loadError}`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Local vision model load timed out'));
    }, timeoutMs);

    const check = () => {
      if (ready) { clearTimeout(timer); resolve(); }
      else if (loadError) { clearTimeout(timer); reject(new Error(loadError)); }
      else setTimeout(check, 200);
    };
    check();
  });
}

let requestId = 0;

export async function analyzeLocal(imagePath: string, question?: string): Promise<string> {
  const absPath = resolve(process.cwd(), imagePath);
  if (!existsSync(absPath)) throw new Error(`Image not found: ${imagePath}`);

  const imageData = readFileSync(absPath);
  const imageB64 = imageData.toString('base64');

  startProcess();
  await waitForReady();

  return new Promise((resolve, reject) => {
    const id = String(++requestId);

    const timer = setTimeout(() => {
      pendingResolves.delete(id);
      reject(new Error('Local vision request timed out'));
    }, 60000);

    pendingResolves.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(`[Image analysis via local (Florence-2-base)]\n${msg.content}`);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    const req = { image: imageB64, question: question || '' };
    proc!.stdin!.write(JSON.stringify(req) + '\n');
  });
}

export function isLocalVisionAvailable(): boolean {
  return existsSync(SCRIPT_PATH);
}

let preloadStarted = false;

export function preloadLocalVision(): void {
  if (preloadStarted || !isLocalVisionAvailable()) return;
  preloadStarted = true;
  startProcess();
  process.stderr.write('[local-vision] Preloading Florence-2 in background...\n');
  // Don't await — model loads in background
}
