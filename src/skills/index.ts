/**
 * Skill registry for the P2 WorkBuddy pipeline.
 *
 * Skills extend the tool loop with *artifact-producing* capabilities: they obey
 * the same ToolRegistry contract, but their ToolResult.content carries an
 * Artifact envelope (src/shared/artifact.ts) that the renderer can preview.
 *
 * The registry list is consumed by src/tools/index.ts, so shadowing, tool-list
 * surfacing and dispatch happen through the exact same machinery as filesystem
 * / sqlite — one loop, two payload kinds.
 */

import type { ToolRegistry } from '../tools/types.js';
import { SHEET_TOOLS, SHEET_TOOL_DEFS, callSheetTool } from './sheet.js';
import { CHART_TOOLS, CHART_TOOL_DEFS, callChartTool } from './chart.js';

export { SHEET_TOOLS, SHEET_TOOL_DEFS, callSheetTool } from './sheet.js';
export { CHART_TOOLS, CHART_TOOL_DEFS, callChartTool } from './chart.js';

/** Every office skill family served by the worker. */
export const SKILL_REGISTRIES: ToolRegistry[] = [
  { id: 'sheet', defs: SHEET_TOOL_DEFS, call: callSheetTool },
  { id: 'chart', defs: CHART_TOOL_DEFS, call: callChartTool },
];