import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { selectTools, ESSENTIAL_TOOLS } = await import(
  pathToFileURL(join(dist, 'tools', 'tool-relevance.js'))
);
const { TOOL_ROUTING, applyRouting } = await import(pathToFileURL(join(dist, 'tools', 'routing.js')));
const { ALL_TOOL_DEFS, INTERNAL_TOOLS } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));
const {
  createSkillsDisclosureRegistry,
  SKILLS_DISCLOSURE_TOOL_DEFS,
  skillHostFromAgent,
  skillToolNames,
} = await import(pathToFileURL(join(dist, 'tools', 'skills-disclosure.js')));
const { ToolRefreshQueue, refreshToolsResult, REFRESH_TOOLS_DEF } = await import(
  pathToFileURL(join(dist, 'tools', 'refresh-tools.js'))
);

const def = (name, extra = {}) => ({
  name,
  description: `description of ${name}`,
  inputSchema: { type: 'object', properties: {} },
  ...extra,
});

const names = (list) => list.map((t) => t.name);

/**
 * Filler tools. `kw` is matched by every filler, which lets a test push the
 * MIN_KEPT backfill toward the fillers and away from a zero-score decoy —
 * otherwise the floor keeps the decoy and the assertion would be measuring the
 * floor instead of the scoring.
 */
const filler = (n, kw, start = 0) =>
  Array.from({ length: n }, (_, i) =>
    def(`filler_tool_${start + i}`, { keywords: [kw] }),
  );

/** Filler that must never outrank a real match. */
const deadFiller = (n, start = 0) =>
  Array.from({ length: n }, (_, i) =>
    def(`dead_tool_${start + i}`, { keywords: [`zzqq${start + i}`] }),
  );

// ---------------------------------------------------------------------------
// selectTools: fail-open guarantees
// ---------------------------------------------------------------------------

test('essential tools survive a prompt that matches nothing', () => {
  const out = selectTools([def('git_commit', { group: 'git' }), def('read_text_file')], {
    input: 'zzzz qqqq',
    used: new Set(),
  });
  const n = names(out);
  assert.ok(n.includes('read_text_file'), 'essential file tool must survive');
});

test('every tool in ESSENTIAL_TOOLS survives selection', () => {
  const candidates = [...ESSENTIAL_TOOLS].map((n) => def(n));
  const out = selectTools(candidates, { input: '完全不相关的提示', used: new Set() });
  const missing = [...ESSENTIAL_TOOLS].filter((n) => !names(out).includes(n));
  assert.deepEqual(missing, [], `these essential tools were dropped: ${missing.join(', ')}`);
});

test('selection never returns an empty list', () => {
  const out = selectTools([def('totally_unrelated_a'), def('totally_unrelated_b')], {
    input: 'zzz',
    used: new Set(),
  });
  assert.ok(out.length > 0, 'must always offer something');
  assert.ok(out.length >= 2, 'backfills up to the floor rather than returning nothing');
});

test('respectNarrowing returns the candidate list untouched', () => {
  const candidates = [def('alpha'), def('beta'), def('gamma')];
  const out = selectTools(candidates, { input: 'zzz', used: new Set(), respectNarrowing: true });
  assert.deepEqual(names(out), ['alpha', 'beta', 'gamma']);
});

test('selection does not mutate its input', () => {
  const candidates = [def('alpha'), def('beta')];
  const before = names(candidates);
  selectTools(candidates, { input: 'zzz', used: new Set() });
  assert.deepEqual(names(candidates), before);
});

test('duplicate defs are collapsed so the model is not sent two copies', () => {
  const dup = def('git_commit', { keywords: ['commit'] });
  const out = selectTools([dup, { ...dup }, def('read_text_file'), ...deadFiller(40)], {
    input: 'commit this',
    used: new Set(),
  });
  const count = names(out).filter((n) => n === 'git_commit').length;
  assert.equal(count, 1, 'a duplicated def must appear once');
});

test('an empty candidate list is returned as-is', () => {
  const out = selectTools([], { input: 'anything', used: new Set() });
  assert.deepEqual(out, []);
});

