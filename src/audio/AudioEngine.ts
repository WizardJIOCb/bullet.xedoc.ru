import { clamp, hashString, mulberry32 } from '../core/math';
import type { MusicProfile, MusicTransition, RhythmBeat } from '../core/types';
import { createDefaultMusicProfile } from '../game/track';
import type { AudioSettings } from '../settings/SettingsStore';
import { analyzeMusicNovelty, normalizeMusicBands, poolMusicCurve } from './musicAnalysis';
import { createMusicAccentEnvelope } from './musicAccent';

export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  overall: number;
  pulse: number;
  onBeat: boolean;
}

export type AudioSourceKind = 'synthetic' | 'catalog' | 'local';
export type GameSound = 'fire' | 'impact' | 'pickup' | 'ability' | 'upgrade' | 'destroy';

export type AudioImportErrorCode = 'empty' | 'too-large' | 'too-long' | 'read' | 'network' | 'decode' | 'invalid';

export class AudioImportError extends Error {
  constructor(
    readonly code: AudioImportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AudioImportError';
  }
}

export interface CatalogAudioTrack {
  id: string;
  title: string;
  file: string;
  bytes?: number;
}

export interface PreviewPlaybackState {
  available: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
}

type TransportMode = 'idle' | 'preview' | 'game';

