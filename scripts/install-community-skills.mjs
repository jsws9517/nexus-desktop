// Download community skills from mattpocock/skills into ~/.nexus/skills/
// so they are available to the agent on next startup.
//
// Usage:  node scripts/install-community-skills.mjs
//         npm run install-skills
//
// Skill manifest — add or remove entries as desired.
// Each entry: { name, category, extra[] }
//   - name     directory name under skills/<category> in the upstream repo
//   - category engineering | productivity | misc | personal
//   - extra[]  additional files to fetch alongside SKILL.md

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { get } from 'https';

const BASE = 'https://raw.githubusercontent.com/mattpocock/skills/main/skills';

const SKILLS = [
  // ── Tier 1  Engineering ──────────────────────────────────────────────
  { name: 'diagnosing-bugs',             category: 'engineering',    extra: [] },
  { name: 'code-review',                 category: 'engineering',    extra: [] },
  { name: 'tdd',                         category: 'engineering',    extra: ['tests.md'] },
  { name: 'research',                    category: 'engineering',    extra: [] },
  { name: 'resolving-merge-conflicts',   category: 'engineering',    extra: [] },

  // ── Tier 2  Productivity ─────────────────────────────────────────────
  { name: 'grill-me',                    category: 'productivity',   extra: [] },
  { name: 'grilling',                    category: 'productivity',   extra: [] },
  { name: 'handoff',                     category: 'productivity',   extra: [] },
  { name: 'writing-great-skills',        category: 'productivity',   extra: ['GLOSSARY.md'] },

  // ── Tier 2  Engineering ──────────────────────────────────────────────
  { name: 'codebase-design',             category: 'engineering',    extra: ['DEEPENING.md', 'DESIGN-IT-TWICE.md'] },
  { name: 'domain-modeling',             category: 'engineering',    extra: ['CONTEXT-FORMAT.md', 'ADR-FORMAT.md'] },
];

const DEST = join(homedir(), '.nexus', 'skills');
const FORCE = process.argv.includes('--force');

function allInstalled() {
  for (const skill of SKILLS) {
    if (!existsSync(join(DEST, skill.name, 'SKILL.md'))) return false;
    for (const file of skill.extra) {
      if (!existsSync(join(DEST, skill.name, file))) return false;
    }
  }
  return true;
}

function httpGet(url, retries = 3) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (n > 0) {
            setTimeout(() => attempt(n - 1), 1000);
          } else {
            resolve(null);
          }
          return;
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', () => {
        if (n > 0) {
          setTimeout(() => attempt(n - 1), 1000);
        } else {
          resolve(null);
        }
      });
    };
    attempt(retries);
  });
}

async function main() {
  if (!FORCE && allInstalled()) {
    console.log(`All ${SKILLS.length} community skills already installed.`);
    return;
  }

  if (FORCE) console.log('Re-installing community skills (--force) →', DEST);
  else console.log('Installing community skills →', DEST);

  let ok = 0;
  let fail = 0;

  for (const skill of SKILLS) {
    const dir = join(DEST, skill.name);
    mkdirSync(dir, { recursive: true });

    // ── SKILL.md ─────────────────────────────────────────────────────
    const skUrl = `${BASE}/${skill.category}/${skill.name}/SKILL.md`;
    const body = await httpGet(skUrl);
    if (body === null) {
      console.warn(`  [FAIL]  ${skill.name}/SKILL.md  —  ${skUrl}`);
      fail++;
      continue;
    }
    writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
    ok++;
    console.log(`  [OK]    ${skill.name}/SKILL.md`);

    // ── extra files ───────────────────────────────────────────────────
    for (const file of skill.extra) {
      const url = `${BASE}/${skill.category}/${skill.name}/${file}`;
      const content = await httpGet(url);
      if (content === null) {
        console.warn(`  [WARN]  ${skill.name}/${file}  —  not found, skipping`);
        continue;
      }
      writeFileSync(join(dir, file), content, 'utf-8');
      ok++;
      console.log(`  [OK]    ${skill.name}/${file}`);
    }
  }

  const total = SKILLS.length;
  const installed = total - fail;
  console.log(`\nDone. ${installed}/${total} skill(s) installed (${ok} file(s) total).`);
  if (fail > 0) process.exitCode = 1;
}

main();
