# Mid-Turn Intent Recognition: Steer and Rollback

> Scope: how a follow-up prompt sent while a turn is still running reaches the agent. Covers the core (`nexus-coder`: `Agent.enqueueSteer` / the private `Agent.applyRollback` / `Agent.restoreFromBackup`) and the desktop surface that drives it (`nexus-desktop`: `nexus:steer`, the rollback button, transcript resync). Written after the first implementation attempt failed acceptance — see "Why the classifier was deleted".

## The problem

Intent recognition in the desktop was only ever an **abort predicate**. A message sent while a turn was running was pushed into a renderer-local queue and stayed inert; the running turn could not see it until its entire `chat()` cycle resolved.

The observable failure: the user sent `发送一段较长文本，我来验证意图识别功能`. The agent read it as "implement the intent-recognition feature" and spent the whole turn writing and reading files. The user had to press 停止 by hand — there was no way to course-correct short of killing the turn and losing the work.

Two independent causes:

1. **No delivery path.** `enqueue()` (`src/renderer/renderer.ts`) pushed to `pendingQueue`; `drain()` saw `running === true` and only updated a "⏳排队 N" label. `AgentService.chat()` was never called, and would have thrown `'Agent is busy'` (`src/agent/service.ts`) if it had been.
2. **The classifier could not work.** `REFINE_MARKERS` was a hand-written CJK word list, and CJK has no word boundaries.

## Why the classifier was deleted

The first fix un-anchored the markers (`^(不对|不是|…)` → `(不对|不是|…)`) so a change-of-plan could be recognized mid-sentence. That immediately produced a false positive on the very string used to test it:

```
"意图识别验证，现在中止"  ->  ABORT   via "别"
```

`识别` contains `别`. The same un-anchored list matches `别名 / 别人 / 告别` (via 别), `即将 / 即使` (via 即), and `不要紧` (via 不要). Meanwhile the phrases a user actually types for an abort — `中止 / 停止 / 终止 / 马上停 / 停` — matched nothing, because bare `停` had been dropped to avoid matching `暂停 / 保持 / 稳定`.

Clause-start anchoring (`(^|[，,。.；;])\s*(…)`) fixes the mid-sentence cases but **not** this class: `别名` at position 0 still matches `别`. There is no regex-only answer.

So the word list is gone. The decision is now structural:

- **Steering is lossless.** A mid-turn message is delivered to the running turn; if the turn ends first it runs as the next turn. Nothing is dropped either way.
- **A wrong hard-abort destroys work; a missed one only costs latency.** That asymmetry says the decision of *when* to abandon the current plan belongs to the model (which now sees the instruction), not to a keyword table that must be simultaneously over- and under-triggering on Chinese.

`requestStop()` itself remains — the 停止 button and ESC still use it. Only the *automatic* invocation from the intent path was removed.

## Steer

### Core

`Agent.enqueueSteer(text, opts)` (`src/agent.ts`) pushes onto `steerQueue` when `busy`, returning `false` if no turn is in flight (the caller then starts a normal turn instead).

`drainSteerQueue()` runs at the **top of `runLlmTurn`, before `getToolsForContext` and before the LLM call**, so the turn that acts on the follow-up is already reasoning about it. Multiple queued steers merge into one message:

```
<user_steer>
The user sent a follow-up while you were still working. Take it into account now; abandon any remaining plan that conflicts with it.

<text 1>

<text 2>
</user_steer>
```

Draining emits `steer_applied { texts }`. Consumption is therefore **asynchronous and observable**: the desktop drops a message from its pending queue only when the core confirms it reached the model. If the turn is aborted first, the message simply runs as the next turn — no loss, no duplicate.

`chat()` clears `steerQueue` on entry so an unconsumed steer cannot leak into the next cycle.

### Early effect: leaving the tool batch

A turn executes a whole batch of tool calls before recursing. Draining only at the turn boundary means a 6-call batch runs to completion before the follow-up is seen.

`runLlmTurn`'s tool loop breaks out as soon as `steerQueue` is non-empty. It **cannot** be a bare `break`: every `tool_use` block in an assistant message must have a matching `tool_result`, or the provider rejects the request. Each skipped call therefore gets a synthetic result:

```
{ role: 'tool', toolCallId: <skipped.id>,
  content: 'Cancelled: the user sent a new instruction before this tool ran.' }
```

emitted as a normal `tool_result` event so the UI shows what was dropped. Latency drops from "the whole batch finishes" to "the current tool finishes".

## Rollback

### Semantics

Toggle `contextWindow.intentRollback`, **default `false`**.

| | `intentRollback: false` (default) | `intentRollback: true` |
|---|---|---|
| Mid-turn message | merged into the live turn | merged into the live turn |
| Completed tool results of the interrupted turn | kept in context | **discarded** from context + DB + transcript |
| UI entry point | none | `↺ 作废上一条并重发` button |