test('empty input short-circuits to the full list', () => {
  const candidates = [def('alpha'), def('beta'), def('gamma'), def('delta')];
  const out = selectTools(candidates, { input: '', used: new Set() });
  assert.equal(out.length, candidates.length, 'no signal means no narrowing');
});

// ---------------------------------------------------------------------------
// selectTools: CJK regression — the bug this whole mechanism exists to fix
// ---------------------------------------------------------------------------

test('an author-supplied Chinese keyword surfaces its tool for a Chinese prompt', () => {
  const tool = def('weather_skill', { keywords: ['天气', 'weather'] });
  const other = def('unrelated_tool', { keywords: ['database'] });
  // 40 fillers also match 广州, so they outrank the zero-score decoy and the
  // MIN_KEPT backfill is spent on them rather than on `unrelated_tool`.
  const out = selectTools([tool, other, ...filler(40, '广州')], {
    input: '帮我查一下广州的天气',
    used: new Set(),
  });
  assert.ok(names(out).includes('weather_skill'), '天气 must match 天气');
  assert.ok(!names(out).includes('unrelated_tool'), 'an unrelated tool must not ride along');
});

test('English keywords still work for English prompts', () => {
  const tool = def('git_commit', { keywords: ['commit', '提交'] });
  const out = selectTools([tool, def('noise', { keywords: ['zzz'] })], {
    input: 'please commit this change',
    used: new Set(),
  });
  assert.ok(names(out).includes('git_commit'));
});

test('bigram similarity surfaces a tool with no keywords at all', () => {
  // The language-agnostic fallback: no author keywords, but the description
  // shares bigrams with the prompt.
  const tool = def('x', { description: 'spreadsheet spreadsheet analysis for csv files' });
  const out = selectTools([tool, def('y', { description: 'completely different subject matter' })], {
    input: 'spreadsheet analysis',
    used: new Set(),
  });
  assert.ok(names(out).includes('x'), 'similarity alone should keep a matching tool');
});

// ---------------------------------------------------------------------------
// selectTools: usage memory
// ---------------------------------------------------------------------------

test('a tool already used this session stays reachable even when it no longer matches', () => {
  const tool = def('git_push', { keywords: ['push', '推送'] });
  const out = selectTools([tool, def('other', { keywords: ['unrelated'] })], {
    input: 'zzz qqq',
    used: new Set(['git_push']),
  });
  assert.ok(names(out).includes('git_push'), 'usage memory must pin an already-used tool');
});

// ---------------------------------------------------------------------------
// selectTools: the refresh_tools escape hatch
// ---------------------------------------------------------------------------

test('a forced tool is surfaced by its natural-language intent', () => {
  const target = def('sheet_reader', { keywords: ['spreadsheet', '表格'] });
  const out = selectTools([target, ...deadFiller(40)], {
    input: 'zzz',
    used: new Set(),
    force: new Set(['spreadsheet 表格']),
  });
  assert.ok(names(out).includes('sheet_reader'), 'force must widen the selection');
});

test('a forced tool stays visible on a round whose prompt does not mention it', () => {
  // The refresh_tools contract: the request is applied to the NEXT round, whose
  // input is whatever the model says next. The widening must not evaporate.
  const target = def('sheet_reader', { keywords: ['spreadsheet'] });
  const widened = selectTools([target, ...deadFiller(40)], {
    input: 'now write the tests',
    used: new Set(),
    force: new Set(['spreadsheet']),
  });
  assert.ok(names(widened).includes('sheet_reader'));
});

test('force with an empty intent set changes nothing', () => {
  const candidates = [def('a', { keywords: ['a'] }), def('b', { keywords: ['b'] }), ...filler(40, 'a')];
  const out = selectTools(candidates, { input: 'a', used: new Set(), force: new Set() });
  assert.ok(names(out).includes('a'), 'the matching tool stays');
  assert.ok(!names(out).includes('b'), 'an unmatched tool is not force-included');
});

// ---------------------------------------------------------------------------
// ToolRefreshQueue
// ---------------------------------------------------------------------------

