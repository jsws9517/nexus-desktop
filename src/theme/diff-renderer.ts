import { ThemeAccessor } from './accessor.js';

export function renderDiff(diffText: string, t: ThemeAccessor): string {
  const lines = diffText.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+')) {
      result.push(t.diffAdded(line));
    } else if (line.startsWith('-')) {
      result.push(t.diffRemoved(line));
    } else if (line.startsWith('@@')) {
      result.push(t.info(line));
    } else if (line.startsWith('diff --git') || line.startsWith('index')) {
      result.push(t.textDim(line));
    } else {
      result.push(t.diffContext(line));
    }
  }

  return result.join('\n');
}

export function renderInlineDiff(oldText: string, newText: string, t: ThemeAccessor): string {
  const lines: string[] = [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (i < oldLines.length && i < newLines.length) {
      if (oldLines[i] !== newLines[i]) {
        lines.push(t.diffRemoved(`- ${oldLines[i]}`));
        lines.push(t.diffAdded(`+ ${newLines[i]}`));
      } else {
        lines.push(t.diffContext(` ${oldLines[i]}`));
      }
    } else if (i < oldLines.length) {
      lines.push(t.diffRemoved(`- ${oldLines[i]}`));
    } else if (i < newLines.length) {
      lines.push(t.diffAdded(`+ ${newLines[i]}`));
    }
  }

  return lines.join('\n');
}