Rollback is equivalent to an automatic 撤回 + 重发, but without stopping the turn.

The trigger is **explicit user action**, never inference. A destructive operation must not be triggered by a keyword table that has already been demonstrated to misfire on ordinary Chinese words.

### The safe point

Both rollback and steer injection execute at the **top of `runLlmTurn`**, rollback first, injection second.

It must not happen mid-batch. At that moment `pendingToolCalls` and `assistantMessage` are live on the stack, and the loop still calls `context.add(toolMsg)` after each result. Truncating underneath produces an orphaned `tool` message with no preceding `tool_use` → provider rejection. Letting the batch finish intact and truncating at the next turn boundary keeps every `tool_use`/`tool_result` pair well-formed.

### Boundary resolution

The boundary is the last `role === 'user'` message whose content does **not** begin with `<user_steer>`. Skipping steer messages is essential: the boundary is resolved before injection, but a second rollback in the same turn must not delete the steer that was already merged in.

Two off-by-one traps live here, both of which delete the prompt the user just typed:

- `ContextManager.truncateAfter(index)` keeps `slice(0, index)` — it drops the message **at** `index`. The cut is therefore `boundary + 1`.
- `SessionManager.deleteMessagesFrom(sessionId, fromId)` is **inclusive** of `fromId`, so the DB tail must be sliced from one row *past* the boundary user row (`cut = i + 1`), not at it.

The two layers are resolved independently: the context boundary comes from the context message list, the DB cut from the stored **role sequence**. They are not index-parity twins — injected (non-persisted) blocks shift the two — so deriving one from the other's index is wrong.

`chat()` and `startSession()` reset the once-per-turn `rollbackDone` flag. `applyRollback` is private and reached only through `drainSteerQueue`, which is what guarantees it runs at a safe point.

### Why not `ContextManager.setMessages`

`setMessages()` sets `systemPromptInjected = false` (`src/llm/context-manager.ts`). The truncation slice still contains the original system message, and the next `chat()` re-injects via `insertSystemPromptFirst()` — producing **two** system messages.

`ContextManager.truncateAfter(index)` therefore slices and recounts tokens, and clears `systemPromptInjected` **only when no `role === 'system'` message survives in the slice**.

### Persistence

`SessionManager.deleteMessagesFrom(sessionId, fromId)` is new — the core had no delete path at all (`withdraw()` was writing SQL itself from the desktop repo). Messages are ordered by `id ASC` (`src/session-db.ts`), so a rollback is a plain tail delete and needs no renumbering.

### Backup

Written before truncation, to the **global** trash:

```
~/.nexus/trash/rollback/<sessionId>/<ts>.jsonl
```

Global rather than project `.nexus/trash/` because sessions are global (`sessions.db` lives in `~/.nexus/`) and cwd changes mid-session via `/setdir` and `/chcwd` — a project-scoped backup would land in whatever project happened to be current and be unfindable, and the project rules ask for scratch files to be cleaned up.

Format: a header line with metadata, then one line per removed message.

```jsonc
{"kind":"meta","sessionId":"...","steerRowId":4821,"boundaryStoredId":4790,"createdAt":1758000000000,"count":7}
{"kind":"msg","role":"assistant","content":"...","toolCalls":[...],"toolCallId":null}
```

`steerRowId` is written as `0` and patched afterwards: the backup is taken during truncation, which happens *before* the follow-up is injected, so the steer row does not exist yet. `drainSteerQueue` rewrites the meta line once `addMessage` has assigned the real id. A backup that could not be patched is still a valid forensic record — it just cannot unwind the steer row.

The file is written `mode 0o600`: it can contain tool output, i.e. the same confidentiality as `sessions.db` itself.

Retention: the 20 most recent files per session; older ones are removed. `sessions.db` is already ~200 MB and backups must not grow without bound.

### Restore

`Agent.restoreFromBackup(path)` is an **undo of the undo**:

1. `deleteMessagesFrom(sessionId, steerRowId)` — removes the steer and any work produced after it.
2. Re-append the backed-up messages via `addMessage`.
3. `startSession(undefined, sessionId)` — reload context from the DB.

The result is byte-identical to the pre-rollback state. Append-only, so no `id` renumbering is needed.

Mid-turn the live context cannot be spliced, so the request is parked in `pendingRestorePath` and applied by `drainPendingRestore` at the next turn boundary — before `drainSteerQueue`, so a restore always outranks the rollback it is undoing. The deferral must bypass the busy check inside `restoreFromBackup`, otherwise it re-queues itself forever.

Restore is deliberately **not** "keep the steer and add the work back". That would require inserting before an existing autoincrement id and renumbering the rest of the session's `id` space — high blast radius for a marginal semantic gain. The rollback means "the previous instruction is void"; restoring it means returning to exactly the moment before the button was pressed.

