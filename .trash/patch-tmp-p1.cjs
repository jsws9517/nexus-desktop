// Byte-safe CSS insert: does NOT rewrite line endings (the file has a MIXED
// CRLF/LF history — this patch preserves whatever exists and only inserts the
// new block, using the same newline flavor found right after the anchor).
const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/static/styles.css';
const buf = fs.readFileSync(p); // keep raw bytes

const anchorText = '.sidebar-toggle:hover {';
const idx = buf.indexOf(Buffer.from(anchorText, 'latin1'));
console.log('anchor idx:', idx);
if (idx === -1) { console.log('ANCHOR NOT FOUND — abort'); process.exit(1); }

// Determine newline flavor immediately following the anchor block's closing
// brace: scan forward from the anchor to the next blank line boundary.
const after = buf.slice(idx);
// Find the end of the .sidebar-toggle:hover { ... } rule (the next '}').
const braceEnd = after.indexOf(Buffer.from('}', 'latin1'), after.indexOf(Buffer.from('{', 'latin1')));
const tail = after.slice(braceEnd, braceEnd + 16).toString('latin1');
const nl = tail.startsWith('\r\n') ? '\r\n' : '\n';
console.log('newline flavor after rule:', JSON.stringify(nl));

const insert = nl
  + nl
  + '/* ---- P1 sidebar extension tabs & page (DSH Better SideBar port) ---- */' + nl
  + '#sidebar.collapsed .sidebar-tabs,' + nl
  + '#sidebar.collapsed .sidebar-page { display: none; }' + nl
  + '.sidebar-tabs {' + nl
  + '  display: flex;' + nl
  + '  gap: 4px;' + nl
  + '  padding: 6px 8px 0;' + nl
  + '  border-bottom: 1px solid var(--border);' + nl
  + '  flex-shrink: 0;' + nl
  + '  flex-wrap: wrap;' + nl
  + '}' + nl
  + '.sidebar-tabs.hidden { display: none; }' + nl
  + '.sidebar-tab {' + nl
  + '  background: transparent;' + nl
  + '  border: 1px solid transparent;' + nl
  + '  border-radius: 6px;' + nl
  + '  color: var(--text-dim);' + nl
  + '  font-size: 11px;' + nl
  + '  padding: 4px 8px;' + nl
  + '  cursor: pointer;' + nl
  + '  transition: background 0.15s, color 0.15s;' + nl
  + '}' + nl
  + '.sidebar-tab:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }' + nl
  + '.sidebar-tab.active {' + nl
  + '  background: var(--accent-dim);' + nl
  + '  border-color: color-mix(in srgb, var(--accent) 45%, transparent);' + nl
  + '  color: var(--accent);' + nl
  + '}' + nl
  + '.sidebar-page {' + nl
  + '  flex: 1;' + nl
  + '  min-height: 0;' + nl
  + '  overflow-y: auto;' + nl
  + '  border-bottom: 1px solid var(--border);' + nl
  + '}' + nl
  + '.sidebar-page[hidden] { display: none; }' + nl
  + nl
  + '/* ---- Sub-Agents page (flagship P1 use case) ---- */' + nl
  + '.sub-agents-page { padding: 10px; }' + nl
  + '.sub-agents-root { display: flex; flex-direction: column; gap: 10px; }' + nl
  + '.sub-agents-header { display: flex; flex-direction: column; gap: 2px; }' + nl
  + '.sub-agents-title { font-size: 13px; font-weight: 600; color: var(--text); }' + nl
  + '.sub-agents-legend { font-size: 11px; color: var(--text-dim); }' + nl
  + '.sub-agents-list { display: flex; flex-direction: column; gap: 10px; }' + nl
  + '.sub-agents-empty {' + nl
  + '  font-size: 12px;' + nl
  + '  color: var(--text-dim);' + nl
  + '  padding: 12px;' + nl
  + '  border: 1px dashed var(--border);' + nl
  + '  border-radius: 8px;' + nl
  + '  text-align: center;' + nl
  + '}' + nl
  + '.sub-agents-session { display: flex; flex-direction: column; gap: 6px; }' + nl
  + '.sub-agents-session-head {' + nl
  + '  font-size: 12px;' + nl
  + '  font-weight: 600;' + nl
  + '  color: var(--text-dim);' + nl
  + '  padding: 6px 8px;' + nl
  + '  background: color-mix(in srgb, var(--accent) 8%, transparent);' + nl
  + '  border-radius: 6px;' + nl
  + '  overflow: hidden;' + nl
  + '  text-overflow: ellipsis;' + nl
  + '  white-space: nowrap;' + nl
  + '}' + nl
  + '.sub-agents-session .parallel-task-card {' + nl
  + '  border-width: 1px;' + nl
  + '  border-radius: 8px;' + nl
  + '  margin-bottom: 0;' + nl
  + '}';

// Insert right after the anchor rule's closing brace.
const insertAt = braceEnd + 1;
const out = Buffer.concat([buf.slice(0, insertAt), Buffer.from(insert, 'latin1'), buf.slice(insertAt)]);
fs.writeFileSync(p, out);
console.log('CSS patched OK (byte-safe, line endings preserved)');