import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { authorizePath } from '../security/path-authorizer.js';

// Lazy-loaded Cloudinary config — module loads successfully even without env vars
let _cloudName: string | null = null;
let _apiKey: string | null = null;
let _apiSecret: string | null = null;
let _configChecked = false;

function ensureConfig(): boolean {
  if (_configChecked) return _cloudName !== null;
  _configChecked = true;
  _cloudName = process.env.CLOUDINARY_CLOUD_NAME || null;
  _apiKey = process.env.CLOUDINARY_API_KEY || null;
  _apiSecret = process.env.CLOUDINARY_API_SECRET || null;
  return _cloudName !== null && _apiKey !== null && _apiSecret !== null;
}

export function isCloudinaryAvailable(): boolean {
  return ensureConfig();
}

function timestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(str: string): string {
  return createHash('sha1').update(str).digest('hex');
}

async function uploadToCloudinary(filePath: string): Promise<{ url: string; publicId: string }> {
  if (!ensureConfig()) throw new Error('Cloudinary not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');

  const absPath = resolve(process.cwd(), filePath);
  // Gate the upload behind the path-authorizer so arbitrary files cannot be
  // exfiltrated to a third-party image host.
  if (!(await authorizePath(absPath))) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed path list.`);
  }
  if (!existsSync(absPath)) throw new Error(`File not found: ${filePath}`);

  const data = readFileSync(absPath);
  const base64 = data.toString('base64');
  const ts = timestamp();

  const ext = absPath.toLowerCase();
  const mime =
    ext.endsWith('.png') ? 'image/png' :
    ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' :
    ext.endsWith('.gif') ? 'image/gif' :
    ext.endsWith('.webp') ? 'image/webp' :
    ext.endsWith('.bmp') ? 'image/bmp' :
    'image/png';

  const formData = new FormData();
  formData.append('file', `data:${mime};base64,${base64}`);
  formData.append('api_key', _apiKey!);
  formData.append('timestamp', String(ts));
  formData.append('signature', sign(`timestamp=${ts}${_apiSecret}`));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${_cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown');
    throw new Error(`Cloudinary upload failed (${res.status}): ${err}`);
  }

  const json = await res.json() as any;
  return { url: json.secure_url as string, publicId: json.public_id as string };
}

/**
 * Delete an uploaded image from Cloudinary by its public_id.
 * Errors are logged to stderr but never thrown — cleanup is best-effort.
 */
export async function deleteImage(publicId: string): Promise<void> {
  if (!ensureConfig()) return;

  const ts = timestamp();
  const params = `public_id=${publicId}&timestamp=${ts}`;
  const signature = sign(`${params}${_apiSecret}`);

  const formData = new FormData();
  formData.append('public_id', publicId);
  formData.append('api_key', _apiKey!);
  formData.append('timestamp', String(ts));
  formData.append('signature', signature);

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${_cloudName}/image/destroy`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown');
      process.stderr.write(`[vision] Cloudinary cleanup warning (${res.status}): ${err}\n`);
    }
  } catch (err) {
    process.stderr.write(`[vision] Cloudinary cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Upload a local image to Cloudinary and return the URL + public_id.
 * For the vision pipeline the caller should call deleteImage() after analysis
 * to avoid accumulating temporary files and wasting Cloudinary credits.
 */
export async function uploadImage(filePath: string): Promise<{ url: string; publicId: string }> {
  return uploadToCloudinary(filePath);
}
