import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { esc, renderInline, renderBlocks, isAbsoluteLocalPath, hydrateImages } from '../dist/renderer/markdown.js';

test('esc escapes HTML metacharacters', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(esc('plain text'), 'plain text');
});

test('renderInline renders code, bold, links', () => {
  const out = renderInline('use `npm i` and **bold** and [link](https://a.com/x)');
  assert.match(out, /<code>npm i<\/code>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<a href="https:\/\/a\.com\/x" target="_blank" rel="noopener noreferrer">link<\/a>/);
});

test('renderInline escapes html but keeps data-url images', () => {
  const out = renderInline('a <script> tag and ![img](data:image/png;base64,AAA)');
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<img alt="img" src="data:image\/png;base64,AAA"/);
});

test('renderBlocks renders fenced code with lang + copy button', () => {
  const out = renderBlocks('```js\nconst x = 1;\n```');
  assert.match(out, /class="code-block"/);
  assert.match(out, /class="code-lang">js</);
  assert.match(out, /class="code-copy"/);
  assert.match(out, /const x = 1;/);
});

test('renderBlocks escapes code content', () => {
  const out = renderBlocks('```\nif (a < b) {}\n```');
  assert.match(out, /a &lt; b/);
});

test('renderBlocks renders diff blocks with colored lines', () => {
  const out = renderBlocks('```diff\n+added\n-removed\n@@ hunk\ncontext\n```');
  assert.match(out, /style="color:#7bc96f"/);
  assert.match(out, /style="color:#e05a5a"/);
  assert.match(out, /style="color:#4f8cff"/);
});

test('renderBlocks renders tables', () => {
  const src = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
  const out = renderBlocks(src);
  assert.match(out, /<table class="md-table">/);
  assert.match(out, /<th>A<\/th>/);
  assert.match(out, /<td>1<\/td>/);
});

test('renderBlocks keeps pipes inside inline code as cell content', () => {
  // GFM: `|` inside a code span must NOT split the cell (regression for the
  // git-page table whose last cell embedded callGitTool('a'|'b'…)).
  const src =
    '| 现状 | 证据 |\n|---|---|\n' +
    '| 工具：`callGitTool(\'a\'|\'b\')` 存在 | ✅ 已核 |';
  const out = renderBlocks(src);
  assert.match(out, /<td>工具：<code>callGitTool\(&#39;a&#39;\|&#39;b&#39;\)<\/code> 存在<\/td>/);
  assert.match(out, /<td>✅ 已核<\/td>/);
  assert.ok(!out.includes('"a"</td><td>"b"'), 'pipe inside code must not create a cell');
});

test('renderBlocks handles escaped pipes in table cells', () => {
  const out = renderBlocks('| A |\n|---|\n| x \\| y |');
  assert.match(out, /<td>x \| y<\/td>/);
  assert.ok(!out.includes('<td>x </td>'), 'escaped pipe must not split the cell');
});

test('renderBlocks renders task checklists', () => {
  const out = renderBlocks('- [x] done\n- [ ] todo');
  assert.match(out, /class="task-item"/);
  assert.match(out, /type="checkbox" checked disabled/);
  assert.match(out, /type="checkbox" disabled/);
});

test('renderBlocks renders headings and lists', () => {
  const out = renderBlocks('# H1\n## H2\n- item\n1. numbered');
  assert.match(out, /<h1>H1<\/h1>/);
  assert.match(out, /<h2>H2<\/h2>/);
  assert.match(out, /• item/);
  assert.match(out, /numbered/);
});

test('renderBlocks skips image hydration for non-local images', () => {
  const out = renderBlocks('![alt](https://example.com/x.png)');
  assert.match(out, /<img alt="alt" src="https:\/\/example\.com\/x\.png"/);
});

test('renderBlocks preserves blank-line separated paragraphs', () => {
  const out = renderBlocks('line1\n\nline2');
  assert.ok(out.length > 0);
  assert.match(out, /line1/);
  assert.match(out, /line2/);
});

// ── local image refs (chat png thumbnails → inline preview cards) ─────────

test('isAbsoluteLocalPath classifies local filesystem refs', () => {
  assert.equal(isAbsoluteLocalPath('C:/x.png'), true);
  assert.equal(isAbsoluteLocalPath('C:\\x.png'), true);
  assert.equal(isAbsoluteLocalPath('\\\\server\\share\\a.png'), true);
  assert.equal(isAbsoluteLocalPath('/tmp/x.png'), true);
  assert.equal(isAbsoluteLocalPath('images/x.png'), false);
  assert.equal(isAbsoluteLocalPath('https://a.com/x.png'), false);
  assert.equal(isAbsoluteLocalPath('data:image/png;base64,AAA'), false);
  assert.equal(isAbsoluteLocalPath('blob:xyz'), false);
});

test('renderInline turns absolute local paths into hydratable images', () => {
  const winPath = renderInline('![tokyo](C:/Users/pgw/pic.png)');
  assert.match(winPath, /<img alt="tokyo" data-src="C:\/Users\/pgw\/pic\.png" loading="lazy"/);
  const backslashed = renderInline('![b](C:\\Users\\pgw\\x.png)');
  assert.match(backslashed, /data-src="C:\\Users\\pgw\\x\.png"/);
  const posix = renderInline('![y](/tmp/x.png)');
  assert.match(posix, /<img alt="y" data-src="\/tmp\/x\.png"/);
});

test('renderInline strips the local: prefix for hydration', () => {
  const out = renderInline('![a](local:C:/x.png)');
  assert.match(out, /<img alt="a" data-src="C:\/x\.png"/);
});

test('renderInline keeps relative / remote image refs as literal text', () => {
  const out = renderInline('![a](images/pic.png)');
  assert.equal(out, '![a](images/pic.png)');
});

// ── hydration: data URL + data-preview-path for the delegated click ───────

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
const tick = async () => { await new Promise((r) => setTimeout(r, 0)); };

test('hydrateImages stamps data-preview-path and swaps in the data URL', async () => {
  const seen = [];
  win.nexusDesktop = {
    readImagePreview: async (p) => { seen.push(p); return 'data:image/png;base64,AAA'; },
  };
  const div = win.document.createElement('div');
  div.innerHTML = renderInline('![tokyo](C:/Users/pgw/pic.png)');
  win.document.body.appendChild(div);
  hydrateImages(div);
  await tick();
  const img = div.querySelector('img');
  assert.equal(img.dataset.previewPath, 'C:/Users/pgw/pic.png', 'preview path stamped');
  assert.equal(img.dataset.hydrated, '1');
  assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAA');
  assert.deepEqual(seen, ['C:/Users/pgw/pic.png']);
  win.document.body.innerHTML = '';
  delete win.nexusDesktop;
});

test('hydrateImages leaves the node out when the IPC read fails', async () => {
  win.nexusDesktop = {
    readImagePreview: async () => { throw new Error('outside allowed roots'); },
  };
  const div = win.document.createElement('div');
  div.innerHTML = renderInline('![gone](C:/nope/missing.png)');
  win.document.body.appendChild(div);
  hydrateImages(div);
  await tick();
  assert.equal(div.querySelector('img'), null, 'failed image removed');
  win.document.body.innerHTML = '';
  delete win.nexusDesktop;
});

test('hydrateImages without an IPC bridge removes unresolvable local images', async () => {
  delete win.nexusDesktop;
  const div = win.document.createElement('div');
  div.innerHTML = renderInline('![x](C:/nope.png)');
  win.document.body.appendChild(div);
  hydrateImages(div);
  await tick();
  assert.equal(div.querySelector('img'), null);
  win.document.body.innerHTML = '';
});
