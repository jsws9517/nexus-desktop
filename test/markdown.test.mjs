import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, renderInline, renderBlocks } from '../dist/renderer/markdown.js';

test('esc escapes HTML metacharacters', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(esc('plain text'), 'plain text');
});

test('renderInline renders code, bold, links', () => {
  const out = renderInline('use `npm i` and **bold** and [link](https://a.com/x)');
  assert.match(out, /<code>npm i<\/code>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<a href="https:\/\/a\.com\/x" target="_blank">link<\/a>/);
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