const MAX_AUDIO_FILE_BYTES = 48 * 1024 * 1024;
const MAX_AUDIO_DURATION = 12 * 60;
const MAX_PLAYBACK_DURATION = 108;
const AUDIO_METADATA_TIMEOUT = 3000;
const DEFAULT_MUSIC_FADE_SECONDS = 1.65;
const MIN_AUDIO_GAIN = 0.0001;

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private musicInput: GainNode | null = null;
  private musicAccentFilter: BiquadFilterNode | null = null;
  private musicAccentGain: GainNode | null = null;
  private musicAccentPeakGain = 1;
  private musicAccentPeakEq = 0;
  private musicAccentReleaseAt = 0;
  private musicFadeGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private frequencyData = new Uint8Array(256);
  private decodedTrack: AudioBuffer | null = null;
  private trackSource: AudioBufferSourceNode | null = null;
  private transportMode: TransportMode = 'idle';
  private previewPlaying = false;
  private previewOffset = 0;
  private previewStartedAt = 0;
  private previewGeneration = 0;
  private profile: MusicProfile = createDefaultMusicProfile();
  private sourceKind: AudioSourceKind = 'synthetic';
  private usingFile = false;
  private running = false;
  private startedAt = 0;
  private nextStepTime = 0;
  private stepIndex = 0;
  private lastBeatAt = -10;
  private beatAnchor = 0;
  private lastObservedTime = 0;
  private beatPulse = 0;
  private smoothedBass = 0;
  private noiseBuffer: AudioBuffer | null = null;
  private deathNoiseBuffer: AudioBuffer | null = null;
  private deathExplosionSequence = 0;
  private readonly activeSources = new Map<AudioScheduledSourceNode, () => void>();
  private audioSettings: AudioSettings = {
    masterVolume: 0.9,
    musicVolume: 0.82,
    effectsVolume: 0.72,
    muted: false,
  };

  getProfile(): MusicProfile {
    return this.profile;
  }

  getSourceKind(): AudioSourceKind {
    return this.sourceKind;
  }

  isCustomTrack(): boolean {
    return this.usingFile;
  }

  getPreviewPlaybackState(): PreviewPlaybackState {
    return {
      available: Boolean(this.decodedTrack),
      playing: this.previewPlaying && this.transportMode === 'preview',
      currentTime: this.getPreviewTime(),
      duration: this.getPreviewDuration(),
    };
  }

  private isGameTransport(): boolean {
    return this.transportMode === 'game';
  }

  async playPreview(): Promise<void> {
    if (!this.decodedTrack || this.isGameTransport() || this.previewPlaying) return;
    const duration = this.getPreviewDuration();
    if (duration <= 0) return;

    const context = this.ensureContext();
    this.resetMusicAccent();
    this.resetMusicFade();
    const generation = ++this.previewGeneration;
    const offset = this.previewOffset >= duration ? 0 : clamp(this.previewOffset, 0, duration);
    try {
      await context.resume();
    } catch (error) {
      if (generation === this.previewGeneration) {
        this.previewPlaying = false;
        this.running = false;
      }
      throw error;
    }
    if (generation !== this.previewGeneration || !this.decodedTrack || this.isGameTransport()) return;

    this.transportMode = 'preview';
    this.previewPlaying = true;
    this.running = true;
    try {
      this.startPreviewSource(context, offset, generation);
    } catch (error) {
      if (generation === this.previewGeneration) {
        this.clearTrackSource();
        this.previewPlaying = false;
        this.running = false;
      }
      throw error;
    }
  }

  pausePreview(): void {
    if (this.transportMode !== 'preview' || !this.previewPlaying) return;
    this.resetMusicAccent();
    const time = this.getPreviewTime();
    this.previewGeneration += 1;
    this.clearTrackSource();
    this.previewOffset = time;
    this.previewPlaying = false;
    this.running = false;
    this.resetRhythmTransport(time);
  }

  seekPreview(seconds: number): void {
    if (!this.decodedTrack || this.transportMode === 'game') return;
    this.resetMusicAccent();
    const duration = this.getPreviewDuration();
    const target = clamp(Number.isFinite(seconds) ? seconds : 0, 0, duration);
    const wasPlaying = this.transportMode === 'preview' && this.previewPlaying;
    const context = this.context;
    const generation = ++this.previewGeneration;
    if (wasPlaying) this.clearTrackSource();
    this.transportMode = 'preview';
    this.previewOffset = target;
    this.previewPlaying = false;
    this.running = false;
    this.resetRhythmTransport(target);

    if (!wasPlaying || !context || context.state !== 'running' || target >= duration) return;
    this.previewPlaying = true;
    this.running = true;
    this.startPreviewSource(context, target, generation);
  }

  stopPreview(reset = true): void {
    const time = this.getPreviewTime();
    this.resetMusicAccent();
    this.previewGeneration += 1;
    this.previewPlaying = false;
    if (this.transportMode === 'game') {
      if (reset) this.previewOffset = 0;
      return;
    }
    this.clearTrackSource();
    this.running = false;
    this.transportMode = 'idle';
    this.previewOffset = reset ? 0 : time;
    this.resetRhythmTransport(this.previewOffset);
  }

  setAudioSettings(settings: AudioSettings): void {
    this.audioSettings = {
      masterVolume: clamp(settings.masterVolume, 0, 1),
      musicVolume: clamp(settings.musicVolume, 0, 1),
      effectsVolume: clamp(settings.effectsVolume, 0, 1),
      muted: Boolean(settings.muted),
    };
    this.applyAudioSettings();
  }

  private applyAudioSettings(): void {
    if (!this.context || !this.musicGain || !this.effectsGain || !this.outputGain) return;
    const now = this.context.currentTime;
    this.musicGain.gain.setTargetAtTime(this.audioSettings.musicVolume, now, 0.025);
    this.effectsGain.gain.setTargetAtTime(this.audioSettings.effectsVolume, now, 0.025);
    this.outputGain.gain.setTargetAtTime(this.audioSettings.muted ? 0 : this.audioSettings.masterVolume, now, 0.025);
  }

  /** Fades only the soundtrack, leaving impact and explosion effects audible. */
  fadeOutMusic(durationSeconds = DEFAULT_MUSIC_FADE_SECONDS): number {
    const duration = clamp(
      Number.isFinite(durationSeconds) ? durationSeconds : DEFAULT_MUSIC_FADE_SECONDS,
      0.08,
      6,
    );
    const context = this.context;
    const fade = this.musicFadeGain?.gain;
    if (
      !context
      || !fade
      || context.state !== 'running'
      || this.transportMode !== 'game'
      || !this.running
    ) return duration;

    this.resetMusicAccent();
    const now = context.currentTime;
    const held = Math.max(MIN_AUDIO_GAIN, this.holdAudioParam(fade, now, 1));
    fade.setValueAtTime(held, now);
    fade.exponentialRampToValueAtTime(MIN_AUDIO_GAIN, now + duration);
    fade.setValueAtTime(0, now + duration);
    return duration;
  }

  /** Restores the neutral per-run soundtrack envelope without changing user volume. */
  resetMusicFade(): void {
    const context = this.context;
    const fade = this.musicFadeGain?.gain;
    if (!context || !fade) return;
    const now = context.currentTime;
    fade.cancelScheduledValues(now);
    fade.setValueAtTime(1, now);
  }

  /** Rewards an on-beat action by briefly lifting the music itself, without a new SFX source. */
  accentMusic(amount = 1): void {
    const context = this.context;
    const accentGain = this.musicAccentGain?.gain;
    const accentEq = this.musicAccentFilter?.gain;
    if (
      !context
      || !accentGain
      || !accentEq
      || context.state !== 'running'
      || this.transportMode !== 'game'
      || !this.running
    ) return;

    const envelope = createMusicAccentEnvelope(amount, this.profile.bpm);
    if (!envelope.active) return;
    const now = context.currentTime;
    const heldGain = this.holdAudioParam(accentGain, now, 1);
    const heldEq = this.holdAudioParam(accentEq, now, 0);
    const peakAt = now + envelope.attackSeconds;
    const releaseAt = now + envelope.releaseSeconds;
    const scheduledAccentActive = Number.isFinite(this.musicAccentReleaseAt)
      && now < this.musicAccentReleaseAt;
    const peakGain = Math.max(
      heldGain,
      envelope.peakGain,
      scheduledAccentActive ? this.musicAccentPeakGain : 1,
    );
    const peakEq = Math.max(
      heldEq,
      envelope.peakLowShelfDb,
      scheduledAccentActive ? this.musicAccentPeakEq : 0,
    );

    accentGain.linearRampToValueAtTime(peakGain, peakAt);
    accentGain.linearRampToValueAtTime(1, releaseAt);
    accentEq.linearRampToValueAtTime(peakEq, peakAt);
    accentEq.linearRampToValueAtTime(0, releaseAt);
    this.musicAccentPeakGain = peakGain;
    this.musicAccentPeakEq = peakEq;
    this.musicAccentReleaseAt = releaseAt;
  }

  private holdAudioParam(param: AudioParam, time: number, fallback: number): number {
    const held = Number.isFinite(param.value) ? param.value : fallback;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(held, time);
    }
    return held;
  }

  private resetMusicAccent(): void {
    this.musicAccentPeakGain = 1;
    this.musicAccentPeakEq = 0;
    this.musicAccentReleaseAt = 0;
    if (!this.context) return;
    const now = this.context.currentTime;
    const reset = (param: AudioParam | undefined, baseline: number): void => {
      if (!param) return;
      param.cancelScheduledValues(now);
      param.setValueAtTime(baseline, now);
    };
    reset(this.musicAccentGain?.gain, 1);
    reset(this.musicAccentFilter?.gain, 0);
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.76;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.musicInput = this.context.createGain();
    this.musicAccentFilter = this.context.createBiquadFilter();
    this.musicAccentGain = this.context.createGain();
    this.musicFadeGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.effectsGain = this.context.createGain();
    this.outputGain = this.context.createGain();
    this.limiter = this.context.createDynamicsCompressor();
    this.musicAccentFilter.type = 'lowshelf';
    this.musicAccentFilter.frequency.value = 180;
    this.musicAccentFilter.gain.value = 0;
    this.musicAccentGain.gain.value = 1;
    this.musicFadeGain.gain.value = 1;
    this.musicGain.gain.value = this.audioSettings.musicVolume;
    this.effectsGain.gain.value = this.audioSettings.effectsVolume;
    this.outputGain.gain.value = this.audioSettings.muted ? 0 : this.audioSettings.masterVolume;
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.musicInput.connect(this.analyser);
    this.analyser.connect(this.musicAccentFilter);
    this.musicAccentFilter.connect(this.musicAccentGain);
    this.musicAccentGain.connect(this.musicFadeGain);
    this.musicFadeGain.connect(this.musicGain);
    this.musicGain.connect(this.outputGain);
    this.effectsGain.connect(this.outputGain);
    this.outputGain.connect(this.limiter);
    this.limiter.connect(this.context.destination);
    this.noiseBuffer = this.createNoiseBuffer(this.context);
    this.deathNoiseBuffer = this.createNoiseBuffer(this.context, 2, 0xd347b00f);
    this.applyAudioSettings();
    return this.context;
  }

  private clearTrackSource(): void {
    if (!this.trackSource) return;
    const source = this.trackSource;
    this.trackSource = null;
    try {
      source.stop();
    } catch {
      // A source that never started or already ended is safe to discard.
    }
    source.disconnect();
  }

  private registerSource(source: AudioScheduledSourceNode, cleanup: () => void): void {
    this.activeSources.set(source, cleanup);
    source.addEventListener('ended', () => this.releaseSource(source), { once: true });
  }

  private releaseSource(source: AudioScheduledSourceNode): void {
    const cleanup = this.activeSources.get(source);
    if (!cleanup) return;
    this.activeSources.delete(source);
    source.disconnect();
    cleanup();
  }

  private clearActiveSources(): void {
    for (const [source, cleanup] of this.activeSources) {
      try {
        source.stop();
      } catch {
        // A source that has already ended is safe to release.
      }
      source.disconnect();
      cleanup();
    }
    this.activeSources.clear();
  }

  private startDecodedTrack(
    context: AudioContext,
    startAt: number,
    absoluteOffset = 0,
    onEnded?: () => void,
  ): AudioBufferSourceNode {
    if (!this.decodedTrack) throw new Error('Decoded track is not available');
    this.clearTrackSource();
    const source = context.createBufferSource();
    source.buffer = this.decodedTrack;
    source.loop = true;
    source.connect(this.musicInput!);
    this.trackSource = source;
    source.addEventListener('ended', () => {
      if (this.trackSource !== source) return;
      this.trackSource = null;
      source.disconnect();
      onEnded?.();
    }, { once: true });
    const bufferDuration = Math.max(Number.EPSILON, this.decodedTrack.duration);
    const offset = ((absoluteOffset % bufferDuration) + bufferDuration) % bufferDuration;
    source.start(startAt, offset);
    return source;
  }

  private getPreviewDuration(): number {
    return this.decodedTrack ? Math.max(0, this.profile.runDuration) : 0;
  }

  private getPreviewTime(): number {
    const duration = this.getPreviewDuration();
    if (!duration) return 0;
    if (!this.previewPlaying || this.transportMode !== 'preview' || !this.context) {
      return clamp(this.previewOffset, 0, duration);
    }
    return clamp(this.getPresentedContextTime() - this.previewStartedAt, 0, duration);
  }

  private getPresentedContextTime(): number {
    if (!this.context) return 0;
    const timestamp = typeof this.context.getOutputTimestamp === 'function'
      ? this.context.getOutputTimestamp()
      : null;
    const timestampContextTime = timestamp?.contextTime;
    if (typeof timestampContextTime === 'number' && Number.isFinite(timestampContextTime) && timestampContextTime >= 0) {
      return timestampContextTime;
    }
    const contextWithLatency = this.context as AudioContext & { outputLatency?: number; baseLatency?: number };
    const outputLatency = Number(contextWithLatency.outputLatency);
    const baseLatency = Number(contextWithLatency.baseLatency);
    const latency = clamp(Number.isFinite(baseLatency) ? baseLatency : 0, 0, 1)
      + clamp(Number.isFinite(outputLatency) ? outputLatency : 0, 0, 1);
    return Math.max(0, this.context.currentTime - latency);
  }

  private resetRhythmTransport(time: number): void {
    this.lastBeatAt = -10;
    this.beatAnchor = this.profile.beatOffset || 0;
    this.lastObservedTime = time;
    this.beatPulse = 0;
  }

  private startPreviewSource(context: AudioContext, absoluteOffset: number, generation: number): void {
    const duration = this.getPreviewDuration();
    const offset = clamp(absoluteOffset, 0, duration);
    const remaining = duration - offset;
    if (!this.decodedTrack || remaining <= 0) return;

    const startAt = context.currentTime;
    this.previewOffset = offset;
    this.previewStartedAt = startAt - offset;
    this.resetRhythmTransport(offset);
    const source = this.startDecodedTrack(context, startAt, offset, () => {
      if (generation !== this.previewGeneration || this.transportMode !== 'preview') return;
      this.previewPlaying = false;
      this.running = false;
      this.previewOffset = duration;
      this.resetRhythmTransport(duration);
    });
    source.stop(startAt + remaining);
  }

  private async readMetadataDuration(blob: Blob): Promise<number | null> {
    if (
      typeof Audio === 'undefined'
      || typeof URL === 'undefined'
      || typeof URL.createObjectURL !== 'function'
    ) return null;

    return new Promise<number | null>((resolve) => {
      const media = new Audio();
      const url = URL.createObjectURL(blob);
      let settled = false;
      let timeout = 0;
      const finish = (duration: number | null): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        media.removeEventListener('loadedmetadata', readDuration);
        media.removeEventListener('durationchange', readDuration);
        media.removeEventListener('error', ignoreMetadataFailure);
        try {
          media.removeAttribute('src');
          media.load();
        } catch {
          // Metadata probing is advisory; decoder validation remains authoritative.
        }
        try {
          URL.revokeObjectURL(url);
        } catch {
          // A revoked/invalid probe URL must not block importing the audio bytes.
        }
        resolve(duration);
      };
      const readDuration = (): void => {
        if (Number.isFinite(media.duration) && media.duration > 0) finish(media.duration);
      };
      const ignoreMetadataFailure = (): void => finish(null);
      timeout = globalThis.setTimeout(() => finish(null), AUDIO_METADATA_TIMEOUT);
      media.preload = 'metadata';
      media.addEventListener('loadedmetadata', readDuration);
      media.addEventListener('durationchange', readDuration);
      media.addEventListener('error', ignoreMetadataFailure, { once: true });
      try {
        media.src = url;
      } catch {
        finish(null);
      }
    });
  }

  private async validateAudioBlob(blob: Blob, label: string): Promise<void> {
    if (blob.size <= 0) {
      throw new AudioImportError('empty', `${label} is empty`);
    }
    if (blob.size > MAX_AUDIO_FILE_BYTES) {
      throw new AudioImportError('too-large', `${label} is larger than 48 MB`);
    }
    let metadataDuration: number | null = null;
    try {
      metadataDuration = await this.readMetadataDuration(blob);
    } catch {
      // Some browsers fail metadata probing for files decodeAudioData can read.
      // Only a known finite duration is allowed to reject before decoding.
    }
    if (metadataDuration !== null && metadataDuration > MAX_AUDIO_DURATION) {
      throw new AudioImportError('too-long', `${label} is longer than 12 minutes`);
    }
  }

  private async decodeAudioBlob(context: AudioContext, blob: Blob, label: string): Promise<AudioBuffer> {
    await this.validateAudioBlob(blob, label);
    let bytes: ArrayBuffer;
    try {
      bytes = await blob.arrayBuffer();
    } catch (error) {
      throw new AudioImportError('read', `${label} could not be read`, { cause: error });
    }
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (error) {
      throw new AudioImportError('decode', `${label} could not be decoded`, { cause: error });
    }
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.length <= 0) {
      throw new AudioImportError('invalid', `${label} has an invalid duration`);
    }
    if (buffer.duration > MAX_AUDIO_DURATION) {
      throw new AudioImportError('too-long', `${label} is longer than 12 minutes`);
    }
    return buffer;
  }

  private trimPlaybackBuffer(context: AudioContext, buffer: AudioBuffer): AudioBuffer {
    if (buffer.duration <= MAX_PLAYBACK_DURATION) return buffer;
    const frameCount = Math.min(buffer.length, Math.ceil(MAX_PLAYBACK_DURATION * buffer.sampleRate));
    const trimmed = context.createBuffer(buffer.numberOfChannels, frameCount, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      trimmed.copyToChannel(buffer.getChannelData(channel).subarray(0, frameCount), channel);
    }
    return trimmed;
  }

  async prepareFile(file: File): Promise<MusicProfile> {
    const context = this.ensureContext();
    const buffer = await this.decodeAudioBlob(context, file, file.name);
    const profile = this.analyzeBuffer(buffer, `${file.name}:${file.size}:${file.lastModified}`, file.name);
    const playbackBuffer = this.trimPlaybackBuffer(context, buffer);
    this.stop();
    this.profile = profile;
    this.sourceKind = 'local';
    this.usingFile = true;
    this.decodedTrack = playbackBuffer;
    return this.profile;
  }

  async prepareCatalogTrack(track: CatalogAudioTrack): Promise<MusicProfile> {
    const context = this.ensureContext();
    if (typeof track.bytes === 'number' && track.bytes > MAX_AUDIO_FILE_BYTES) {
      throw new AudioImportError('too-large', `${track.title} is larger than 48 MB`);
    }
    let response: Response;
    try {
      response = await fetch(track.file, { cache: 'force-cache' });
    } catch (error) {
      throw new AudioImportError('network', `${track.title} could not be downloaded`, { cause: error });
    }
    if (!response.ok) {
      throw new AudioImportError('network', `Music request failed: ${response.status} ${response.statusText}`);
    }
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch (error) {
      throw new AudioImportError('network', `${track.title} download was interrupted`, { cause: error });
    }
    const byteLength = blob.size;
    const buffer = await this.decodeAudioBlob(context, blob, track.title);
    const profile = this.analyzeBuffer(buffer, `catalog:${track.id}:${byteLength}`, track.title);
    const playbackBuffer = this.trimPlaybackBuffer(context, buffer);
    this.stop();
    this.profile = profile;
    this.sourceKind = 'catalog';
    this.usingFile = true;
    this.decodedTrack = playbackBuffer;
    return this.profile;
  }

  useSynthetic(): MusicProfile {
    this.stop();
    this.decodedTrack = null;
    this.profile = createDefaultMusicProfile();
    this.sourceKind = 'synthetic';
    this.usingFile = false;
    return this.profile;
  }

  async start(paused = false): Promise<void> {
    const context = this.ensureContext();
    this.resetMusicAccent();
    this.resetMusicFade();
    this.stopPreview(true);
    this.clearTrackSource();
    if (paused) {
      // Resume once inside the trusted Start click to satisfy autoplay policy,
      // then freeze the clock before the game source is created for countdown.
      if (context.state !== 'running') await context.resume();
      if (context.state === 'running') await context.suspend();
    } else if (context.state !== 'running') {
      await context.resume();
    }
    const startAt = context.currentTime;
    this.transportMode = 'game';
    if (this.usingFile) this.startDecodedTrack(context, startAt, 0);
    this.running = !paused;
    this.lastBeatAt = -10;
    this.beatAnchor = this.profile.beatOffset || 0;
    this.lastObservedTime = 0;
    this.beatPulse = 0;
    this.stepIndex = 0;
    this.nextStepTime = startAt + 0.05;
    // Decoded audio starts at startAt. The synth's first kick is scheduled on
    // nextStepTime, so its transport epoch must start on that exact sample too.
    this.startedAt = this.usingFile ? startAt : this.nextStepTime;
  }

  pause(): void {
    if (this.transportMode !== 'game' || !this.running) return;
    this.resetMusicAccent();
    this.running = false;
    if (this.context?.state === 'running') void this.context.suspend();
  }

  async resume(): Promise<void> {
    if (this.transportMode !== 'game') return;
    const context = this.ensureContext();
    await context.resume();
    this.running = true;
    if (this.nextStepTime < context.currentTime + 0.01) {
      this.nextStepTime = context.currentTime + 0.04;
      if (!this.usingFile && this.stepIndex === 0) this.startedAt = this.nextStepTime;
    }
  }

  stop(): void {
    this.resetMusicAccent();
    this.previewGeneration += 1;
    this.previewPlaying = false;
    this.previewOffset = 0;
    this.transportMode = 'idle';
    this.running = false;
    this.clearTrackSource();
    this.clearActiveSources();
    this.resetMusicFade();
    if (this.context) this.startedAt = this.context.currentTime;
    if (this.context?.state === 'running') void this.context.suspend();
  }

  getTime(): number {
    if (!this.context) return 0;
    const elapsed = this.getTransportTime();
    const loopDuration = this.decodedTrack?.duration || this.profile.duration;
    return this.usingFile && loopDuration > 0 ? elapsed % loopDuration : elapsed;
  }

  getTransportTime(): number {
    if (!this.context) return 0;
    if (this.transportMode === 'preview') return this.getPreviewTime();
    if (this.transportMode !== 'game') return 0;
    return Math.max(0, this.getPresentedContextTime() - this.startedAt);
  }

  update(dt: number): AudioBands {
    if (!this.context || !this.analyser) {
      const pulsePhase = (performance.now() / 1000) * (this.profile.bpm / 60);
      const pulse = Math.exp(-((pulsePhase % 1) * 7));
      return { bass: pulse * 0.7, mids: 0.3, highs: 0.2, overall: 0.3 + pulse * 0.3, pulse, onBeat: pulse > 0.82 };
    }

    if (this.running && !this.usingFile) this.scheduleSynth();
    this.analyser.getByteFrequencyData(this.frequencyData);
    const liveBass = this.averageBins(1, 10);
    const liveMids = this.averageBins(11, 64);
    const liveHighs = this.averageBins(65, 180);
    const now = this.getTime();
    const transportTime = this.getTransportTime();
    const rhythmTime = this.usingFile ? transportTime : now;
    const bass = this.usingFile ? this.sampleProfileCurve(this.profile.bass, now) : liveBass;
    const mids = this.usingFile ? this.sampleProfileCurve(this.profile.mids, now) : liveMids;
    const highs = this.usingFile ? this.sampleProfileCurve(this.profile.highs, now) : liveHighs;
    const overall = this.usingFile
      ? this.sampleProfileCurve(this.profile.energy, now)
      : clamp(bass * 0.46 + mids * 0.36 + highs * 0.18, 0, 1);
    if (this.usingFile && rhythmTime + 0.12 < this.lastObservedTime) {
      this.lastBeatAt = -10;
      this.beatAnchor = this.profile.beatOffset || 0;
      this.beatPulse = 0;
    }
    this.lastObservedTime = rhythmTime;
    const interval = 60 / this.profile.bpm;
    const beatPhase = ((((now - this.beatAnchor) % interval) + interval) % interval);
    const mappedBeatTime = this.usingFile ? this.mappedBeatAtOrBefore(transportTime) : undefined;
    const sinceMappedBeat = mappedBeatTime === undefined ? Number.POSITIVE_INFINITY : transportTime - mappedBeatTime;
    const timedPulse = mappedBeatTime === undefined
      ? Math.exp(-(beatPhase / interval) * 8.5)
      : Math.exp(-(Math.max(0, sinceMappedBeat) / interval) * 8.5);
    this.smoothedBass += (bass - this.smoothedBass) * Math.min(1, dt * 4.5);
    const detected = !this.usingFile
      && bass > Math.max(0.34, this.smoothedBass * 1.22)
      && rhythmTime - this.lastBeatAt > 0.23;
    const gridBeat = this.usingFile
      ? sinceMappedBeat >= 0
        && sinceMappedBeat < Math.min(0.055, interval * 0.14)
        && rhythmTime - this.lastBeatAt > Math.max(0.08, interval * 0.2)
      : beatPhase < Math.min(0.055, interval * 0.14) && rhythmTime - this.lastBeatAt > interval * 0.62;
    const onBeat = this.running && (detected || gridBeat);
    if (onBeat) {
      this.lastBeatAt = rhythmTime;
      this.beatPulse = 1;
    }
    this.beatPulse = Math.max(timedPulse * 0.72, this.beatPulse * Math.exp(-dt * 9));
    return { bass, mids, highs, overall, pulse: this.beatPulse, onBeat };
  }

  isInsideBeatWindow(windowSeconds = 0.08): boolean {
    const mappedBeats = this.profile.beats || [];
    const transportTime = this.getTransportTime();
    if (mappedBeats.length > 0) {
      let left = 0;
      let right = mappedBeats.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (mappedBeats[middle].time < transportTime) left = middle + 1;
        else right = middle;
      }
      const previousDelta = left > 0 ? Math.abs(mappedBeats[left - 1].time - transportTime) : Number.POSITIVE_INFINITY;
      const nextDelta = left < mappedBeats.length ? Math.abs(mappedBeats[left].time - transportTime) : Number.POSITIVE_INFINITY;
      return Math.min(previousDelta, nextDelta) <= windowSeconds;
    }

    const interval = 60 / this.profile.bpm;
    const now = this.getTime();
    const phase = ((((now - this.beatAnchor) % interval) + interval) % interval);
    const sinceDetectedBeat = now - this.lastBeatAt;
    return (sinceDetectedBeat >= 0 && sinceDetectedBeat <= windowSeconds)
      || phase <= windowSeconds
      || interval - phase <= windowSeconds;
  }

  private averageBins(start: number, end: number): number {
    const safeEnd = Math.min(end, this.frequencyData.length);
    let total = 0;
    for (let index = start; index < safeEnd; index += 1) total += this.frequencyData[index];
    return total / Math.max(1, safeEnd - start) / 255;
  }

  private sampleProfileCurve(values: readonly number[], time: number): number {
    if (values.length === 0) return 0;
    if (values.length === 1) return clamp(values[0], 0, 1);
    const duration = Math.max(0.001, Math.min(this.profile.duration || MAX_PLAYBACK_DURATION, MAX_PLAYBACK_DURATION));
    const loopTime = ((time % duration) + duration) % duration;
    const scaled = clamp(loopTime / duration, 0, 0.999999) * (values.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(left + 1, values.length - 1);
    const mix = scaled - left;
    return clamp(values[left] + (values[right] - values[left]) * mix, 0, 1);
  }

  private mappedBeatAtOrBefore(time: number): number | undefined {
    const beats = this.profile.beats || [];
    if (beats.length === 0 || time < beats[0].time) return undefined;
    let left = 0;
    let right = beats.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (beats[middle].time <= time) left = middle + 1;
      else right = middle;
    }
    return beats[Math.max(0, left - 1)]?.time;
  }

  private createNoiseBuffer(context: AudioContext, duration = 0.12, seed?: number): AudioBuffer {
    const length = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    const random = seed === undefined ? Math.random : mulberry32(seed);
    for (let index = 0; index < length; index += 1) channel[index] = random() * 2 - 1;
    return buffer;
  }

  playEffect(sound: GameSound, amount = 1): void {
    if (!this.context || !this.effectsGain || this.context.state !== 'running') return;
    const context = this.context;
    const destination = this.effectsGain;
    const time = context.currentTime;
    const intensity = clamp(amount, 0.05, 1.5);

    const tone = (
      type: OscillatorType,
      from: number,
      to: number,
      duration: number,
      level: number,
      delay = 0,
    ): void => {
      const start = time + delay;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(Math.max(20, from), start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level * intensity), start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(destination);
      this.registerSource(oscillator, () => gain.disconnect());
      oscillator.start(start);
      oscillator.stop(start + duration + 0.015);
    };

    const noise = (frequency: number, duration: number, level: number): void => {
      if (!this.noiseBuffer) return;
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = this.noiseBuffer;
      filter.type = 'bandpass';
      filter.frequency.value = frequency;
      filter.Q.value = 1.4;
      gain.gain.setValueAtTime(Math.max(0.0001, level * intensity), time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      this.registerSource(source, () => {
        filter.disconnect();
        gain.disconnect();
      });
      source.start(time);
      source.stop(time + duration);
    };

    if (sound === 'fire') tone('square', 760, 190, 0.085, 0.075);
    else if (sound === 'impact') {
      noise(170, 0.12, 0.28);
      tone('sawtooth', 105, 42, 0.18, 0.13);
    } else if (sound === 'pickup') {
      tone('sine', 620, 980, 0.14, 0.1);
      tone('sine', 930, 1320, 0.12, 0.055, 0.055);
    } else if (sound === 'ability') {
      tone('sawtooth', 120, 720, 0.24, 0.12);
      tone('sine', 360, 1080, 0.26, 0.06, 0.025);
    } else if (sound === 'upgrade') {
      tone('triangle', 440, 660, 0.18, 0.08);
      tone('triangle', 660, 990, 0.2, 0.065, 0.09);
    } else {
      noise(520, 0.1, 0.18);
      tone('square', 190, 58, 0.14, 0.08);
    }
  }

  /**
   * Plays a seeded, multi-layer hull explosion through the effects bus.
   * The sequence counter deliberately changes repeat attempts while preserving
   * deterministic output for the same ordered series of seeds.
   *
   * @returns the audible tail length in seconds, or zero when audio is inactive.
   */
  playDeathExplosion(seed: number, amount = 1): number {
    const context = this.context;
    const destination = this.effectsGain;
    const noiseBuffer = this.deathNoiseBuffer;
    if (
      !context
      || !destination
      || !noiseBuffer
      || context.state !== 'running'
      || this.transportMode !== 'game'
      || !this.running
    ) return 0;

    const intensity = clamp(Number.isFinite(amount) ? amount : 1, 0.05, 1.5);
    const normalizedSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : this.profile.seed;
    this.deathExplosionSequence += 1;
    const variationSeed = (
      normalizedSeed
      ^ this.profile.seed
      ^ Math.imul(this.deathExplosionSequence, 0x9e3779b9)
      ^ 0xd347b00f
    ) >>> 0;
    const random = mulberry32(variationSeed);
    const archetype = Math.floor(random() * 4);
    const time = context.currentTime;

    const tone = (
      type: OscillatorType,
      from: number,
      to: number,
      duration: number,
      level: number,
      delay = 0,
      pan = 0,
    ): void => {
      const start = time + delay;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(Math.max(20, from), start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
      gain.gain.setValueAtTime(MIN_AUDIO_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(MIN_AUDIO_GAIN, level * intensity), start + 0.008);
      gain.gain.exponentialRampToValueAtTime(MIN_AUDIO_GAIN, start + duration);
      panner.pan.setValueAtTime(clamp(pan, -1, 1), start);
      oscillator.connect(gain);
      gain.connect(panner);
      panner.connect(destination);
      this.registerSource(oscillator, () => {
        gain.disconnect();
        panner.disconnect();
      });
      oscillator.start(start);
      oscillator.stop(start + duration + 0.015);
    };

    const noise = (
      filterType: BiquadFilterType,
      from: number,
      to: number,
      q: number,
      duration: number,
      level: number,
      delay = 0,
      pan = 0,
      playbackRate = 1,
      offset = 0,
    ): void => {
      const start = time + delay;
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      source.buffer = noiseBuffer;
      source.playbackRate.setValueAtTime(clamp(playbackRate, 0.45, 1.8), start);
      filter.type = filterType;
      filter.frequency.setValueAtTime(Math.max(20, from), start);
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
      filter.Q.setValueAtTime(Math.max(0.1, q), start);
      gain.gain.setValueAtTime(MIN_AUDIO_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(MIN_AUDIO_GAIN, level * intensity), start + 0.006);
      gain.gain.exponentialRampToValueAtTime(MIN_AUDIO_GAIN, start + duration);
      panner.pan.setValueAtTime(clamp(pan, -1, 1), start);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(panner);
      panner.connect(destination);
      this.registerSource(source, () => {
        filter.disconnect();
        gain.disconnect();
        panner.disconnect();
      });
      source.start(start, clamp(offset, 0, 0.42));
      source.stop(start + duration + 0.01);
    };

    const bodyDuration = 1.04 + random() * 0.34 + (archetype === 0 ? 0.16 : 0);
    const subDuration = 0.78 + random() * 0.32 + (archetype === 0 ? 0.18 : 0);
    const secondaryDelay = 0.2 + random() * 0.28;
    const secondaryDuration = 0.34 + random() * 0.24;
    const fragmentCount = 2 + (archetype === 2 ? 2 : 0) + Math.floor(random() * 2);
    let tailDuration = Math.max(bodyDuration, subDuration, secondaryDelay + secondaryDuration);

    noise(
      'lowpass',
      480 + random() * 260,
      105 + random() * 95,
      0.7 + random() * 0.9,
      bodyDuration,
      archetype === 0 ? 0.38 : 0.31,
      0,
      (random() - 0.5) * 0.18,
      0.68 + random() * 0.28,
      random() * 0.32,
    );
    noise(
      'highpass',
      1_800 + random() * 2_400,
      5_600 + random() * 2_600,
      0.5 + random() * 1.4,
      0.11 + random() * 0.09,
      archetype === 1 ? 0.3 : 0.22,
      0,
      (random() - 0.5) * 0.6,
      1.05 + random() * 0.45,
      random() * 0.42,
    );
    tone(
      'sine',
      92 + random() * 48,
      24 + random() * 16,
      subDuration,
      archetype === 0 ? 0.32 : 0.26,
      0,
      (random() - 0.5) * 0.12,
    );
    tone(
      archetype === 1 ? 'sawtooth' : 'triangle',
      190 + random() * 170,
      42 + random() * 44,
      0.38 + random() * 0.22,
      0.14,
      0.018 + random() * 0.025,
      (random() - 0.5) * 0.28,
    );

    noise(
      'bandpass',
      260 + random() * 540,
      95 + random() * 180,
      1.1 + random() * 1.6,
      secondaryDuration,
      archetype === 3 ? 0.29 : 0.2,
      secondaryDelay,
      (random() - 0.5) * 1.1,
      0.74 + random() * 0.36,
      random() * 0.36,
    );
    tone(
      'sine',
      78 + random() * 62,
      27 + random() * 22,
      secondaryDuration + 0.08,
      0.14,
      secondaryDelay,
      (random() - 0.5) * 1.1,
    );

    for (let index = 0; index < fragmentCount; index += 1) {
      const delay = 0.1 + index * (0.075 + random() * 0.055) + random() * 0.06;
      const duration = 0.14 + random() * 0.24;
      tailDuration = Math.max(tailDuration, delay + duration);
      tone(
        index % 2 === 0 ? 'triangle' : 'sawtooth',
        360 + random() * 880 + archetype * 70,
        58 + random() * 130,
        duration,
        0.055 + random() * 0.04,
        delay,
        (random() - 0.5) * 1.6,
      );
    }

    return tailDuration + 0.03;
  }

  private scheduleSynth(): void {
    if (!this.context || !this.musicInput || !this.noiseBuffer) return;
    const stepDuration = 60 / this.profile.bpm / 4;
    while (this.nextStepTime < this.context.currentTime + 0.12) {
      const step = this.stepIndex % 16;
      if (step % 4 === 0) this.scheduleKick(this.nextStepTime, step === 0 ? 1 : 0.72);
      if (step % 2 === 0) this.scheduleHat(this.nextStepTime, step % 4 === 2 ? 0.7 : 0.32);
      if ([0, 3, 6, 8, 11, 14].includes(step)) this.scheduleBass(this.nextStepTime, step);
      this.nextStepTime += stepDuration;
      this.stepIndex += 1;
    }
  }

  private scheduleKick(time: number, amount: number): void {
    if (!this.context || !this.musicInput) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.setValueAtTime(145, time);
    oscillator.frequency.exponentialRampToValueAtTime(42, time + 0.13);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.55 * amount, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    oscillator.connect(gain);
    gain.connect(this.musicInput);
    this.registerSource(oscillator, () => gain.disconnect());
    oscillator.start(time);
    oscillator.stop(time + 0.22);
  }

  private scheduleHat(time: number, amount: number): void {
    if (!this.context || !this.musicInput || !this.noiseBuffer) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = 'highpass';
    filter.frequency.value = 6800;
    gain.gain.setValueAtTime(0.13 * amount, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicInput);
    this.registerSource(source, () => {
      filter.disconnect();
      gain.disconnect();
    });
    source.start(time);
    source.stop(time + 0.065);
  }

  private scheduleBass(time: number, step: number): void {
    if (!this.context || !this.musicInput) return;
    const notes = [55, 55, 65.41, 49, 73.42, 49];
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = notes[step % notes.length];
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(340, time);
    filter.frequency.exponentialRampToValueAtTime(110, time + 0.16);
    filter.Q.value = 6;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.095, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicInput);
    this.registerSource(oscillator, () => {
      filter.disconnect();
      gain.disconnect();
    });
    oscillator.start(time);
    oscillator.stop(time + 0.2);
  }

  private analyzeBuffer(buffer: AudioBuffer, key: string, title: string): MusicProfile {
    const maxDuration = Math.min(buffer.duration, 108);
    const maxSamples = Math.floor(maxDuration * buffer.sampleRate);
    const hop = 1024;
    const stride = 4;
    const sampleRate = buffer.sampleRate / stride;
    const frameCount = Math.max(1, Math.ceil(maxSamples / hop));
    const energyRaw: number[] = [];
    const bassRaw: number[] = [];
    const midsRaw: number[] = [];
    const highsRaw: number[] = [];
    const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
    const midAlpha = 1 - Math.exp((-2 * Math.PI * 2600) / sampleRate);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const lowStates = new Float64Array(channels.length);
    const midStates = new Float64Array(channels.length);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = frame * hop;
      const end = Math.min(maxSamples, start + hop);
      let totalEnergy = 0;
      let lowEnergy = 0;
      let midEnergy = 0;
      let highEnergy = 0;
      let count = 0;
      for (let index = start; index < end; index += stride) {
        let sampleEnergy = 0;
        let sampleLowEnergy = 0;
        let sampleMidEnergy = 0;
        let sampleHighEnergy = 0;
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          const sample = channels[channelIndex][index] || 0;
          lowStates[channelIndex] += lowAlpha * (sample - lowStates[channelIndex]);
          midStates[channelIndex] += midAlpha * (sample - midStates[channelIndex]);
          const low = lowStates[channelIndex];
          const mid = midStates[channelIndex] - lowStates[channelIndex];
          const high = sample - midStates[channelIndex];
          sampleEnergy += sample * sample;
          sampleLowEnergy += low * low;
          sampleMidEnergy += mid * mid;
          sampleHighEnergy += high * high;
        }
        const channelScale = 1 / Math.max(1, channels.length);
        totalEnergy += sampleEnergy * channelScale;
        lowEnergy += sampleLowEnergy * channelScale;
        midEnergy += sampleMidEnergy * channelScale;
        highEnergy += sampleHighEnergy * channelScale;
        count += 1;
      }
      energyRaw.push(Math.sqrt(totalEnergy / Math.max(1, count)));
      bassRaw.push(Math.sqrt(lowEnergy / Math.max(1, count)));
      midsRaw.push(Math.sqrt(midEnergy / Math.max(1, count)));
      highsRaw.push(Math.sqrt(highEnergy / Math.max(1, count)));
    }

    const normalized = normalizeMusicBands(energyRaw, bassRaw, midsRaw, highsRaw);
    const energyNorm = normalized.energy;
    const bassNorm = normalized.bass;
    const midsNorm = normalized.mids;
    const highsNorm = normalized.highs;
    const tempo = this.estimateTempo(energyNorm, bassNorm, hop / buffer.sampleRate);
    const bins = 384;
    const cleanTitle = title.replace(/\.[^/.]+$/, '').slice(0, 48).toUpperCase();
    const runDuration = clamp(buffer.duration, 58, 108);
    const energy = poolMusicCurve(energyNorm, bins);
    const bass = poolMusicCurve(bassNorm, bins);
    const mids = poolMusicCurve(midsNorm, bins);
    const highs = poolMusicCurve(highsNorm, bins);
    const rhythm = this.buildRhythmMap(
      energyNorm,
      bassNorm,
      midsNorm,
      highsNorm,
      Math.min(buffer.duration, MAX_PLAYBACK_DURATION),
      runDuration,
      hop / buffer.sampleRate,
      tempo.bpm,
      tempo.beatOffset,
    );
    const onsets = poolMusicCurve(rhythm.onsets, bins, 'peak');
    const kicks = poolMusicCurve(rhythm.kicks, bins, 'peak');
    const transients = poolMusicCurve(rhythm.transients, bins, 'peak');
    const fingerprintCurve = (label: string, values: number[]): string => `${label}:${values
      .filter((_, index) => index % 4 === 0)
      .map((value) => Math.round(value * 127))
      .join(',')}`;
    const cueCode = (beat: RhythmBeat): string => beat.cue === 'kick'
      ? 'k'
      : beat.cue === 'transient'
        ? 'h'
        : beat.cue === 'transition'
          ? 'x'
          : 'b';
    const contentFingerprint = [
      `bpm:${tempo.bpm}`,
      `offset:${Math.round(tempo.beatOffset * 1000)}`,
      `course:${Math.round(runDuration * 1000)}`,
      fingerprintCurve('energy', energy),
      fingerprintCurve('bass', bass),
      fingerprintCurve('mids', mids),
      fingerprintCurve('highs', highs),
      fingerprintCurve('onsets', onsets),
      fingerprintCurve('kicks', kicks),
      fingerprintCurve('hits', transients),
      `beats:${rhythm.beats.map((beat) => [
        Math.round(beat.time * 100),
        cueCode(beat),
        Math.round(beat.strength * 31),
        Math.round((beat.kick ?? 0) * 15),
        Math.round((beat.transient ?? 0) * 15),
        beat.gridBeat === false ? 'o' : 'g',
      ].join('')).join(',')}`,
      `transitions:${rhythm.transitions.map((transition) => `${
        Math.round(transition.time * 100)
      }${transition.kind[0]}${Math.round(transition.strength * 31)}`).join(',')}`,
    ].join(':');
    return {
      id: key,
      title: cleanTitle,
      duration: buffer.duration,
      runDuration,
      bpm: tempo.bpm,
      beatOffset: tempo.beatOffset,
      energy,
      bass,
      mids,
      highs,
      onsets,
      kicks,
      transients,
      beats: rhythm.beats,
      transitions: rhythm.transitions,
      seed: hashString(contentFingerprint),
    };
  }

  private buildRhythmMap(
    energy: number[],
    bass: number[],
    mids: number[],
    highs: number[],
    sourceDuration: number,
    runDuration: number,
    frameDuration: number,
    bpm: number,
    beatOffset: number,
  ): {
    beats: RhythmBeat[];
    transitions: MusicTransition[];
    onsets: number[];
    kicks: number[];
    transients: number[];
  } {
    const novelty = analyzeMusicNovelty(energy, bass, mids, highs, frameDuration);
    const onsets = novelty.frames.map((frame) => frame.onset);
    const kicks = novelty.frames.map((frame) => frame.kick);
    const transients = novelty.frames.map((frame) => frame.transient);
    const interval = 60 / bpm;
    const beats: RhythmBeat[] = [];
    const sourceFrames = Math.max(1, energy.length - 1);
    const frameAt = (time: number): number => {
      const loopTime = sourceDuration > 0 ? ((time % sourceDuration) + sourceDuration) % sourceDuration : time;
      const effectiveFrameDuration = Math.max(frameDuration, sourceDuration / Math.max(1, energy.length));
      return clamp(Math.round(loopTime / effectiveFrameDuration - 0.5), 0, sourceFrames);
    };
    const frameTime = (index: number): number => Math.min(sourceDuration, (index + 0.5) * frameDuration);
    let barBeat: 0 | 1 | 2 | 3 = 0;
    for (let time = Math.max(0, beatOffset); time <= runDuration + 0.0001; time += interval) {
      const center = frameAt(time);
      let peakIndex = center;
      const searchRadius = Math.max(2, Math.round(Math.min(0.14, interval * 0.28) / frameDuration));
      for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
        const candidate = clamp(center + offset, 0, sourceFrames);
        const candidateScore = Math.max(kicks[candidate] || 0, transients[candidate] || 0, (onsets[candidate] || 0) * 0.78);
        const peakScore = Math.max(kicks[peakIndex] || 0, transients[peakIndex] || 0, (onsets[peakIndex] || 0) * 0.78);
        if (candidateScore > peakScore) peakIndex = candidate;
      }
      const onsetStrength = onsets[peakIndex] || 0;
      const kickStrength = kicks[peakIndex] || 0;
      const transientStrength = transients[peakIndex] || 0;
      const loopTime = sourceDuration > 0 ? ((time % sourceDuration) + sourceDuration) % sourceDuration : time;
      let alignment = frameTime(peakIndex) - loopTime;
      if (sourceDuration > 0 && alignment > sourceDuration * 0.5) alignment -= sourceDuration;
      if (sourceDuration > 0 && alignment < -sourceDuration * 0.5) alignment += sourceDuration;
      const maximumShift = Math.min(0.14, interval * 0.28);
      const accentStrength = Math.max(kickStrength, transientStrength, onsetStrength * 0.78);
      const onsetShift = accentStrength > 0.2 ? clamp(alignment, -maximumShift, maximumShift) : 0;
      const previousBeat = beats[beats.length - 1];
      const minimumTime = previousBeat ? previousBeat.time + interval * 0.5 : 0;
      const alignedTime = clamp(Math.max(minimumTime, time + onsetShift), 0, runDuration);
      const cue = kickStrength >= Math.max(0.48, transientStrength * 0.9)
        ? 'kick'
        : transientStrength >= 0.52
          ? 'transient'
          : 'beat';
      const localEnergy = energy[peakIndex] || 0;
      beats.push({
        time: Number(alignedTime.toFixed(4)),
        strength: clamp(
          0.12
          + onsetStrength * 0.3
          + kickStrength * 0.34
          + transientStrength * 0.25
          + localEnergy * 0.1
          + (barBeat === 0 && kickStrength > 0.34 ? 0.08 : 0),
          0,
          1,
        ),
        bass: bass[peakIndex] || 0,
        highs: highs[peakIndex] || 0,
        barBeat,
        gridBeat: true,
        cue,
        onset: onsetStrength,
        kick: kickStrength,
        transient: transientStrength,
      });
      barBeat = ((barBeat + 1) % 4) as 0 | 1 | 2 | 3;
    }

    // Preserve strong syncopated hits that live between the estimated BPM beats.
    // They become first-class anchors instead of being discarded by the grid.
    for (let loopStart = 0; loopStart < runDuration; loopStart += Math.max(sourceDuration, 0.1)) {
      for (const accent of novelty.accents) {
        const time = accent.time + loopStart;
        if (time < 0 || time > runDuration + 0.0001) continue;
        let nearest: RhythmBeat | undefined;
        let nearestDelta = Number.POSITIVE_INFINITY;
        for (const beat of beats) {
          const delta = Math.abs(beat.time - time);
          if (delta < nearestDelta) {
            nearest = beat;
            nearestDelta = delta;
          }
          if (beat.time > time + interval) break;
        }
        const sameHitWindow = Math.min(0.045, Math.max(0.025, frameDuration * 1.5), interval * 0.12);
        if (nearest && nearestDelta <= sameHitWindow) {
          if (accent.strength > (nearest.onset ?? 0)) {
            nearest.time = Number(time.toFixed(4));
            nearest.cue = accent.cue;
            nearest.onset = Math.max(nearest.onset ?? 0, accent.onset);
            nearest.kick = Math.max(nearest.kick ?? 0, accent.kick);
            nearest.transient = Math.max(nearest.transient ?? 0, accent.transient);
            nearest.strength = Math.max(nearest.strength, clamp(0.2 + accent.strength * 0.76, 0, 1));
          }
          continue;
        }

        const sourceFrame = clamp(accent.frame, 0, sourceFrames);
        const gridOrdinal = Math.max(0, Math.round((time - Math.max(0, beatOffset)) / interval));
        beats.push({
          time: Number(time.toFixed(4)),
          strength: clamp(0.2 + accent.strength * 0.76 + (energy[sourceFrame] || 0) * 0.04, 0, 1),
          bass: bass[sourceFrame] || 0,
          highs: highs[sourceFrame] || 0,
          barBeat: (gridOrdinal % 4) as RhythmBeat['barBeat'],
          gridBeat: false,
          cue: accent.cue,
          onset: accent.onset,
          kick: accent.kick,
          transient: accent.transient,
        });
      }
    }
    beats.sort((left, right) => left.time - right.time || right.strength - left.strength);

    const sourceCandidates: Array<MusicTransition & { score: number }> = [];
    const average = (values: number[], start: number, end: number): number => {
      let sum = 0;
      let count = 0;
      for (let index = Math.max(0, start); index < Math.min(values.length, end); index += 1) {
        sum += values[index];
        count += 1;
      }
      return sum / Math.max(1, count);
    };
    const transitionStep = Math.max(1, Math.round(0.42 / frameDuration));
    const longWindow = Math.max(transitionStep * 4, Math.round(2.2 / frameDuration));
    for (let index = longWindow; index < energy.length - transitionStep; index += transitionStep) {
      const beforeEnergy = average(energy, index - longWindow, index - transitionStep);
      const nowEnergy = average(energy, index, index + transitionStep);
      const beforeBass = average(bass, index - longWindow, index - transitionStep);
      const nowBass = average(bass, index, index + transitionStep);
      const beforeHighs = average(highs, index - transitionStep * 2, index);
      const nowHighs = average(highs, index, index + transitionStep);
      const energyDelta = nowEnergy - beforeEnergy;
      const bassDelta = nowBass - beforeBass;
      const highDelta = nowHighs - beforeHighs;
      let kind: MusicTransition['kind'] | null = null;
      let strength = 0;
      if (energyDelta > 0.16 && bassDelta > 0.08) {
        kind = 'drop';
        strength = energyDelta * 2.5 + bassDelta * 1.6;
      } else if (energyDelta > 0.1) {
        kind = 'build';
        strength = energyDelta * 3.2 + Math.max(0, highDelta);
      } else if (energyDelta < -0.16 && nowEnergy < 0.52) {
        kind = 'break';
        strength = -energyDelta * 2.8;
      } else if (Math.abs(highDelta) > 0.18) {
        kind = 'fill';
        strength = Math.abs(highDelta) * 2.4 + Math.abs(bassDelta);
      }
      if (!kind || strength < 0.38) continue;
      let peakIndex = index;
      const snapRadius = Math.max(1, Math.round(Math.min(0.16, interval * 0.32) / frameDuration));
      for (let offset = -snapRadius; offset <= snapRadius; offset += 1) {
        const candidate = clamp(index + offset, 0, sourceFrames);
        const candidateScore = Math.max(kicks[candidate] || 0, transients[candidate] || 0, (onsets[candidate] || 0) * 0.78);
        const peakScore = Math.max(kicks[peakIndex] || 0, transients[peakIndex] || 0, (onsets[peakIndex] || 0) * 0.78);
        if (candidateScore > peakScore) peakIndex = candidate;
      }
      sourceCandidates.push({
        time: Number(frameTime(peakIndex).toFixed(4)),
        strength: clamp(strength, 0, 1),
        kind,
        score: strength,
      });
    }
    const eligibleCandidates = sourceCandidates.filter((candidate) => (
      candidate.time >= 4 && candidate.time <= sourceDuration - 3
    ));
    const candidateScores = eligibleCandidates.map((candidate) => candidate.score).sort((a, b) => a - b);
    const scoreMean = candidateScores.reduce((sum, score) => sum + score, 0) / Math.max(1, candidateScores.length);
    const scoreVariance = candidateScores.reduce(
      (sum, score) => sum + (score - scoreMean) ** 2,
      0,
    ) / Math.max(1, candidateScores.length);
    const scoreDeviation = Math.sqrt(scoreVariance);
    const scorePercentile = candidateScores[Math.floor(Math.max(0, candidateScores.length - 1) * 0.62)] ?? 1;
    const strongestScore = candidateScores[candidateScores.length - 1] ?? 1;
    const adaptiveScoreCutoff = Math.min(
      strongestScore,
      Math.max(0.46, scorePercentile, scoreMean + scoreDeviation * 0.18),
    );
    eligibleCandidates.sort((a, b) => b.score - a.score || a.time - b.time);
    const transitionBudget = Math.round(clamp(runDuration / 12, 4, 9));
    const minimumTransitionGap = 5.5;
    const selected: MusicTransition[] = [];
    for (const candidate of eligibleCandidates) {
      if (candidate.score + Number.EPSILON < adaptiveScoreCutoff) continue;
      if (selected.some((item) => Math.abs(item.time - candidate.time) < minimumTransitionGap)) continue;
      selected.push({ time: candidate.time, strength: candidate.strength, kind: candidate.kind });
      if (selected.length >= transitionBudget) break;
    }
    const transitions: MusicTransition[] = [];
    let transitionBudgetReached = false;
    for (let loopStart = 0; loopStart < runDuration; loopStart += Math.max(sourceDuration, 0.1)) {
      for (const transition of selected) {
        const time = transition.time + loopStart;
        if (time < runDuration) transitions.push({ ...transition, time });
        if (transitions.length >= transitionBudget) {
          transitionBudgetReached = true;
          break;
        }
      }
      if (transitionBudgetReached) break;
    }
    transitions.sort((a, b) => a.time - b.time);
    return { beats, transitions, onsets, kicks, transients };
  }

  private estimateTempo(energy: number[], bass: number[], frameDuration: number): { bpm: number; beatOffset: number } {
    const safeFrameDuration = Math.max(0.001, frameDuration);
    const onset = energy.map((value, index) => {
      if (index === 0) return 0;
      return Math.max(0, value - energy[index - 1]) * 0.4 + Math.max(0, bass[index] - bass[index - 1]) * 0.6;
    });
    const mean = onset.reduce((sum, value) => sum + value, 0) / Math.max(1, onset.length);
    const variance = onset.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, onset.length);
    const deviation = Math.sqrt(variance);
    const noiseFloor = mean + deviation * 0.35;
    const sparsePeaks = new Array<number>(onset.length).fill(0);
    let strongestPeak = 0;
    let strongestPeakIndex = -1;
    for (let index = 1; index < onset.length - 1; index += 1) {
      if (onset[index] < onset[index - 1] || onset[index] <= onset[index + 1]) continue;
      const strength = Math.max(0, onset[index] - noiseFloor);
      sparsePeaks[index] = strength;
      if (strength > strongestPeak) {
        strongestPeak = strength;
        strongestPeakIndex = index;
      }
    }
    const fallbackTempo = (): { bpm: number; beatOffset: number } => {
      const bpm = 140;
      const interval = 60 / bpm;
      const strongestTime = strongestPeakIndex >= 0 ? strongestPeakIndex * safeFrameDuration : 0;
      return { bpm, beatOffset: ((strongestTime % interval) + interval) % interval };
    };
    if (strongestPeak <= 0.000001) return fallbackTempo();

    const envelope = sparsePeaks.map((value) => clamp(value / strongestPeak, 0, 1));
    const peakCount = envelope.reduce((count, value) => count + (value >= 0.08 ? 1 : 0), 0);
    const totalPeakPower = envelope.reduce((sum, value) => sum + value * value, 0);
    if (peakCount < 5 || totalPeakPower < 0.12) return fallbackTempo();

    const sampleEnvelope = (position: number): number => {
      if (position < 0 || position >= envelope.length - 1) return 0;
      const left = Math.floor(position);
      const mix = position - left;
      return envelope[left] + (envelope[left + 1] - envelope[left]) * mix;
    };
    const autocorrelation = (lag: number): number => {
      let correlation = 0;
      let presentPower = 0;
      let delayedPower = 0;
      for (let index = Math.ceil(lag); index < envelope.length; index += 1) {
        const present = envelope[index];
        const delayed = sampleEnvelope(index - lag);
        correlation += present * delayed;
        presentPower += present * present;
        delayedPower += delayed * delayed;
      }
      return correlation / Math.max(0.000000001, Math.sqrt(presentPower * delayedPower));
    };
    const pulseAt = (position: number): number => {
      const radius = Math.max(1, Math.round(0.045 / safeFrameDuration));
      let pulse = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const index = Math.round(position) + offset;
        if (index < 0 || index >= envelope.length) continue;
        const distance = Math.abs(index - position);
        const proximity = clamp(1 - distance / (radius + 1), 0, 1);
        pulse = Math.max(pulse, envelope[index] * proximity);
      }
      return pulse;
    };

    interface TempoCandidate {
      bpm: number;
      score: number;
      phaseCoherence: number;
      beatOffset: number;
    }
    const candidates: TempoCandidate[] = [];
    for (let bpm = 84; bpm <= 184; bpm += 1) {
      const lag = 60 / bpm / safeFrameDuration;
      const periodicity = autocorrelation(lag) * 0.62
        + autocorrelation(lag * 2) * 0.26
        + autocorrelation(lag * 3) * 0.12;
      let bestPhaseCoherence = 0;
      let bestPhase = 0;
      const phaseBins = 64;
      for (let phaseBin = 0; phaseBin < phaseBins; phaseBin += 1) {
        const phase = (phaseBin / phaseBins) * lag;
        let pulseSum = 0;
        let pulseCount = 0;
        for (let position = phase; position < envelope.length; position += lag) {
          pulseSum += pulseAt(position);
          pulseCount += 1;
        }
        const coherence = pulseSum / Math.max(0.000000001, Math.sqrt(pulseCount * totalPeakPower));
        if (coherence > bestPhaseCoherence) {
          bestPhaseCoherence = coherence;
          bestPhase = phase;
        }
      }
      candidates.push({
        bpm,
        score: periodicity * 0.58 + bestPhaseCoherence * 0.42,
        phaseCoherence: bestPhaseCoherence,
        beatOffset: bestPhase * safeFrameDuration,
      });
    }
    candidates.sort((left, right) => right.score - left.score || left.bpm - right.bpm);
    let best = candidates[0];

    // Only the lowest octave overlaps our candidate range. Prefer its slower
    // interpretation when it explains almost as much energy as an alternating
    // double-time pulse; a uniform high-tempo click still wins comfortably.
    if (best.bpm >= 168) {
      const lowerCandidates = candidates
        .filter((candidate) => Math.abs(candidate.bpm - best.bpm / 2) <= 0.75)
        .sort((left, right) => right.score - left.score || left.bpm - right.bpm);
      const lower = lowerCandidates[0];
      if (
        lower
        && lower.score >= best.score * 0.91
        && lower.phaseCoherence >= best.phaseCoherence * 0.82
      ) best = lower;
    }
    if (!best || best.score < 0.28 || best.phaseCoherence < 0.2) return fallbackTempo();
    const interval = 60 / best.bpm;
    return {
      bpm: best.bpm,
      beatOffset: ((best.beatOffset % interval) + interval) % interval,
    };
  }

  async dispose(): Promise<void> {
    this.stop();
    this.decodedTrack = null;
    this.musicInput?.disconnect();
    this.analyser?.disconnect();
    this.musicAccentFilter?.disconnect();
    this.musicAccentGain?.disconnect();
    this.musicFadeGain?.disconnect();
    this.musicGain?.disconnect();
    this.effectsGain?.disconnect();
    this.outputGain?.disconnect();
    this.limiter?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
    this.noiseBuffer = null;
    this.deathNoiseBuffer = null;
  }
}