test('refresh queue records, peeks and clears', () => {
  const q = new ToolRefreshQueue();
  assert.deepEqual(q.peek(), []);
  q.push('read a spreadsheet');
  q.push('查天气');
  assert.deepEqual(q.peek(), ['read a spreadsheet', '查天气']);
  q.clear();
  assert.deepEqual(q.peek(), []);
});

test('refresh queue ignores blank intents', () => {
  const q = new ToolRefreshQueue();
  assert.equal(q.push('   '), 0);
  assert.deepEqual(q.peek(), []);
});

test('refresh queue is bounded so a model cannot grow it without limit', () => {
  const q = new ToolRefreshQueue();
  for (let i = 0; i < 50; i++) q.push(`intent ${i}`);
  assert.ok(q.peek().length <= 4, `queue must stay bounded, got ${q.peek().length}`);
});

test('refresh_tools reports success and records the intent', () => {
  const q = new ToolRefreshQueue();
  const res = refreshToolsResult(q, 'read a spreadsheet');
  assert.notEqual(res.isError, true);
  assert.deepEqual(q.peek(), ['read a spreadsheet']);
});

test('refresh_tools rejects an empty intent', () => {
  const res = refreshToolsResult(new ToolRefreshQueue(), '  ');
  assert.equal(res.isError, true);
});

test('refresh_tools is registered as a tool', () => {
  assert.ok(INTERNAL_TOOLS.has('refresh_tools'));
  assert.ok(ALL_TOOL_DEFS.some((d) => d.name === 'refresh_tools'));
});

// ---------------------------------------------------------------------------
// Skills progressive disclosure
// ---------------------------------------------------------------------------

const fakeSkills = [
  { name: 'weather', description: 'Query the weather for a city', rootDir: '/s/weather' },
  { name: 'gitee', description: 'Manage Gitee repositories and push code', rootDir: '/s/gitee' },
  { name: 'ppt', description: 'Build a horizontal swipe HTML slide deck', steps: [{ name: 'plan', done: 'outline' }] },
];

const fakeHost = {
  listSkills: () => fakeSkills,
  invokeSkill: async (name, task) => ({
    content: `<skill-instructions>\nbody of ${name}\n</skill-instructions>\n\nUser task: ${task}`,
  }),
};

test('skills disclosure registers three constant-size tools', () => {
  const reg = createSkillsDisclosureRegistry();
  assert.deepEqual(names(reg.defs), ['skills_index', 'skills_search', 'skills_load']);
  assert.ok(reg.defs.every((d) => typeof d.description === 'string' && d.description.length < 400));
});

test('skills_index lists every skill with a truncated description', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_index', {}, { skills: fakeHost });
  for (const s of fakeSkills) assert.ok(res.content.includes(s.name), `index must list ${s.name}`);
  assert.ok(res.content.includes('skills_load'), 'index must point at the load step');
});

test('skills_search finds a skill by topic and returns its name', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_search', { query: 'gitee' }, { skills: fakeHost });
  assert.ok(res.content.includes('gitee'));
});

test('skills_search reports no match without failing the turn', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_search', { query: 'zzzz' }, { skills: fakeHost });
  assert.notEqual(res.isError, true);
  assert.ok(res.content.includes('skills_index'), 'should fall back to the index');
});

test('skills_search requires a query', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_search', { query: '  ' }, { skills: fakeHost });
  assert.equal(res.isError, true);
});

test('skills_load returns the body through the core wrapper', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_load', { name: 'weather', task: '查天气' }, { skills: fakeHost });
  assert.ok(res.content.includes('<skill-instructions>'), 'must reuse the core injection wrapper');
  assert.ok(res.content.includes('body of weather'));
  assert.ok(res.content.includes('查天气'), 'must echo the caller task');
});

test('skills_load rejects an unknown skill and lists what exists', async () => {
  const reg = createSkillsDisclosureRegistry();
  const res = await reg.call('skills_load', { name: 'nope' }, { skills: fakeHost });
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('weather'), 'should list the available names');
});

