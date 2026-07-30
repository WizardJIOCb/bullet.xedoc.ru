import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACKS, type MusicProfile, type MusicTransition, type RhythmBeat } from '../core/types';
import { AudioEngine, AudioImportError } from './AudioEngine';
import { createDefaultMusicProfile, generateTrack } from '../game/track';

interface RhythmMapBuilder {
  buildRhythmMap(
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
  };
}

interface BeatWindowHarness {
  profile: MusicProfile;
  context: Pick<AudioContext, 'currentTime'>;
  startedAt: number;
  transportMode: 'idle' | 'preview' | 'game';
  beatAnchor: number;
  lastBeatAt: number;
}

interface DecodedUpdateHarness {
  context: AudioContext;
  analyser: AnalyserNode;
  profile: MusicProfile;
  usingFile: boolean;
  running: boolean;
  startedAt: number;
  transportMode: 'idle' | 'preview' | 'game';
  lastBeatAt: number;
  beatAnchor: number;
  lastObservedTime: number;
  beatPulse: number;
  smoothedBass: number;
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  readonly starts: Array<[number | undefined, number | undefined]> = [];
  readonly stops: Array<number | undefined> = [];
  disconnectCount = 0;
  private endedListeners: Array<EventListenerOrEventListenerObject> = [];

  connect(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }

  start(when?: number, offset?: number): void {
    this.starts.push([when, offset]);
  }

  stop(when?: number): void {
    this.stops.push(when);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'ended') this.endedListeners.push(listener);
  }

  emitEnded(): void {
    const event = new Event('ended');
    const listeners = [...this.endedListeners];
    this.endedListeners = [];
    for (const listener of listeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

class FakePreviewContext {
  currentTime = 100;
  state: AudioContextState = 'suspended';
  resumeCalls = 0;
  suspendCalls = 0;
  readonly sources: FakeBufferSource[] = [];

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
  }
}

interface PreviewHarness {
  context: AudioContext;
  musicInput: GainNode;
  decodedTrack: AudioBuffer;
  profile: MusicProfile;
  usingFile: boolean;
  sourceKind: 'synthetic' | 'catalog' | 'local';
}

interface ImportHarness {
  context: AudioContext;
  decodedTrack: AudioBuffer | null;
  profile: MusicProfile;
  sourceKind: 'synthetic' | 'catalog' | 'local';
  usingFile: boolean;
  analyzeBuffer: (buffer: AudioBuffer, key: string, title: string) => MusicProfile;
}

interface AnalysisHarness {
  analyzeBuffer(buffer: AudioBuffer, key: string, title: string): MusicProfile;
}

interface TempoEstimatorHarness {
  estimateTempo(energy: number[], bass: number[], frameDuration: number): { bpm: number; beatOffset: number };
}

function createImportFile(size = 9_305_968): File {
  return {
    name: 'long-track.mp3',
    size,
    type: 'audio/mpeg',
    lastModified: 1234,
    arrayBuffer: vi.fn(async () => new ArrayBuffer(16)),
  } as unknown as File;
}

function createStereoSideBuffer(sidePeriod: number, swapChannels = false): AudioBuffer {
  const sampleRate = 8_000;
  const duration = 18;
  const length = sampleRate * duration;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const center = index % 4_000 < 80
      ? 0.1875
      : index % 160 < 80
        ? 0.0625
        : -0.0625;
    const side = index % sidePeriod < sidePeriod / 2 ? 0.25 : -0.25;
    left[index] = center + side;
    right[index] = center - side;
  }
  const channels = swapChannels ? [right, left] : [left, right];
  return {
    duration,
    length,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => channels[channel],
  } as unknown as AudioBuffer;
}

function courseEventSignature(profile: MusicProfile): Array<[string, number, number, number]> {
  return generateTrack(TRACKS.aurora, profile, 12_345).events.map((event) => [
    event.kind,
    Number(event.musicTime.toFixed(4)),
    Number(event.angle.toFixed(5)),
    event.patternId,
  ]);
}

