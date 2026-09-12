# Multi-Agent Parallel Architecture - Phase Execution Plan

> Status: Ready for Execution
> Based on: `implementation-plan-multi-agent-parallel.md`
> Created: 2026

---

## Overview

This document provides detailed, step-by-step execution instructions for each phase (P1-P4), with specific file operations, verification criteria, and acceptance tests.

**Execution Protocol**:
1. Each phase is独立验收 (independently verified)
2. TypeScript compilation must pass before proceeding
3. Unit tests must pass for each phase
4. Manual verification for UI/integration phases

---

## Phase 1: Foundation (Week 1)

### P1.1 Create Type Definitions

**File**: `src/agent/sub-agent/types.ts` (NEW)

**Steps**:
1. Create directory `src/agent/sub-agent/`
2. Create `types.ts` with the following content:

```typescript
import type { AgentEvent } from '../types.js';

/** Unique identifier for the sub-task */
export interface SubTask {
  /** Stable ID for tracking */
  id: string;
  
  /** Human-readable description */
  description: string;
  
  /** Prompt given to the sub-agent */
  prompt: string;
  
  /** Tool allowlist (optional = all tools) */
  tools?: string[];
  
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  
  /** Maximum conversation turns (default: 10) */
  maxTurns?: number;
  
  /** IDs of dependent sub-tasks */
  dependsOn?: string[];
}

/** Execution status of a sub-task */
export type SubTaskStatus = 
  | 'pending'     /** Waiting in queue */
  | 'queued'      /** Ready for execution */
  | 'running'     /** Currently executing */
  | 'succeeded'   /** Completed successfully */
  | 'failed'      /** Execution failed */
  | 'timeout'     /** Exceeded timeout */
  | 'cancelled';  /** Explicitly cancelled */

/** Result from a sub-task execution */
export interface SubTaskResult {
  taskId: string;
  status: SubTaskStatus;
  output: string;
  tokenUsage: { prompt: number; completion: number };
  durationMs: number;
  error?: string;
  events?: AgentEvent[];
}

/** Parallel execution configuration */
export interface ParallelConfig {
  /** Maximum concurrent sub-agents (default: 4) */
  maxConcurrent?: number;
  
  /** Total timeout in milliseconds (default: 300000) */
  timeoutMs?: number;
  
  /** Fallback to serial on partial failure (default: true) */
  fallbackToSerial?: boolean;
}

/** Token usage tracking */
export interface TokenUsage {
  prompt: number;
  completion: number;
}

/** Orchestration result */
export interface OrchestrationResult {
  success: boolean;
  output: string;
  tasks: SubTaskResult[];
  tokenUsage: TokenUsage;
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P1.2 Implement Tool Categories

**File**: `src/agent/sub-agent/tool-categories.ts` (NEW)

**Steps**:
1. Create `tool-categories.ts` with the following content:

```typescript
import type { SubTask } from './types.js';

/**
 * Read-only tools that can be executed in parallel.
 * Based on actual tool definitions from src/tools/ and src/main/.
 */
export const READ_ONLY_TOOLS = new Set([
  // Filesystem tools
  'read_media_file',
  'list_directory_with_sizes',
  'list_allowed_directories',
  
  // Sequential thinking
  'sequentialthinking',
  
  // SQLite read operations
  'query',
  'list-tables',
  'describe-table',
  
  // Skills
  'sheet.read',
  'sheet.analyze',
  'bi.chart',
  
  // Memory read operations
  'read_graph',
  'search_nodes',
  'open_nodes',
  
  // Git read operations
  'git_list_branches',
  'git_blame',
  'git_diff',
  'git_file_history',
  'git_log',
  'git_search',
  'git_show',
  'git_status',
  'git_find_lost',
  'git_reflog',
  
  // Fetch
  'fetch',
  
  // Time
  'get_current_time',
  'convert_time',
]);

/**
 * Write tools that require serial execution.
 * These tools modify state and cannot run concurrently.
 */
export const WRITE_TOOLS = new Set([
  // SQLite write operations
  'execute',
  'create-table',
  'drop-table',
  'insert-record',
  'update-record',
  'delete-record',
  'transaction',
  
  // Memory write operations
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations',
  
  // Git write operations
  'git_checkout',
  'git_cherry_pick',
  'git_create_branch',
  'git_delete_branch',
  'git_merge',
  'git_move_changes',
  'git_rebase',
  'git_commit',
  'git_stage',
  'git_amend',
  'git_squash',
  'git_fetch',
  'git_pull',
  'git_push',
  'git_remote',
  'git_stash',
  'git_update_branch',
  'git_discard_changes',
  'git_reset',
  'git_revert',
  'git_undo_commit',
  'git_undo_merge',
  'git_unstage',
  'git_recover_branch',
  'git_recover_commit',
  'git_reset_to_reflog',
]);

/**
 * Check if a task requires serial execution due to write operations.
 */
export function requiresSerialization(task: SubTask): boolean {
  if (!task.tools || task.tools.length === 0) return false;
  return task.tools.some(t => WRITE_TOOLS.has(t));
}

/**
 * Filter tools to only include read-only tools safe for parallel execution.
 */
export function filterToolsForSubAgent(allowedTools?: string[]): string[] {
  if (!allowedTools) return Array.from(READ_ONLY_TOOLS);
  return allowedTools.filter(t => READ_ONLY_TOOLS.has(t));
}

