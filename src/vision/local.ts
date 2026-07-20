import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve the Florence-2 python script. Candidates, in order:
//   1. dist/src/vision/local_vision.py  (npm package / tsc build — copied by build step)
//   2. src/vision/local_vision.py       (running from source via tsx)
//   3. <pkg>/src/vision/local_vision.py (dev tree relative to dist)
const CANDIDATES = [
  resolve(__dirname, 'local_vision.py'),
  resolve(__dirname, '..', '..', '..', 'src', 'vision', 'local_vision.py'),
  resolve(__dirname, '..', '..', 'src', 'vision', 'local_vision.py'),
];
const SCRIPT_PATH = CANDIDATES.find(p => existsSync(p)) || CANDIDATES[0];

let proc: ChildProcess | null = null;
let modelLoading = false;
let loadError: string | null = null;
let ready = false;
let pendingResolves: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map();

let starting = false;

// Background preload/load progress is noisy and pollutes the interactive
// TUI input line. Suppress it by default; enable with VISION_DEBUG=1.
const VISION_DEBUG = process.env.VISION_DEBUG === '1';

function vlog(msg: string): void {
  if (VISION_DEBUG) process.stderr.write(`[local-vision] ${msg}\n`);
}

function startProcess(): void {
  if (proc || modelLoading || starting) return;
  modelLoading = true;
  starting = true;

  const pythonBin = process.env.LLMA_VISION_PYTHON || 'python';
  proc = spawn(pythonBin, [SCRIPT_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';

  const onChildLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.content !== undefined) {
        handleResponse(msg);
      } else if (msg.error) {
        handleError(msg);
      }
    } catch {
      // Non-JSON diagnostics from the python child (stdout carries the JSON
      // results; stderr carries progress like "Loading..."/"Model loaded").
      if (line.includes('ready')) {
        ready = true;
        modelLoading = false;
        vlog('Florence-2 ready.');
      } else if (line.includes('Loading') || line.includes('loaded') || line.includes('Analysis')) {
        vlog(line);
      } else if (line.toLowerCase().includes('error') || line.toLowerCase().includes('traceback')) {
        // Errors are always surfaced — they indicate a real failure.
        process.stderr.write(`[local-vision] ${line}\n`);
      }
    }
  };

  const onChildData = (data: Buffer): void => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) onChildLine(line);
  };

  // Python writes JSON results to stdout, and progress/diagnostics to stderr.
  // Listen to both so load progress is surfaced to the user.
  proc.stdout!.on('data', onChildData);
  proc.stderr!.on('data', onChildData);

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
  // Resolve the oldest pending request (FIFO order)
  const entry = pendingResolves.entries().next();
  if (!entry.done) {
    const [id, p] = entry.value;
    pendingResolves.delete(id);
    p.resolve(msg);
  }
}

function handleError(msg: any): void {
  // Reject the oldest pending request (FIFO order)
  const entry = pendingResolves.entries().next();
  if (!entry.done) {
    const [id, p] = entry.value;
    pendingResolves.delete(id);
    p.reject(new Error(msg.error));
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
    if (!proc || !proc.stdin || proc.killed) {
      // The preloaded process may have died or entered a bad state (e.g. a
      // transient inference error). Drop the stale handle so the next call
      // spawns a fresh process with a freshly loaded model instead of
      // silently failing against a dead one.
      proc = null;
      ready = false;
      pendingResolves.delete(id);
      clearTimeout(timer);
      reject(new Error('Local vision process is not running'));
      return;
    }
    proc.stdin.write(JSON.stringify(req) + '\n');
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
  vlog('Preloading Florence-2 in background...');
  // Don't await — model loads in background
}
