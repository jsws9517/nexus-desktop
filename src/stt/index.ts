import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ConfigManager } from '../config/index.js';
import { decryptApiKey } from '../security/env-key-encrypt.js';
import { authorizePath } from '../security/path-authorizer.js';
import { redactPaths } from '../utils/sanitize.js';

export interface SttResult {
  text: string;
  provider: string;
  model?: string;
}

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma'];

export function isAudioFile(path: string): boolean {
  const lower = path.toLowerCase();
  return AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

async function readAudioFile(filePath: string): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  const absPath = resolve(process.cwd(), filePath);
  if (!(await authorizePath(absPath))) {
    throw new Error(`Access denied: "${filePath}" is not in the allowed path list.`);
  }
  if (!existsSync(absPath)) throw new Error(`Audio file not found: ${redactPaths(filePath)}`);
  const lower = absPath.toLowerCase();
  const mime =
    lower.endsWith('.wav') ? 'audio/wav' :
    lower.endsWith('.mp3') ? 'audio/mpeg' :
    lower.endsWith('.m4a') ? 'audio/mp4' :
    lower.endsWith('.ogg') ? 'audio/ogg' :
    lower.endsWith('.flac') ? 'audio/flac' :
    lower.endsWith('.webm') ? 'audio/webm' :
    lower.endsWith('.aac') ? 'audio/aac' :
    lower.endsWith('.wma') ? 'audio/wma' :
    'audio/mpeg';
  const dotIdx = lower.lastIndexOf('.');
  const ext = dotIdx >= 0 ? lower.slice(dotIdx) : '.mp3';
  const data = readFileSync(absPath);
  return { buffer: data, mime, ext };
}

function isDashScopeAsr(model: string): boolean {
  return model.startsWith('qwen3-asr') || model.includes('paraformer');
}

async function transcribeDashScope(
  apiKey: string, baseUrl: string, model: string, filePath: string,
): Promise<string> {
  const { buffer, mime } = await readAudioFile(filePath);
  const b64 = buffer.toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;

  const chatUrl = baseUrl.endsWith('/')
    ? `${baseUrl}chat/completions`
    : `${baseUrl}/chat/completions`;

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
      }],
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown error');
    throw new Error(`Speech API error (${response.status}): ${errText}`);
  }

  const json = await response.json() as any;
  return json?.choices?.[0]?.message?.content || '';
}

async function transcribeWhisper(
  apiKey: string, baseUrl: string, model: string, filePath: string,
): Promise<string> {
  const { buffer, mime, ext } = await readAudioFile(filePath);

  const url = baseUrl.endsWith('/')
    ? `${baseUrl}audio/transcriptions`
    : `${baseUrl}/audio/transcriptions`;

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), `audio${ext}`);
  form.append('model', model);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown error');
    throw new Error(`Speech API error (${response.status}): ${errText}`);
  }

  const json = await response.json() as any;
  return json?.text || '';
}

function getSttProviders(config: ConfigManager): Record<string, any> {
  const all = config.getSpeechProviders();
  const result: Record<string, any> = {};
  for (const [name, p] of Object.entries(all)) {
    if (!p.category || p.category === 'stt') {
      result[name] = p;
    }
  }
  return result;
}

export async function transcribeAudio(filePath: string): Promise<SttResult> {
  if (!isAudioFile(filePath)) {
    throw new Error(`"${filePath}" is not a supported audio file for transcription.`);
  }

  const config = new ConfigManager();
  const providers = getSttProviders(config);
  const activeName = config.getActiveSpeechProvider();

  const orderedNames: string[] = [];
  if (providers[activeName]) orderedNames.push(activeName);
  for (const name of Object.keys(providers)) {
    if (name !== activeName) orderedNames.push(name);
  }

  if (orderedNames.length === 0) {
    throw new Error('No STT provider configured. Use "nexus config speech set <name> -c stt" to add one.');
  }

  let lastError: Error | null = null;

  for (const name of orderedNames) {
    let provider: { apiKey: string; baseUrl: string; model: string };
    try {
      provider = config.getSpeechProvider(name);
    } catch {
      continue;
    }

    try {
      let apiKey = provider.apiKey || '';
      if (provider.baseUrl && /(127\.0\.0\.1|localhost)/i.test(provider.baseUrl)) {
        // localhost provider — no apiKey decryption needed
      } else {
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

      let text: string;
      if (isDashScopeAsr(model)) {
        text = await transcribeDashScope(apiKey, baseUrl, model, filePath);
      } else {
        text = await transcribeWhisper(apiKey, baseUrl, model, filePath);
      }
      return { text: text.trim(), provider: name, model };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(`[speech] Provider "${name}" failed: ${lastError.message}\n`);
    }
  }

  throw lastError || new Error('All STT providers failed');
}

export function isSpeechAvailable(): boolean {
  const config = new ConfigManager();
  const providers = getSttProviders(config);
  return Object.keys(providers).length > 0;
}
