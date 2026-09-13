const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/agent/sub-agent/executor.ts';
let s = fs.readFileSync(p, 'utf8');

// 1. executeParallel: add constitutionText param
s = s.replace(
  '  async executeParallel(\n    tasks: SubTask[],\n    baseSessionId: string\n  ): Promise<SubTaskResult[]> {',
  '  async executeParallel(\n    tasks: SubTask[],\n    baseSessionId: string,\n    constitutionText?: string\n  ): Promise<SubTaskResult[]> {'
);

// 2. Pass constitutionText through executeWithRetry
s = s.replace(
  '        this.executeWithRetry(task, baseSessionId)\n      );',
  '        this.executeWithRetry(task, baseSessionId, constitutionText)\n      );'
);

// 3. executeWithRetry: accept + pass constitutionText
s = s.replace(
  '  private async executeWithRetry(\n    task: SubTask, \n    baseSessionId: string,\n    maxRetries: number = 2\n  ): Promise<SubTaskResult> {',
  '  private async executeWithRetry(\n    task: SubTask, \n    baseSessionId: string,\n    maxRetries: number = 2,\n    constitutionText?: string\n  ): Promise<SubTaskResult> {'
);

s = s.replace(
  'return await this.executeSingle(task, baseSessionId);',
  'return await this.executeSingle(task, baseSessionId, constitutionText);'
);

// 4. executeSingle: accept constitutionText + pass to runSubAgent params
s = s.replace(
  '  private async executeSingle(\n    task: SubTask,\n    baseSessionId: string\n  ): Promise<SubTaskResult> {',
  '  private async executeSingle(\n    task: SubTask,\n    baseSessionId: string,\n    constitutionText?: string\n  ): Promise<SubTaskResult> {'
);

s = s.replace(
  "      const result = await worker.request('runSubAgent', {\n        taskId: task.id,\n        prompt: task.prompt,\n        tools: task.tools,\n        maxTurns: task.maxTurns ?? 10,\n        timeoutMs: task.timeoutMs ?? 60000,\n      });",
  "      const result = await worker.request('runSubAgent', {\n        taskId: task.id,\n        prompt: task.prompt,\n        tools: task.tools,\n        maxTurns: task.maxTurns ?? 10,\n        timeoutMs: task.timeoutMs ?? 60000,\n        ...(constitutionText != null ? { constitution: constitutionText } : {}),\n      });"
);

fs.writeFileSync(p, s);
console.log('executor.ts updated');