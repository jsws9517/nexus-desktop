/**
 * Coverage for the desktop shell controls added around the workbench:
 *  - the toolbar language selector and its setLanguage IPC chain
 *  - the left sidebar width drag (mirrors the right sidebar).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { validateMainLocalParams } = await import(
  pathToFileURL(join(ROOT, 'dist', 'shared', 'ipc-validation.js')).href
);

// ── toolbar language selector ───────────────────────────────────────────────

test('toolbar exposes a bilingual language selector next to the theme control', () => {
  const html = read('static/index.html');
  assert.match(html, /<select id="language-select" aria-label="Language">/);
  assert.match(html, /<option value="zh-CN" data-i18n="languageZh">/);
  assert.match(html, /<option value="en" data-i18n="languageEn">/);
  // The selector lives in the toolbar next to the theme control, before settings.
  const themeIdx = html.indexOf('id="theme-select"');
  const langIdx = html.indexOf('id="language-select"');
  const settingsIdx = html.indexOf('id="btn-settings"');
  assert.ok(themeIdx >= 0 && langIdx > themeIdx && langIdx < settingsIdx);
});

test('language option strings are bilingual', () => {
  const i18n = read('src/renderer/i18n.ts');
  assert.match(i18n, /languageZh: \{ 'zh-CN': '中文', en: 'Chinese' \}/);
  assert.match(i18n, /languageEn: \{ 'zh-CN': '英文', en: 'English' \}/);
});

test('setLanguage is wired through every IPC layer', () => {
  const channels = read('src/ipc/channels.ts');
  const validation = read('src/shared/ipc-validation.ts');
  const register = read('src/ipc/register.ts');
  const preload = read('src/preload.cts');
  const renderer = read('src/renderer/renderer.ts');

  assert.match(channels, /setLanguage: 'nexus:setLanguage'/);
  assert.match(validation, /setLanguage: \{ fields: \{ language: S\.en\(\['zh-CN', 'en'\]\) \} \}/);
  assert.match(register, /ipcMain\.handle\(CHANNELS\.setLanguage,/);
  assert.match(register, /validateMainLocalParams\('setLanguage', p\)/);
  // Fixed config path, never a renderer-supplied one.
  assert.match(register, /const cfgPath = join\(homedir\(\), '\.nexus', 'config\.json'\)/);
  assert.match(preload, /setLanguage: \(language: string\) => ipcRenderer\.invoke\('nexus:setLanguage', \{ language \}\)/);
  assert.match(renderer, /setLanguage\(language: string\): Promise<\{ ok: boolean; error\?: string \}>;/);
});

test('toolbar language change persists then repaints through the shared path', () => {
  const renderer = read('src/renderer/renderer.ts');
  assert.match(renderer, /function syncLanguageSelect\(\): void/);
  assert.match(renderer, /async function changeLanguage\(next: string\): Promise<void>/);
  assert.match(renderer, /window\.nexusDesktop\.setLanguage\(lang\)/);
  assert.match(renderer, /await loadLanguage\(\); \/\/ re-read config from disk \+ applyI18n\(\)/);
  assert.match(renderer, /notifyLanguageChanged\(\);/);
  // Both the toolbar and the settings window keep the selector in sync.
  assert.match(renderer, /document\.getElementById\('language-select'\)\?\.addEventListener\('change'/);
  assert.match(renderer, /await loadLanguage\(\);\n  syncLanguageSelect\(\);/);
});

test('setLanguage params accept only the two known languages', () => {
  assert.equal(validateMainLocalParams('setLanguage', { language: 'zh-CN' }), null);
  assert.equal(validateMainLocalParams('setLanguage', { language: 'en' }), null);
  assert.notEqual(validateMainLocalParams('setLanguage', { language: 'fr' }), null);
  assert.notEqual(validateMainLocalParams('setLanguage', { language: '../evil' }), null);
  assert.notEqual(validateMainLocalParams('setLanguage', {}), null);
});

// ── left sidebar width drag ─────────────────────────────────────────────────

test('left sidebar uses a width variable with a drag handle like the right one', () => {
  const html = read('static/index.html');
  const css = read('static/styles.css');
  assert.match(html, /<div class="sidebar-resize" role="separator" aria-orientation="vertical"/);
  assert.match(css, /--sidebar-w: 274px;/);
  assert.match(css, /width: var\(--sidebar-w\)/);
  assert.match(css, /#sidebar \{ --sidebar-w: 250px; \}/); // responsive cap mirrors right bar
  assert.match(css, /\.sidebar-resize \{[\s\S]*right: -3px;[\s\S]*cursor: col-resize;/);
  assert.match(css, /#sidebar\.dragging \{ transition: none; \}/);
  assert.match(css, /#sidebar\.collapsed \.sidebar-resize \{ display: none; \}/);
});

test('left sidebar drag clamps to the same 274~720px range as the right sidebar', () => {
  const renderer = read('src/renderer/renderer.ts');
  assert.match(renderer, /const LSIDE_W_KEY = 'nexus\.left-sidebar\.width'/);
  assert.match(renderer, /const LSIDE_W_MIN = 274;/);
  assert.match(renderer, /const LSIDE_W_MAX = 720;/);
  assert.match(renderer, /sidebarEl\.querySelector<HTMLElement>\('\.sidebar-resize'\)/);
  // Drag rightwards to widen (clientX increases with the pointer).
  assert.match(renderer, /startW \+ \(ev\.clientX - startX\)/);
  assert.match(renderer, /style\.setProperty\('--sidebar-w'/);
  assert.match(renderer, /localStorage\.setItem\(LSIDE_W_KEY/);
  assert.match(renderer, /window\.addEventListener\('resize', applyLsideWidth\)/);
});

// ── context usage is shown once, in Session Info ────────────────────────────

test('no duplicate context-usage block: stats live only in Session Info', () => {
  const html = read('static/index.html');
  const css = read('static/styles.css');
  const renderer = read('src/renderer/renderer.ts');
  const i18n = read('src/renderer/i18n.ts');

  // The redundant task-summary card and its render function are gone.
  assert.equal(html.includes('id="task-summary"'), false);
  assert.equal(css.includes('.task-summary'), false);
  assert.equal(renderer.includes('renderTaskSummary'), false);
  assert.equal(renderer.includes('taskSummaryEl'), false);
  assert.equal(i18n.includes('contextUsage:'), false);

  // The single source of truth (Session Info rows) stays.
  assert.match(html, /id="rside-token"/);
  assert.match(html, /id="rside-summary-count"/);
  assert.match(renderer, /rsideToken\.textContent = t\('tokenEstimated'/);
  assert.match(renderer, /rsideSummaryCount\.textContent = `\$\{t\('compressSummarize'\)/);
});

// ── compact action sits in the composer, beside the mode selector ───────────

test('compact button lives in the composer action bar, not the sidebar', () => {
  const html = read('static/index.html');
  const css = read('static/styles.css');
  const icons = read('src/renderer/icons.ts');

  // Positioned inside .input-left, immediately after the permission-mode box.
  const permBox = html.indexOf('id="perm-box"');
  const permPopoverFoot = html.indexOf('permPopoverFoot');
  const compact = html.indexOf('id="btn-compact"');
  const inputLeftEnd = html.indexOf('class="input-hint"', compact);
  assert.ok(permBox >= 0 && compact > permPopoverFoot, 'compact follows the mode selector');
  assert.ok(compact < inputLeftEnd, 'compact is inside .input-left');

  // Rendered as a small chip with an icon + i18n label, not the old full-width button.
  assert.match(html, /id="btn-compact" type="button" class="compact-btn"/);
  assert.match(html, /<span class="icon-slot" data-icon="compress"><\/span>/);
  assert.match(html, /<span class="compact-label" data-i18n="compactContext">/);
  assert.match(icons, /compress: '/);
  assert.match(css, /\.input-left \.compact-btn \{/);
  assert.equal(html.includes('compact-btn" data-i18n="compactContext" disabled'), false);

  // Not left behind in the right sidebar's task section.
  const taskSection = html.slice(html.indexOf('data-i18n="taskProgress"'), html.indexOf('data-panel="files"'));
  assert.equal(taskSection.includes('btn-compact'), false);
});

// ── compact action is a guarded, lossy-operation control ────────────────────

test('compact action is semi-hidden, danger-styled, and warns of data loss', () => {
  const html = read('static/index.html');
  const css = read('static/styles.css');
  const i18n = read('src/renderer/i18n.ts');

  // Semi-hidden by default; revealed only while the pointer is in the action bar.
  assert.match(css, /\.input-left \.compact-btn \{[^}]*opacity:\s*0\.25/s);
  assert.match(css, /\.input-left:hover \.compact-btn,\s*\.input-left \.compact-btn:focus-visible \{ opacity: 1; \}/);

  // Bold danger-red label (the icon inherits currentColor from the button).
  assert.match(css, /\.compact-label \{[^}]*color:\s*var\(--danger\)[^}]*font-weight:\s*700/s);

  // A caution tooltip, hidden until the region is hovered, with a bilingual warning.
  assert.match(html, /class="compact-caution" id="compact-caution-tip" role="tooltip"/);
  assert.match(html, /<span data-i18n="compactCaution">/);
  assert.match(i18n, /compactCaution:\s*\{ 'zh-CN': '[^']+', en: '[^']+' \}/);
  assert.match(css, /\.compact-caution \{[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.input-left:hover \.compact-caution,[^}]*opacity: 1; visibility: visible/s);
});

// ── the session mode picker offers all four core modes, basic first ──────────

test('permission picker offers basic / prompt / auto / unattended', () => {
  const html = read('static/index.html');
  const i18n = read('src/renderer/i18n.ts');
  const renderer = read('src/renderer/renderer.ts');
  const css = read('static/styles.css');
  const shared = read('src/shared/permissions-config.ts');

  const options = [...html.matchAll(/class="perm-option" data-mode="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ['basic', 'prompt', 'auto', 'unattended']);
  assert.match(html, /id="perm-box" class="perm-box" data-mode="basic"/);
  // The default badge belongs to basic, not prompt.
  const basicBlock = html.slice(html.indexOf('data-mode="basic"'), html.indexOf('data-mode="prompt"'));
  assert.match(basicBlock, /perm-badge default/);

  assert.match(i18n, /permModeBasic:/);
  assert.match(i18n, /permDescBasic:/);
  assert.match(renderer, /function permLabel[\s\S]*?mode === 'basic'/);
  assert.match(renderer, /mode === 'basic' \|\| mode === 'prompt'/);
  assert.match(css, /\.perm-box\[data-mode="basic"\] \.perm-trigger/);
  assert.match(shared, /PERMISSION_MODES = \['basic', 'prompt', 'auto', 'unattended'\]/);
});
