import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootCore = join(__dirname, '..', '..', 'dist', 'src');
const outCore = join(__dirname, '..', 'vendor', 'core', 'src');

if (!existsSync(rootCore)) {
  console.error(
    '[nexus-desktop] Core build not found at dist/src. Run "npm run build" in the repo root first.',
  );
  process.exit(1);
}

rmSync(join(outCore, '..'), { recursive: true, force: true });
mkdirSync(dirname(outCore), { recursive: true });
cpSync(rootCore, outCore, { recursive: true });
console.log(`[nexus-desktop] core copied: ${outCore}`);