test('the disclosure tools degrade safely with no skill host attached', async () => {
  const reg = createSkillsDisclosureRegistry();
  for (const name of names(reg.defs)) {
    const res = await reg.call(name, { name: 'x', query: 'y' }, {});
    assert.equal(res.isError, true, `${name} must report unavailable, not crash`);
  }
});

test('skills_load never reads SKILL.md from disk itself', async () => {
  // The core owns the <skill-instructions> prompt-injection boundary. If this
  // module ever inlined the body instead of delegating, that boundary would be
  // forked — so assert delegation is what actually happens.
  const reg = createSkillsDisclosureRegistry();
  let invoked = false;
  const res = await reg.call(
    'skills_load',
    { name: 'weather' },
    {
      skills: {
        listSkills: () => fakeSkills,
        invokeSkill: async () => {
          invoked = true;
          return { content: 'delegated' };
        },
      },
    },
  );
  assert.equal(invoked, true, 'must delegate to the core registry');
  assert.equal(res.content, 'delegated');
});

// ---------------------------------------------------------------------------
// Skill suppression
// ---------------------------------------------------------------------------

test('skillToolNames reads both the skill name and its tool names', () => {
  const fakeAgent = {
    skills: {
      list: () => [{ name: 'weather', tools: [{ name: 'weather_run' }] }, { name: 'gitee' }],
      callTool: async () => ({ content: 'x' }),
    },
  };
  const s = skillToolNames(fakeAgent);
  assert.ok(s.has('weather'));
  assert.ok(s.has('weather_run'));
  assert.ok(s.has('gitee'));
});

test('skillHostFromAgent returns null for an agent with no registry', () => {
  assert.equal(skillHostFromAgent({}), null);
  assert.equal(skillHostFromAgent(null), null);
  assert.equal(skillHostFromAgent(undefined), null);
});

test('skillHostFromAgent survives a registry that throws', () => {
  const host = skillHostFromAgent({
    skills: {
      list: () => {
        throw new Error('boom');
      },
      callTool: async () => ({ content: 'x' }),
    },
  });
  assert.deepEqual(host.listSkills(), [], 'a throwing list must degrade to empty');
});

// ---------------------------------------------------------------------------
// Routing metadata
// ---------------------------------------------------------------------------

test('applyRouting fills group/keywords without mutating the input', () => {
  const input = [{ name: 'git_commit', description: 'd', inputSchema: {} }];
  const out = applyRouting(input);
  assert.equal(out[0].group, 'git');
  assert.ok(out[0].keywords.includes('提交'));
  assert.equal(input[0].group, undefined, 'input must not be mutated');
});

test('applyRouting does not override metadata the def already declares', () => {
  const out = applyRouting([{ name: 'git_commit', description: 'd', inputSchema: {}, group: 'meta', keywords: ['zzz'] }]);
  assert.equal(out[0].group, 'meta');
  assert.deepEqual(out[0].keywords, ['zzz']);
});

test('every desktop tool def ends up with a group and keywords', () => {
  const missing = ALL_TOOL_DEFS.filter((d) => !d.group).map((d) => d.name);
  assert.deepEqual(missing, [], `defs without a routing group: ${missing.join(', ')}`);
});

test('routing covers the injected git and memory families', () => {
  for (const n of ['git_commit', 'git_push', 'git_status', 'read_graph', 'create_entities']) {
    assert.ok(TOOL_ROUTING[n], `${n} must be routable`);
  }
});

test('routing keywords are non-empty and lower-case-safe', () => {
  for (const [name, route] of Object.entries(TOOL_ROUTING)) {
    if (!route.keywords) continue;
    assert.ok(route.keywords.length > 0, `${name} has an empty keyword list`);
    assert.ok(route.keywords.every((k) => typeof k === 'string' && k.length > 0), `${name} has a bad keyword`);
  }
});

// ---------------------------------------------------------------------------
// The data-artifact tools must surface on their own, without the removed
// [Work Mode: Skill Enforcement] regex prompt injection.
// ---------------------------------------------------------------------------

