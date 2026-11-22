/**
 * Voice input picker (send-area microphone button).
 *
 * State machine: idle → recording → transcribing → idle. One mic click starts
 * recording; a second click stops immediately and transcribes; trailing silence
 * (5 s) also transcribes automatically. While transcribing the mic is inert.
 * The transcript is inserted at the composer caret — never auto-sent. A
 * semi-hidden × to the left of the mic cancels at any stage, and after a
 * successful insert it undoes only the text this controller just added (10 s).
 *
 * VAD is deliberately conservative: an adaptive noise floor with rate-limited
 * fall/rise feeds a two-threshold hysteresis plus 150 ms onset / 350 ms offset
 * confirmation. Only confirmed voice frames refresh the silence timer, so a
 * covered mic or steady noise cannot hold the recorder until the 120 s cap.
 * Manual stop ignores VAD entirely and uses total audio length, so a soft voice
 * missed by detection is still transcribed when the user stops by hand.
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
  /** Semi-hidden cancel/undo affordance placed left of the mic. */
  clearButton: HTMLButtonElement;
  popover: HTMLElement;
  input: HTMLTextAreaElement;
  /** Existing running-status readout; hidden while the picker is recording. */
  statusEl?: HTMLElement;
  transcribe: (wavBase64: string) => Promise<VoiceTranscribeResult>;
  /** Label of the current active STT provider, e.g. "openai / whisper-1". */
  getProviderLabel: () => string;
  onError: (msg: string) => void;
  onNotice?: (msg: string) => void;
  /** Re-run autogrow / draft persistence after text is inserted or undone. */
  onAfterFill: () => void;
  /** Hard cap for one recording segment (default 120 s). */
  maxSeconds?: number;
  /** Trailing silence before auto-transcribing (default 5 s). */
  silenceSeconds?: number;
  /** Silence before any voice is heard → cancel (default 10 s). */
  preSilenceSeconds?: number;
  /** Minimum voiced audio to keep (default 300 ms). */
  minSpeechMs?: number;
  /** How long the post-insert undo affordance stays up (default 10 s). */
  undoWindowMs?: number;
}

type VoiceState = 'idle' | 'recording' | 'transcribing';
type HintMode = 'idle' | 'preparing' | 'listening' | 'voice' | 'silence';

/** Absolute detection floors. Conservative on purpose: soft speech may need a
 *  manual stop, but a covered mic / room noise must not reset the silence timer. */
const MIN_VOICE_ON = 0.010;
const MIN_VOICE_OFF = 0.006;
/** Adaptive floor bounds + slew rates (per second). The floor starts low so the
 *  very first utterance is detectable, rises slowly to match a noisy room, and
 *  never collapses to zero on a single digital-silence frame. */
const NOISE_FLOOR_INIT = 0.002;
const NOISE_FLOOR_MAX = 0.012;
const NOISE_FALL_PER_SEC = 0.02;
const NOISE_RISE_PER_SEC = 0.002;
/** Confirmation windows: brief spikes never count as speech. */
const VOICE_ON_MS = 150;
const VOICE_OFF_MS = 350;

export interface VadState {
  floor: number;
  onThreshold: number;
  offThreshold: number;
  aboveMs: number;
  belowMs: number;
  active: boolean;
}

export interface VadFrame {
  active: boolean;
  floor: number;
  onThreshold: number;
  offThreshold: number;
}

export function makeVadState(): VadState {
  return {
    floor: NOISE_FLOOR_INIT,
    onThreshold: MIN_VOICE_ON,
    offThreshold: MIN_VOICE_OFF,
    aboveMs: 0,
    belowMs: 0,
    active: false,
  };
}

/**
 * Advance the adaptive floor by one audio window and report whether a voice
 * segment is confirmed. Two thresholds give hysteresis (a dip between off and
 * on does not chop a sentence), and onset/offset must persist for a full window
 * before the state flips. Pure and DOM-free so it can be driven frame by frame
 * in unit tests.
 */