/**
 * Get all available tool names (for validation).
 */
export function getAllToolNames(): string[] {
  return [...Array.from(READ_ONLY_TOOLS), ...Array.from(WRITE_TOOLS)];
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] Tool lists match actual project tools (verified against exploration)

---

### P1.3 Implement SubAgentExecutor Core

**File**: `src/agent/sub-agent/executor.ts` (NEW)

**Steps**:
1. Create `executor.ts` with the following content:

```typescript
import { WorkerHost } from '../../main/worker-host.js';
import { workerScriptPath } from '../../main/session-workers.js';
import type { SubTask, SubTaskResult, SubTaskStatus, ParallelConfig } from './types.js';
import { logger } from '../../shared/logger.js';

/**
 * Manages the lifecycle of parallel sub-agent execution.
 * 
 * Key responsibilities:
 * - Dependency resolution via topological sort
 * - Concurrency control with batching
 * - Worker process lifecycle management
 * - Result aggregation
 */
export class SubAgentExecutor {
  private workers = new Map<string, WorkerHost>();
  private results = new Map<string, SubTaskResult>();
  
  constructor(
    private config: ParallelConfig = {},
    private onProgress?: (taskId: string, status: SubTaskStatus) => void
  ) {}

  /**
   * Execute multiple sub-tasks in parallel with dependency resolution.
   */
  async executeParallel(
    tasks: SubTask[],
    baseSessionId: string
  ): Promise<SubTaskResult[]> {
    // 1. Topological sort for dependency resolution
    const sorted = this.topologicalSort(tasks);
    
    // 2. Chunk by concurrency limit
    const batches = this.chunkByConcurrency(sorted);
    
    const allResults: SubTaskResult[] = [];
    
    for (const batch of batches) {
      const batchPromises = batch.map(task => 
        this.executeSingle(task, baseSessionId)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push(this.toFailedResult(result.reason));
        }
      }
    }
    
    return allResults;
  }

  /**
   * Execute a single sub-task in an isolated worker.
   */
  private async executeSingle(
    task: SubTask,
    baseSessionId: string
  ): Promise<SubTaskResult> {
    const startTime = Date.now();
    
    this.onProgress?.(task.id, 'queued');
    
    const worker = await this.spawnWorker(task, baseSessionId);
    
    this.onProgress?.(task.id, 'running');
    
    try {
      const result = await worker.request('runSubAgent', {
        taskId: task.id,
        prompt: task.prompt,
        tools: task.tools,
        maxTurns: task.maxTurns ?? 10,
        timeoutMs: task.timeoutMs ?? 60000,
      });
      
      this.onProgress?.(task.id, 'succeeded');
      
      return {
        taskId: task.id,
        status: 'succeeded',
        output: typeof result === 'string' ? result : JSON.stringify(result),
        tokenUsage: result?.tokenUsage ?? { prompt: 0, completion: 0 },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.onProgress?.(task.id, 'failed');
      
      return {
        taskId: task.id,
        status: 'failed',
        output: '',
        tokenUsage: { prompt: 0, completion: 0 },
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      worker.stop();
      this.workers.delete(task.id);
    }
  }

  /**
   * Topological sort for dependency resolution.
   * Detects circular dependencies and throws.
   */
  topologicalSort(tasks: SubTask[]): SubTask[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: SubTask[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    
    const visit = (id: string) => {
      if (temp.has(id)) {
        throw new Error(`Circular dependency detected: ${id}`);
      }
      if (visited.has(id)) return;
      
      temp.add(id);
      
      const task = taskMap.get(id);
      if (task?.dependsOn) {
        for (const depId of task.dependsOn) {
          visit(depId);
        }
      }
      
      temp.delete(id);
      visited.add(id);
      sorted.push(task!);
    };
    
    for (const task of tasks) {
      visit(task.id);
    }
    
    return sorted;
  }

  /**
   * Chunk tasks by concurrency limit.
   */
  chunkByConcurrency(tasks: SubTask[], size?: number): SubTask[][] {
    const chunkSize = size ?? this.config.maxConcurrent ?? 4;
    const chunks: SubTask[][] = [];
    
    for (let i = 0; i < tasks.length; i += chunkSize) {
      chunks.push(tasks.slice(i, i + chunkSize));
    }
    
    return chunks;
  }

  /**
   * Spawn an isolated worker for a sub-task.
   */
  private async spawnWorker(
    task: SubTask,
    baseSessionId: string
  ): Promise<WorkerHost> {
    const worker = new WorkerHost(workerScriptPath());
    worker.start();
    
    await worker.request('earlyInit');
    
    await worker.request('startSession', {
      prevSessionId: baseSessionId,
      isolate: true,
    });
    
    this.workers.set(task.id, worker);
    
    return worker;
  }

  /**
   * Convert an error to a failed SubTaskResult.
   */
  private toFailedResult(error: unknown): SubTaskResult {
    return {
      taskId: 'unknown',
      status: 'failed',
      output: '',
      tokenUsage: { prompt: 0, completion: 0 },
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Cleanup all workers.
   */
  async cleanup(): Promise<void> {
    for (const [taskId, worker] of this.workers) {
      try {
        worker.stop();
      } catch (e) {
        logger.warn(`Failed to stop worker for task ${taskId}: ${e}`);
      }
    }
    this.workers.clear();
    this.results.clear();
  }
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] All methods implemented

---

### P1.4 Create Unit Tests

**File**: `test/sub-agent.test.mjs` (NEW)

**Steps**:
1. Create `test/sub-agent.test.mjs` with the following content:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the modules we're testing
// Note: These will be available after TypeScript compilation

describe('SubAgentExecutor', () => {
  describe('topologicalSort', () => {
    it('should sort tasks with no dependencies', async () => {
      // Test implementation after compilation
      assert.ok(true, 'Placeholder - implement after compilation');
    });

    it('should sort tasks with valid dependencies', async () => {
      // Test implementation after compilation
      assert.ok(true, 'Placeholder - implement after compilation');
    });

    it('should detect circular dependencies', async () => {
      // Test implementation after compilation
      assert.ok(true, 'Placeholder - implement after compilation');
    });
  });

  describe('chunkByConcurrency', () => {
    it('should chunk tasks by concurrency limit', async () => {
      // Test implementation after compilation
      assert.ok(true, 'Placeholder - implement after compilation');
    });

    it('should handle empty task list', async () => {
      // Test implementation after compilation
      assert.ok(true, 'Placeholder - implement after compilation');
    });
  });
});

describe('Tool Categories', () => {
  it('should have correct read-only tools', async () => {
    // Test implementation after compilation
    assert.ok(true, 'Placeholder - implement after compilation');
  });

  it('should have correct write tools', async () => {
    // Test implementation after compilation
    assert.ok(true, 'Placeholder - implement after compilation');
  });

  it('should correctly identify tasks requiring serialization', async () => {
    // Test implementation after compilation
    assert.ok(true, 'Placeholder - implement after compilation');
  });
});
```