test('no prompt injection hardcodes the sheet/chart tools any more', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const src = rf(join(dist, 'agent', 'service.js'), 'utf8');
  assert.ok(
    !src.includes('Work Mode: Skill Enforcement'),
    'the regex-triggered work-mode prompt injection should be gone',
  );
  assert.ok(
    !/hasDataFile|hasAnalysisKeyword/.test(src),
    'the CSV/分析 regex trigger should be gone',
  );
});

test('the "do not narrate file contents" constraint moved into the tool descriptions', async () => {
  const { SHEET_TOOL_DEFS } = await import(pathToFileURL(join(dist, 'skills', 'sheet.js')));
  const { CHART_TOOL_DEFS } = await import(pathToFileURL(join(dist, 'skills', 'chart.js')));
  const all = [...SHEET_TOOL_DEFS, ...CHART_TOOL_DEFS];
  // Deleting the system-prompt block would otherwise silently drop these rules.
  assert.ok(
    all.some((d) => /never summarize, quote or infer/i.test(d.description)),
    'sheet.read must carry the load-before-speaking constraint',
  );
  assert.ok(
    all.some((d) => /instead of computing it yourself/i.test(d.description)),
    'sheet.analyze must carry the do-not-compute constraint',
  );
  assert.ok(
    all.some((d) => /rather than\s+describing one in text/i.test(d.description)),
    'bi.chart must carry the render-dont-describe constraint',
  );
});

test('the data tools are surfaced by routing keywords alone', () => {
  const pool = [...ALL_TOOL_DEFS, ...deadFiller(60)];
  const cases = [
    ['分析一下 data.csv 的销售额', ['sheet.read', 'sheet.analyze']],
    ['把这个 excel 做个图表', ['sheet.read', 'bi.chart']],
    ['算一下 csv 的平均值', ['sheet.analyze']],
  ];
  for (const [prompt, expected] of cases) {
    const sel = names(selectTools(pool, { input: prompt, used: new Set() }));
    for (const tool of expected) {
      assert.ok(sel.includes(tool), `"${tool}" must surface for "${prompt}" without any prompt injection`);
    }
  }
});

// ---------------------------------------------------------------------------
// Parity with the core's own essentialTools allowlist
// ---------------------------------------------------------------------------