function createTempoFixture(
  bpm: number,
  beatOffset: number,
  syncopated = false,
): { energy: number[]; bass: number[]; frameDuration: number } {
  const frameDuration = 0.02;
  const duration = 48;
  const frameCount = Math.round(duration / frameDuration);
  const energy = new Array<number>(frameCount);
  const bass = new Array<number>(frameCount);
  let randomState = 123_456;
  const random = (): number => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 4_294_967_296;
  };
  for (let index = 0; index < frameCount; index += 1) {
    const noise = syncopated ? (random() - 0.5) * 0.035 : 0;
    energy[index] = 0.08 + Math.sin(index * 0.017) * 0.006 + noise;
    bass[index] = 0.05 + Math.sin(index * 0.011) * 0.004 + noise * 0.4;
  }
  const addPulse = (time: number, energyAmount: number, bassAmount: number): void => {
    const index = Math.round(time / frameDuration);
    if (index < 1 || index >= frameCount - 2) return;
    energy[index] += energyAmount;
    bass[index] += bassAmount;
    energy[index + 1] += energyAmount * 0.25;
    bass[index + 1] += bassAmount * 0.2;
  };
  const interval = 60 / bpm;
  for (let time = beatOffset; time < duration; time += interval) {
    addPulse(time, 0.8, 0.82);
    if (syncopated) {
      addPulse(time + interval * 0.5, 0.36, 0.17);
      addPulse(time + interval * 0.75, 0.18, 0.06);
    }
  }
  if (syncopated) {
    for (let time = 0.37; time < duration; time += 0.79 + random() * 0.18) {
      addPulse(time, 0.12, 0.08);
    }
  }
  return { energy, bass, frameDuration };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createPreviewHarness(bufferDuration = 30, runDuration = 58): {
  engine: AudioEngine;
  context: FakePreviewContext;
} {
  const engine = new AudioEngine();
  const context = new FakePreviewContext();
  const harness = engine as unknown as PreviewHarness;
  harness.context = context as unknown as AudioContext;
  harness.musicInput = {} as GainNode;
  harness.decodedTrack = { duration: bufferDuration } as AudioBuffer;
  harness.profile = {
    ...createDefaultMusicProfile(),
    duration: bufferDuration,
    runDuration,
  };
  harness.usingFile = true;
  harness.sourceKind = 'local';
  return { engine, context };
}

describe('decoded audio profile identity', () => {
  it('keeps different stereo-side content in the profile seed and generated course', () => {
    const engine = new AudioEngine() as unknown as AnalysisHarness;
    const lowSide = engine.analyzeBuffer(createStereoSideBuffer(18), 'stereo-track', 'stereo-track');
    const highSide = engine.analyzeBuffer(createStereoSideBuffer(5), 'stereo-track', 'stereo-track');

    expect(lowSide.seed).not.toBe(highSide.seed);
    expect({ bass: lowSide.bass, mids: lowSide.mids, highs: lowSide.highs }).not.toEqual({
      bass: highSide.bass,
      mids: highSide.mids,
      highs: highSide.highs,
    });
    expect(courseEventSignature(lowSide)).not.toEqual(courseEventSignature(highSide));
  });

  it('keeps the profile and course invariant when stereo channels are swapped', () => {
    const engine = new AudioEngine() as unknown as AnalysisHarness;
    const original = engine.analyzeBuffer(createStereoSideBuffer(18), 'stereo-track', 'stereo-track');
    const swapped = engine.analyzeBuffer(createStereoSideBuffer(18, true), 'stereo-track', 'stereo-track');

    expect(swapped).toEqual(original);
    expect(courseEventSignature(swapped)).toEqual(courseEventSignature(original));
  });
});

