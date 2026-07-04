import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Agent } from '../src/agent.js';

describe('ACP Tools Exposure', () => {
  it('should expose ACP agent tools via getAcpTools()', async () => {
    const agent = new Agent();
    await agent.init();

    // Check if config has ACP agents with tools
    const acpTools = agent.getAcpTools();

    console.log(`Found ${acpTools.length} ACP tool(s):`);
    for (const t of acpTools) {
      console.log(`  - ${t.name}: ${t.description.slice(0, 80)}`);
    }

    // Verify tool structure
    for (const tool of acpTools) {
      assert.ok(tool.name, 'Tool must have name');
      assert.ok(tool.description, 'Tool must have description');
      assert.ok(tool.inputSchema, 'Tool must have inputSchema');
    }
  });

  it('should include ACP tools in LLM tool list', async () => {
    const agent = new Agent();
    await agent.init();

    const mcpTools = agent.mcp.getAllTools();
    const skillTools = agent.skills.getTools();
    const acpTools = agent.getAcpTools();

    const totalTools = [...mcpTools, ...skillTools, ...acpTools];

    console.log(`\nTotal tools available to LLM: ${totalTools.length}`);
    console.log(`  MCP: ${mcpTools.length}`);
    console.log(`  Skills: ${skillTools.length}`);
    console.log(`  ACP Agents: ${acpTools.length}`);

    // Check for known ACP tools
    const cogView = acpTools.find((t) => t.name.includes('CogView'));
    if (cogView) {
      console.log(`\n  Found CogView tool: ${cogView.name}`);
      console.log(`  Description: ${cogView.description}`);
    }
  });
});
