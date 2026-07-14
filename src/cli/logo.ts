import { ThemeManager } from '../theme/manager.js';
import { t as i18nTr, tf as i18nTf } from '../i18n/index.js';

const _theme = new ThemeManager();
const t = _theme.token;

const NEXUS_LOGO: string[] = [
  '    ╭─────╮    ',
  '   ╱  ◉  ◉  ╲   ',
  '  ◉         ◉   ',
  '  ◉    ●    ◉   ',
  '  ◉    ●    ◉   ',
  '  ◉         ◉   ',
  '   ╲  ◉  ◉  ╱   ',
  '    ╰─────╯    ',
];

export interface WelcomeInfo {
  name: string;
  model: string;
  cwd: string;
  version: string;
  sessionId: string;
}

export type BorderMode = 'auto' | 'fill';

function isCjk(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (
    (code >= 0x2e80 && code <= 0x2eff) || // CJK Radicals
    (code >= 0x2f00 && code <= 0x2fdf) || // Kangxi Radicals
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0x3100 && code <= 0x312f) || // Bopomofo
    (code >= 0x3200 && code <= 0x32ff) || // Enclosed CJK
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0x20000 && code <= 0x2a6df)   // CJK Extension B
  );
}

function visibleLength(s: string): number {
  const plain = s.replace(/\x1B\[[0-9;]*m/g, '');
  let len = 0;
  for (const char of plain) {
    len += isCjk(char) ? 2 : 1;
  }
  return len;
}

function padRight(s: string, w: number): string {
  const len = visibleLength(s);
  if (len >= w) return s;
  return s + ' '.repeat(w - len);
}

function calcFillMax(columns: number): number {
  return Math.floor(Math.max(columns * 0.96, 82));
}

export function showWelcomeScreen(info: WelcomeInfo, mode?: BorderMode): void {
  const borderMode = mode ?? (process.env.NEXUS_BORDER_MODE as BorderMode) ?? 'fill';

  const tipsItems: string[] = [
    `  ${t.textDim('•')} ${i18nTr('tip_init')}`,
    `  ${t.textDim('•')} ${i18nTr('tip_help')}`,
    `  ${t.textDim('•')} ${i18nTr('tip_tools')}`,
    `  ${t.textDim('•')} ${i18nTr('tip_run')}`,
  ];
  const newsItems: string[] = [
    `  ${t.textDim('•')} ${i18nTr('wn_history')}`,
    `  ${t.textDim('•')} ${i18nTr('wn_detail')}`,
    `  ${t.textDim('•')} ${i18nTr('wn_import')}`,
    `  ${t.textDim('•')} ${i18nTr('wn_persist')}`,
  ];

  const termWidth = process.stdout.columns ?? 120;

  if (borderMode === 'auto') {
    renderAuto(info, tipsItems, newsItems, termWidth);
  } else {
    const fillMax = calcFillMax(termWidth);
    renderFill(info, tipsItems, newsItems, fillMax);
  }

  console.log('');
  console.log(t.textDim(i18nTf('session_label')(info.sessionId)));
  console.log(t.textDim(i18nTr('type_help')));
  console.log(t.textDim(i18nTr('shortcuts_line')));
  console.log('');
}

function calcLeftContentMax(info: WelcomeInfo): number {
  const lines = [
    '',
    'Welcome back!',
    '',
    ...NEXUS_LOGO,
    '',
    `  nexus-agent v${info.version}`,
    `  ${info.model}`,
    `  ${info.cwd}`,
  ];
  return Math.max(...lines.map((s) => visibleLength(s)));
}

function calcRightContentMax(tipsItems: string[], newsItems: string[]): number {
  const lines = [
    'Tips for getting started',
    ...tipsItems,
    '',
    "What's new",
    ...newsItems,
  ];
  return Math.max(...lines.map((s) => visibleLength(s)));
}

function buildLeftLines(info: WelcomeInfo, lw: number): string[] {
  const indent = ' '.repeat(Math.max(0, Math.floor(((lw - 2) - 15) / 2)));
  return [
    '',
    `${indent}${t.heading(i18nTr('welcome_back'))}`,
    '',
    ...NEXUS_LOGO.map((line) => `${indent}${t.borderAccent(line)}`),
    '',
    `  ${t.textDim('nexus-agent')} ${t.textDim('v')}${info.version}`,
    `  ${t.textDim(info.model)}`,
    `  ${t.textDim(info.cwd)}`,
  ];
}

function buildRightLines(tipsItems: string[], newsItems: string[], rw: number): string[] {
  const sepLine = t.textDim('─'.repeat(Math.min(rw - 2, 50)));
  return [
    t.heading(i18nTr('tips_title')),
    sepLine,
    ...tipsItems,
    '',
    t.heading(i18nTr('whatsnew_title')),
    sepLine,
    ...newsItems,
  ];
}

function renderBoxes(
  leftLines: string[],
  rightLines: string[],
  lw: number,
  rw: number,
  indent: string,
): void {
  const totalWidth = lw + rw + 1;

  const topBorder = `${indent}${t.borderAccent('╭' + '─'.repeat(totalWidth) + '╮')}`;
  const botBorder = `${indent}${t.borderAccent('╰' + '─'.repeat(totalWidth) + '╯')}`;

  console.log(topBorder);
  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const l = i < leftLines.length ? leftLines[i] : '';
    const r = i < rightLines.length ? rightLines[i] : '';
    console.log(
      `${indent}${t.borderAccent('│')} ${padRight(l, lw - 2)} ${t.borderAccent('│')} ${padRight(r, rw - 2)} ${t.borderAccent('│')}`
    );
  }
  console.log(botBorder);
}

function renderAuto(
  info: WelcomeInfo,
  tipsItems: string[],
  newsItems: string[],
  termWidth: number,
): void {
  const leftMax = calcLeftContentMax(info);
  const rightMax = calcRightContentMax(tipsItems, newsItems);

  const lw = leftMax + 2;
  const rw = Math.min(rightMax + 2, Math.max(25, termWidth - lw - 3));

  const leftLines = buildLeftLines(info, lw);
  const rightLines = buildRightLines(tipsItems, newsItems, rw);

  renderBoxes(leftLines, rightLines, lw, rw, '');
}

function renderFill(
  info: WelcomeInfo,
  tipsItems: string[],
  newsItems: string[],
  termWidth: number,
): void {
  const leftMax = calcLeftContentMax(info);
  const rightMax = calcRightContentMax(tipsItems, newsItems);

  const MIN_LW = 35;
  const MIN_RW = rightMax + 2;
  const autoLw = leftMax + 2;

  let lw = Math.max(autoLw, MIN_LW);
  let rw = Math.max(MIN_RW, termWidth - lw - 3);

  if (lw + rw + 3 > termWidth) {
    rw = termWidth - lw - 3;
  }

  if (rw < MIN_RW) {
    renderAuto(info, tipsItems, newsItems, termWidth);
    return;
  }

  const leftLines = buildLeftLines(info, lw);
  const rightLines = buildRightLines(tipsItems, newsItems, rw);

  renderBoxes(leftLines, rightLines, lw, rw, '');
}

export function showNexusLogo(): void {
  console.log(t.borderAccent(`
    ╭═══●═
   ╲╭╭╭╭╲
    ╱═┤╲╔┐└
   ●────────────●
   ●────────────●
   ╭══════════════
  `));
}
