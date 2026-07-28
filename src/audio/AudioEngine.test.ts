import { describe, expect, it } from 'vitest';
import type { MusicProfile, MusicTransition, RhythmBeat } from '../core/types';
import { AudioEngine } from './AudioEngine';
import { createDefaultMusicProfile } from '../game/track';

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

describe('decoded audio rhythm map', () => {
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
