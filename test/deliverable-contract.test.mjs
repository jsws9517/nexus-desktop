/**
 * Deliverable Contract — parsing, verification, anti-cheat tests.
 *
 * The contract is what turns "done" from a claim into a boolean. These tests
 * pin the seven shortcut patterns from the design doc.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseContract,
  verifyContract,
  antiCheatChecks,
  claimsCompletion,
  formatContractCorrection,
  requestImpliesImplementation,
} = await import('../dist/agent/deliverable-contract.js');

describe('contract parsing', () => {
  it('extracts an explicitly requested file', () => {
    const c = parseContract('请创建 `src/parser.ts` 并实现解析逻辑');
    assert.ok(c.items.some((i) => i.kind === 'file_exists' && i.path === 'src/parser.ts'));
    assert.equal(c.source, 'parsed_from_user');
  });

  it('extracts test commands', () => {
    const c = parseContract('实现后运行 npm test 并确保通过');
    assert.ok(c.items.some((i) => i.kind === 'test_pass' && /npm\s+test/.test(i.cmd)));
  });

  it('extracts build commands', () => {
    const c = parseContract('最后确保 npm run build 成功');
    assert.ok(c.items.some((i) => i.kind === 'exit_zero' && /npm run build/.test(i.cmd)));
  });

  it('extracts citation and numeric requirements', () => {
    const c = parseContract('写一份调研报告，至少 3 个来源，附参考文献');
    assert.ok(c.items.some((i) => i.kind === 'citation'));
    assert.ok(c.items.some((i) => i.kind === 'numeric' && i.expect === 3));
  });

  it('does not turn a mere mention into a deliverable', () => {
    const c = parseContract('看一下 package.json 里怎么配置的');
    assert.equal(c.items.filter((i) => i.kind === 'file_exists').length, 0);
  });

  it('falls back to inferred_baseline when nothing is checkable', () => {
    const c = parseContract('解释一下什么是闭包');
    assert.equal(c.items.length, 0);
    assert.equal(c.source, 'inferred_baseline');
  });

  it('detects implementation requests', () => {
    assert.equal(requestImpliesImplementation('实现一个解析器'), true);
    assert.equal(requestImpliesImplementation('解释一下这个函数'), false);
  });
});

describe('contract verification', () => {
  const contract = {
    items: [
      { kind: 'file_exists', path: 'out/a.ts', nonEmpty: true },
      { kind: 'test_pass', cmd: 'npm test' },
      { kind: 'citation', min: 2 },
    ],
    source: 'parsed_from_user',
    raw: '',
  };

  it('passes when every item is satisfied', () => {
    const v = verifyContract(contract, {
      exists: (p) => p === 'out/a.ts',
      size: () => 12,
      run: () => ({ code: 0, stdout: 'ok', stderr: '' }),
      citationCount: 3,
    });
    assert.equal(v.passed, true);
    assert.equal(v.failed.length, 0);
    assert.equal(v.checked, 3);
  });

  it('reports each failure with evidence', () => {
    const v = verifyContract(contract, {
      exists: () => false,
      run: () => ({ code: 1, stdout: '', stderr: 'boom' }),
      citationCount: 0,
    });
    assert.equal(v.passed, false);
    assert.equal(v.failed.length, 3);
    assert.ok(v.failed.every((f) => f.why.length > 0));
  });

  it('skips command items when no runner is provided', () => {
    const v = verifyContract(contract, {
      exists: () => true,
      size: () => 1,
      citationCount: 2,
    });
    assert.equal(v.passed, true);
    assert.ok(v.skipped.some((s) => s.item.kind === 'test_pass'));
  });
});

describe('completion claim detection', () => {
  it('recognises Chinese and English claims', () => {
    assert.equal(claimsCompletion('已完成，所有测试通过。'), true);
    assert.equal(claimsCompletion('All done — implemented the parser.'), true);
  });

  it('rejects negated claims', () => {
    assert.equal(claimsCompletion('尚未完成，还差一个测试。'), false);
    assert.equal(claimsCompletion('not completed yet'), false);
  });
});

describe('anti-cheat checks', () => {
  const mk = (overrides) => ({
    userRequest: '实现解析器并修复 bug',
    diffKnown: true,
    transcript: [],
    diff: { files: [] },
    ...overrides,
  });

  it('flags tests-only changes', () => {
    const findings = antiCheatChecks(
      mk({
        diff: { files: [{ path: 'test/parser.test.mjs', added: 10, removed: 0 }] },
      }),
    );
    assert.ok(findings.some((f) => f.id === 'tests_only_change'));
  });

  it('flags removed assertions with no additions', () => {
    const findings = antiCheatChecks(
      mk({
        diff: {
          files: [
            {
              path: 'test/x.test.mjs',
              added: 1,
              removed: 2,
              patch: '-assert.equal(a, 1)\n-assert.equal(b, 2)\n+// removed\n',
            },
          ],
        },
      }),
    );
    assert.ok(findings.some((f) => f.id === 'assertion_deleted'));
  });

  it('flags stub-as-implementation when completion is claimed', () => {
    const findings = antiCheatChecks(
      mk({
        diff: {
          files: [
            {
              path: 'src/parser.ts',
              added: 2,
              removed: 0,
              patch: '+export function parse() { throw new Error("not implemented") }\n',
            },
          ],
        },
        transcript: [
          { role: 'assistant', text: '已完成解析器实现', toolCalls: 3 },
        ],
      }),
    );
    assert.ok(findings.some((f) => f.id === 'stub_as_impl'));
  });

  it('flags narration without action', () => {
    const findings = antiCheatChecks(
      mk({
        diff: { files: [{ path: 'src/parser.ts', added: 1, removed: 0 }] },
        transcript: [{ role: 'assistant', text: '已完成，全部搞定', toolCalls: 0 }],
      }),
    );
    assert.ok(findings.some((f) => f.id === 'narration_without_action'));
  });

  it('flags pushing work back to the user', () => {
    const findings = antiCheatChecks(
      mk({
        diff: { files: [{ path: 'src/parser.ts', added: 1, removed: 0 }] },
        transcript: [
          { role: 'assistant', text: '请你手动运行 npm test 检查一下', toolCalls: 0 },
        ],
      }),
    );
    assert.ok(findings.some((f) => f.id === 'pushback_to_user'));
  });

  it('flags an empty diff when completion is claimed', () => {
    const findings = antiCheatChecks(
      mk({ transcript: [{ role: 'assistant', text: 'Done, implemented it.', toolCalls: 2 }] }),
    );
    assert.ok(findings.some((f) => f.id === 'empty_diff_claims'));
  });

  it('flags a claimed artifact with no file named', () => {
    const findings = antiCheatChecks(
      mk({
        diff: { files: [{ path: 'src/parser.ts', added: 1, removed: 0 }] },
        transcript: [{ role: 'assistant', text: '报告已生成并保存', toolCalls: 1 }],
      }),
    );
    assert.ok(findings.some((f) => f.id === 'report_without_artifact'));
  });

  it('skips diff-derived checks when the diff is unknown', () => {
    const findings = antiCheatChecks(
      mk({
        diffKnown: false,
        transcript: [{ role: 'assistant', text: 'Done, implemented it.', toolCalls: 2 }],
      }),
    );
    assert.equal(findings.some((f) => f.id === 'empty_diff_claims'), false);
  });
});

describe('correction hint formatting', () => {
  it('names every failing item', () => {
    const hint = formatContractCorrection(
      {
        passed: false,
        checked: 1,
        failed: [{ item: { kind: 'file_exists', path: 'a.ts' }, why: 'missing' }],
        skipped: [],
      },
      [{ id: 'narration_without_action', severity: 'high', evidence: 'no tools' }],
    );
    assert.ok(hint.includes('shortcut_suspect'));
    assert.ok(hint.includes('a.ts'));
    assert.ok(hint.includes('narration_without_action'));
  });

  it('returns an empty string when nothing failed', () => {
    assert.equal(formatContractCorrection(null, []), '');
  });
});
