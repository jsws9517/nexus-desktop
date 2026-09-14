import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'src';
const needles = [
  'contextBridge', 'readRecentLogs', 'onLog', 'readRecentLogs',
  'getMessages', 'chat:', 'getMessages:', 'chat(', 'exec(', 'execCommand',
  'runSubAgent', 'getSessionMetadata', 'getParallelSessions', 'parallel_start',
  'onTabEvents', 'getParallelSessions(', 'onLog(', 'onLog:',
];

const hits = {};
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|cts)$/.test(e.name)) {
      const c = fs.readFileSync(p, 'utf8');
      for (const k of needles) {
        if (c.includes(k)) (hits[k] ??= []).push([p, c.split(k).length - 1]);
      }
    }
  }
}
walk(rootESE);
for (const k of Object.keys(hits).sort()) {
  console.log('## ' + k);
  for (const [p, n] of hits[k]) console.log('  ' + p + '  [' + n + ']');
}
