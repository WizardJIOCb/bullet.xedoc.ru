import { clamp, hashString } from '../core/math';
import type { MusicProfile } from '../core/types';
import { createDefaultMusicProfile } from '../game/track';

export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  overall: number;
  pulse: number;
  onBeat: boolean;
}

export type AudioSourceKind = 'synthetic' | 'catalog' | 'local';

export interface CatalogAudioTrack {
  id: string;
  title: string;
  file: string;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private master: GainNode | null = null;
  private frequencyData = new Uint8Array(256);
  private media: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private ownedMediaUrl: string | null = null;
  private profile: MusicProfile = createDefaultMusicProfile();
  private sourceKind: AudioSourceKind = 'synthetic';
  private usingFile = false;
  private running = false;
  private startedAt = 0;
  private pausedAt = 0;
  private nextStepTime = 0;
  private stepIndex = 0;
  private lastBeatAt = -10;
  private beatAnchor = 0;
  private lastObservedTime = 0;
  private beatPulse = 0;
  private smoothedBass = 0;
  private noiseBuffer: AudioBuffer | null = null;

  getProfile(): MusicProfile {
    return this.profile;
  }

  getSourceKind(): AudioSourceKind {
    return this.sourceKind;
  }

  isCustomTrack(): boolean {
    return this.usingFile;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.76;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.master = this.context.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.noiseBuffer = this.createNoiseBuffer(this.context);
    return this.context;
  }

  private clearMedia(): void {
    this.mediaSource?.disconnect();
    this.mediaSource = null;
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }
    this.media = null;
    if (this.ownedMediaUrl) URL.revokeObjectURL(this.ownedMediaUrl);
    this.ownedMediaUrl = null;
  }

  private installMedia(context: AudioContext, src: string, ownsUrl: boolean): void {
    this.clearMedia();
    const media = new Audio();
    media.crossOrigin = 'anonymous';
    media.preload = 'auto';
    media.loop = true;
    media.src = src;
    this.media = media;
    this.ownedMediaUrl = ownsUrl ? src : null;
    this.mediaSource = context.createMediaElementSource(media);
    this.mediaSource.connect(this.master!);
  }

  async prepareFile(file: File): Promise<MusicProfile> {
    const context = this.ensureContext();
    this.stop();
    const bytes = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    this.profile = this.analyzeBuffer(buffer, `${file.name}:${file.size}:${file.lastModified}`, file.name);
    this.sourceKind = 'local';
    this.usingFile = true;
    this.installMedia(context, URL.createObjectURL(file), true);
    return this.profile;
  }

  async prepareCatalogTrack(track: CatalogAudioTrack): Promise<MusicProfile> {
    const context = this.ensureContext();
    this.stop();
    const response = await fetch(track.file, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Music request failed: ${response.status} ${response.statusText}`);
    const bytes = await response.arrayBuffer();
    const byteLength = bytes.byteLength;
    const buffer = await context.decodeAudioData(bytes);
    this.profile = this.analyzeBuffer(buffer, `catalog:${track.id}:${byteLength}`, track.title);
    this.sourceKind = 'catalog';
    this.usingFile = true;
    this.installMedia(context, track.file, false);
    return this.profile;
  }

  useSynthetic(): MusicProfile {
    this.stop();
    this.clearMedia();
    this.profile = createDefaultMusicProfile();
    this.sourceKind = 'synthetic';
    this.usingFile = false;
    return this.profile;
  }

  async start(): Promise<void> {
    const context = this.ensureContext();
    let playPromise: Promise<void> = Promise.resolve();
    if (this.usingFile && this.media) {
      this.media.currentTime = 0;
      playPromise = this.media.play();
    }
    await Promise.all([context.resume(), playPromise]);
    this.running = true;
    this.pausedAt = 0;
    this.startedAt = context.currentTime;
    this.lastBeatAt = -10;
    this.beatAnchor = this.profile.beatOffset || 0;
    this.lastObservedTime = 0;
    this.beatPulse = 0;
    this.stepIndex = 0;
    this.nextStepTime = context.currentTime + 0.05;
  }

  pause(): void {
    if (!this.running) return;
    this.pausedAt = this.getTime();
    this.running = false;
    if (this.media) this.media.pause();
    if (this.context?.state === 'running') void this.context.suspend();
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    await context.resume();
    this.startedAt = context.currentTime - this.pausedAt;
    this.running = true;
    if (this.nextStepTime < context.currentTime + 0.01) this.nextStepTime = context.currentTime + 0.04;
    if (this.usingFile && this.media) await this.media.play();
  }

  stop(): void {
    this.running = false;
    this.pausedAt = 0;
    if (this.media) {
      this.media.pause();
      this.media.currentTime = 0;
    }
    if (this.context?.state === 'running') void this.context.suspend();
  }

  getTime(): number {
    if (this.usingFile && this.media) return this.media.currentTime;
    if (!this.context) return this.pausedAt;
    return this.running ? Math.max(0, this.context.currentTime - this.startedAt) : this.pausedAt;
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

  private scheduleSynth(): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
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
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.setValueAtTime(145, time);
    oscillator.frequency.exponentialRampToValueAtTime(42, time + 0.13);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.55 * amount, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(time);
    oscillator.stop(time + 0.22);
  }

  private scheduleHat(time: number, amount: number): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
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
    gain.connect(this.master);
    source.start(time);
    source.stop(time + 0.065);
  }

  private scheduleBass(time: number, step: number): void {
    if (!this.context || !this.master) return;
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
    gain.connect(this.master);
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
    const bins = 192;
    const compress = (values: number[]): number[] => Array.from({ length: bins }, (_, index) => {
      const start = Math.floor((index / bins) * values.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / bins) * values.length));
      let total = 0;
      for (let cursor = start; cursor < Math.min(end, values.length); cursor += 1) total += values[cursor];
      return total / Math.max(1, Math.min(end, values.length) - start);
    });
    const cleanTitle = title.replace(/\.[^/.]+$/, '').slice(0, 48).toUpperCase();
    const runDuration = clamp(buffer.duration, 58, 108);
    return {
      id: key,
      title: cleanTitle,
      duration: buffer.duration,
      runDuration,
      bpm: tempo.bpm,
      beatOffset: tempo.beatOffset,
      energy: compress(energyNorm),
      bass: compress(bassNorm),
      mids: compress(midsNorm),
      highs: compress(highsNorm),
      seed: hashString(key),
    };
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
    this.clearMedia();
    this.master?.disconnect();
    this.analyser?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}
