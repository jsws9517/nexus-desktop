const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/agent/service.ts';
let s = fs.readFileSync(p, 'utf8');

const broken =
  "              else if (constitution.reason === 'too-large') {\r\n" +
  "              this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
  "              else if (constitution.reason === 'unauthorized') {\r\n" +
  "                this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
  "              }\r\n" +
  "            }";

const fixed =
  "              else if (constitution.reason === 'too-large') {\r\n" +
  "                this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
  "              } else if (constitution.reason === 'unauthorized') {\r\n" +
  "                this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
  "              }\r\n" +
  "            }";

const n = s.indexOf(broken);
console.log('idx', n);
if (n < 0) {
  console.log('pattern not found');
  process.exit(1);
}
s = s.slice(0, n) + fixed + s.slice(n + broken.length);
fs.writeFileSync(p, s);
console.log('fixed OK');