export function updateVad(state: VadState, rms: number, dtMs: number): VadFrame {
  const dtSec = dtMs / 1000;
  if (rms < state.floor) {
    // Rate-limited downward tracking: one quiet frame cannot zero the floor and
    // make the next noise burst look like speech.
    state.floor = Math.max(rms, state.floor - NOISE_FALL_PER_SEC * dtSec);
  } else {
    state.floor = Math.min(
      state.floor + NOISE_RISE_PER_SEC * dtSec,
      NOISE_FLOOR_MAX,
      rms,
    );
  }
  state.onThreshold = Math.max(state.floor * 3, MIN_VOICE_ON);
  state.offThreshold = Math.max(state.floor * 2, MIN_VOICE_OFF);

  if (state.active) {
    if (rms > state.offThreshold) {
      state.belowMs = 0;
    } else {
      state.belowMs += dtMs;
      if (state.belowMs >= VOICE_OFF_MS) {
        state.active = false;
        state.aboveMs = 0;
        state.belowMs = 0;
      }
    }
  } else {
    if (rms > state.onThreshold) {
      state.aboveMs += dtMs;
      state.belowMs = 0;
      if (state.aboveMs >= VOICE_ON_MS) {
        state.active = true;
        state.aboveMs = 0;
      }
    } else {
      state.aboveMs = 0;
      state.belowMs += dtMs;
    }
  }
  return {
    active: state.active,
    floor: state.floor,
    onThreshold: state.onThreshold,
    offThreshold: state.offThreshold,
  };
}

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
  private readonly clearButton: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly statusEl?: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly opts: VoiceInputOptions;
  private readonly providerEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly barsEl: HTMLElement;
  private readonly bars: HTMLElement[] = [];

  private readonly silenceMs: number;
  private readonly preSilenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxMs: number;
  private readonly undoMs: number;

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

  // Adaptive noise floor + confirmed voice activity tracking.
  private vad = makeVadState();
  private lastVoiceAt = 0;
  private voiceSamples = 0;

  // Post-insert undo affordance.
  private clearVisible = false;
  private undoTimer: number | null = null;
  private lastInsert: { start: number; text: string } | null = null;
  private hintMode: HintMode = 'idle';
  /** False from the click until the first captured audio frame arrives. The
   *  popover must not say "Listening" before the mic is actually delivering
   *  samples, otherwise the user speaks into a gap and loses the first words. */
  private captureReady = false;

  /** Escape is swallowed while the picker owns an active recording or
   *  transcription, so the global "Escape = stop agent" handler never fires
   *  mid-voice. Cancelling is done with the mic or the × button. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.state !== 'idle') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** Any user edit invalidates the just-inserted transcript's undo window. */
  private readonly onInput = (): void => {
    if (this.state === 'idle' && this.clearVisible) this.hideClear();
  };

  constructor(opts: VoiceInputOptions) {
    this.opts = opts;
    this.button = opts.button;
    this.clearButton = opts.clearButton;
    this.popover = opts.popover;
    this.input = opts.input;
    this.statusEl = opts.statusEl;
    this.providerEl = must('voice-provider');
    this.timerEl = must('voice-timer');
    this.barsEl = must('voice-bars');
    this.hintEl = must('voice-hint');
    this.silenceMs = (opts.silenceSeconds ?? 5) * 1000;
    this.preSilenceMs = (opts.preSilenceSeconds ?? 10) * 1000;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    this.maxMs = (opts.maxSeconds ?? 120) * 1000;
    this.undoMs = opts.undoWindowMs ?? 10_000;

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
    this.clearButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClearClick();
    });
    this.input.addEventListener('input', this.onInput);
    this.popover.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', this.onKeyDown, true);
    this.applyLanguage();
  }

  /** Refresh dynamic (JS-populated) labels after an i18n language switch. */
  applyLanguage(): void {
    this.providerEl.textContent = t('voiceProvider', { name: this.opts.getProviderLabel() || '—' });
    this.updateTitles();
    this.updateHint(true);
  }

  /** Toggle the disabled affordance when the active STT provider config changes. */
  setAvailable(available: boolean): void {
    this.available = available;
    this.button.disabled = !available;
    if (!available && this.state !== 'idle') {
      this.close();
      this.opts.onNotice?.(t('voiceNoProvider'));
    }
    this.applyLanguage();
  }

  /** True while the picker is recording or transcribing (composer keydown guard). */
  isOpen(): boolean {
    return this.state !== 'idle';
  }

  /** Hide the temporary cancel/undo affordance (send, session switch, draft load). */
  hideClear(): void {
    if (this.undoTimer !== null) {
      window.clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
    this.clearVisible = false;
    this.lastInsert = null;
    this.clearButton.classList.remove('visible');
    this.updateTitles();
  }

  // ---------- state / affordance plumbing ----------

  private setState(next: VoiceState): void {
    this.state = next;
    this.button.classList.toggle('recording', next === 'recording');
    this.button.classList.toggle('transcribing', next === 'transcribing');
    this.button.setAttribute('aria-pressed', next === 'recording' ? 'true' : 'false');
    // The existing "running/busy" readout must not compete with the live
    // recording indicator: hide it for the duration of the voice interaction.
    this.statusEl?.classList.toggle('voice-hidden', next !== 'idle');
    this.updateTitles();
    this.updateHint(true);
  }

  private showClear(): void {
    this.clearVisible = true;
    this.clearButton.classList.add('visible');
    this.updateTitles();
  }

  private micTitle(): string {
    if (!this.available) return t('voiceNoProvider');
    switch (this.state) {
      case 'recording': return t('voiceMicTitleRecording');
      case 'transcribing': return t('voiceMicTitleTranscribing');
      default: return this.clearVisible ? t('voiceMicTitleInserted') : t('voiceMicTitleIdle');
    }
  }

  private clearTitle(): string {
    switch (this.state) {
      case 'recording': return t('voiceClearTitleRecording');
      case 'transcribing': return t('voiceClearTitleTranscribing');
      default: return t('voiceClearTitleInserted');
    }
  }

  private updateTitles(): void {
    const mic = this.micTitle();
    this.button.title = mic;
    this.button.setAttribute('aria-label', mic);
    const clear = this.clearTitle();
    this.clearButton.title = clear;
    this.clearButton.setAttribute('aria-label', clear);
  }

  private updateHint(force = false): void {
    let mode: HintMode = 'idle';
    if (this.state === 'recording') {
      if (!this.captureReady) mode = 'preparing';
      else if (this.vad.active) mode = 'voice';
      else if (this.lastVoiceAt > 0) mode = 'silence';
      else mode = 'listening';
    }
    if (!force && mode === this.hintMode) return;
    this.hintMode = mode;
    switch (mode) {
      case 'preparing':
        this.hintEl.textContent = t('voiceHintPreparing');
        break;
      case 'voice':
        this.hintEl.textContent = t('voiceHintVoice');
        break;
      case 'silence':
        this.hintEl.textContent = t('voiceHintSilence', { seconds: Math.ceil(this.silenceMs / 1000) });
        break;
      default:
        this.hintEl.textContent = t('voiceHint');
    }
  }

  // ---------- public interaction ----------

  private toggle(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (this.state === 'idle') return this.start();
    if (this.state === 'recording') return this.stopAndTranscribe(true);
    // Transcribing: ignore. A second request while the STT is in flight could
    // duplicate the transcript or leave a stale token behind.
    return Promise.resolve();
  }

  private onClearClick(): void {
    if (this.state === 'recording') {
      this.close(); // discard the segment; no toast, the affordance is explicit
      return;
    }
    if (this.state === 'transcribing') {
      this.close(); // bumps transcribingToken, so a late result is dropped
      return;
    }
    this.undoInsert();
  }

  /** Remove exactly the text inserted by the last transcription, if untouched. */
  private undoInsert(): void {
    const last = this.lastInsert;
    if (!last) {
      this.hideClear();
      return;
    }
    const actual = this.input.value.slice(last.start, last.start + last.text.length);
    if (actual !== last.text) {
      this.hideClear();
      this.opts.onNotice?.(t('voiceCannotUndo'));
      return;
    }
    this.input.value = this.input.value.slice(0, last.start)
      + this.input.value.slice(last.start + last.text.length);
    this.hideClear();
    this.input.focus();
    this.input.setSelectionRange(last.start, last.start);
    this.opts.onAfterFill();
  }

  // ---------- recording ----------

  private async start(): Promise<void> {
    this.closeTimers();
    this.releaseAudio();
    this.chunks = [];
    this.level = 0;
    this.vad = makeVadState();
    this.lastVoiceAt = 0;
    this.voiceSamples = 0;
    this.captureReady = false;
    this.hideClear();
    this.setState('recording');
    this.showClear();
    this.timerEl.textContent = '00:00';
    this.popover.classList.remove('hidden');

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
        if (!this.captureReady) {
          // First real sample has arrived: switch the hint from "starting" to
          // the live-state text before doing anything else.
          this.captureReady = true;
          this.updateHint(true);
        }
        this.chunks.push(new Float32Array(data));
        // RMS over a stride is plenty for both the meter and VAD.
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 8) { sum += data[i] * data[i]; n++; }
        const rms = n ? Math.sqrt(sum / n) : 0;
        this.updateBars(rms);

        const dtMs = data.length / this.sampleRate * 1000;
        const voiced = updateVad(this.vad, rms, dtMs).active;
        if (voiced) {
          // Only confirmed voice refreshes the trailing-silence timer and the
          // keep/discard decision. Covered-mic thumps and steady noise never count.
          this.lastVoiceAt = Date.now();
          this.voiceSamples += data.length;
        }
        this.updateHint();
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

        if (this.lastVoiceAt === 0 && now - this.startedAt >= this.preSilenceMs) {
          this.close();
          this.opts.onNotice?.(t('voiceNoSpeech'));
          return;
        }
        if (this.lastVoiceAt > 0 && now - this.lastVoiceAt >= this.silenceMs) {
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

  private async stopAndTranscribe(manual = false): Promise<void> {
    if (this.state !== 'recording') return;
    this.closeTimers();
    this.releaseAudio();
    const frames = this.chunks.reduce((n, c) => n + c.length, 0);
    const totalMs = frames / this.sampleRate * 1000;
    const voicedMs = this.voiceSamples / this.sampleRate * 1000;
    // Manual stop bypasses VAD: a soft voice that never crossed the threshold
    // must still transcribe. Only a genuinely tiny clip is discarded.
    if ((manual ? totalMs : voicedMs) < this.minSpeechMs) {
      this.close();
      this.opts.onNotice?.(t('voiceTooShort'));
      return;
    }
    if (frames < 1000) {
      this.close();
      this.opts.onError(t('voiceEmpty'));
      return;
    }
    const pcm = resample(this.chunks, this.sampleRate, 16000);
    const base64 = toBase64(encodeWav(pcm, 16000));
    this.setState('transcribing');
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
    this.lastInsert = { start: pos, text: ins };
    this.armUndoTimer();
    this.showClear();
    this.input.focus();
    this.input.setSelectionRange(caret, caret);
    this.opts.onAfterFill();
  }

  private armUndoTimer(): void {
    if (this.undoTimer !== null) window.clearTimeout(this.undoTimer);
    this.undoTimer = window.setTimeout(() => {
      this.undoTimer = null;
      if (this.state === 'idle') this.hideClear();
    }, this.undoMs);
  }

  close(): void {
    this.transcribingToken++;
    this.captureReady = false;
    this.closeTimers();
    this.releaseAudio();
    this.popover.classList.add('hidden');
    this.hideClear();
    this.setState('idle');
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
