/**
 * Voice input picker (send-area microphone button).
 *
 * State machine: idle → recording → transcribing → idle. A single mic click
 * starts recording; recording stops itself on trailing silence (default 5 s),
 * pre-recording silence (default 10 s) cancels, and a hard cap (default 120 s)
 * forces a transcribe. The transcript is inserted straight into the composer —
 * there is no confirm dialog and nothing is auto-sent.
 *
 * Silence detection calibrates an ambient-noise floor from the first 300 ms of
 * the clip, then treats RMS above `max(floor * 3, 0.012)` as voice. A clip with
 * under 300 ms of voiced audio is discarded (cough / accidental click).
 *
 * Audio is captured as raw PCM with an AudioContext ScriptProcessor, resampled
 * to 16 kHz and encoded as a 16-bit mono WAV in the renderer. The WAV (base64)
 * goes through the desktop bridge to the worker, which runs core's STT.
 */

import { t } from './i18n.js';

export interface VoiceTranscribeResult {
  ok: boolean;
  text: string;
  provider: string;
  model: string;
  error?: string;
}

export interface VoiceInputOptions {
  button: HTMLButtonElement;
  popover: HTMLElement;
  input: HTMLTextAreaElement;
  transcribe: (wavBase64: string) => Promise<VoiceTranscribeResult>;
  /** Label of the current active STT provider, e.g. "openai / whisper-1". */
  getProviderLabel: () => string;
  onError: (msg: string) => void;
  onNotice?: (msg: string) => void;
  /** Re-run autogrow / draft persistence after text is inserted. */
  onAfterFill: () => void;
  /** Hard cap for one recording segment (default 120 s). */
  maxSeconds?: number;
  /** Trailing silence before auto-transcribing (default 5 s). */
  silenceSeconds?: number;
  /** Silence before any voice is heard → cancel (default 10 s). */
  preSilenceSeconds?: number;
  /** Minimum voiced audio to keep (default 300 ms). */
  minSpeechMs?: number;
}

type VoiceState = 'idle' | 'recording' | 'transcribing';

const CALIBRATION_MS = 300;
const MIN_VOICE_RMS = 0.012;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`voice-input: missing #${id}`);
  return el as T;
}

/** Average-downsample to 16 kHz: STT providers expect it and it keeps the
 *  120 s clip under the IPC payload cap (≈3.8 MB WAV / 5.1 MB base64). */