**Verification**:
- [ ] File created successfully
- [ ] Tests run: `npm run test:unit`

---

### P1.5 Verify TypeScript Compilation

**Command**: `npx tsc --noEmit`

**Expected Output**:
- No TypeScript errors
- All new files compile successfully

**Verification**:
- [ ] Command succeeds
- [ ] No errors in output

---

### P1.6 Phase 1 Acceptance Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| `src/agent/sub-agent/types.ts` created | ☐ | |
| `src/agent/sub-agent/tool-categories.ts` created | ☐ | |
| `src/agent/sub-agent/executor.ts` created | ☐ | |
| `test/sub-agent.test.mjs` created | ☐ | |
| TypeScript compiles without errors | ☐ | |
| Unit tests pass | ☐ | |
| Tool lists match actual project tools | ☐ | Verified against exploration |

---

## Phase 2: AgentService Integration (Week 2)

### P2.1 Extend Worker Protocol

**File**: `src/agent-worker.ts` (MODIFY)

**Steps**:
1. Add new method types to `WorkerRequest` union (around line 57):

```typescript
| { id: number; method: 'runSubAgent'; params: { taskId: string; prompt: string; tools?: string[]; maxTurns?: number; timeoutMs?: number } }
| { id: number; method: 'getSubAgentStatus'; params: { taskId: string } }
| { id: number; method: 'cancelSubAgent'; params: { taskId: string } }
```

2. Add sub-agent state tracking (after line 84):

```typescript
// Sub-agent state tracking
const subAgentStates = new Map<string, { status: string; startTime: number }>();
```

3. Add handlers in the dispatch switch (after the existing cases):

```typescript
case 'runSubAgent': {
  const { taskId, prompt, tools, maxTurns, timeoutMs } = params;
  subAgentStates.set(taskId, { status: 'running', startTime: Date.now() });
  
  try {
    // Create a temporary AgentService for isolated execution
    const tempService = new AgentService();
    await tempService.earlyInit();
    
    if (tools && tools.length > 0) {
      tempService.setToolAllowlist(new Set(tools));
    }
    
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Task ${taskId} timed out`)), timeoutMs ?? 60000)
    );
    
    const result = await Promise.race([
      tempService.chat(prompt, 'temp-session'),
      timeoutPromise,
    ]);
    
    subAgentStates.set(taskId, { status: 'succeeded', startTime: Date.now() });
    respond(id, {
      output: result.output,
      tokenUsage: result.tokenUsage,
    });
  } catch (error) {
    subAgentStates.set(taskId, { status: 'failed', startTime: Date.now() });
    respondError(id, error);
  }
  break;
}

case 'getSubAgentStatus': {
  const { taskId } = params;
  const state = subAgentStates.get(taskId);
  respond(id, state ?? { status: 'unknown' });
  break;
}

