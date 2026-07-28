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
  ): { beats: RhythmBeat[]; transitions: MusicTransition[] };
}

interface BeatWindowHarness {
  profile: MusicProfile;
  context: Pick<AudioContext, 'currentTime'>;
  startedAt: number;
  transportMode: 'idle' | 'preview' | 'game';
  beatAnchor: number;
  lastBeatAt: number;
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

    expect(map.beats[0].time).toBeCloseTo(0.043, 3);
    expect(map.beats[1].time).toBeCloseTo(0.457, 3);
    expect(map.beats[2].time).toBeCloseTo(1.086, 3);
    expect(map.beats.some((beat, index) => index > 0 && Math.abs(beat.time - index * 0.5) > 0.035)).toBe(true);
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
