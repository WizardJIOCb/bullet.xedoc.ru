import { clamp, hashString } from '../core/math';
import type { MusicProfile, MusicTransition, RhythmBeat } from '../core/types';
import { createDefaultMusicProfile } from '../game/track';
import type { AudioSettings } from '../settings/SettingsStore';

export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  overall: number;
  pulse: number;
  onBeat: boolean;
}

export type AudioSourceKind = 'synthetic' | 'catalog' | 'local';
export type GameSound = 'fire' | 'impact' | 'pickup' | 'perfect' | 'ability' | 'upgrade' | 'destroy';

export interface CatalogAudioTrack {
  id: string;
  title: string;
  file: string;
  bytes?: number;
}

const MAX_AUDIO_FILE_BYTES = 48 * 1024 * 1024;
const MAX_AUDIO_DURATION = 3 * 60;
const MAX_PLAYBACK_DURATION = 108;

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private musicInput: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private frequencyData = new Uint8Array(256);
  private decodedTrack: AudioBuffer | null = null;
  private trackSource: AudioBufferSourceNode | null = null;
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

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.76;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.musicInput = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.effectsGain = this.context.createGain();
    this.outputGain = this.context.createGain();
    this.limiter = this.context.createDynamicsCompressor();
    this.musicGain.gain.value = this.audioSettings.musicVolume;
    this.effectsGain.gain.value = this.audioSettings.effectsVolume;
    this.outputGain.gain.value = this.audioSettings.muted ? 0 : this.audioSettings.masterVolume;
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.musicInput.connect(this.analyser);
    this.analyser.connect(this.musicGain);
    this.musicGain.connect(this.outputGain);
    this.effectsGain.connect(this.outputGain);
    this.outputGain.connect(this.limiter);
    this.limiter.connect(this.context.destination);
    this.noiseBuffer = this.createNoiseBuffer(this.context);
    this.applyAudioSettings();
    return this.context;
  }

  private clearTrackSource(): void {
    if (!this.trackSource) return;
    try {
      this.trackSource.stop();
    } catch {
      // A source that never started or already ended is safe to discard.
    }
    this.trackSource.disconnect();
    this.trackSource = null;
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

  private startDecodedTrack(context: AudioContext, startAt: number): void {
    if (!this.decodedTrack) throw new Error('Decoded track is not available');
    this.clearTrackSource();
    const source = context.createBufferSource();
    source.buffer = this.decodedTrack;
    source.loop = true;
    source.connect(this.musicInput!);
    source.start(startAt);
    this.trackSource = source;
  }

  private async validateAudioBlob(blob: Blob, label: string): Promise<void> {
    if (blob.size > MAX_AUDIO_FILE_BYTES) {
      throw new Error(`${label} is larger than 48 MB`);
    }
    const duration = await new Promise<number>((resolve, reject) => {
      const media = new Audio();
      const url = URL.createObjectURL(blob);
      let settled = false;
      let timeout = 0;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        const resolvedDuration = media.duration;
        window.clearTimeout(timeout);
        media.removeAttribute('src');
        media.load();
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve(resolvedDuration);
      };
      timeout = window.setTimeout(() => finish(new Error('Audio metadata timed out')), 10000);
      media.preload = 'metadata';
      media.addEventListener('loadedmetadata', () => finish(), { once: true });
      media.addEventListener('error', () => finish(new Error('Audio metadata could not be read')), { once: true });
      media.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label} has an invalid duration`);
    if (duration > MAX_AUDIO_DURATION) throw new Error(`${label} is longer than 3 minutes`);
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
    this.stop();
    this.decodedTrack = null;
    await this.validateAudioBlob(file, file.name);
    const bytes = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    if (buffer.duration > MAX_AUDIO_DURATION) throw new Error(`${file.name} is longer than 3 minutes`);
    const profile = this.analyzeBuffer(buffer, `${file.name}:${file.size}:${file.lastModified}`, file.name);
    const playbackBuffer = this.trimPlaybackBuffer(context, buffer);
    this.profile = profile;
    this.sourceKind = 'local';
    this.usingFile = true;
    this.decodedTrack = playbackBuffer;
    return this.profile;
  }

  async prepareCatalogTrack(track: CatalogAudioTrack): Promise<MusicProfile> {
    const context = this.ensureContext();
    this.stop();
    this.decodedTrack = null;
    if (typeof track.bytes === 'number' && track.bytes > MAX_AUDIO_FILE_BYTES) {
      throw new Error(`${track.title} is larger than 48 MB`);
    }
    const response = await fetch(track.file, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Music request failed: ${response.status} ${response.statusText}`);
    const blob = await response.blob();
    await this.validateAudioBlob(blob, track.title);
    const byteLength = blob.size;
    const bytes = await blob.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    if (buffer.duration > MAX_AUDIO_DURATION) throw new Error(`${track.title} is longer than 3 minutes`);
    const profile = this.analyzeBuffer(buffer, `catalog:${track.id}:${byteLength}`, track.title);
    const playbackBuffer = this.trimPlaybackBuffer(context, buffer);
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

  async start(): Promise<void> {
    const context = this.ensureContext();
    const startAt = context.currentTime;
    const resumePromise = context.resume();
    if (this.usingFile) this.startDecodedTrack(context, startAt);
    this.startedAt = startAt;
    await resumePromise;
    this.running = true;
    this.lastBeatAt = -10;
    this.beatAnchor = this.profile.beatOffset || 0;
    this.lastObservedTime = 0;
    this.beatPulse = 0;
    this.stepIndex = 0;
    this.nextStepTime = context.currentTime + 0.05;
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.context?.state === 'running') void this.context.suspend();
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    await context.resume();
    this.running = true;
    if (this.nextStepTime < context.currentTime + 0.01) this.nextStepTime = context.currentTime + 0.04;
  }

  stop(): void {
    this.running = false;
    this.clearTrackSource();
    this.clearActiveSources();
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
    return Math.max(0, this.context.currentTime - this.startedAt);
  }

  update(dt: number): AudioBands {
    if (!this.context || !this.analyser) {
      const pulsePhase = (performance.now() / 1000) * (this.profile.bpm / 60);
      const pulse = Math.exp(-((pulsePhase % 1) * 7));
      return { bass: pulse * 0.7, mids: 0.3, highs: 0.2, overall: 0.3 + pulse * 0.3, pulse, onBeat: pulse > 0.82 };
    }

    if (this.running && !this.usingFile) this.scheduleSynth();
    this.analyser.getByteFrequencyData(this.frequencyData);
    const bass = this.averageBins(1, 10);
    const mids = this.averageBins(11, 64);
    const highs = this.averageBins(65, 180);
    const overall = clamp(bass * 0.46 + mids * 0.36 + highs * 0.18, 0, 1);
    const now = this.getTime();
    if (this.usingFile && now + 0.12 < this.lastObservedTime) {
      this.lastBeatAt = -10;
      this.beatAnchor = this.profile.beatOffset || 0;
      this.beatPulse = 0;
    }
    this.lastObservedTime = now;
    const interval = 60 / this.profile.bpm;
    const beatPhase = ((((now - this.beatAnchor) % interval) + interval) % interval);
    const timedPulse = Math.exp(-(beatPhase / interval) * 8.5);
    this.smoothedBass += (bass - this.smoothedBass) * Math.min(1, dt * 4.5);
    const detected = bass > Math.max(0.34, this.smoothedBass * 1.22) && now - this.lastBeatAt > 0.23;
    const gridBeat = beatPhase < Math.min(0.055, interval * 0.14) && now - this.lastBeatAt > interval * 0.62;
    const onBeat = this.running && (detected || gridBeat);
    if (onBeat) {
      if (detected && this.usingFile) {
        const nearestBeat = this.beatAnchor + Math.round((now - this.beatAnchor) / interval) * interval;
        const phaseError = now - nearestBeat;
        if (Math.abs(phaseError) < interval * 0.42) this.beatAnchor += clamp(phaseError, -0.09, 0.09) * 0.24;
      }
      this.lastBeatAt = now;
      this.beatPulse = 1;
    }
    this.beatPulse = Math.max(timedPulse * 0.72, this.beatPulse * Math.exp(-dt * 9));
    return { bass, mids, highs, overall, pulse: this.beatPulse, onBeat };
  }

  isInsideBeatWindow(windowSeconds = 0.08): boolean {
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

  private createNoiseBuffer(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 0.12);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) channel[index] = Math.random() * 2 - 1;
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
    } else if (sound === 'perfect') {
      tone('triangle', 880, 1320, 0.16, 0.075);
      tone('sine', 1320, 1760, 0.13, 0.045, 0.07);
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
    const hop = 2048;
    const stride = 4;
    const sampleRate = buffer.sampleRate / stride;
    const frameCount = Math.max(1, Math.ceil(maxSamples / hop));
    const energyRaw: number[] = [];
    const bassRaw: number[] = [];
    const midsRaw: number[] = [];
    const highsRaw: number[] = [];
    let lowState = 0;
    let midState = 0;
    const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
    const midAlpha = 1 - Math.exp((-2 * Math.PI * 2600) / sampleRate);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = frame * hop;
      const end = Math.min(maxSamples, start + hop);
      let totalEnergy = 0;
      let lowEnergy = 0;
      let midEnergy = 0;
      let highEnergy = 0;
      let count = 0;
      for (let index = start; index < end; index += stride) {
        let sample = 0;
        for (const channel of channels) sample += channel[index] || 0;
        sample /= channels.length;
        lowState += lowAlpha * (sample - lowState);
        midState += midAlpha * (sample - midState);
        const low = lowState;
        const mid = midState - lowState;
        const high = sample - midState;
        totalEnergy += sample * sample;
        lowEnergy += low * low;
        midEnergy += mid * mid;
        highEnergy += high * high;
        count += 1;
      }
      energyRaw.push(Math.sqrt(totalEnergy / Math.max(1, count)));
      bassRaw.push(Math.sqrt(lowEnergy / Math.max(1, count)));
      midsRaw.push(Math.sqrt(midEnergy / Math.max(1, count)));
      highsRaw.push(Math.sqrt(highEnergy / Math.max(1, count)));
    }

    const normalize = (values: number[]): number[] => {
      const sorted = [...values].sort((a, b) => a - b);
      const ceiling = sorted[Math.floor(sorted.length * 0.94)] || 1;
      return values.map((value) => clamp(value / ceiling, 0, 1));
    };
    const energyNorm = normalize(energyRaw);
    const bassNorm = normalize(bassRaw);
    const midsNorm = normalize(midsRaw);
    const highsNorm = normalize(highsRaw);
    const tempo = this.estimateTempo(energyNorm, bassNorm, hop / buffer.sampleRate);
    const bins = 384;
    const compress = (values: number[]): number[] => Array.from({ length: bins }, (_, index) => {
      const start = Math.floor((index / bins) * values.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / bins) * values.length));
      let total = 0;
      for (let cursor = start; cursor < Math.min(end, values.length); cursor += 1) total += values[cursor];
      return total / Math.max(1, Math.min(end, values.length) - start);
    });
    const cleanTitle = title.replace(/\.[^/.]+$/, '').slice(0, 48).toUpperCase();
    const runDuration = clamp(buffer.duration, 58, 108);
    const energy = compress(energyNorm);
    const bass = compress(bassNorm);
    const mids = compress(midsNorm);
    const highs = compress(highsNorm);
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
    const contentFingerprint = [
      tempo.bpm,
      Math.round(buffer.duration * 10),
      ...energy.filter((_, index) => index % 8 === 0).map((value) => Math.round(value * 31)),
      ...bass.filter((_, index) => index % 8 === 0).map((value) => Math.round(value * 31)),
      ...highs.filter((_, index) => index % 8 === 0).map((value) => Math.round(value * 31)),
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
  ): { beats: RhythmBeat[]; transitions: MusicTransition[] } {
    const onset = energy.map((value, index) => {
      if (index === 0) return 0;
      const energyRise = Math.max(0, value - energy[index - 1]);
      const bassRise = Math.max(0, bass[index] - bass[index - 1]);
      const spectralChange = Math.abs(mids[index] - mids[index - 1]) + Math.abs(highs[index] - highs[index - 1]);
      return energyRise * 0.42 + bassRise * 0.42 + spectralChange * 0.16;
    });
    const sortedOnsets = [...onset].sort((a, b) => a - b);
    const onsetCeiling = sortedOnsets[Math.floor(sortedOnsets.length * 0.94)] || 1;
    const interval = 60 / bpm;
    const beats: RhythmBeat[] = [];
    const sourceFrames = Math.max(1, energy.length - 1);
    const frameAt = (time: number): number => {
      const loopTime = sourceDuration > 0 ? ((time % sourceDuration) + sourceDuration) % sourceDuration : time;
      return clamp(Math.round(loopTime / Math.max(frameDuration, sourceDuration / sourceFrames)), 0, sourceFrames);
    };
    let barBeat: 0 | 1 | 2 | 3 = 0;
    for (let time = Math.max(0, beatOffset); time <= runDuration + 0.0001; time += interval) {
      const center = frameAt(time);
      let peakIndex = center;
      for (let offset = -2; offset <= 2; offset += 1) {
        const candidate = clamp(center + offset, 0, sourceFrames);
        if ((onset[candidate] || 0) > (onset[peakIndex] || 0)) peakIndex = candidate;
      }
      const onsetStrength = clamp((onset[peakIndex] || 0) / onsetCeiling, 0, 1);
      const loopTime = sourceDuration > 0 ? ((time % sourceDuration) + sourceDuration) % sourceDuration : time;
      let alignment = peakIndex * frameDuration - loopTime;
      if (sourceDuration > 0 && alignment > sourceDuration * 0.5) alignment -= sourceDuration;
      if (sourceDuration > 0 && alignment < -sourceDuration * 0.5) alignment += sourceDuration;
      const maximumShift = Math.min(0.11, interval * 0.22);
      const onsetShift = onsetStrength > 0.16 ? clamp(alignment, -maximumShift, maximumShift) * 0.86 : 0;
      const previousBeat = beats[beats.length - 1];
      const minimumTime = previousBeat ? previousBeat.time + interval * 0.5 : 0;
      const alignedTime = clamp(Math.max(minimumTime, time + onsetShift), 0, runDuration);
      beats.push({
        time: Number(alignedTime.toFixed(4)),
        strength: clamp(0.28 + onsetStrength * 0.58 + (barBeat === 0 ? 0.14 : 0), 0, 1),
        bass: bass[peakIndex] || 0,
        highs: highs[peakIndex] || 0,
        barBeat,
      });
      barBeat = ((barBeat + 1) % 4) as 0 | 1 | 2 | 3;
    }

    const sourceCandidates: MusicTransition[] = [];
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
      sourceCandidates.push({
        time: Number(Math.min(sourceDuration, index * frameDuration).toFixed(4)),
        strength: clamp(strength, 0, 1),
        kind,
      });
    }
    sourceCandidates.sort((a, b) => b.strength - a.strength);
    const selected: MusicTransition[] = [];
    for (const candidate of sourceCandidates) {
      if (candidate.time < 4 || candidate.time > sourceDuration - 3) continue;
      if (selected.some((item) => Math.abs(item.time - candidate.time) < 2.4)) continue;
      selected.push(candidate);
      if (selected.length >= 16) break;
    }
    if (selected.length === 0 && runDuration > 20) {
      selected.push(
        { time: Number((runDuration * 0.36).toFixed(4)), strength: 0.58, kind: 'build' },
        { time: Number((runDuration * 0.62).toFixed(4)), strength: 0.78, kind: 'drop' },
      );
    }
    const transitions: MusicTransition[] = [];
    for (let loopStart = 0; loopStart < runDuration; loopStart += Math.max(sourceDuration, 0.1)) {
      for (const transition of selected) {
        const time = transition.time + loopStart;
        if (time < runDuration) transitions.push({ ...transition, time });
      }
    }
    transitions.sort((a, b) => a.time - b.time);
    return { beats, transitions };
  }

  private estimateTempo(energy: number[], bass: number[], frameDuration: number): { bpm: number; beatOffset: number } {
    const onset = energy.map((value, index) => {
      if (index === 0) return 0;
      return Math.max(0, value - energy[index - 1]) * 0.4 + Math.max(0, bass[index] - bass[index - 1]) * 0.6;
    });
    const mean = onset.reduce((sum, value) => sum + value, 0) / Math.max(1, onset.length);
    const variance = onset.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, onset.length);
    const threshold = mean + Math.sqrt(variance) * 1.05;
    const peaks: Array<{ time: number; strength: number }> = [];
    for (let index = 1; index < onset.length - 1; index += 1) {
      if (onset[index] > threshold && onset[index] >= onset[index - 1] && onset[index] > onset[index + 1]) {
        peaks.push({ time: index * frameDuration, strength: onset[index] });
      }
    }
    const bpms: number[] = [];
    for (let index = 1; index < peaks.length; index += 1) {
      const delta = peaks[index].time - peaks[index - 1].time;
      if (delta < 0.22 || delta > 1.2) continue;
      let candidate = 60 / delta;
      while (candidate < 92) candidate *= 2;
      while (candidate > 178) candidate /= 2;
      bpms.push(candidate);
    }
    if (bpms.length < 4) {
      const fallbackBpm = 140;
      const fallbackInterval = 60 / fallbackBpm;
      return { bpm: fallbackBpm, beatOffset: peaks.length ? peaks[0].time % fallbackInterval : 0 };
    }
    bpms.sort((a, b) => a - b);
    const bpm = Math.round(clamp(bpms[Math.floor(bpms.length / 2)], 92, 178));
    const interval = 60 / bpm;
    const histogram = new Array<number>(48).fill(0);
    for (const peak of peaks) {
      const phase = ((peak.time % interval) + interval) % interval;
      const bin = Math.min(histogram.length - 1, Math.floor((phase / interval) * histogram.length));
      histogram[bin] += peak.strength;
    }
    let strongestBin = 0;
    for (let index = 1; index < histogram.length; index += 1) {
      if (histogram[index] > histogram[strongestBin]) strongestBin = index;
    }
    const beatOffset = ((strongestBin + 0.5) / histogram.length) * interval;
    return { bpm, beatOffset };
  }

  async dispose(): Promise<void> {
    this.stop();
    this.decodedTrack = null;
    this.musicInput?.disconnect();
    this.analyser?.disconnect();
    this.musicGain?.disconnect();
    this.effectsGain?.disconnect();
    this.outputGain?.disconnect();
    this.limiter?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}
