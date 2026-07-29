import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { ConfigManager } from '../config/index.js';
import { decryptApiKey } from '../security/env-key-encrypt.js';
import { authorizePath } from '../security/path-authorizer.js';
import { redactPaths } from '../utils/sanitize.js';

export interface TtsResult {
  filePath: string;
  provider: string;
  model?: string;
  format: string;
}

function isDashScopeTts(model: string): boolean {
  return model.startsWith('qwen3-tts') || model.startsWith('cosyvoice');
}

async function synthesizeDashScope(
  apiKey: string, baseUrl: string, model: string, text: string, voice?: string, language?: string,
): Promise<{ data: Buffer; format: string }> {
  // DashScope native TTS uses multimodal-generation endpoint
  const url = baseUrl.endsWith('/')
    ? `${baseUrl}api/v1/services/aigc/multimodal-generation/generation`
    : `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

  const body: Record<string, unknown> = {
    model,
    input: {
      text,
      ...(voice ? { voice } : {}),
      ...(language ? { language_type: language } : {}),
    },
  };

  let json: any;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error');
      throw new Error(`TTS API error (${response.status}): ${errText}`);
    }

    json = await response.json() as any;
  } finally {
    clearTimeout(timeout);
  }
  // DashScope returns output.audio.url (download URL) or output.audio.data (base64)
  if (json?.output?.audio?.data) {
    return { data: Buffer.from(json.output.audio.data, 'base64'), format: 'mp3' };
  }
  if (json?.output?.audio?.url) {
    const audioResp = await fetch(json.output.audio.url);
    if (!audioResp.ok) throw new Error(`Failed to download audio: ${audioResp.status}`);
    const arrayBuf = await audioResp.arrayBuffer();
    return { data: Buffer.from(arrayBuf), format: 'mp3' };
  }
  throw new Error(`Unexpected DashScope TTS response: ${JSON.stringify(json).slice(0, 500)}`);
}

async function synthesizeOpenAI(
  apiKey: string, baseUrl: string, model: string, text: string, voice?: string,
): Promise<{ data: Buffer; format: string }> {
  const url = baseUrl.endsWith('/')
    ? `${baseUrl}audio/speech`
    : `${baseUrl}/audio/speech`;

  const body: Record<string, unknown> = {
    model,
    input: text,
    ...(voice ? { voice } : {}),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delayMs = 2000 * attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        if (response.status >= 500 && attempt < 2) continue;
        throw new Error(`TTS API error (${response.status}): ${errText}`);
      }

      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      const format = contentType.includes('wav') ? 'wav' : contentType.includes('pcm') ? 'pcm' : 'mp3';
      const arrayBuf = await response.arrayBuffer();
      return { data: Buffer.from(arrayBuf), format };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('TTS request failed after 3 attempts');
}

function getTtsProviders(config: ConfigManager): Record<string, any> {
  const all = config.getSpeechProviders();
  const result: Record<string, any> = {};
  for (const [name, p] of Object.entries(all)) {
    if (p.category === 'tts') {
      result[name] = p;
    }
  }
  return result;
}

export async function synthesizeSpeech(text: string, outputPath?: string, voice?: string): Promise<TtsResult> {
  const config = new ConfigManager();
  const providers = getTtsProviders(config);
  const activeName = config.getActiveTtsProvider();

  const orderedNames: string[] = [];
  if (providers[activeName]) orderedNames.push(activeName);
  for (const name of Object.keys(providers)) {
    if (name !== activeName) orderedNames.push(name);
  }

  if (orderedNames.length === 0) {
    throw new Error('No TTS provider configured. Use "nexus config speech set <name> -c tts" to add one.');
  }

  let lastError: Error | null = null;

  for (const name of orderedNames) {
    let provider: { apiKey: string; baseUrl: string; model: string; voice?: string; language?: string };
    try {
      provider = config.getSpeechProvider(name);
    } catch (e) {
      continue;
    }

    try {
      let apiKey = provider.apiKey || '';
      if (!(provider.baseUrl && /(127\.0\.0\.1|localhost)/i.test(provider.baseUrl))) {
        for (let i = 0; i < 20; i++) {
          if (!apiKey.startsWith('mem:') && !apiKey.startsWith('enc:')) break;
          const prev = apiKey;
          apiKey = decryptApiKey(apiKey);
          if (apiKey === prev) break;
        }
      }
      if (!apiKey) continue;
      const baseUrl = provider.baseUrl || '';
      const model = provider.model || '';
      if (!baseUrl || !model) continue;

      const effectiveVoice = voice || provider.voice;

      let result: { data: Buffer; format: string };
      if (isDashScopeTts(model)) {
        result = await synthesizeDashScope(apiKey, baseUrl, model, text, effectiveVoice, provider.language);
      } else {
        result = await synthesizeOpenAI(apiKey, baseUrl, model, text, effectiveVoice);
      }

      // Determine output path
      let outPath = outputPath;
      if (!outPath) {
        const outputDir = resolve(homedir(), '.nexus', 'output');
        if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
        const timestamp = Date.now();
        const slug = text.slice(0, 40).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'speech';
        outPath = resolve(outputDir, `${slug}_${timestamp}.${result.format}`);
      }

      writeFileSync(outPath, result.data);
      return { filePath: outPath, provider: name, model, format: result.format };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(`[tts] Provider "${name}" failed: ${lastError.message}\n`);
    }
  }

  throw lastError || new Error('All TTS providers failed');
}

export function isTtsAvailable(): boolean {
  const config = new ConfigManager();
  const providers = getTtsProviders(config);
  return Object.keys(providers).length > 0;
}
