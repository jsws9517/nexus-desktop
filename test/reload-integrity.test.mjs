/**
 * H-4: config hot-reload integrity.
 *
 * The concern: if any getter caches a reference at construction time, a
 * reload() / reloadMailAndBg() leaves that subsystem stale. These tests pin
 * the invariant: every getter returns live data from the current this.config.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nexus-reload-integrity-'));
process.env.NEXUS_CONFIG_DIR = join(tmp, '.nexus');
process.env.LLMA_DATA_DIR = join(tmp, '.llm-agent');

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const { ConfigManager } = await import('nexus-coder/dist/src/config/index.js');

function writeConfig(cfg) {
  mkdirSync(join(tmp, '.nexus'), { recursive: true });
  writeFileSync(join(tmp, '.nexus', 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

describe('ConfigManager reload integrity (H-4)', () => {
  it('reload() replaces getPlatforms() with disk value', () => {
    writeConfig({ platforms: { feishu: [{ app_id: 'a', enabled: true }] } });
    const cfg = new ConfigManager();
    const before = cfg.getPlatforms();
    assert.ok(before.feishu, 'initial platforms loaded');

    writeConfig({ platforms: { telegram: [{ token: 't', enabled: true }] } });
    cfg.reload();

    const after = cfg.getPlatforms();
    assert.ok(!after.feishu, 'feishu should be gone after reload');
    assert.ok(after.telegram, 'telegram should appear after reload');
    assert.notEqual(before, after, 'reload must not return the same object reference');
  });

  it('reload() replaces getMail() with disk value', () => {
    writeConfig({ mail: { provider: 'smtp', host: 'a' } });
    const cfg = new ConfigManager();
    const before = cfg.getMail();
    assert.equal(before?.host, 'a');

    writeConfig({ mail: { provider: 'smtp', host: 'b' } });
    cfg.reload();

    const after = cfg.getMail();
    assert.equal(after?.host, 'b');
    assert.notEqual(before, after, 'getMail() must return the new reference');
  });

  it('reloadMailAndBg() refreshes mail + bg but NOT platforms', () => {
    writeConfig({
      platforms: { feishu: [{ app_id: 'x', enabled: true }] },
      mail: { provider: 'smtp', host: 'm1' },
      bg: { notifyRoute: 'auto' },
    });
    const cfg = new ConfigManager();

    // Change disk: platforms + mail + bg all different
    writeConfig({
      platforms: { telegram: [{ token: 'tg', enabled: true }] },
      mail: { provider: 'smtp', host: 'm2' },
      bg: { notifyRoute: 'mail' },
    });

    cfg.reloadMailAndBg();

    // mail + bg refreshed
    assert.equal(cfg.getMail()?.host, 'm2');
    assert.equal(cfg.getBgConfig().notifyRoute, 'mail');
    // platforms NOT refreshed (narrow reload leaves it stale by design)
    assert.ok(cfg.getPlatforms().feishu, 'platforms unchanged after narrow reload');
    assert.ok(!cfg.getPlatforms().telegram, 'new telegram not visible until full reload');

    // Full reload fixes it
    cfg.reload();
    assert.ok(cfg.getPlatforms().telegram);
    assert.ok(!cfg.getPlatforms().feishu);
  });

  it('getBgConfig() returns live values after reload', () => {
    writeConfig({ bg: { autoRoute: true, notifyRoute: 'auto' } });
    const cfg = new ConfigManager();
    assert.equal(cfg.getBgConfig().autoRoute, true);

    writeConfig({ bg: { autoRoute: false, notifyRoute: 'mail' } });
    cfg.reload();

    assert.equal(cfg.getBgConfig().autoRoute, false);
    assert.equal(cfg.getBgConfig().notifyRoute, 'mail');
  });

  it('getSubAgentMaxTurns() returns live values after reload', () => {
    writeConfig({ subAgents: { maxTurns: { general: 10 } } });
    const cfg = new ConfigManager();
    assert.equal(cfg.getSubAgentMaxTurns('general'), 10);

    writeConfig({ subAgents: { maxTurns: { general: 20 } } });
    cfg.reload();

    assert.equal(cfg.getSubAgentMaxTurns('general'), 20);
  });
});