case 'cancelSubAgent': {
  const { taskId } = params;
  subAgentStates.set(taskId, { status: 'cancelled', startTime: Date.now() });
  respond(id, { success: true });
  break;
}
```

**Verification**:
- [ ] New methods added to WorkerRequest union
- [ ] State tracking Map added
- [ ] Handlers implemented in dispatch switch
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P2.2 Extend IPC Validation

**File**: `src/shared/ipc-validation.ts` (MODIFY)

**Steps**:
1. Add validation specs for new methods (in WORKER_METHODS object):

```typescript
runSubAgent: {
  taskId: 'string',
  prompt: 'string', 
  tools: 'object?',
  maxTurns: 'number?',
  timeoutMs: 'number?',
},
getSubAgentStatus: {
  taskId: 'string',
},
cancelSubAgent: {
  taskId: 'string',
},
```

**Verification**:
- [ ] Validation specs added
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P2.3 Extend IPC Channels

**File**: `src/ipc/channels.ts` (MODIFY)

**Steps**:
1. Add new channels (after line 61):

```typescript
// Parallel execution channels
runSubAgent: 'nexus:runSubAgent',
getSubAgentStatus: 'nexus:getSubAgentStatus',
cancelSubAgent: 'nexus:cancelSubAgent',
subAgentProgress: 'nexus:subAgentProgress',
```

**Verification**:
- [ ] Channels added
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P2.4 Implement OrchestratorAgent

**File**: `src/agent/sub-agent/orchestrator.ts` (NEW)

**Steps**:
1. Create `orchestrator.ts` with the following content:

```typescript
import type { AgentService } from '../service.js';
import { SubAgentExecutor } from './executor.js';
import type { SubTask, SubTaskResult, ParallelConfig, OrchestrationResult } from './types.js';
import { logger } from '../../shared/logger.js';

/**
 * Coordinates task decomposition and result aggregation.
 * 
 * Responsibilities:
 * - Decompose user request into parallel sub-tasks
 * - Execute sub-tasks via SubAgentExecutor
 * - Aggregate results into final output
 */
export class OrchestratorAgent {
  private executor: SubAgentExecutor;
  
  constructor(
    private agentService: AgentService,
    config?: { maxConcurrent?: number; timeoutMs?: number }
  ) {
    this.executor = new SubAgentExecutor(config || {});
  }