Timing mirrors rollback: if a turn is in flight the restore is deferred to the next turn boundary; if idle it applies immediately via `startSession`.

Backups are plain-text JSONL containing tool output. They carry the same confidentiality as `sessions.db` and are not additionally encrypted.

## Desktop surface

- `nexus:steer` gains `rollback?: boolean`; `AgentService.steer(input, rollback)` forwards it as `enqueueSteer(input, { rollback })`.
- `nexus:getIntentRecognition` returns `{ intentRecognition, intentRollback }` in one read (the config lives in `config.json`, read directly rather than through the worker because the renderer needs it before `fullReady`).
- `#btn-rollback` sits before `#input-status` in `.input-actions`, `hidden` by default. Visible only while `running`, with `intentRollback` on, and a non-empty textarea. Not rendered at all when the toggle is off, so it cannot be hit by accident. Confirms before acting, like `undoAt`.
- On rollback the transcript gains a clickable line `↺ 已回滚 N 条 · 点击恢复` carrying the backup path.

### Forced cache resync

Both rollback and restore run the exact sequence `undoAt` already uses (`src/renderer/renderer.ts`):

```
syncMsgCache(sessionId) → renderMessageWindow() → refreshSessions() → refreshSessionStats()
```

No incremental DOM patching. Rollback shifts `userMessageSeq`, so every regenerate/undo index downstream would silently point at the wrong message if the DOM were edited in place.

`toolCards`, `curAssistant` and `curThinking` must also be cleared: a stream still flushing deltas would otherwise write into a node that `renderMessageWindow()` has already detached.

## Event flow

```
renderer enqueue(text)
   │
   ├─ intentRecognition on?  ── no ──▶ pendingQueue only
   │
   └─ nexus:steer { input, rollback }            service.ts → agent.enqueueSteer()
          │                                              │
          │◀── true ─────────────────────────────────────┤ busy
          │◀── false ──▶ stays queued, drain() runs it as the next turn
          │
          ▼
   runLlmTurn (next turn boundary)
          1. rollback?  → truncateAfter(boundary) + deleteMessagesFrom + backup JSONL
          2. drainSteerQueue() → inject <user_steer>, emit steer_applied
          3. resolve tools, call the LLM

   emit steer_applied  ──▶ renderer drops it from pendingQueue
   emit rollback_applied ──▶ renderer force-resyncs transcript + adds restore line
```

## Known limitations

- **A restored transcript is ordered `[original prompt, restored work]`.** Any tool calls the model made *after* the rollback land after that. Logically consistent, but the sequence can look odd.
- **Restore removes the steer.** Intentional (see above), but it means "restore" cannot be used to keep a correction *and* recover the work.
- **`~/.nexus/trash/rollback/` is not cleaned by anything.** Retention is capped at 20 files per session by the writer; nothing prunes orphaned directories for deleted sessions.

## Tests

`test/intent-steer.test.mjs` — 19 cases against a `Object.create(Agent.prototype)` instance with fake context/session, plus the real `ContextManager`:

- `enqueueSteer` rejects blank text and an idle agent.
- `enqueueSteer` carries `rollback` through and consumes the flag at the boundary.
- `drainSteerQueue` merges N steers into one message and emits `steer_applied`; no-op when empty.
- Rollback truncates at the last real user message and deletes the matching DB tail.
- The boundary **skips `<user_steer>` messages** — an earlier steer is discarded, the newly injected one survives.
- Rollback is a no-op with no real user message in context.
- A second rollback in the same turn deletes nothing and emits no second `rollback_applied`.
- `truncateAfter` keeps `systemPromptInjected` when a system message survives, clears it otherwise, and is a no-op at/past the end.
- Leaving the tool batch keeps `tool_use`/`tool_result` strictly paired and in order.
- `AgentService.steer` gate: forwards when idle-free and busy, reports `false` when idle, no-ops without an agent, and honours `intentRollback` in **both** directions.
- `AgentService.restore` delegates and tolerates a missing agent.
- The deleted classifier is really gone (no `REFINE_MARKERS` / `isIterativeIntent` / `bigrams` in the built renderer, no `withinWindow` in the built service).
- `nexus:steer` / `nexus:restore` param specs.

### Not covered

These need a live provider or a real DB, so they are unverified by the suite and rest on manual acceptance:

- Config resolution of `intentRollback` for absent / `false` / `true` (only the service-side gate is tested).
- `SessionStore.deleteMessagesFrom` / `SessionManager` against a real `sessions.db` — the tests use a fake session, so the actual SQL is unexercised.
- Backup file writing and `restoreFromBackup` round-tripping the pre-rollback row set.
- `restoreFromBackup`'s mid-turn deferral (`pendingRestorePath`) and the `steerRowId` patch ordering.