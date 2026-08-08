import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/set-version.mjs <version>');
  process.exit(1);
}

function updateVersionInJson(file) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data.version === 'string') data.version = version;
  // lockfileVersion 3: root package descriptor also carries its own version.
  if (data.packages && data.packages['']) {
    data.packages[''].version = version;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

updateVersionInJson('package.json');
updateVersionInJson('package-lock.json');
console.log(`set version to ${version} in package.json and package-lock.json`);