function resample(chunks: Float32Array[], fromRate: number, toRate: number): Float32Array[] {
  if (fromRate === toRate) return chunks;
  const ratio = fromRate / toRate;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const out = new Float32Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.ceil((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) { sum += merged[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return [out];
}

/** Encode captured Float32 PCM chunks as a 16-bit mono PCM WAV (RIFF). */
function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const frames = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = frames * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return buf;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class VoiceInputController {
  private readonly button: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly opts: VoiceInputOptions;
  private readonly providerEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly barsEl: HTMLElement;
  private readonly bars: HTMLElement[] = [];

  private readonly silenceMs: number;
  private readonly preSilenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxMs: number;

  private state: VoiceState = 'idle';
  /** Disabled when no active STT provider is configured (checked via svConfig). */
  private available = false;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 16000;
  private startedAt = 0;
  private tick: number | null = null;
  private transcribingToken = 0;
  private level = 0;

  // Ambient-noise calibration + voice activity tracking.
  private calibrating = true;
  private noiseSum = 0;
  private noiseCount = 0;
  private noiseSamples = 0;
  private voiceThreshold = MIN_VOICE_RMS;
  private lastVoiceAt = 0;
  private voiceSamples = 0;

  /** Escape is swallowed while the picker is open so the global
   *  "Escape = stop agent" handler never fires mid-recording. Cancelling is
   *  intentionally mic-button-only. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.state !== 'idle') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  constructor(opts: VoiceInputOptions) {
    this.opts = opts;
    this.button = opts.button;
    this.popover = opts.popover;
    this.input = opts.input;
    this.providerEl = must('voice-provider');
    this.timerEl = must('voice-timer');
    this.barsEl = must('voice-bars');
    this.silenceMs = (opts.silenceSeconds ?? 5) * 1000;
    this.preSilenceMs = (opts.preSilenceSeconds ?? 10) * 1000;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    this.maxMs = (opts.maxSeconds ?? 120) * 1000;

    for (let i = 0; i < 12; i++) {
      const b = document.createElement('i');
      b.className = 'voice-bar';
      this.barsEl.appendChild(b);
      this.bars.push(b);
    }

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.toggle();
    });
    this.popover.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', this.onKeyDown, true);
    this.applyLanguage();
  }

  /** Refresh dynamic (JS-populated) labels after an i18n language switch. */
  applyLanguage(): void {
    this.providerEl.textContent = t('voiceProvider', { name: this.opts.getProviderLabel() || '—' });
    // The button keeps a static data-i18n-title in HTML, but a disabled one needs
    // an explanatory tooltip, so own its title/label here too.
    const label = this.available ? t('voiceInputTitle') : t('voiceNoProvider');
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
  }

  /** Toggle the disabled affordance when the active STT provider config changes. */
  setAvailable(available: boolean): void {
    this.available = available;
    this.button.disabled = !available;
    if (!available && this.state !== 'idle') this.close();
    this.applyLanguage();
  }

  /** True while the picker owns the screen (used by the composer keydown guard). */
  isOpen(): boolean {
    return this.state !== 'idle';
  }

  private toggle(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (this.state === 'idle') return this.start();
    // recording → discard; transcribing → cancel pending fill. Either way the
    // mic button is the only cancel affordance.
    this.close();
    return Promise.resolve();
  }

  private async start(): Promise<void> {
    this.closeTimers();
    this.releaseAudio();
    this.chunks = [];
    this.level = 0;
    this.calibrating = true;
    this.noiseSum = 0;
    this.noiseCount = 0;
    this.noiseSamples = 0;
    this.voiceThreshold = MIN_VOICE_RMS;
    this.lastVoiceAt = 0;
    this.voiceSamples = 0;
    this.state = 'recording';
    this.button.classList.add('recording');
    this.button.setAttribute('aria-pressed', 'true');
    this.timerEl.textContent = '00:00';
    this.popover.classList.remove('hidden');
    this.applyLanguage();

    if (!navigator.mediaDevices?.getUserMedia) {
      this.close();
      this.opts.onError(t('voiceMicDenied'));
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      this.close();
      this.opts.onError(t('voiceMicDenied'));
      return;
    }
    // Permission prompts are async — the user may have cancelled in the meantime.
    if (this.state !== 'recording') {
      this.releaseAudio();
      return;
    }
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      this.audioCtx = ctx;
      this.sampleRate = ctx.sampleRate || 16000;
      this.source = ctx.createMediaStreamSource(this.stream);
      this.processor = ctx.createScriptProcessor(4096, 1, 1);
      this.sink = ctx.createGain();
      this.sink.gain.value = 0; // silent drain so the processor keeps firing
      this.processor.onaudioprocess = (e) => {
        if (this.state !== 'recording') return;
        const data = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(data));
        // RMS over a stride is plenty for both the meter and VAD.
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 8) { sum += data[i] * data[i]; n++; }
        const rms = n ? Math.sqrt(sum / n) : 0;
        this.updateBars(rms);

        if (this.calibrating) {
          this.noiseSum += sum;
          this.noiseCount += n;
          this.noiseSamples += data.length;
          if (this.noiseSamples >= this.sampleRate * CALIBRATION_MS / 1000 && this.noiseCount > 0) {
            const floor = Math.sqrt(this.noiseSum / this.noiseCount);
            this.voiceThreshold = Math.max(floor * 3, MIN_VOICE_RMS);
            this.calibrating = false;
          }
          return;
        }
        if (rms > this.voiceThreshold) {
          this.lastVoiceAt = Date.now();
          this.voiceSamples += data.length;
        }
      };
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(ctx.destination);
      void ctx.resume().catch(() => {});

      this.startedAt = Date.now();
      this.tick = window.setInterval(() => {
        const now = Date.now();
        const sec = Math.floor((now - this.startedAt) / 1000);
        this.timerEl.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

        if (!this.calibrating && this.lastVoiceAt === 0 && now - this.startedAt >= this.preSilenceMs) {
          this.close();
          this.opts.onNotice?.(t('voiceNoSpeech'));
          return;
        }
        if (!this.calibrating && this.lastVoiceAt > 0 && now - this.lastVoiceAt >= this.silenceMs) {
          void this.stopAndTranscribe();
          return;
        }
        if (sec * 1000 >= this.maxMs) {
          this.opts.onNotice?.(t('voiceLimit'));
          void this.stopAndTranscribe();
        }
      }, 250);
    } catch (err) {
      this.close();
      this.opts.onError(t('voiceRecordFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private updateBars(level: number): void {
    this.level = Math.max(level, this.level * 0.82);
    const norm = Math.min(1, this.level * 6);
    const phase = performance.now() / 90;
    this.bars.forEach((b, i) => {
      const wobble = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.9 + phase));
      b.style.height = `${(2 + norm * wobble * 18).toFixed(1)}px`;
    });
  }

  private async stopAndTranscribe(): Promise<void> {
    if (this.state !== 'recording') return;
    this.closeTimers();
    this.releaseAudio();
    const voicedMs = this.voiceSamples / this.sampleRate * 1000;
    if (voicedMs < this.minSpeechMs) {
      this.close();
      this.opts.onNotice?.(t('voiceTooShort'));
      return;
    }
    const frames = this.chunks.reduce((n, c) => n + c.length, 0);
    if (frames < 1000) {
      this.close();
      this.opts.onError(t('voiceEmpty'));
      return;
    }
    const pcm = resample(this.chunks, this.sampleRate, 16000);
    const base64 = toBase64(encodeWav(pcm, 16000));
    this.state = 'transcribing';
    this.button.classList.remove('recording');
    this.button.classList.add('transcribing');
    this.button.setAttribute('aria-pressed', 'false');
    this.popover.classList.add('hidden');
    const token = ++this.transcribingToken;
    try {
      const res = await this.opts.transcribe(base64);
      if (token !== this.transcribingToken) return;
      if (!res?.ok || !res.text) {
        this.close();
        this.opts.onError(res?.error
          ? t('voiceTranscribeFailed', { error: res.error })
          : t('voiceEmpty'));
        return;
      }
      this.insertText(res.text);
    } catch (err) {
      if (token !== this.transcribingToken) return;
      this.close();
      this.opts.onError(t('voiceTranscribeFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  /** Insert the transcript at the composer caret (never send). */
  private insertText(text: string): void {
    const txt = text.trim();
    if (!txt) {
      this.close();
      this.opts.onError(t('voiceEmpty'));
      return;
    }
    const pos = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, pos);
    const after = this.input.value.slice(pos);
    let ins = txt;
    if (before && !/\s$/.test(before)) ins = ` ${ins}`;
    if (after && !/^\s/.test(after)) ins = `${ins} `;
    this.input.value = before + ins + after;
    const caret = (before + ins).length;
    this.close();
    this.input.focus();
    this.input.setSelectionRange(caret, caret);
    this.opts.onAfterFill();
  }

  close(): void {
    this.transcribingToken++;
    this.closeTimers();
    this.releaseAudio();
    this.popover.classList.add('hidden');
    this.button.classList.remove('recording', 'transcribing');
    this.button.setAttribute('aria-pressed', 'false');
    this.state = 'idle';
  }

  private closeTimers(): void {
    if (this.tick !== null) {
      window.clearInterval(this.tick);
      this.tick = null;
    }
  }

  private releaseAudio(): void {
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
    } catch { /* already detached */ }
    try { this.source?.disconnect(); } catch { /* already detached */ }
    try { this.sink?.disconnect(); } catch { /* already detached */ }
    try { this.stream?.getTracks().forEach((track) => track.stop()); } catch { /* already stopped */ }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close().catch(() => {});
    }
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.audioCtx = null;
  }
}
