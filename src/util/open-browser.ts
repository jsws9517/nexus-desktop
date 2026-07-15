import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type Opener = (
  url: string,
) => { command: string; args: string[] } | null;

function getOpener(): Opener | null {
  if (process.platform === 'win32') {
    return (url: string) => ({ command: 'cmd', args: ['/c', 'start', '""', url] });
  }
  if (process.platform === 'darwin') {
    return (url: string) => ({ command: 'open', args: [url] });
  }
  // Linux + other Unix
  return (url: string) => ({ command: 'xdg-open', args: [url] });
}

/**
 * Best-effort cross-platform URL opener. Never throws — returns false if no
 * browser is available so the caller can fall back to printing the URL.
 */
export async function openBrowser(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;

  const opener = getOpener();
  if (!opener) return false;

  const target = opener(url);
  if (!target) return false;

  try {
    await execFileAsync(target.command, target.args, {
      stdio: 'ignore',
      windowsHide: true,
    } as Parameters<typeof execFileAsync>[2]);
    return true;
  } catch {
    return false;
  }
}
