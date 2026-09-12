# Multi-Agent Parallel Architecture - Implementation Plan

> Status: Ready for Implementation
> Based on: `multi-agent-parallel-architecture.md`
> Created: 2026

---

## 1. Executive Summary

This document provides a detailed, actionable implementation plan for transforming Nexus-Desktop from a single-agent serial execution model to a parallel sub-agent system. The plan is organized into 4 phases with specific file changes, dependencies, and verification criteria.

**Key Insight from Code Analysis**: The existing `SessionWorkers` architecture already provides per-tab isolated worker processes. The parallel agent system builds on this foundation by introducing an orchestrator that coordinates multiple worker processes within a single tab.

---

## 2. Architecture Analysis

### 2.1 Existing Components

| Component | Location | Purpose | Reuse Potential |
|-----------|----------|---------|-----------------|
| `AgentService` | `src/agent/service.ts` | Core agent logic (~1950 lines) | **High** - wrap with orchestrator |
| `WorkerHost` | `src/main/worker-host.ts` | Worker process management | **High** - reuse for sub-agents |
| `SessionWorkers` | `src/main/session-workers.ts` | Per-tab worker registry | **Medium** - reference pattern |
| `agent-worker.ts` | `src/agent-worker.ts` | Worker entry point (346 lines) | **High** - extend with sub-agent support |
| `ToolRegistry` | `src/tools/types.ts` | Tool definitions | **High** - filter for sub-agents |
| IPC Channels | `src/ipc/channels.ts` | Communication protocol | **High** - add parallel channels |

### 2.2 Integration Points

```
┌─────────────────────────────────────────────────────────────────┐
│                        Main Process                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ SessionWorkers│    │  McpHub     │    │ WorkerHost  │         │
│  │  (per-tab)   │    │  (singleton)│    │  (manager)  │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            │                                    │
│                    ┌───────▼───────┐                            │
│                    │ Orchestrator  │ ◄── NEW                    │
│                    │   (in-worker) │                            │
│                    └───────┬───────┘                            │
└────────────────────────────┼────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Sub-Agent #1   │ │  Sub-Agent #2   │ │  Sub-Agent #3   │
│  (WorkerHost)   │ │  (WorkerHost)   │ │  (WorkerHost)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 3. Phase 1: Foundation (Week 1)

### 3.1 Create Type Definitions

**File**: `src/agent/sub-agent/types.ts` (NEW)

```typescript
// Sub-task identifier and configuration
export interface SubTask {
  id: string;
  description: string;
  prompt: string;
  tools?: string[];
  timeoutMs?: number;
  maxTurns?: number;
  dependsOn?: string[];
}

export type SubTaskStatus = 
  | 'pending' | 'queued' | 'running' 
  | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

export interface SubTaskResult {
  taskId: string;
  status: SubTaskStatus;
  output: string;
  tokenUsage: { prompt: number; completion: number };
  durationMs: number;
  error?: string;
  events?: AgentEvent[];
}

export interface ParallelConfig {
  maxConcurrent?: number;  // default: 4
  timeoutMs?: number;      // default: 300000
  fallbackToSerial?: boolean;  // default: true
}
```

**Dependencies**: None
**Verification**: TypeScript compiles without errors

### 3.2 Implement Tool Categories

**File**: `src/agent/sub-agent/tool-categories.ts` (NEW)

```typescript
import { ALL_TOOL_DEFS } from '../../tools/index.js';

export const READ_ONLY_TOOLS = new Set([
  'read_text_file',
  'list_directory',
  'query',
  'git_log',
  'git_diff',
  'git_show',
  'fetch',
  'pyright_status',
  'ts_status',
  'sheet.analyze',
  'bi.chart',
]);

export const WRITE_TOOLS = new Set([
  'file_write',
  'git_commit',
  'git_push',
  'execute',
]);

export function requiresSerialization(task: SubTask): boolean {
  if (!task.tools || task.tools.length === 0) return false;
  return task.tools.some(t => WRITE_TOOLS.has(t));
}