describe('decoded audio rhythm map', () => {
  it.each([
    { bpm: 100, beatOffset: 0.17 },
    { bpm: 128, beatOffset: 0.11 },
    { bpm: 150, beatOffset: 0.08 },
  ])('estimates a coherent $bpm BPM click grid', ({ bpm, beatOffset }) => {
    const engine = new AudioEngine() as unknown as TempoEstimatorHarness;
    const fixture = createTempoFixture(bpm, beatOffset);
    const tempo = engine.estimateTempo(fixture.energy, fixture.bass, fixture.frameDuration);
    const interval = 60 / bpm;
    const offsetDelta = Math.abs(tempo.beatOffset - beatOffset);

    expect(tempo.bpm).toBe(bpm);
    expect(Math.min(offsetDelta, interval - offsetDelta)).toBeLessThanOrEqual(fixture.frameDuration);
  });

  it('keeps a noisy syncopated 90 BPM pulse out of the 180 BPM double-time octave', () => {
    const engine = new AudioEngine() as unknown as TempoEstimatorHarness;
    const fixture = createTempoFixture(90, 0.14, true);
    const tempo = engine.estimateTempo(fixture.energy, fixture.bass, fixture.frameDuration);

    expect(tempo.bpm).toBe(90);
    expect(tempo.beatOffset).toBeCloseTo(0.14, 1);
  });

  it('uses a deterministic conservative fallback for rhythmically flat audio', () => {
    const engine = new AudioEngine() as unknown as TempoEstimatorHarness;
    const tempo = engine.estimateTempo(
      new Array<number>(2_000).fill(0.2),
      new Array<number>(2_000).fill(0.1),
      0.02,
    );

    expect(tempo).toEqual({ bpm: 140, beatOffset: 0 });
  });

  it('moves the BPM grid toward nearby real onset peaks', () => {
    const frameDuration = 0.05;
    const frameCount = 81;
    const energy = new Array<number>(frameCount).fill(0.04);
    const bass = new Array<number>(frameCount).fill(0.03);
    const mids = new Array<number>(frameCount).fill(0.05);
    const highs = new Array<number>(frameCount).fill(0.04);
    const shiftedFrames = [1, 9, 22, 28, 41, 49, 62, 68];
    for (const frame of shiftedFrames) {
      energy[frame] = 1;
      bass[frame] = 0.92;
      highs[frame] = 0.68;
    }

    const engine = new AudioEngine();
    const buildRhythmMap = (engine as unknown as RhythmMapBuilder).buildRhythmMap.bind(engine);
    const map = buildRhythmMap(energy, bass, mids, highs, 4, 4, frameDuration, 120, 0);

    expect(map.beats[0].time).toBeCloseTo(0.075, 3);
    expect(map.beats[1].time).toBeCloseTo(0.475, 3);
    expect(map.beats[2].time).toBeCloseTo(1.125, 3);
    expect(map.beats.some((beat, index) => index > 0 && Math.abs(beat.time - index * 0.5) > 0.035)).toBe(true);
  });

  it('keeps strong off-grid drum hits as independent musical anchors', () => {
    const frameDuration = 0.025;
    const frameCount = 121;
    const energy = new Array<number>(frameCount).fill(0.05);
    const bass = new Array<number>(frameCount).fill(0.04);
    const mids = new Array<number>(frameCount).fill(0.05);
    const highs = new Array<number>(frameCount).fill(0.04);
    energy[10] = 0.96;
    bass[10] = 1;
    energy[30] = 0.88;
    mids[30] = 0.96;
    highs[30] = 1;

    const engine = new AudioEngine();
    const buildRhythmMap = (engine as unknown as RhythmMapBuilder).buildRhythmMap.bind(engine);
    const map = buildRhythmMap(energy, bass, mids, highs, 3, 3, frameDuration, 120, 0);
    const kick = map.beats.find((beat) => Math.abs(beat.time - 0.2625) < 0.03);
    const transient = map.beats.find((beat) => Math.abs(beat.time - 0.7625) < 0.03);

    expect(kick).toMatchObject({ cue: 'kick' });
    expect(transient).toMatchObject({ cue: 'transient' });
    expect(map.onsets.some((value) => value > 0.5)).toBe(true);
  });

  it('keeps structural transitions sparse with duration-scaled budgets', () => {
    const engine = new AudioEngine();
    const buildRhythmMap = (engine as unknown as RhythmMapBuilder).buildRhythmMap.bind(engine);
    const buildDynamicMap = (duration: number) => {
      const frameDuration = 0.1;
      const frameCount = Math.round(duration / frameDuration);
      const energy: number[] = [];
      const bass: number[] = [];
      const mids: number[] = [];
      const highs: number[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const segment = Math.floor((index * frameDuration) / 6);
        const intense = segment % 2 === 1;
        energy.push(intense ? 0.92 : 0.18);
        bass.push(intense ? 0.78 : 0.12);
        mids.push(intense ? 0.55 : 0.16);
        highs.push(segment % 3 === 2 ? 0.72 : 0.14);
      }
      return buildRhythmMap(
        energy,
        bass,
        mids,
        highs,
        duration,
        duration,
        frameDuration,
        120,
        0,
      );
    };

    const shortMap = buildDynamicMap(60);
    const longMap = buildDynamicMap(108);
    expect(shortMap.transitions.length).toBeGreaterThan(0);
    expect(shortMap.transitions.length).toBeLessThanOrEqual(5);
    expect(longMap.transitions.length).toBeGreaterThan(shortMap.transitions.length);
    expect(longMap.transitions.length).toBeLessThanOrEqual(9);
    for (const transitions of [shortMap.transitions, longMap.transitions]) {
      for (let index = 1; index < transitions.length; index += 1) {
        expect(transitions[index].time - transitions[index - 1].time).toBeGreaterThanOrEqual(5.5);
      }
    }
  });

  it('scores against the explicit onset map before falling back to the average BPM grid', () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as BeatWindowHarness;
    harness.profile = {
      ...createDefaultMusicProfile(),
      bpm: 120,
      beatOffset: 0,
      beats: [{ time: 1.1, strength: 1, bass: 1, highs: 0.6, barBeat: 2 }],
    };
    harness.context = { currentTime: 1 };
    harness.startedAt = 0;
    harness.transportMode = 'game';
    harness.beatAnchor = 0;
    harness.lastBeatAt = -10;

    expect(engine.isInsideBeatWindow(0.04)).toBe(false);
    harness.context = { currentTime: 1.1 };
    expect(engine.isInsideBeatWindow(0.04)).toBe(true);
    harness.context = { currentTime: 1.17 };
    expect(engine.isInsideBeatWindow(0.04)).toBe(false);
  });

  it('falls back to both processing and device latency when output timestamps are unavailable', () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as BeatWindowHarness;
    harness.context = {
      currentTime: 20,
      baseLatency: 0.04,
      outputLatency: 0.22,
    } as unknown as Pick<AudioContext, 'currentTime'>;
    harness.startedAt = 10;
    harness.transportMode = 'game';

    expect(engine.getTransportTime()).toBeCloseTo(9.74, 8);
  });

  it('drives decoded-track effects from the audible profile instead of a future analyser quantum', () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as DecodedUpdateHarness;
    harness.context = {
      currentTime: 11,
      getOutputTimestamp: () => ({ contextTime: 10.5, performanceTime: 0 }),
    } as unknown as AudioContext;
    harness.analyser = {
      getByteFrequencyData: (values: Uint8Array<ArrayBuffer>) => values.fill(255),
    } as unknown as AnalyserNode;
    harness.profile = {
      ...createDefaultMusicProfile(),
      duration: 58,
      runDuration: 58,
      energy: [0.42],
      bass: [0.2],
      mids: [0.3],
      highs: [0.1],
      beats: [{ time: 10.5, strength: 1, bass: 0.8, highs: 0.4, barBeat: 0, cue: 'kick' }],
    };
    harness.usingFile = true;
    harness.running = true;
    harness.startedAt = 0;
    harness.transportMode = 'game';
    harness.lastBeatAt = -10;
    harness.beatAnchor = 0;
    harness.lastObservedTime = 0;
    harness.beatPulse = 0;
    harness.smoothedBass = 0;

    const bands = engine.update(1 / 60);
    expect(bands).toMatchObject({
      bass: 0.2,
      mids: 0.3,
      highs: 0.1,
      overall: 0.42,
      onBeat: true,
    });
    expect(bands.pulse).toBeGreaterThan(0.85);
  });
});

