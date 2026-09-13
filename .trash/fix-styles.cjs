const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/static/styles.css';
let s = fs.readFileSync(p, 'utf8');

const next = s.indexOf('\n\n/* Warm low-blue theme');
if (next < 0) {
  console.log('anchor not found');
  process.exit(1);
}

const styles =
  '\n/* ---- Terminal page (P1 built-in) ---- */\n' +
  '.terminal-page { padding: 10px; }\n' +
  '.terminal-root { display: flex; flex-direction: column; gap: 8px; height: 100%; }\n' +
  '.terminal-header { display: flex; flex-direction: column; gap: 2px; }\n' +
  '.terminal-title { font-size: 13px; font-weight: 600; color: var(--text); }\n' +
  '.terminal-legend { font-size: 11px; color: var(--text-dim); }\n' +
  '.terminal-output { flex: 1; min-height: 120px; max-height: 320px; overflow-y: auto; background: var(--bg-2, #111); color: var(--text); font-family: var(--mono, monospace); font-size: 12px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-all; }\n' +
  '.terminal-input-row { display: flex; gap: 6px; }\n' +
  '.terminal-input { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-family: var(--mono, monospace); font-size: 12px; }\n' +
  '\n/* ---- Side Chat page (P1 built-in) ---- */\n' +
  '.sidechat-page { padding: 10px; }\n' +
  '.sidechat-root { display: flex; flex-direction: column; gap: 8px; height: 100%; }\n' +
  '.sidechat-header { display: flex; flex-direction: column; gap: 2px; }\n' +
  '.sidechat-title { font-size: 13px; font-weight: 600; color: var(--text); }\n' +
  '.sidechat-legend { font-size: 11px; color: var(--text-dim); }\n' +
  '.sidechat-history { flex: 1; min-height: 120px; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }\n' +
  '.sidechat-msg { font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); }\n' +
  '.sidechat-msg.user { background: var(--accent-dim, rgba(99,179,237,0.12)); }\n' +
  '.sidechat-msg.agent { background: var(--bg-2, #111); }\n' +
  '.sidechat-input-row { display: flex; gap: 6px; }\n' +
  '.sidechat-input { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }\n' +
  '.sidechat-send { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--accent, #3b82f6); color: #fff; font-size: 12px; cursor: pointer; }\n' +
  '\n/* ---- Git page (P1 built-in) ---- */\n' +
  '.git-page { padding: 10px; }\n' +
  '.git-root { display: flex; flex-direction: column; gap: 10px; }\n' +
  '.git-header { display: flex; flex-direction: column; gap: 2px; }\n' +
  '.git-title { font-size: 13px; font-weight: 600; color: var(--text); }\n' +
  '.git-legend { font-size: 11px; color: var(--text-dim); }\n' +
  '.git-dir { font-family: var(--mono, monospace); font-size: 12px; padding: 8px; background: var(--bg-2, #111); border-radius: 6px; border: 1px solid var(--border); word-break: break-all; }\n' +
  '.git-hint { font-size: 12px; color: var(--text-dim); line-height: 1.5; }\n' +
  '.git-tools { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
  '.git-chip { font-size: 11px; font-family: var(--mono, monospace); padding: 3px 8px; border-radius: 10px; border: 1px solid var(--border); color: var(--text-dim); background: var(--bg); }\n';

s = s.slice(0, next) + styles + s.slice(next);
fs.writeFileSync(p, s);
console.log('styles.css updated');