export function filterToolsForSubAgent(allowedTools?: string[]): string[] {
  if (!allowedTools) return Array.from(READ_ONLY_TOOLS);
  return allowedTools.filter(t => READ_ONLY_TOOLS.has(t));
}
```

**Dependencies**: `src/tools/index.ts`
**Verification**: Unit tests for tool classification

### 3.3 Implement SubAgentExecutor Core

**File**: `src/agent/sub-agent/executor.ts` (NEW)

Key methods to implement:
1. `executeParallel(tasks, baseSessionId)` - Main entry point
2. `executeSingle(task, baseSessionId)` - Single task execution
3. `topologicalSort(tasks)` - Dependency resolution
4. `chunkByConcurrency(tasks)` - Batch creation
5. `spawnWorker(task, baseSessionId)` - Worker instantiation

**Dependencies**: 
- `src/main/worker-host.ts` (reuse WorkerHost)
- `src/main/session-workers.ts` (reference pattern)
- `src/agent/sub-agent/types.ts`

**Verification**: 
- Unit tests for topological sort (circular dependency detection)
- Unit tests for concurrency chunking
- Integration test with mock workers

### 3.4 Unit Tests

**File**: `test/sub-agent.test.mjs` (NEW)

Test cases:
- Topological sort with valid dependencies
- Topological sort with circular dependencies (should throw)
- Concurrency chunking with different limits
- Tool classification (read-only vs write)
- SubTask validation

---

## 4. Phase 2: AgentService Integration (Week 2)

### 4.1 Extend Worker Protocol

**File**: `src/agent-worker.ts` (MODIFY)

Add new worker methods:
```typescript
| { id: number; method: 'runSubAgent'; params: { taskId: string; prompt: string; tools?: string[]; maxTurns?: number; timeoutMs?: number } }
| { id: number; method: 'getSubAgentStatus'; params: { taskId: string } }
| { id: number; method: 'cancelSubAgent'; params: { taskId: string } }
```

**Changes**:
1. Add new method types to `WorkerRequest` union
2. Implement handlers in the dispatch switch
3. Add sub-agent state tracking (Map<taskId, SubAgentState>)

**Dependencies**: None
**Verification**: Worker starts and responds to new methods

### 4.2 Extend IPC Validation

**File**: `src/shared/ipc-validation.ts` (MODIFY)

Add validation specs for new methods:
```typescript
runSubAgent: {
  taskId: 'string',
  prompt: 'string', 
  tools: 'object?',
  maxTurns: 'number?',
  timeoutMs: 'number?',
},
```

**Dependencies**: None
**Verification**: Validation passes for valid params, rejects invalid

### 4.3 Extend IPC Channels

**File**: `src/ipc/channels.ts` (MODIFY)

Add new channels:
```typescript
// Parallel execution channels
runSubAgent: 'nexus:runSubAgent',
getSubAgentStatus: 'nexus:getSubAgentStatus',
cancelSubAgent: 'nexus:cancelSubAgent',
subAgentProgress: 'nexus:subAgentProgress',
```

**Dependencies**: None
**Verification**: Channels registered correctly

### 4.4 Implement OrchestratorAgent

**File**: `src/agent/sub-agent/orchestrator.ts` (NEW)

Key methods:
1. `orchestrate(userPrompt, sessionId)` - Main orchestration
2. `decomposeTasks(userPrompt, sessionId)` - LLM-based decomposition
3. `aggregateResults(results, originalPrompt)` - Result merging

**Dependencies**:
- `src/agent/service.ts` (for LLM calls)
- `src/agent/sub-agent/executor.ts`

**Verification**:
- Integration test with mock LLM decomposition
- Test result aggregation logic

### 4.5 Integrate into AgentService

**File**: `src/agent/service.ts` (MODIFY)

Add parallel execution support:
```typescript
export class AgentService {
  private orchestrator: OrchestratorAgent | null = null;
  
  private shouldUseParallel(prompt: string): boolean {
    const patterns = [
      /分析.*和.*和/i,
      /比较.*与.*与/i,
      /分别.*处理.*和.*和/i,
      /并行/i,
    ];
    return patterns.some(p => p.test(prompt));
  }

  async chat(prompt: string, sessionId: string): Promise<ChatResult> {
    if (this.shouldUseParallel(prompt)) {
      return this.chatParallel(prompt, sessionId);
    }
    return this.chatSerial(prompt, sessionId);
  }

