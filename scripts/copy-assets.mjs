import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcStatic = join(__dirname, '..', 'static');
const outStatic = join(__dirname, '..', 'dist', 'static');

if (existsSync(srcStatic)) {
  mkdirSync(outStatic, { recursive: true });
  for (const file of readdirSync(srcStatic)) {
    copyFileSync(join(srcStatic, file), join(outStatic, file));
    console.log(`[nexus-desktop] copied static/${file}`);
  }
}