test('desktop ESSENTIAL_TOOLS covers every name in the core essentialTools list', () => {
  // The selector's floor is ESSENTIAL_TOOLS. If the core adds a tool to its own
  // bypass list and the desktop does not mirror it, that tool becomes hideable.
  // This test is the guard against that drifting apart silently.
  const coreAgent = readFileSync(
    join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'agent.js'),
    'utf8',
  );
  const block = coreAgent.match(/const essentialTools = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'could not locate the core essentialTools set — did the core change shape?');
  const coreNames = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(coreNames.length > 10, `parsed only ${coreNames.length} core essential tools`);
  const missing = coreNames.filter((n) => !ESSENTIAL_TOOLS.has(n));
  assert.deepEqual(
    missing,
    [],
    `core essentialTools not mirrored in ESSENTIAL_TOOLS (they would become hideable): ${missing.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Coverage of the core's own builtins
// ---------------------------------------------------------------------------

const CORE_SRC = join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src');
const { BUILTIN_TOOLS } = await import(pathToFileURL(join(CORE_SRC, 'mcp', 'builtin-tools.js')));

/**
 * Core builtins we deliberately leave unrouted.
 *
 * `add_inline_eval_whitelist` is an unattended-mode security escape hatch: it
 * widens what may run without a permission prompt. Keeping it out of every
 * route table is the safer default, so it must be named here rather than left to
 * chance.
 */
const UNROUTED_BY_DESIGN = new Map([
  ['add_inline_eval_whitelist', 'security escape hatch — must not be reachable by prompt wording'],
]);

test('every core builtin is pinned, routed, or explicitly unrouted by design', () => {
  // The failure this guards: a core-owned tool ships with an English-only
  // description, is absent from ESSENTIAL_TOOLS, and has no routing entry — so a
  // Chinese prompt scores it 0 and the model is never offered it. `acp_route` hit
  // exactly that and named-agent delegation became silently unusable.
  //
  // Requiring an explicit decision per tool means a new core builtin cannot slip
  // through unrouted: this test goes red and the author must pin it, route it, or
  // justify leaving it dark.
  const unrouted = BUILTIN_TOOLS.filter((t) => {
    if (ESSENTIAL_TOOLS.has(t.name)) return false;
    if (TOOL_ROUTING[t.name]?.keywords?.length) return false;
    return !UNROUTED_BY_DESIGN.has(t.name);
  }).map((t) => t.name);

  assert.deepEqual(
    unrouted,
    [],
    `core builtins with no keywords and not pinned — invisible on a CJK prompt: ${unrouted.join(', ')}. ` +
      `Add keywords to DESKTOP_ROUTING in src/tools/routing.ts, pin it in ESSENTIAL_TOOLS, ` +
      `or add it to UNROUTED_BY_DESIGN with a reason.`,
  );
});

test('UNROUTED_BY_DESIGN only names tools that exist', () => {
  // A stale entry would make the coverage test above pass for a tool that no
  // longer ships, so the exclusion list has to be pruned alongside the core.
  const known = new Set(BUILTIN_TOOLS.map((t) => t.name));
  const stale = [...UNROUTED_BY_DESIGN.keys()].filter((n) => !known.has(n));
  assert.deepEqual(stale, [], `UNROUTED_BY_DESIGN names tools the core no longer ships: ${stale.join(', ')}`);
});

test('acp_route is routed so named-agent delegation survives a Chinese prompt', () => {
  const route = TOOL_ROUTING.acp_route;
  assert.ok(route, 'acp_route needs a routing entry');
  assert.equal(route.group, 'acp');
  assert.ok(route.keywords.some((k) => /[一-鿿]/.test(k)), 'needs CJK trigger words');
  assert.ok(route.keywords.includes('claude'), 'needs the agent names users actually type');
});

test('a Chinese delegation request surfaces acp_route from a realistic pool', () => {
  // Regression test for the reported bug, end to end through the real selector.
  // The pool is shaped like the live one (core builtins + desktop defs + MCP
  // stand-ins) so this exercises ranking, not just the declaration.
  //
  // Deliberately no "unrouted variant must be dropped" precondition: weak bigram
  // similarity against the English description can keep a zero-keyword tool alive
  // by luck of the pool shape, so that assertion measured the fixture rather than
  // the behaviour. What must hold deterministically is that a delegation request
  // carrying an agent name routes on the keyword and survives selection.
  const mcpStand = Array.from({ length: 20 }, (_, i) => def(`pyright_${i}`, {
    server: 'mcp:pyright',
    group: 'meta',
    keywords: ['python', '类型', '诊断'],
  }));
  const pool = [...BUILTIN_TOOLS, ...ALL_TOOL_DEFS, ...mcpStand];
  assert.ok(pool.length > 40, `pool must be realistically large, got ${pool.length}`);

  for (const input of ['委派给claude', '派发任务到指定的agent', '把这个架构分析交给 claude 去做']) {
    const out = selectTools(pool, { input, used: new Set(), respectNarrowing: false });
    assert.ok(
      out.some((t) => t.name === 'acp_route'),
      `acp_route must survive a Chinese delegation request: "${input}"`,
    );
  }
});

test('a non-delegation prompt does not drag acp_route in', () => {
  // Keywords must not turn the tool into a permanent resident — that would spend
  // tokens on every round and invite misroutes.
  const mcpStand = Array.from({ length: 20 }, (_, i) => def(`pyright_${i}`, {
    server: 'mcp:pyright',
    group: 'meta',
    keywords: ['python', '类型', '诊断'],
  }));
  const pool = [...BUILTIN_TOOLS, ...ALL_TOOL_DEFS, ...mcpStand];
  const out = selectTools(pool, { input: 'git 提交一下', used: new Set(), respectNarrowing: false });
  assert.equal(out.some((t) => t.name === 'acp_route'), false);
});