  private async chatParallel(prompt: string, sessionId: string): Promise<ChatResult> {
    if (!this.orchestrator) {
      this.orchestrator = new OrchestratorAgent(this);
    }
    // ... orchestration logic
  }
}
```

**Dependencies**: OrchestratorAgent
**Verification**: 
- Manual test with parallelizable prompt
- Verify fallback to serial for non-parallel prompts

---

## 5. Phase 3: UI Display (Week 3)

### 5.1 Add Parallel Execution Events

**File**: `src/agent/types.ts` (MODIFY)

Add new event types:
```typescript
export type AgentEvent = 
  | { type: string } & Record<string, unknown>
  | { type: 'parallel_start'; sessionId: string; prompt: string }
  | { type: 'parallel_end'; sessionId: string; tasks: SubTaskResult[]; tokenUsage: TokenUsage }
  | { type: 'task_progress'; taskId: string; status: SubTaskStatus };
```

**Dependencies**: None
**Verification**: Events emitted correctly

### 5.2 Create Parallel Execution Card Component

**File**: `src/renderer/components/ParallelExecutionCard.tsx` (NEW)

Features:
- Task ID display
- Status indicator (pending/running/succeeded/failed)
- Duration display
- Progress bar for running tasks
- Output preview for succeeded tasks
- Error display for failed tasks

**Dependencies**: None
**Verification**: Component renders correctly in isolation

### 5.3 Integrate into Session View

**File**: `src/renderer/session-view.tsx` (MODIFY)

Add event handlers:
```typescript
ipcRenderer.on('nexus:tabEvents', (event: Event) => {
  const data = (event as CustomEvent).detail;
  
  switch (data.type) {
    case 'parallel_start':
      showParallelExecutionPanel(data.prompt);
      break;
    case 'parallel_end':
      hideParallelExecutionPanel();
      showAggregatedResult(data.tasks, data.tokenUsage);
      break;
    case 'task_progress':
      updateTaskStatus(data.taskId, data.status);
      break;
  }
});
```

**Dependencies**: ParallelExecutionCard component
**Verification**: UI updates correctly during parallel execution

---

## 6. Phase 4: Optimization (Week 4)

### 6.1 Implement Failure Retry

**File**: `src/agent/sub-agent/executor.ts` (MODIFY)

Add retry logic:
```typescript
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
        await this.delay(Math.pow(2, attempt) * 1000); // Exponential backoff
      }
    }
  }
  
  return this.toFailedResult(lastError!);
}
```

**Dependencies**: None
**Verification**: 
- Test retry with failing tasks
- Verify exponential backoff timing

### 6.2 Add Performance Metrics

**File**: `src/agent/sub-agent/metrics.ts` (NEW)

Track:
- Total parallel execution time
- Per-task execution time
- Token usage comparison (serial vs parallel)
- Success/failure rates

**Dependencies**: None
**Verification**: Metrics logged correctly

### 6.3 Implement LLM-Assisted Decomposition

**File**: `src/agent/sub-agent/decomposer.ts` (NEW)

Enhance decomposition with:
- Context-aware task splitting
- Dependency detection
- Tool recommendation per task

**Dependencies**: AgentService LLM access
**Verification**: 
- Test with complex multi-part prompts
- Verify decomposition quality

---

## 7. File Structure Summary

```
src/agent/sub-agent/
├── types.ts              # Data structures (Phase 1)
├── tool-categories.ts    # Tool classification (Phase 1)
├── executor.ts           # Core executor (Phase 1)
├── orchestrator.ts       # Coordinator agent (Phase 2)
├── decomposer.ts         # Task decomposition (Phase 4)
└── metrics.ts            # Performance tracking (Phase 4)

src/renderer/components/
└── ParallelExecutionCard.tsx  # UI component (Phase 3)

test/
└── sub-agent.test.mjs    # Unit tests (Phase 1)
```

---

## 8. Dependency Graph

```
Phase 1: Foundation
    ├── types.ts (no deps)
    ├── tool-categories.ts → tools/index.ts
    ├── executor.ts → worker-host.ts, types.ts
    └── sub-agent.test.mjs → executor.ts, tool-categories.ts