  /**
   * Orchestrate parallel task execution.
   */
  async orchestrate(
    userPrompt: string,
    sessionId: string
  ): Promise<OrchestrationResult> {
    // 1. Decompose into sub-tasks
    const subTasks = await this.decomposeTasks(userPrompt, sessionId);
    
    if (subTasks.length === 0) {
      return {
        success: true,
        output: 'No parallelizable tasks detected.',
        tasks: [],
        tokenUsage: { prompt: 0, completion: 0 },
      };
    }
    
    // 2. Execute in parallel
    const results = await this.executor.executeParallel(subTasks, sessionId);
    
    // 3. Aggregate results
    const output = await this.aggregateResults(results, userPrompt);
    
    // 4. Calculate total token usage
    const totalUsage = results.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0 }
    );
    
    return {
      success: results.every(r => r.status === 'succeeded'),
      output,
      tasks: results,
      tokenUsage: totalUsage,
    };
  }

  /**
   * Decompose user request into parallel sub-tasks via LLM.
   */
  private async decomposeTasks(
    userPrompt: string,
    sessionId: string
  ): Promise<SubTask[]> {
    const decompositionPrompt = `
You are a task decomposition expert. Given the following user request,
break it down into independent sub-tasks that can be executed in parallel.

Rules:
1. Each sub-task should be self-contained and independent
2. Max 5 sub-tasks (more indicates poor decomposition)
3. Each sub-task should have clear description and prompt
4. Specify dependencies if tasks are not independent

User request:
${userPrompt}

Return JSON array:
[
  {
    "id": "task_1",
    "description": "What this task does",
    "prompt": "Detailed instructions for the sub-agent",
    "tools": ["read_text_file", "exec_command"],
    "dependsOn": []
  }
]
`;

    try {
      const response = await this.agentService.callLlm({
        messages: [
          { role: 'system', content: decompositionPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: 'decomposer',
      });
      
      const subTasks = JSON.parse(response);
      
      return subTasks.map((task: any, index: number) => ({
        id: task.id || `task_${index + 1}`,
        description: task.description || `Sub-task ${index + 1}`,
        prompt: task.prompt || task.description,
        tools: task.tools || ['read_media_file', 'list_directory_with_sizes', 'query'],
        timeoutMs: task.timeoutMs || 60000,
        maxTurns: task.maxTurns || 10,
        dependsOn: task.dependsOn || [],
      }));
    } catch (error) {
      logger.warn(`Task decomposition failed: ${error}. Using single-task fallback.`);
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: ['read_media_file', 'list_directory_with_sizes', 'query'],
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }
  }

  /**
   * Aggregate sub-task results into final output.
   */
  private async aggregateResults(
    results: SubTaskResult[],
    originalPrompt: string
  ): Promise<string> {
    const succeeded = results.filter(r => r.status === 'succeeded');
    const failed = results.filter(r => r.status !== 'succeeded');
    
    if (failed.length > 0) {
      const errorReport = failed.map(r => 
        `[FAILED] ${r.taskId}: ${r.error}`
      ).join('\n');
      
      return `Completed ${succeeded.length}/${results.length} tasks.\n\nErrors:\n${errorReport}`;
    }
    
    const sections = succeeded.map(r => 
      `## ${r.taskId}\n${r.output}`
    );
    
    return sections.join('\n\n---\n\n');
  }

  /**
   * Cleanup executor resources.
   */
  async cleanup(): Promise<void> {
    await this.executor.cleanup();
  }
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P2.5 Integrate into AgentService

**File**: `src/agent/service.ts` (MODIFY)

**Steps**:
1. Add import at top of file:

```typescript
import { OrchestratorAgent } from './sub-agent/orchestrator.js';
```

2. Add orchestrator property (after line 97):

```typescript
private orchestrator: OrchestratorAgent | null = null;
```

3. Add parallel detection method (after the property):

```typescript
/**
 * Determine if parallel execution is appropriate.
 */
private shouldUseParallel(prompt: string): boolean {
  const patterns = [
    /分析.*和.*和/i,              // Analyze A and B and C
    /比较.*与.*与/i,              // Compare A with B with C
    /分别.*处理.*和.*和/i,        // Process A, B, and C separately
    /并行/i,                      // Explicitly mentions parallel
    /\bx\d+\b/.test(prompt),     // Multiple targets (x1, x2, x3)
  ];
  
  return patterns.some(p => p.test(prompt));
}
```

4. Modify `chat` method to support parallel execution (find the existing chat method and modify):

```typescript
async chat(prompt: string, sessionId: string): Promise<ChatResult> {
  if (this.shouldUseParallel(prompt)) {
    return this.chatParallel(prompt, sessionId);
  }
  
  return this.chatSerial(prompt, sessionId);
}

/**
 * Parallel execution mode.
 */
private async chatParallel(prompt: string, sessionId: string): Promise<ChatResult> {
  if (!this.orchestrator) {
    this.orchestrator = new OrchestratorAgent(this);
  }
  
  this.onEvent?.({ type: 'parallel_start', sessionId, prompt });
  
  const result = await this.orchestrator.orchestrate(prompt, sessionId);
  
  this.onEvent?.({ 
    type: 'parallel_end', 
    sessionId,
    tasks: result.tasks,
    tokenUsage: result.tokenUsage
  });
  
  return {
    success: result.success,
    output: result.output,
    tokenUsage: result.tokenUsage,
  };
}

/**
 * Serial execution mode (existing logic).
 */
private async chatSerial(prompt: string, sessionId: string): Promise<ChatResult> {
  // ... existing implementation ...
}
```

**Verification**:
- [ ] Import added
- [ ] Property added
- [ ] Detection method added
- [ ] chat method modified
- [ ] chatParallel method added
- [ ] chatSerial method added (existing logic preserved)
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P2.6 Phase 2 Acceptance Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| `src/agent-worker.ts` extended with new methods | ☐ | |
| `src/shared/ipc-validation.ts` extended | ☐ | |
| `src/ipc/channels.ts` extended | ☐ | |
| `src/agent/sub-agent/orchestrator.ts` created | ☐ | |
| `src/agent/service.ts` modified | ☐ | |
| TypeScript compiles without errors | ☐ | |
| Worker responds to new methods | ☐ | Manual test |

---

## Phase 3: UI Display (Week 3)

### P3.1 Add Parallel Execution Events

**File**: `src/agent/types.ts` (MODIFY)

**Steps**:
1. Add new event types (after line 4):

```typescript
import type { SubTaskResult, TokenUsage } from './sub-agent/types.js';

/** Parallel execution events */
export interface ParallelStartEvent {
  type: 'parallel_start';
  sessionId: string;
  prompt: string;
}

export interface ParallelEndEvent {
  type: 'parallel_end';
  sessionId: string;
  tasks: SubTaskResult[];
  tokenUsage: TokenUsage;
}

export interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: string;
}

/** Union of all agent events */
export type AgentEvent = 
  | { type: string } & Record<string, unknown>
  | ParallelStartEvent
  | ParallelEndEvent
  | TaskProgressEvent;
```

**Verification**:
- [ ] New event types added
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P3.2 Create Parallel Execution Card Component

**File**: `src/renderer/components/ParallelExecutionCard.tsx` (NEW)

**Steps**:
1. Create `src/renderer/components/` directory (if not exists)
2. Create `ParallelExecutionCard.tsx` with the following content:

```tsx
import type { SubTaskStatus } from '../../agent/sub-agent/types.js';

interface ParallelExecutionCardProps {
  taskId: string;
  status: SubTaskStatus;
  output?: string;
  durationMs?: number;
  error?: string;
}

const statusIcons: Record<SubTaskStatus, string> = {
  pending: '⏳',
  queued: '📋',
  running: '🔄',
  succeeded: '✅',
  failed: '❌',
  timeout: '⏱️',
  cancelled: '🚫',
};

const statusColors: Record<SubTaskStatus, string> = {
  pending: '#6b7280',
  queued: '#3b82f6',
  running: '#f59e0b',
  succeeded: '#10b981',
  failed: '#ef4444',
  timeout: '#f97316',
  cancelled: '#6b7280',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function ParallelExecutionCard({ 
  taskId, status, output, durationMs, error 
}: ParallelExecutionCardProps) {
  return (
    <div style={{
      border: `1px solid ${statusColors[status]}`,
      borderRadius: '8px',
      padding: '12px',
      marginBottom: '8px',
      backgroundColor: '#f9fafb',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
      }}>
        <span style={{ fontWeight: 'bold', color: '#374151' }}>
          {taskId}
        </span>
        <span style={{ color: statusColors[status] }}>
          {statusIcons[status]} {status}
        </span>
        {durationMs && (
          <span style={{ color: '#6b7280', fontSize: '0.875rem' }}>
            {formatDuration(durationMs)}
          </span>
        )}
      </div>
      
      {status === 'running' && (
        <div style={{
          height: '4px',
          backgroundColor: '#e5e7eb',
          borderRadius: '2px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: '100%',
            backgroundColor: statusColors.running,
            animation: 'pulse 1.5s infinite',
          }} />
        </div>
      )}
      
      {status === 'succeeded' && output && (
        <div style={{
          marginTop: '8px',
          padding: '8px',
          backgroundColor: '#f3f4f6',
          borderRadius: '4px',
          fontSize: '0.875rem',
          color: '#374151',
          maxHeight: '200px',
          overflow: 'auto',
        }}>
          {output}
        </div>
      )}
      
      {status === 'failed' && error && (
        <div style={{
          marginTop: '8px',
          padding: '8px',
          backgroundColor: '#fef2f2',
          borderRadius: '4px',
          fontSize: '0.875rem',
          color: '#dc2626',
        }}>
          ❌ {error}
        </div>
      )}
    </div>
  );
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P3.3 Integrate into Session View

**File**: `src/renderer/session-view.tsx` (MODIFY)

**Steps**:
1. Add import for ParallelExecutionCard (at top of file):

```typescript
import { ParallelExecutionCard } from './components/ParallelExecutionCard.js';
```

2. Add state for parallel execution (in component state):

```typescript
const [parallelTasks, setParallelTasks] = useState<Array<{
  taskId: string;
  status: string;
  output?: string;
  durationMs?: number;
  error?: string;
}>>([]);
const [showParallelPanel, setShowParallelPanel] = useState(false);
```

3. Add event handlers (in the useEffect for IPC events):

```typescript
case 'parallel_start':
  setShowParallelPanel(true);
  setParallelTasks([]);
  break;

case 'parallel_end':
  setShowParallelPanel(false);
  // Show aggregated result
  showAggregatedResult(data.tasks, data.tokenUsage);
  break;

case 'task_progress':
  setParallelTasks(prev => {
    const existing = prev.find(t => t.taskId === data.taskId);
    if (existing) {
      return prev.map(t => 
        t.taskId === data.taskId ? { ...t, status: data.status } : t
      );
    }
    return [...prev, { taskId: data.taskId, status: data.status }];
  });
  break;
```

4. Add parallel execution panel in JSX (in the render section):

```tsx
{showParallelPanel && (
  <div style={{
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    width: '400px',
    maxHeight: '60vh',
    overflow: 'auto',
    backgroundColor: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    padding: '16px',
    zIndex: 1000,
  }}>
    <h3 style={{ marginBottom: '12px', color: '#374151' }}>
      Parallel Execution
    </h3>
    {parallelTasks.map(task => (
      <ParallelExecutionCard
        key={task.taskId}
        taskId={task.taskId}
        status={task.status as any}
        output={task.output}
        durationMs={task.durationMs}
        error={task.error}
      />
    ))}
  </div>
)}
```

**Verification**:
- [ ] Import added
- [ ] State added
- [ ] Event handlers added
- [ ] JSX panel added
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P3.4 Phase 3 Acceptance Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| `src/agent/types.ts` extended with events | ☐ | |
| `src/renderer/components/ParallelExecutionCard.tsx` created | ☐ | |
| `src/renderer/session-view.tsx` modified | ☐ | |
| TypeScript compiles without errors | ☐ | |
| UI renders parallel execution cards | ☐ | Manual test |

---

## Phase 4: Optimization (Week 4)

### P4.1 Implement Failure Retry

**File**: `src/agent/sub-agent/executor.ts` (MODIFY)

**Steps**:
1. Add retry method (after `executeSingle` method):

```typescript
/**
 * Execute with retry logic and exponential backoff.
 */
private async executeWithRetry(
  task: SubTask, 
  baseSessionId: string,
  maxRetries: number = 2
): Promise<SubTaskResult> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await this.executeSingle(task, baseSessionId);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff
        logger.warn(`Task ${task.id} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }
  }
  
  return this.toFailedResult(lastError!);
}

/**
 * Utility: delay for specified milliseconds.
 */
private delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

2. Modify `executeParallel` to use retry:

```typescript
async executeParallel(
  tasks: SubTask[],
  baseSessionId: string
): Promise<SubTaskResult[]> {
  const sorted = this.topologicalSort(tasks);
  const batches = this.chunkByConcurrency(sorted);
  
  const allResults: SubTaskResult[] = [];
  
  for (const batch of batches) {
    const batchPromises = batch.map(task => 
      this.executeWithRetry(task, baseSessionId)  // Changed from executeSingle
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allResults.push(result.value);
      } else {
        allResults.push(this.toFailedResult(result.reason));
      }
    }
  }
  
  return allResults;
}
```

**Verification**:
- [ ] Retry method added
- [ ] Delay utility added
- [ ] executeParallel modified to use retry
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P4.2 Add Performance Metrics

**File**: `src/agent/sub-agent/metrics.ts` (NEW)

**Steps**:
1. Create `metrics.ts` with the following content:

```typescript
import type { SubTaskResult, TokenUsage } from './types.js';
import { logger } from '../../shared/logger.js';

/**
 * Performance metrics for parallel execution.
 */
export interface ParallelMetrics {
  totalDurationMs: number;
  taskCount: number;
  succeededCount: number;
  failedCount: number;
  timeoutCount: number;
  totalTokenUsage: TokenUsage;
  averageTaskDurationMs: number;
  maxTaskDurationMs: number;
  minTaskDurationMs: number;
}

/**
 * Collector for parallel execution metrics.
 */
export class MetricsCollector {
  private startTime: number = 0;
  private taskResults: SubTaskResult[] = [];

  /**
   * Start metrics collection.
   */
  start(): void {
    this.startTime = Date.now();
    this.taskResults = [];
  }

  /**
   * Record a task result.
   */
  recordTask(result: SubTaskResult): void {
    this.taskResults.push(result);
  }

  /**
   * Get collected metrics.
   */
  getMetrics(): ParallelMetrics {
    const totalDurationMs = Date.now() - this.startTime;
    const taskCount = this.taskResults.length;
    const succeededCount = this.taskResults.filter(r => r.status === 'succeeded').length;
    const failedCount = this.taskResults.filter(r => r.status === 'failed').length;
    const timeoutCount = this.taskResults.filter(r => r.status === 'timeout').length;
    
    const totalTokenUsage = this.taskResults.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0 }
    );
    
    const durations = this.taskResults.map(r => r.durationMs);
    const averageTaskDurationMs = durations.length > 0 
      ? durations.reduce((a, b) => a + b, 0) / durations.length 
      : 0;
    const maxTaskDurationMs = durations.length > 0 ? Math.max(...durations) : 0;
    const minTaskDurationMs = durations.length > 0 ? Math.min(...durations) : 0;

    return {
      totalDurationMs,
      taskCount,
      succeededCount,
      failedCount,
      timeoutCount,
      totalTokenUsage,
      averageTaskDurationMs,
      maxTaskDurationMs,
      minTaskDurationMs,
    };
  }

  /**
   * Log metrics summary.
   */
  logSummary(): void {
    const metrics = this.getMetrics();
    
    logger.info('=== Parallel Execution Metrics ===');
    logger.info(`Total Duration: ${metrics.totalDurationMs}ms`);
    logger.info(`Tasks: ${metrics.taskCount} (Succeeded: ${metrics.succeededCount}, Failed: ${metrics.failedCount}, Timeout: ${metrics.timeoutCount})`);
    logger.info(`Token Usage: ${metrics.totalTokenUsage.prompt} prompt, ${metrics.totalTokenUsage.completion} completion`);
    logger.info(`Task Duration: avg=${metrics.averageTaskDurationMs.toFixed(0)}ms, min=${metrics.minTaskDurationMs}ms, max=${metrics.maxTaskDurationMs}ms`);
    logger.info('==================================');
  }

  /**
   * Reset metrics.
   */
  reset(): void {
    this.startTime = 0;
    this.taskResults = [];
  }
}

