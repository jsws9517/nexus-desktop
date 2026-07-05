import chalk from 'chalk';
import { ColorToken, ThemeDefinition, ThemeBase } from './tokens.js';

const ANSI_MAP: Record<string, number> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, '11': 11, '12': 12, '13': 13, '14': 14, '15': 15,
};

function ansiToChalk(n: string): (text: string) => string {
  const idx = ANSI_MAP[n];
  if (idx === undefined) return (t: string) => t;
  return (text: string) => chalk.ansi256(idx)(text);
}

export class ThemeAccessor {
  private noColor: boolean;

  constructor(
    private theme: ThemeDefinition,
    noColor?: boolean,
  ) {
    this.noColor = noColor ?? false;
  }

  private apply(token: ColorToken, text: string): string {
    if (this.noColor) return text;
    const color = this.theme.colors[token];
    if (!color) return text;
    if (this.theme.base === 'dark-ansi' || this.theme.base === 'light-ansi') {
      return ansiToChalk(color)(text);
    }
    return chalk.hex(color)(text);
  }

  border(text: string): string       { return this.apply('border', text); }
  borderAccent(text: string): string { return this.apply('borderAccent', text); }

  success(text: string): string  { return this.apply('success', text); }
  error(text: string): string    { return this.apply('error', text); }
  warning(text: string): string  { return this.apply('warning', text); }
  info(text: string): string     { return this.apply('info', text); }

  entityName(text: string): string  { return this.apply('entityName', text); }
  entityLabel(text: string): string { return this.apply('entityLabel', text); }
  entityId(text: string): string    { return this.apply('entityId', text); }

  prompt(text: string): string       { return this.apply('prompt', text); }
  thinking(text: string): string     { return this.apply('thinking', text); }
  toolCallName(text: string): string { return this.apply('toolCallName', text); }
  toolCallBadge(text: string): string{ return this.apply('toolCallBadge', text); }
  spinner(text: string): string      { return this.apply('spinner', text); }

  diffAdded(text: string): string   { return this.apply('diffAdded', text); }
  diffRemoved(text: string): string { return this.apply('diffRemoved', text); }
  diffContext(text: string): string { return this.apply('diffContext', text); }

  textPrimary(text: string): string   { return this.apply('textPrimary', text); }
  textSecondary(text: string): string { return this.apply('textSecondary', text); }
  textDim(text: string): string       { return this.apply('textDim', text); }
  heading(text: string): string       { return this.apply('heading', text); }
}
