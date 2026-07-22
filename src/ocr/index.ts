import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ConfigManager } from '../config/index.js';
import { decryptApiKey } from '../security/env-key-encrypt.js';
import { authorizePath } from '../security/path-authorizer.js';
import { redactPaths } from '../utils/sanitize.js';

export type OcrProviderType = 'openai-compatible' | 'paddleocr';

export interface OcrResult {
  text: string;
  provider: string;
  model?: string;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

export function isOcrImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

async function imageToDataUri(filePath: string): Promise<string> {
  const absPath = resolve(process.cwd(), filePath);
  if (!(await authorizePath(absPath))) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed path list.`);
  }
  if (!existsSync(absPath)) throw new Error(`Image file not found: ${redactPaths(filePath)}`);
  const ext = absPath.toLowerCase();
  const mime =
    ext.endsWith('.png') ? 'image/png' :
    ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' :
    ext.endsWith('.gif') ? 'image/gif' :
    ext.endsWith('.webp') ? 'image/webp' :
    ext.endsWith('.bmp') ? 'image/bmp' :
    ext.endsWith('.tiff') || ext.endsWith('.tif') ? 'image/tiff' :
    'image/png';
  const data = readFileSync(absPath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * Call an OpenAI-compatible API for OCR text extraction.
 * The prompt is engineered to extract all visible text from the image.
 */
async function callOpenAiCompatibleOcr(
  apiKey: string, baseUrl: string, model: string,
  imageUrl: string, language?: string,
): Promise<string> {
  const langHint = language ? ` Language: ${language}.` : '';
  const prompt = `Extract ALL visible text from this image. Return only the extracted text, preserving the original layout and line breaks as much as possible.${langHint} Do not describe the image, only extract text.`;

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown error');
    throw new Error(`OCR API error (${response.status}): ${errText}`);
  }

  const json = await response.json() as any;
  return json?.choices?.[0]?.message?.content || '';
}

/**
 * Call a local PaddleOCR server for text extraction.
 * PaddleOCR can be started as a HTTP server or invoked via CLI.
 */
async function callPaddleOcr(
  imagePath: string,
  command?: string,
  args?: string[],
  language?: string,
): Promise<string> {
  const absPath = resolve(process.cwd(), imagePath);
  if (!(await authorizePath(absPath))) {
    throw new Error(`Access denied: "${imagePath}" is not in the allowed path list.`);
  }
  if (!existsSync(absPath)) {
    throw new Error(`Image file not found: ${redactPaths(imagePath)}`);
  }

  // Try HTTP server mode first (PaddleOCR serving)
  // Then fall back to CLI mode
  const cmd = command || 'paddleocr';
  const lang = language || 'en';

  // CLI mode: paddleocr --image_dir <path> --lang <lang> --use_angle_cls true
  const { execSync } = await import('child_process');
  const cliArgs = args || ['--image_dir', absPath, '--lang', lang, '--use_angle_cls', 'true', '--ocr_version', 'PP-OCRv4'];
  const fullCmd = `"${cmd}" ${cliArgs.join(' ')}`;

  try {
    const output = execSync(fullCmd, {
      timeout: 60000,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    // PaddleOCR outputs text lines, parse them
    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('['));
    return lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`PaddleOCR failed: ${msg}`);
  }
}

/**
 * Try OCR using configured providers in priority order.
 * Returns the first successful result.
 */
async function tryOcrProviders(
  imagePath: string,
  language?: string,
): Promise<OcrResult> {
  const config = new ConfigManager();
  const providers = config.getOcrProviders();
  const activeName = config.getActiveOcrProvider();

  // Build ordered list: active first, then others
  const orderedNames: string[] = [];
  if (providers[activeName]) orderedNames.push(activeName);
  for (const name of Object.keys(providers)) {
    if (name !== activeName) orderedNames.push(name);
  }

  if (orderedNames.length === 0) {
    throw new Error('No OCR provider configured. Use "nexus config ocr set" to add one.');
  }

  let lastError: Error | null = null;

  for (const name of orderedNames) {
    let provider: { type: string; apiKey?: string; baseUrl?: string; model?: string; command?: string; args?: string[]; languages?: string[] };
    try {
      provider = config.getOcrProvider(name);
    } catch {
      continue;
    }

    try {
      if (provider.type === 'openai-compatible') {
        const apiKey = provider.apiKey ? decryptApiKey(provider.apiKey) : '';
        if (!apiKey) continue;
        const baseUrl = provider.baseUrl || '';
        const model = provider.model || '';
        if (!baseUrl || !model) continue;

        const imageUrl = await imageToDataUri(imagePath);
        const text = await callOpenAiCompatibleOcr(apiKey, baseUrl, model, imageUrl, language);
        return { text: text.trim(), provider: name, model };
      }

      if (provider.type === 'paddleocr') {
        const text = await callPaddleOcr(
          imagePath,
          provider.command,
          provider.args,
          language || provider.languages?.[0],
        );
        return { text: text.trim(), provider: name, model: 'paddleocr' };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(`[ocr] Provider "${name}" failed: ${lastError.message}\n`);
    }
  }

  throw lastError || new Error('All OCR providers failed');
}

/**
 * Extract text from an image using configured OCR providers.
 */
export async function extractText(imagePath: string, language?: string): Promise<OcrResult> {
  if (!isOcrImageFile(imagePath)) {
    throw new Error(`"${imagePath}" is not a supported image file for OCR.`);
  }
  return await tryOcrProviders(imagePath, language);
}

/**
 * Check if any OCR provider is configured.
 */
export function isOcrAvailable(): boolean {
  const config = new ConfigManager();
  const providers = config.getOcrProviders();
  return Object.keys(providers).length > 0;
}