describe('decoded audio preview transport', () => {
  it('stays unavailable for the synthetic source', async () => {
    const engine = new AudioEngine();

    expect(engine.getPreviewPlaybackState()).toEqual({
      available: false,
      playing: false,
      currentTime: 0,
      duration: 0,
    });
    await engine.playPreview();
    engine.seekPreview(12);
    expect(engine.getPreviewPlaybackState().available).toBe(false);
  });

  it('plays a seeked absolute run position through the looped decoded buffer', async () => {
    const { engine, context } = createPreviewHarness(30, 58);
    engine.seekPreview(35);

    expect(engine.getPreviewPlaybackState()).toMatchObject({
      available: true,
      playing: false,
      currentTime: 35,
      duration: 58,
    });

    await engine.playPreview();
    const source = context.sources[0];
    expect(source.loop).toBe(true);
    expect(source.starts).toEqual([[100, 5]]);
    expect(source.stops).toEqual([123]);

    context.currentTime = 102.5;
    expect(engine.getPreviewPlaybackState().currentTime).toBeCloseTo(37.5, 8);
    engine.pausePreview();

    expect(engine.getPreviewPlaybackState()).toMatchObject({ playing: false, currentTime: 37.5 });
    expect(source.stops).toEqual([123, undefined]);
    expect(context.suspendCalls).toBe(0);
    expect(context.state).toBe('running');
  });

  it('recreates the source on a playing seek and ignores the stale ended event', async () => {
    const { engine, context } = createPreviewHarness(30, 58);
    await engine.playPreview();
    const staleSource = context.sources[0];

    context.currentTime = 103;
    engine.seekPreview(20);
    const activeSource = context.sources[1];
    expect(activeSource.starts).toEqual([[103, 20]]);
    expect(activeSource.stops).toEqual([141]);

    staleSource.emitEnded();
    expect(engine.getPreviewPlaybackState()).toMatchObject({ playing: true, currentTime: 20 });

    activeSource.emitEnded();
    expect(engine.getPreviewPlaybackState()).toMatchObject({ playing: false, currentTime: 58 });

    await engine.playPreview();
    expect(context.sources[2].starts).toEqual([[103, 0]]);
  });

  it('cancels preview and prepares decoded gameplay paused at exactly zero', async () => {
    const { engine, context } = createPreviewHarness(30, 58);
    engine.seekPreview(17);
    await engine.playPreview();
    const previewSource = context.sources[0];
    context.currentTime = 106;

    await engine.start(true);
    const gameSource = context.sources[1];
    expect(previewSource.stops.at(-1)).toBeUndefined();
    expect(gameSource.starts).toEqual([[106, 0]]);
    expect(gameSource.stops).toEqual([]);
    expect(engine.getPreviewPlaybackState()).toMatchObject({ playing: false, currentTime: 0 });
    expect(engine.getTransportTime()).toBe(0);
    expect(context.state).toBe('suspended');
    expect(context.suspendCalls).toBe(1);

    engine.stopPreview();
    expect(gameSource.stops).toEqual([]);
    await engine.resume();
    engine.pause();
    expect(context.suspendCalls).toBe(2);
  });

  it('unlocks a fresh AudioContext before freezing the countdown transport', async () => {
    const { engine, context } = createPreviewHarness(30, 58);

    await engine.start(true);

    expect(context.resumeCalls).toBe(1);
    expect(context.suspendCalls).toBe(1);
    expect(context.state).toBe('suspended');
    expect(context.sources[0].starts).toEqual([[100, 0]]);
    expect(engine.getTransportTime()).toBe(0);
  });
});