Phase 2: Integration
    ├── agent-worker.ts → types.ts (extend)
    ├── ipc-validation.ts (extend)
    ├── channels.ts (extend)
    ├── orchestrator.ts → executor.ts, service.ts
    └── service.ts → orchestrator.ts

Phase 3: UI
    ├── types.ts (extend events)
    ├── ParallelExecutionCard.tsx (no deps)
    └── session-view.tsx → ParallelExecutionCard.tsx

Phase 4: Optimization
    ├── executor.ts (extend retry)
    ├── metrics.ts → executor.ts
    └── decomposer.ts → service.ts
```

---

## 9. Risk Mitigation

| Risk | Impact | Mitigation | Owner |
|------|--------|------------|-------|
| Worker process exhaustion | High | Limit maxConcurrent=4, monitor resource usage | Executor |
| Context isolation leaks | High | Independent sessions, no shared state | Orchestrator |
| LLM decomposition errors | Medium | Fallback to pattern matching, manual override | Decomposer |
| UI performance issues | Medium | Virtual scrolling, lazy loading | Renderer |
| Token cost increase | Low | Only parallelize independent tasks | shouldUseParallel |

---

## 10. Testing Strategy

### 10.1 Unit Tests

- **Tool classification**: Verify read-only vs write tool sets
- **Topological sort**: Valid dependencies, circular detection
- **Concurrency chunking**: Different limits, empty arrays
- **Retry logic**: Exponential backoff, max retries

### 10.2 Integration Tests

- **Single sub-agent execution**: Spawn worker, run task, collect result
- **Parallel execution**: Multiple tasks, verify isolation
- **Dependency resolution**: Sequential tasks with dependencies
- **Failure handling**: Timeout, error propagation

### 10.3 Manual Tests

- **UI rendering**: Parallel execution cards, progress indicators
- **Fallback behavior**: Non-parallel prompts use serial path
- **Resource monitoring**: Worker process count, memory usage

---

## 11. Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Response time reduction | 40-60% for parallelizable tasks | Benchmark before/after |
| CPU utilization | 60-80% during parallel execution | Resource monitor |
| Token usage increase | <20% vs serial | Token counter |
| Task success rate | >95% | Metrics dashboard |
| UI responsiveness | No lag during parallel execution | Frame rate monitoring |

---

## 12. Implementation Checklist

### Phase 1: Foundation
- [ ] Create `src/agent/sub-agent/types.ts`
- [ ] Create `src/agent/sub-agent/tool-categories.ts`
- [ ] Create `src/agent/sub-agent/executor.ts`
- [ ] Create `test/sub-agent.test.mjs`
- [ ] Verify TypeScript compilation
- [ ] Run unit tests

### Phase 2: Integration
- [ ] Extend `src/agent-worker.ts` with new methods
- [ ] Extend `src/shared/ipc-validation.ts`
- [ ] Extend `src/ipc/channels.ts`
- [ ] Create `src/agent/sub-agent/orchestrator.ts`
- [ ] Modify `src/agent/service.ts`
- [ ] Test worker communication

### Phase 3: UI
- [ ] Extend `src/agent/types.ts` with new events
- [ ] Create `src/renderer/components/ParallelExecutionCard.tsx`
- [ ] Modify `src/renderer/session-view.tsx`
- [ ] Test UI rendering

### Phase 4: Optimization
- [ ] Add retry logic to `executor.ts`
- [ ] Create `src/agent/sub-agent/metrics.ts`
- [ ] Create `src/agent/sub-agent/decomposer.ts`
- [ ] Performance benchmarking

---

## 13. Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Foundation | 5 days | None |
| Phase 2: Integration | 5 days | Phase 1 |
| Phase 3: UI | 3 days | Phase 2 |
| Phase 4: Optimization | 4 days | Phase 3 |
| **Total** | **17 days** | - |

---

## 14. Future Enhancements

1. **Dynamic Task Splitting**: LLM decides optimal decomposition at runtime
2. **Cross-Session Parallelism**: Share results between tabs
3. **Priority Queuing**: High-priority tasks execute first
4. **Resource-Aware Scheduling**: Adjust concurrency based on system load
5. **Result Caching**: Cache sub-agent results for repeated queries

---

*Document Version: 1.0*
*Created: 2026*
*Status: Ready for Implementation*
