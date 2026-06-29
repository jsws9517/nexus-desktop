import { readdirSync } from 'fs';
import { resolve, sep, relative } from 'path';
import chalk from 'chalk';
import type { Interface as RLInterface } from 'readline';

interface PickerEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

const MAX_VISIBLE = 8;

export class FilePicker {
  active = false;
  private rl!: RLInterface;
  private cwd = '';
  /** Position of `@` in the readline input (we don't own the line — readline does) */
  atIndex = -1;

  // File list state — derived from rl.line
  private dirPath = '';
  private filter = '';
  private entries: PickerEntry[] = [];
  private selected = 0;
  private scrollOffset = 0;
  private renderedLines = 0;

  /** Activate picker. `atPos` is the cursor position where `@` was typed. */
  activate(rl: RLInterface, atPos: number, cwd: string): void {
    this.rl = rl;
    this.cwd = cwd;
    this.atIndex = atPos;
    this.selected = 0;
    this.scrollOffset = 0;
    this.syncFromLine();
    this.active = true;
    this.render();
  }

  /** Called after every keypress that readline processes — sync from rl.line */
  syncFromLine(): void {
    if (!this.rl.line) return;
    const pathStr = this.rl.line.slice(this.atIndex + 1); // text after @
    this.parsePath(pathStr);
  }

  deactivate(insertRelative?: string): void {
    if (!this.active) return;
    this.clearRender();
    this.active = false;
    this.atIndex = -1;

    if (insertRelative !== undefined) {
      process.nextTick(() => {
        // Clear the line, then insert the selected path
        const rl = this.rl as any;
        rl.write(null, { ctrl: true, name: 'u' });
        rl.write(insertRelative);
      });
    }
  }

  /** Handle intercepted keys (up/down/enter/esc/tab). Returns true if handled. */
  handleKey(_str: string, key: { name?: string; ctrl?: boolean }): boolean {
    if (!this.active) return false;

    if (key.name === 'up') {
      this.moveSelection(-1);
      this.render();
      return true;
    }
    if (key.name === 'down') {
      this.moveSelection(1);
      this.render();
      return true;
    }
    if (key.name === 'tab') {
      const entry = this.entries[this.selected];
      if (entry) {
        if (entry.isDir) {
          // Replace @path with @path/ to enter directory
          this.replaceAtLine(entry.fullPath + sep);
        } else {
          this.deactivate(this.relativePath(entry.fullPath));
        }
      }
      this.render();
      return true;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const entry = this.entries[this.selected];
      this.deactivate(entry ? this.relativePath(entry.fullPath) : undefined);
      return true;
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.deactivate();
      return true;
    }

    return false; // Not handled — let readline process it normally
  }

  /** Re-render the file list (called externally after readline processes a key) */
  refresh(): void {
    if (!this.active) return;
    this.render();
  }

  // ---- private helpers ----

  private moveSelection(delta: number): void {
    if (this.entries.length === 0) return;
    this.selected = Math.max(0, Math.min(this.selected + delta, this.entries.length - 1));
    if (this.selected < this.scrollOffset) {
      this.scrollOffset = this.selected;
    } else if (this.selected >= this.scrollOffset + MAX_VISIBLE) {
      this.scrollOffset = this.selected - MAX_VISIBLE + 1;
    }
  }

  /** Replace @path in readline's line with a new path */
  private replaceAtLine(newPath: string): void {
    const rl = this.rl as any;
    const beforeAt = this.rl.line.slice(0, this.atIndex);
    const afterCursor = this.rl.line.slice(rl.cursor || this.rl.line.length);
    const newLine = beforeAt + '@' + newPath + afterCursor;
    const newCursor = beforeAt.length + 1 + newPath.length;

    process.nextTick(() => {
      // Overwrite the full line
      rl.write(null, { ctrl: true, name: 'u' });
      rl.write(newLine);
      // Restore cursor (rl.write leaves it at end)
      const remaining = newLine.length - newCursor;
      for (let i = 0; i < remaining; i++) rl.write(null, { ctrl: true, name: 'left' });
    });
    // Update local state
    this.atIndex = beforeAt.length;
    this.parsePath(newPath);
    this.selected = 0;
    this.scrollOffset = 0;
  }

  private parsePath(pathStr: string): void {
    const normalized = pathStr.replace(/\//g, sep);
    if (normalized === '' || normalized.endsWith(sep)) {
      this.dirPath = normalized === '' ? this.cwd : resolve(this.cwd, normalized);
      this.filter = '';
    } else {
      const lastSep = normalized.lastIndexOf(sep);
      if (lastSep >= 0) {
        this.dirPath = resolve(this.cwd, normalized.slice(0, lastSep + 1));
        this.filter = normalized.slice(lastSep + 1);
      } else {
        this.dirPath = this.cwd;
        this.filter = normalized;
      }
    }
    this.loadEntries();
  }

  private loadEntries(): void {
    try {
      this.entries = readdirSync(this.dirPath, { withFileTypes: true })
        .filter(e => e.name.startsWith(this.filter))
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          fullPath: resolve(this.dirPath, e.name),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      this.entries = [];
    }
  }

  private relativePath(fullPath: string): string {
    const rel = relative(this.cwd, fullPath);
    return rel.startsWith('..') ? fullPath : rel;
  }

  private render(): void {
    this.clearRender();

    const visible = this.entries.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE);
    const lines: string[] = [];

    if (visible.length === 0) {
      lines.push(chalk.gray('  (no matching files)'));
    } else {
      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i];
        if (!entry) continue;
        const isSelected = i + this.scrollOffset === this.selected;
        const icon = entry.isDir ? '📁' : '📄';
        const suffix = entry.isDir ? '/' : '';
        const text = `  ${icon} ${entry.name}${suffix}`;
        lines.push(isSelected ? chalk.inverse(text) : '  ' + chalk.gray(entry.name + suffix));
      }
      if (this.entries.length > MAX_VISIBLE) {
        lines.push(chalk.dim(`  … ${this.entries.length - MAX_VISIBLE} more`));
      }
    }

    lines.push(chalk.dim('─'.repeat(40)));
    lines.push(chalk.dim('↑↓ navigate  Tab enter dir  Enter select  Esc cancel'));

    process.stdout.write('\n');
    for (const line of lines) process.stdout.write(line + '\n');
    this.renderedLines = lines.length + 1;
    // Move cursor back up to the input line
    process.stdout.write(`\x1B[${this.renderedLines}A`);
    // Force readline to re-display its input line (it manages the cursor internally)
    (this.rl as any)._refreshLine();
  }

  private clearRender(): void {
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1B[${this.renderedLines}B`);
      for (let i = 0; i < this.renderedLines; i++) {
        process.stdout.write('\r\x1B[2K');
        if (i < this.renderedLines - 1) process.stdout.write('\x1B[A');
      }
      this.renderedLines = 0;
    }
  }
}
