import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, extname, basename } from 'path';
import { ThemeDefinition } from './tokens.js';
import { ThemeAccessor } from './accessor.js';
import { darkTheme, lightTheme, darkAnsiTheme, lightAnsiTheme } from './themes/index.js';

function getThemeDir(): string { return join(homedir(), '.nexus', 'themes'); }
function getConfigPath(): string { return join(homedir(), '.nexus', 'theme.json'); }

function detectNoColor(): boolean {
  return (
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb' ||
    process.env.CI !== undefined
  );
}

export class ThemeManager {
  private themes: Map<string, ThemeDefinition> = new Map();
  private currentName: string = 'dark';
  private _noColor: boolean;

  constructor(noColor?: boolean) {
    this._noColor = noColor ?? detectNoColor();
    this.register('dark', darkTheme);
    this.register('light', lightTheme);
    this.register('dark-ansi', darkAnsiTheme);
    this.register('light-ansi', lightAnsiTheme);
    this.loadCustomThemes();
    this.loadSavedTheme();
  }

  get noColor(): boolean {
    return this._noColor;
  }

  get token(): ThemeAccessor {
    const theme = this.themes.get(this.currentName) ?? darkTheme;
    return new ThemeAccessor(theme, this._noColor);
  }

  get currentThemeName(): string {
    return this.currentName;
  }

  listThemes(): string[] {
    return Array.from(this.themes.keys());
  }

  switch(name: string): boolean {
    if (!this.themes.has(name)) return false;
    this.currentName = name;
    this.saveTheme(name);
    return true;
  }

  register(name: string, theme: ThemeDefinition): void {
    this.themes.set(name, theme);
  }

  private loadCustomThemes(): void {
    if (!existsSync(getThemeDir())) return;
    try {
      const files = readdirSync(getThemeDir());
      for (const file of files) {
        if (extname(file) !== '.json') continue;
        try {
          const path = join(getThemeDir(), file);
          const raw = readFileSync(path, 'utf-8');
          const theme = JSON.parse(raw) as ThemeDefinition;
          const name = basename(file, '.json');
          this.register(name, theme);
        } catch {
          // skip invalid theme files
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  private loadSavedTheme(): void {
    try {
      if (existsSync(getConfigPath())) {
        const raw = readFileSync(getConfigPath(), 'utf-8');
        const cfg = JSON.parse(raw) as { theme: string };
        if (cfg.theme && this.themes.has(cfg.theme)) {
          this.currentName = cfg.theme;
        }
      }
    } catch {
      // ignore config read errors
    }
  }

  private saveTheme(name: string): void {
    try {
      const dir = join(homedir(), '.nexus');
      if (!existsSync(dir)) return;
      const raw = JSON.stringify({ theme: name }, null, 2);
      writeFileSync(getConfigPath(), raw, 'utf-8');
    } catch {
      // ignore save errors
    }
  }
}