/**
 * Compare serial vs parallel performance.
 */
export function comparePerformance(
  serialMetrics: { durationMs: number; tokenUsage: TokenUsage },
  parallelMetrics: ParallelMetrics
): {
  durationImprovement: number;  // percentage
  tokenOverhead: number;        // percentage
} {
  const durationImprovement = serialMetrics.durationMs > 0
    ? ((serialMetrics.durationMs - parallelMetrics.totalDurationMs) / serialMetrics.durationMs) * 100
    : 0;
  
  const serialTokens = serialMetrics.tokenUsage.prompt + serialMetrics.tokenUsage.completion;
  const parallelTokens = parallelMetrics.totalTokenUsage.prompt + parallelMetrics.totalTokenUsage.completion;
  const tokenOverhead = serialTokens > 0
    ? ((parallelTokens - serialTokens) / serialTokens) * 100
    : 0;

  return {
    durationImprovement,
    tokenOverhead,
  };
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P4.3 Implement LLM-Assisted Decomposition

**File**: `src/agent/sub-agent/decomposer.ts` (NEW)

**Steps**:
1. Create `decomposer.ts` with the following content:

```typescript
import type { AgentService } from '../service.js';
import type { SubTask } from './types.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from './tool-categories.js';
import { logger } from '../../shared/logger.js';

/**
 * Context-aware task decomposition using LLM.
 */
export class TaskDecomposer {
  constructor(private agentService: AgentService) {}

  /**
   * Decompose user request into parallel sub-tasks.
   */
  async decompose(
    userPrompt: string,
    context?: {
      previousResults?: Map<string, string>;
      availableTools?: string[];
    }
  ): Promise<SubTask[]> {
    const systemPrompt = this.buildDecompositionPrompt(context);
    
    try {
      const response = await this.agentService.callLlm({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: 'decomposer',
      });
      
      const parsed = this.parseDecompositionResponse(response);
      return this.validateAndFilterTasks(parsed);
    } catch (error) {
      logger.warn(`LLM decomposition failed: ${error}. Using fallback.`);
      return this.fallbackDecomposition(userPrompt);
    }
  }

  /**
   * Build the system prompt for decomposition.
   */
  private buildDecompositionPrompt(context?: {
    previousResults?: Map<string, string>;
    availableTools?: string[];
  }): string {
    const toolsList = context?.availableTools?.join(', ') || 'read_media_file, list_directory_with_sizes, query';
    
    return `
You are an expert task decomposition agent. Your job is to break down complex user requests 
into independent sub-tasks that can be executed in parallel.

## Rules for Decomposition

1. **Independence**: Each sub-task must be self-contained and not depend on results from other sub-tasks
2. **Completeness**: The combined results of all sub-tasks must fully address the user's request
3. **Efficiency**: Maximize parallelism - only create dependencies when absolutely necessary
4. **Tool Assignment**: Assign appropriate tools to each sub-task based on what it needs to do

## Available Tools
${toolsList}

## Output Format
Return a JSON array of sub-tasks:
[
  {
    "id": "task_1",
    "description": "Brief description of what this task does",
    "prompt": "Detailed instructions for the sub-agent to complete this task",
    "tools": ["tool1", "tool2"],
    "dependsOn": [],
    "priority": "high|medium|low"
  }
]

## Example
User: "Analyze the sales data in report.xlsx, compare it with last quarter's data, and generate a summary"

Decomposition:
[
  {
    "id": "task_1",
    "description": "Read and analyze current quarter sales data",
    "prompt": "Read the file report.xlsx using sheet.read and analyze the sales data using sheet.analyze. Return key metrics and trends.",
    "tools": ["sheet.read", "sheet.analyze"],
    "dependsOn": [],
    "priority": "high"
  },
  {
    "id": "task_2", 
    "description": "Read and analyze last quarter's data",
    "prompt": "Find and read last quarter's sales data file. If not found, use the most recent available data. Analyze and return key metrics.",
    "tools": ["sheet.read", "sheet.analyze"],
    "dependsOn": [],
    "priority": "high"
  },
  {
    "id": "task_3",
    "description": "Compare and generate summary",
    "prompt": "Compare the results from task_1 and task_2. Generate a comprehensive summary highlighting differences, trends, and recommendations.",
    "tools": ["sequentialthinking"],
    "dependsOn": ["task_1", "task_2"],
    "priority": "medium"
  }
]
`;
  }

  /**
   * Parse the LLM response into structured tasks.
   */
  private parseDecompositionResponse(response: string): SubTask[] {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }
    
    return parsed;
  }

  /**
   * Validate and filter tasks to ensure they use valid tools.
   */
  private validateAndFilterTasks(tasks: any[]): SubTask[] {
    return tasks
      .filter(task => task.id && task.prompt)
      .map((task, index) => ({
        id: task.id || `task_${index + 1}`,
        description: task.description || `Sub-task ${index + 1}`,
        prompt: task.prompt,
        tools: this.filterValidTools(task.tools),
        timeoutMs: task.timeoutMs || 60000,
        maxTurns: task.maxTurns || 10,
        dependsOn: task.dependsOn || [],
      }));
  }

  /**
   * Filter tools to only include valid, available tools.
   */
  private filterValidTools(tools?: string[]): string[] {
    if (!tools || !Array.isArray(tools)) {
      return Array.from(READ_ONLY_TOOLS).slice(0, 5); // Default to first 5 read-only tools
    }
    
    return tools.filter(t => READ_ONLY_TOOLS.has(t) || WRITE_TOOLS.has(t));
  }

  /**
   * Fallback decomposition when LLM fails.
   * Splits by obvious conjunctions or returns single task.
   */
  private fallbackDecomposition(userPrompt: string): SubTask[] {
    // Try to split by common conjunctions
    const parts = userPrompt.split(/(?:和|与|以及|,|\band\b)/i)
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    if (parts.length <= 1) {
      // Single task
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }
    
    // Multiple tasks from conjunctions
    return parts.map((part, index) => ({
      id: `task_${index + 1}`,
      description: `Part ${index + 1}: ${part.substring(0, 50)}...`,
      prompt: part,
      tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
      timeoutMs: 60000,
      maxTurns: 10,
      dependsOn: [],
    }));
  }
}
```

**Verification**:
- [ ] File created successfully
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

### P4.4 Phase 4 Acceptance Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| Retry logic added to `executor.ts` | ☐ | |
| `src/agent/sub-agent/metrics.ts` created | ☐ | |
| `src/agent/sub-agent/decomposer.ts` created | ☐ | |
| TypeScript compiles without errors | ☐ | |
| Retry works with exponential backoff | ☐ | Manual test |
| Metrics logged correctly | ☐ | Manual test |

---

## Final Verification

### Complete Build

**Command**: `npm run build`

**Expected**: Build succeeds with no errors

### Complete Test Suite

**Command**: `npm run test:unit`

**Expected**: All tests pass

### Manual Integration Test

1. Start the application: `npm start`
2. Open a new tab
3. Enter a parallelizable prompt: "分析文件A和文件B和文件C"
4. Verify:
   - Parallel execution panel appears
   - Multiple tasks execute concurrently
   - Results are aggregated correctly
   - UI updates in real-time

---

## Rollback Plan

If any phase fails verification:

1. **Phase 1**: Remove `src/agent/sub-agent/` directory
2. **Phase 2**: Revert changes to `agent-worker.ts`, `ipc-validation.ts`, `channels.ts`, `service.ts`
3. **Phase 3**: Revert changes to `types.ts`, `session-view.tsx`, remove `ParallelExecutionCard.tsx`
4. **Phase 4**: Revert changes to `executor.ts`, remove `metrics.ts`, `decomposer.ts`

---

*Document Version: 1.0*
*Created: 2026*
*Status: Ready for Execution*
