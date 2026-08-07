import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { join } from 'node:path';
import { minify } from 'terser';
import JavaScriptObfuscator from 'javascript-obfuscator';

const DIST_DIR = join(process.cwd(), 'dist');

const TERSER_OPTIONS = {
  compress: {
    passes: 2,
    drop_console: false,
    drop_debugger: true
  },
  mangle: {
    toplevel: false,
    reserved: ['electron', 'require', 'module', 'exports']
  },
  format: {
    comments: false
  }
};

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  renameGlobals: false,
  selfDefending: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'mangled-shuffled',
  target: 'browser'
};

async function processFile(filePath) {
  const code = readFileSync(filePath, 'utf-8');
  if (code.trim().length === 0) return;

  try {
    const terserResult = await minify(code, TERSER_OPTIONS);
    if (!terserResult.code) return;

    const obfuscated = JavaScriptObfuscator.obfuscate(
      terserResult.code,
      OBFUSCATOR_OPTIONS
    );

    writeFileSync(filePath, obfuscated.getObfuscatedCode());
    console.log(`  ✓ ${filePath.replace(DIST_DIR, 'dist')}`);
  } catch (err) {
    console.error(`  ✗ ${filePath.replace(DIST_DIR, 'dist')}: ${err.message}`);
  }
}

async function main() {
  console.log('Obfuscating dist/...\n');

  const SKIP_FILES = ['launcher.js'];
  const files = [];
  for await (const entry of glob(join(DIST_DIR, '**', '*.js'))) {
    const fileName = entry.split(/[\\/]/).pop();
    if (!SKIP_FILES.includes(fileName)) {
      files.push(entry);
    }
  }

  if (files.length === 0) {
    console.log('No JS files found in dist/');
    return;
  }

  console.log(`Found ${files.length} files (skipping ${SKIP_FILES.join(', ')})\n`);

  for (const file of files) {
    await processFile(file);
  }

  console.log('\nDone!');
}

main().catch(console.error);
