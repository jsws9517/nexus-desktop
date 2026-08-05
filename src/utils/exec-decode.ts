import { TextDecoder } from 'util';

function countReplacement(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) count++;
  }
  return count;
}

/**
 * Decode raw command output bytes captured from a child process.
 *
 * On Chinese Windows, console-less child processes (cmd.exe / powershell.exe
 * spawned from the desktop worker with `windowsHide`) emit the OEM code page
 * (GBK/cp936) instead of UTF-8, even when `chcp 65001` is prefixed (chcp needs
 * a real console). UTF-8-first decoding then mangles every CJK character into
 * U+FFFD. Try UTF-8 first and fall back to GBK when the bytes are not valid
 * UTF-8, so both UTF-8-emitting tools (git, node) and GBK-emitting tools
 * (cmd/powershell) decode cleanly.
 */
export function decodeCommandOutput(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw;
  if (raw.length === 0) return '';
  const utf8 = raw.toString('utf8');
  const utf8Bad = countReplacement(utf8);
  if (utf8Bad === 0) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(raw);
    const gbkBad = countReplacement(gbk);
    if (gbkBad < utf8Bad) return gbk;
  } catch {
    // ICU missing gbk support (unlikely) — keep the UTF-8 attempt.
  }
  return utf8;
}