describe('decoded audio import', () => {
  it('accepts a normal song longer than three minutes and trims playback to 108 seconds', async () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as ImportHarness;
    const decoded = {
      duration: 232.6236,
      length: Math.round(232.6236 * 44_100),
      sampleRate: 44_100,
      numberOfChannels: 2,
      getChannelData: vi.fn(() => new Float32Array(1)),
    } as unknown as AudioBuffer;
    const playback = {
      duration: 108,
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer;
    harness.context = {
      currentTime: 10,
      state: 'suspended',
      decodeAudioData: vi.fn(async () => decoded),
      createBuffer: vi.fn(() => playback),
    } as unknown as AudioContext;
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      id: 'long-track',
      title: 'LONG TRACK',
      duration: decoded.duration,
      runDuration: 108,
    };
    harness.analyzeBuffer = vi.fn(() => profile);

    await expect(engine.prepareFile(createImportFile())).resolves.toBe(profile);
    expect(engine.getSourceKind()).toBe('local');
    expect(engine.getProfile()).toBe(profile);
    expect(engine.getPreviewPlaybackState()).toMatchObject({ available: true, duration: 108 });
    expect(harness.decodedTrack).toBe(playback);
    expect(harness.context.createBuffer).toHaveBeenCalledWith(2, 4_762_800, 44_100);
  });

  it('keeps the active track intact when a replacement cannot be decoded', async () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as ImportHarness;
    const previousProfile = {
      ...createDefaultMusicProfile(),
      id: 'previous-track',
      title: 'PREVIOUS TRACK',
    };
    const previousBuffer = { duration: 82 } as AudioBuffer;
    harness.context = {
      currentTime: 10,
      state: 'suspended',
      decodeAudioData: vi.fn(async () => {
        throw new DOMException('Unsupported codec', 'EncodingError');
      }),
    } as unknown as AudioContext;
    harness.profile = previousProfile;
    harness.decodedTrack = previousBuffer;
    harness.sourceKind = 'catalog';
    harness.usingFile = true;

    await expect(engine.prepareFile(createImportFile())).rejects.toMatchObject({
      name: 'AudioImportError',
      code: 'decode',
    });
    expect(engine.getProfile()).toBe(previousProfile);
    expect(engine.getSourceKind()).toBe('catalog');
    expect(harness.decodedTrack).toBe(previousBuffer);
    expect(harness.usingFile).toBe(true);
  });

  it('rejects empty and oversized files before asking the browser to decode them', async () => {
    const engine = new AudioEngine();
    const harness = engine as unknown as ImportHarness;
    const decodeAudioData = vi.fn();
    harness.context = {
      currentTime: 0,
      state: 'suspended',
      decodeAudioData,
    } as unknown as AudioContext;

    await expect(engine.prepareFile(createImportFile(0))).rejects.toEqual(
      expect.objectContaining<Partial<AudioImportError>>({ code: 'empty' }),
    );
    await expect(engine.prepareFile(createImportFile(49 * 1024 * 1024))).rejects.toEqual(
      expect.objectContaining<Partial<AudioImportError>>({ code: 'too-large' }),
    );
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('uses a finite metadata duration to reject oversized decoded audio before reading bytes', async () => {
    class LongMetadataAudio {
      duration = 13 * 60;
      preload = '';
      private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const listeners = this.listeners.get(type) || new Set<EventListenerOrEventListenerObject>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        this.listeners.get(type)?.delete(listener);
      }

      set src(_value: string) {
        for (const listener of [...(this.listeners.get('loadedmetadata') || [])]) {
          if (typeof listener === 'function') listener(new Event('loadedmetadata'));
          else listener.handleEvent(new Event('loadedmetadata'));
        }
      }

      removeAttribute(): void {}
      load(): void {}
    }

    vi.stubGlobal('Audio', LongMetadataAudio);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:long-track'),
      revokeObjectURL: vi.fn(),
    });
    const engine = new AudioEngine();
    const harness = engine as unknown as ImportHarness;
    const decodeAudioData = vi.fn();
    const file = createImportFile();
    harness.context = {
      currentTime: 0,
      state: 'suspended',
      decodeAudioData,
    } as unknown as AudioContext;

    await expect(engine.prepareFile(file)).rejects.toMatchObject({ code: 'too-long' });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('still decodes when advisory metadata setup is unavailable', async () => {
    vi.stubGlobal('Audio', class {
      constructor() {
        throw new Error('Metadata API unavailable');
      }
    });
    const engine = new AudioEngine();
    const harness = engine as unknown as ImportHarness;
    const decoded = {
      duration: 30,
      length: 300,
      sampleRate: 10,
      numberOfChannels: 1,
      getChannelData: vi.fn(() => new Float32Array(300)),
    } as unknown as AudioBuffer;
    const profile = {
      ...createDefaultMusicProfile(),
      id: 'fallback-track',
      duration: 30,
      runDuration: 58,
    };
    harness.context = {
      currentTime: 0,
      state: 'suspended',
      decodeAudioData: vi.fn(async () => decoded),
    } as unknown as AudioContext;
    harness.analyzeBuffer = vi.fn(() => profile);

    await expect(engine.prepareFile(createImportFile())).resolves.toBe(profile);
    expect(harness.decodedTrack).toBe(decoded);
  });
});
