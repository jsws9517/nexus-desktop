import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ConfigManager } from '../config/index.js';
import { decryptApiKey } from '../security/env-key-encrypt.js';
import { uploadImage, deleteImage, isCloudinaryAvailable } from './upload.js';
import { analyzeLocal, isLocalVisionAvailable } from './local.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

export function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function imageToDataUri(filePath: string): string {
  const absPath = resolve(process.cwd(), filePath);
  if (!existsSync(absPath)) throw new Error(`Image file not found: ${filePath}`);
  const ext = absPath.toLowerCase();
  const mime =
    ext.endsWith('.png') ? 'image/png' :
    ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' :
    ext.endsWith('.gif') ? 'image/gif' :
    ext.endsWith('.webp') ? 'image/webp' :
    ext.endsWith('.bmp') ? 'image/bmp' :
    'image/png';
  const data = readFileSync(absPath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function callCloudVision(
  apiKey: string, baseUrl: string, model: string,
  imageUrl: string, question: string,
): Promise<string> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: question },
        ],
      }],
      max_tokens: 2048,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown error');
    throw new Error(`Vision API error (${response.status}): ${errText}`);
  }
  const json = await response.json() as any;
  return json?.choices?.[0]?.message?.content || '';
}

async function tryCloud(imagePath: string, q: string): Promise<string> {
  const config = new ConfigManager();
  let lastError: Error | null = null;
  const providers = config.getVisionProviders();
  const activeName = config.getActiveVisionProvider();
  const orderedNames: string[] = [];
  if (providers[activeName]) orderedNames.push(activeName);
  for (const name of Object.keys(providers)) {
    if (name !== activeName) orderedNames.push(name);
  }

  for (const name of orderedNames) {
    let resolved: { apiKey: string; baseUrl: string; model: string };
    try { resolved = config.getVisionProvider(name); } catch { continue; }
    if (!resolved.apiKey) continue;
    const apiKey = decryptApiKey(resolved.apiKey);
    if (!apiKey) continue;

    // Upload to Cloudinary if available, else embed image as data URI
    let uploaded: { url: string; publicId: string } | null = null;
    try {
      if (isCloudinaryAvailable()) {
        uploaded = await uploadImage(imagePath);
      }
      const imageUrl = uploaded ? uploaded.url : imageToDataUri(imagePath);
      const content = await callCloudVision(apiKey, resolved.baseUrl, resolved.model, imageUrl, q);
      return `[Image analysis via ${name} (${resolved.model})]\n${content.trim()}`;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const statusMatch = lastError.message.match(/Vision API error \((\d+)\)/);
      const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;
      if (status === 401 || status === 403 || status === 429 || status >= 500) break;
    } finally {
      // Fire-and-forget cleanup: delete from Cloudinary immediately after use.
      // Non-blocking — adds no latency to the vision response.
      if (uploaded) deleteImage(uploaded.publicId);
    }
  }

  throw lastError || new Error('No vision provider available');
}

async function tryLocal(imagePath: string, q: string): Promise<string> {
  if (!isLocalVisionAvailable()) {
    throw new Error('Local vision (Florence-2) is not available');
  }
  return await analyzeLocal(imagePath, q);
}

export async function analyzeImage(imagePath: string, question?: string): Promise<string> {
  const q = (question?.trim() || '请详细描述这张图片的内容。Please describe this image in detail.');
  const config = new ConfigManager();
  const mode = config.getVisionMode();

  switch (mode) {
    case 'local-only': {
      return await tryLocal(imagePath, q);
    }

    case 'cloud-only': {
      return await tryCloud(imagePath, q);
    }

    case 'cloud-first': {
      try {
        return await tryCloud(imagePath, q);
      } catch (cloudErr) {
        const cloudMsg = cloudErr instanceof Error ? cloudErr.message : String(cloudErr);
        process.stderr.write(`[vision] Cloud analysis failed, falling back to local: ${cloudMsg}\n`);
        return await tryLocal(imagePath, q);
      }
    }

    case 'local-first':
    default: {
      try {
        return await tryLocal(imagePath, q);
      } catch (localErr) {
        const localMsg = localErr instanceof Error ? localErr.message : String(localErr);
        process.stderr.write(`[vision] Local analysis failed, falling back to cloud: ${localMsg}\n`);
        return await tryCloud(imagePath, q);
      }
    }
  }
}
