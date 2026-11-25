/**
 * H-6: tool backend annotation + dynamic description.
 *
 * Verifies:
 *   - acp_route's dynamicDescription returns availability-aware text
 *   - backend field is set on ToolDefinition (acp_route → 'acp', spawn_subagent → 'builtin')
 *   - tool-relevance scoring demotes tools with "will fail" in their description
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Coder side: BUILTIN_TOOLS backend + dynamicDescription ─────────────────

const { BUILTIN_TOOLS } = await import('nexus-coder/dist/src/mcp/builtin-tools.js');

describe('BUILTIN_TOOLS backend annotation (H-6)', () => {
  it('acp_route has backend=acp and dynamicDescription', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'acp_route');
    assert.ok(tool, 'acp_route must exist');
    assert.equal(tool.backend, 'acp');
    assert.equal(typeof tool.dynamicDescription, 'function');
  });

  it('acp_route dynamicDescription: ACP not initialized → warning', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'acp_route');
    // No agent → no acp → "ACP not initialized"
    const desc = tool.dynamicDescription({});
    assert.match(desc, /ACP not initialized/);
    assert.match(desc, /will fail/);
  });

  it('acp_route dynamicDescription: agents available → list', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'acp_route');
    // Fake agent with ACP protocol
    const fakeAgent = {
      acp: {
        listAgents: () => [{ id: 'kimi' }, { id: 'claude' }],
      },
    };
    const desc = tool.dynamicDescription({ agent: fakeAgent });
    assert.match(desc, /Available agents: kimi, claude/);
    assert.doesNotMatch(desc, /will fail/);
  });

  it('acp_route dynamicDescription: no agents registered → warning', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'acp_route');
    const fakeAgent = {
      acp: {
        listAgents: () => [],
      },
    };
    const desc = tool.dynamicDescription({ agent: fakeAgent });
    assert.match(desc, /No agents registered/);
    assert.match(desc, /will fail/);
  });
});

// ── Coder side: ToolDefinition backend field ────────────────────────────────

describe('ToolDefinition backend field (H-6)', () => {
  it('spawn_subagent has backend=builtin', async () => {
    const { getTaskToolDefinitions } = await import('nexus-coder/dist/src/task/task-tools.js');
    const tools = getTaskToolDefinitions();
    const spawn = tools.find((t) => t.name === 'spawn_subagent');
    assert.ok(spawn, 'spawn_subagent must exist');
    assert.equal(spawn.backend, 'builtin');
  });
});

// ── Desktop side: relevance scoring demotion ────────────────────────────────

describe('tool-relevance backend demotion (H-6)', () => {
  it('tool with "will fail" in description gets demoted score', async () => {
    const { scoreTool, ESSENTIAL_TOOLS } = await import('../dist/tools/tool-relevance.js');

    // A tool that looks available
    const availableTool = {
      name: 'acp_route',
      description: 'Delegate a task. (Available agents: kimi, claude)',
      keywords: ['acp'],
    };

    // A tool that signals unavailability
    const unavailableTool = {
      name: 'acp_route',
      description: 'Delegate a task. (ACP not initialized — this tool will fail. Use spawn_subagent instead.)',
      keywords: ['acp'],
    };

    const input = 'acp delegate';
    const bigrams = new Set();
    const opts = { input, used: new Set(), force: new Set() };

    const scoreAvailable = scoreTool(availableTool, bigrams, opts, input.toLowerCase());
    const scoreUnavailable = scoreTool(unavailableTool, bigrams, opts, input.toLowerCase());

    assert.ok(
      scoreUnavailable < scoreAvailable,
      `unavailable tool score (${scoreUnavailable}) must be < available tool score (${scoreAvailable})`,
    );
  });
});
