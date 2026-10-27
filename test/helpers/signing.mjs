/**
 * Signing material for core-overlay tests.
 *
 * Developers have `keys/core-signing-private.pem` locally (gitignored); CI does
 * not, so generate an ephemeral ed25519 key there. Tests must trust the matching
 * public key via `NEXUS_CORE_SIGNING_PUBKEY_HEX`, otherwise they would only pass
 * on a machine that happens to hold the release key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

export function loadSigningKey() {
  const file = path.resolve('keys', 'core-signing-private.pem');
  const fromDisk = fs.existsSync(file);
  const privateKey = fromDisk
    ? createPrivateKey(fs.readFileSync(file))
    : generateKeyPairSync('ed25519').privateKey;
  return {
    privateKey,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    pubKeyB64: createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    fromDisk,
  };
}
