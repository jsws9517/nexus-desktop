import chalk from 'chalk';

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

const TIPS: string[] = [
  'Run /init to set up providers and MCP',
  'Use /help to see all available commands',
  'Press /tools to list MCP tools & skills',
  'Try `nexus run "task"` for one-shot mode',
];

const WHATS_NEW: string[] = [
  'PageUp/PageDown: browse prompt history',
  'Ctrl+O: toggle compact / full reasoning',
  'Auto-import Claude Code MCP and skills',
  'Persistent sessions, cross-process safe',
];

export interface WelcomeInfo {
  name: string;
  model: string;
  cwd: string;
  version: string;
  sessionId: string;
}

export type BorderMode = 'auto' | 'fill';

function visibleLength(s: string): number {
  return [...s.replace(/\x1B\[[0-9;]*m/g, '')].length;
}

function padRight(s: string, w: number): string {
  const len = visibleLength(s);
  if (len >= w) return s;
  return s + ' '.repeat(w - len);
}

const LOGO_VISUAL_W = 15;
const GAP = 2;

const accent = chalk.hex('#06b6d4');
const head = chalk.hex('#67e8f9');
const dim = chalk.gray;

export function showWelcomeScreen(info: WelcomeInfo, mode?: BorderMode): void {
  const borderMode = mode ?? (process.env.NEXUS_BORDER_MODE as BorderMode) ?? 'fill';

  const tipsItems = TIPS.map((t) => `  ${dim('•')} ${t}`);
  const newsItems = WHATS_NEW.map((t) => `  ${dim('•')} ${t}`);

  const termWidth = process.stdout.columns ?? 120;

  if (borderMode === 'auto') {
    renderAuto(info, tipsItems, newsItems, termWidth);
  } else {
    renderFill(info, tipsItems, newsItems, termWidth);
  }

  console.log('');
  console.log(dim(`Session ${info.sessionId}`));
  console.log(dim('Type /help for commands, /exit to quit'));
  console.log(dim('PageUp/PageDown: history  ·  Ctrl+O: detail mode'));
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
  const indent = ' '.repeat(Math.max(0, Math.floor(((lw - 2) - LOGO_VISUAL_W) / 2)));
  return [
    '',
    `${indent}${head('Welcome back!')}`,
    '',
    ...NEXUS_LOGO.map((line) => `${indent}${accent(line)}`),
    '',
    `  ${dim('nexus-agent')} ${dim('v')}${info.version}`,
    `  ${dim(info.model)}`,
    `  ${dim(info.cwd)}`,
  ];
}

function buildRightLines(tipsItems: string[], newsItems: string[], rw: number): string[] {
  const sepLine = dim('─'.repeat(Math.min(rw - 2, 50)));
  return [
    head('Tips for getting started'),
    sepLine,
    ...tipsItems,
    '',
    head("What's new"),
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
  const topBorder = `${indent}${accent('╭' + '─'.repeat(lw) + '╮')}${' '.repeat(GAP)}${accent('╭' + '─'.repeat(rw) + '╮')}`;
  const botBorder = `${indent}${accent('╰' + '─'.repeat(lw) + '╯')}${' '.repeat(GAP)}${accent('╰' + '─'.repeat(rw) + '╯')}`;

  console.log(topBorder);
  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const l = i < leftLines.length ? leftLines[i] : '';
    const r = i < rightLines.length ? rightLines[i] : '';
    console.log(
      `${indent}${accent('│')} ${padRight(l, lw - 2)} ${accent('│')}${' '.repeat(GAP)}${accent('│')} ${padRight(r, rw - 2)} ${accent('│')}`
    );
  }
  console.log(botBorder);
}

/** Mode "auto": panel widths tightly wrap their content, centred on screen */
function renderAuto(
  info: WelcomeInfo,
  tipsItems: string[],
  newsItems: string[],
  termWidth: number,
): void {
  const leftMax = calcLeftContentMax(info);
  const rightMax = calcRightContentMax(tipsItems, newsItems);

  const lw = leftMax + 2;
  const rw = rightMax + 2;
  const totalWidth = lw + GAP + rw;
  const indent = ' '.repeat(Math.max(0, Math.floor((termWidth - totalWidth) / 2)));

  const leftLines = buildLeftLines(info, lw);
  const rightLines = buildRightLines(tipsItems, newsItems, rw);

  renderBoxes(leftLines, rightLines, lw, rw, indent);
}

/** Mode "fill": left panel content-adaptive (min 38), right panel fills to terminal edge */
function renderFill(
  info: WelcomeInfo,
  tipsItems: string[],
  newsItems: string[],
  termWidth: number,
): void {
  const leftMax = calcLeftContentMax(info);
  const rightMax = calcRightContentMax(tipsItems, newsItems);

  const MIN_LW = 38;
  const lw = Math.max(leftMax + 2, MIN_LW);
  const rw = Math.max(rightMax + 2, termWidth - lw - GAP);

  const leftLines = buildLeftLines(info, lw);
  const rightLines = buildRightLines(tipsItems, newsItems, rw);

  renderBoxes(leftLines, rightLines, lw, rw, '');
}

export function showNexusLogo(): void {
  console.log(chalk.cyan(`
    ╭═══●═
   ╲╭╭╭╭╲
    ╱═┤╲╔┐└
   ●────────────●
   ●────────────●
   ╭══════════════
  `));
}
