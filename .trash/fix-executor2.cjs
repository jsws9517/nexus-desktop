const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/agent/sub-agent/executor.ts';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  '        this.executeWithRetry(task, baseSessionId, constitutionText)\n      );',
  '        this.executeWithRetry(task, baseSessionId, undefined, constitutionText)\n      );'
);

fs.writeFileSync(p, s);
console.log('executor.ts fixed');