/**
 * Generate an ed25519 keypair for signing core update manifests.
 *
 * Usage:
 *   node scripts/generate-core-keys.mjs [--keys-dir <dir>]
 *
 * Produces:
 *   <keys-dir>/core-signing-private.pem   PEM-encoded private key (keep secret)
 *   <keys-dir>/core-signing-public.pem    PEM-encoded public key (bundle with app)
 *   <keys-dir>/core-signing-public.txt    raw hex public key (short form for embedding)
 *
 * The public hex key is what clients embed to verify signatures.
 * Exits 0 even if keys already exist (idempotent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const keysDir = flag('keys-dir') || path.join(root, '..', 'keys');

function main() {
  fs.mkdirSync(keysDir, { recursive: true });

  const privKeyFile = path.join(keysDir, 'core-signing-private.pem');
  const pubKeyFile = path.join(keysDir, 'core-signing-public.pem');
  const pubHexFile = path.join(keysDir, 'core-signing-public.txt');

  if (fs.existsSync(privKeyFile) && fs.existsSync(pubKeyFile)) {
    console.log(`[keys] keys already exist in ${keysDir}; skipping generation.`);
    return;
  }

  console.log(`[keys] generating ed25519 keypair in ${keysDir} ...`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const pubPem = publicKey.toString('pem');
  // Extract base64 content from PEM (strip BEGIN/END headers and whitespace).
  const rawHex = pubPem
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('')
    .trim();

  fs.writeFileSync(privKeyFile, privateKey.toString('pem'));
  fs.chmodSync(privKeyFile, 0o600);
  fs.writeFileSync(pubKeyFile, publicKey.toString('pem'));
  fs.writeFileSync(pubHexFile, rawHex);

  console.log(`[keys] private  -> ${privKeyFile}`);
  console.log(`[keys] public   -> ${pubKeyFile}`);
  console.log(`[keys] public-hex (${rawHex.length} chars) -> ${pubHexFile}`);
}

main();
