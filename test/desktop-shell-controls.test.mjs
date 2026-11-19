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
  // The selector lives inside the toolbar, before the provider controls.
  assert.ok(html.indexOf('id="language-select"') < html.indexOf('id="provider-select"'));
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
