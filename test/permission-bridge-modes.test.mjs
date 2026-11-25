/**
 * The desktop `onPermissionRequest` bridge must be non-interactive for BOTH
 * auto and unattended (docs/permissions-modes.md, §unattended).
 *
 * Regression: the old branch only special-cased `auto`; `unattended` fell
 * through to `askPermission()` and could surface a UI card that stayed pending
 * until the 10-minute timeout. The core deliberately skips batch permission in
 * unattended (agent.js: needsBatchPermission = mode !== 'unattended'), so the
 * desktop bridge is the last line of defence against a stray interactive card.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nexus-perm-bridge-'));
process.env.NEXUS_CONFIG_DIR = join(tmp, '.nexus');
process.env.LLMA_DATA_DIR = join(tmp, '.llm-agent');
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
after(() => rmSync(tmp, { recursive: true, force: true }));

const { AgentService } = await import('../dist/agent/service.js');

describe('onPermissionRequest mode contract', () => {
  let svc;

  before(async () => {
    svc = new AgentService();
    await svc.earlyInit();
  });

  after(async () => {
    try {
      await svc.agent?.shutdown?.();
    } catch {}
  });

  for (const mode of ['auto', 'unattended']) {
    it(`${mode}: allows immediately, never opens a permission card`, async () => {
      await svc.setPermissionsOverride(mode);
      let cards = 0;
      svc.onPermission = () => { cards += 1; };
      const verdict = await svc.agent.onPermissionRequest('hypothetical_tool', 'call-1', { a: 1 });
      assert.deepEqual(verdict, { verdict: 'allow' });
      assert.equal(cards, 0, `${mode} must not be interactive`);
    });
  }

  it('prompt: still asks the user and honors an allow answer', async () => {
    await svc.setPermissionsOverride('prompt');
    let seenQuestion = '';
    svc.onPermission = ({ id, question }) => {
      seenQuestion = question;
      void svc.resolvePermission(id, 'y');
    };
    const verdict = await svc.agent.onPermissionRequest('hypothetical_tool', 'call-2', { a: 2 });
    assert.deepEqual(verdict, { verdict: 'allow' });
    assert.match(seenQuestion, /hypothetical_tool/);
  });

  it('setPermissionsOverride mirrors the effective mode into acp.permissionMode', async () => {
    await svc.setPermissionsOverride('unattended');
    assert.equal(svc.getActiveMode(), 'unattended');
    assert.equal(svc.agent.config.getAcpConfig()?.permissionMode, 'auto');

    await svc.setPermissionsOverride('auto');
    assert.equal(svc.getActiveMode(), 'auto');
    assert.equal(svc.agent.config.getAcpConfig()?.permissionMode, 'auto');

    await svc.setPermissionsOverride('prompt');
    assert.equal(svc.getActiveMode(), 'prompt');
    assert.equal(svc.agent.config.getAcpConfig()?.permissionMode, 'prompt');
  });

  it('auto never opens a card even if a stray caller reaches askPermission', async () => {
    await svc.setPermissionsOverride('auto');
    let cards = 0;
    svc.onPermission = () => { cards += 1; };
    const answer = await svc.askPermission('Tool "hypothetical_tool" requested permission.\nArgs: {}');
    assert.equal(answer, 'y');
    assert.equal(cards, 0);
  });

  it('ACP registration re-asserts the desktop bridge instead of an ACP handler', async () => {
    await svc.setPermissionsOverride('auto');
    svc.agent.onPermissionRequest = async () => ({ verdict: 'deny' });
    let cards = 0;
    svc.onPermission = () => { cards += 1; };
    await svc.initAcp();
    const verdict = await svc.agent.onPermissionRequest('hypothetical_tool', 'call-3', { a: 3 });
    assert.deepEqual(verdict, { verdict: 'allow' });
    assert.equal(cards, 0);
  });
});
