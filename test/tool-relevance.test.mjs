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