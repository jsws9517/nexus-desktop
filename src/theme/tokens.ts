export type ColorToken =
  | 'border'
  | 'borderAccent'
  | 'background'
  | 'foreground'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'entityName'
  | 'entityLabel'
  | 'entityId'
  | 'prompt'
  | 'thinking'
  | 'toolCallName'
  | 'toolCallBadge'
  | 'spinner'
  | 'diffAdded'
  | 'diffRemoved'
  | 'diffContext'
  | 'textPrimary'
  | 'textSecondary'
  | 'textDim'
  | 'heading';

export type ThemeBase = 'dark' | 'light' | 'dark-ansi' | 'light-ansi';

export interface ThemeDefinition {
  name: string;
  base: ThemeBase;
  colors: Record<ColorToken, string>;
}
