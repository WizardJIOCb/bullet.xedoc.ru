import { describe, expect, it, vi, type Mock } from 'vitest';
import type { MusicProfile } from '../core/types';
import { createDefaultMusicProfile } from '../game/track';
import type { AudioSettings } from '../settings/SettingsStore';
import { AudioEngine } from './AudioEngine';

type ParamEvent = readonly [kind: 'hold' | 'cancel' | 'set' | 'target' | 'ramp', value: number, time: number];

class FakeAudioParam {
  readonly events: ParamEvent[] = [];

  constructor(public value: number) {}

  cancelAndHoldAtTime(time: number): void {
    this.events.push(['hold', this.value, time]);
  }

  cancelScheduledValues(time: number): void {
    this.events.push(['cancel', this.value, time]);
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push(['set', value, time]);
  }

  setTargetAtTime(value: number, time: number, constant: number): void {
    this.value = value;
    this.events.push(['target', value, time + constant]);
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push(['ramp', value, time]);
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push(['ramp', value, time]);
  }
}

class FakeNode {
  disconnectCount = 0;

  connect(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeScheduledSource extends FakeNode {
  readonly starts: Array<[number | undefined, number | undefined]> = [];
  readonly stops: Array<number | undefined> = [];
  private endedListeners: Array<EventListenerOrEventListenerObject> = [];

  start(when?: number, offset?: number): void {
    this.starts.push([when, offset]);
  }

  stop(when?: number): void {
    this.stops.push(when);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'ended') this.endedListeners.push(listener);
  }
}

class FakeOscillator extends FakeScheduledSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam(440);
}

class FakeBufferSource extends FakeScheduledSource {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam(1);
}

class FakeGain extends FakeNode {
  readonly gain = new FakeAudioParam(1);
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
}

class FakePanner extends FakeNode {
  readonly pan = new FakeAudioParam(0);
}

class FakeDeathContext {
  currentTime = 12;
  state: AudioContextState = 'running';
  readonly oscillators: FakeOscillator[] = [];
  readonly buffers: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];
  readonly panners: FakePanner[] = [];
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });

  createOscillator(): OscillatorNode {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = new FakeBufferSource();
    this.buffers.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const node = new FakeGain();
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    const node = new FakeFilter();
    this.filters.push(node);
    return node as unknown as BiquadFilterNode;
  }

  createStereoPanner(): StereoPannerNode {
    const node = new FakePanner();
    this.panners.push(node);
    return node as unknown as StereoPannerNode;
  }
}

interface DeathHarness {
  context: AudioContext;
  transportMode: 'idle' | 'preview' | 'game';
  running: boolean;
  profile: MusicProfile;
  musicFadeGain: { gain: AudioParam };
  musicAccentGain: { gain: AudioParam };
  musicAccentFilter: { gain: AudioParam };
  musicGain: { gain: AudioParam };
  effectsGain: GainNode & { gain: AudioParam };
  outputGain: { gain: AudioParam };
  deathNoiseBuffer: AudioBuffer;
  activeSources: Map<AudioScheduledSourceNode, () => void>;
  previewGeneration: number;
  previewPlaying: boolean;
  previewOffset: number;
  trackSource: AudioBufferSourceNode | null;
  startedAt: number;
  audioSettings: AudioSettings;
}

function createHarness(): {
  engine: AudioEngine;
  harness: DeathHarness;
  context: FakeDeathContext;
  fade: FakeAudioParam;
  music: FakeAudioParam;
  effects: FakeAudioParam;
  output: FakeAudioParam;
} {
  const context = new FakeDeathContext();
  const fade = new FakeAudioParam(1);
  const music = new FakeAudioParam(0.82);
  const effects = new FakeAudioParam(0.72);
  const output = new FakeAudioParam(0.9);
  const destination = Object.assign(new FakeGain(), { gain: effects });
  const harness = Object.assign(Object.create(AudioEngine.prototype) as object, {
    context: context as unknown as AudioContext,
    transportMode: 'game',
    running: true,
    profile: createDefaultMusicProfile(),
    musicFadeGain: { gain: fade as unknown as AudioParam },
    musicAccentGain: { gain: new FakeAudioParam(1) as unknown as AudioParam },
    musicAccentFilter: { gain: new FakeAudioParam(0) as unknown as AudioParam },
    musicGain: { gain: music as unknown as AudioParam },
    effectsGain: destination as unknown as GainNode,
    outputGain: { gain: output as unknown as AudioParam },
    deathNoiseBuffer: {} as AudioBuffer,
    deathExplosionSequence: 0,
    activeSources: new Map<AudioScheduledSourceNode, () => void>(),
    previewGeneration: 0,
    previewPlaying: false,
    previewOffset: 0,
    trackSource: null,
    startedAt: 0,
    audioSettings: {
      masterVolume: 0.9,
      musicVolume: 0.82,
      effectsVolume: 0.72,
      muted: false,
    },
  }) as unknown as DeathHarness;
  return {
    engine: harness as unknown as AudioEngine,
    harness,
    context,
    fade,
    music,
    effects,
    output,
  };
}

function explosionSignature(context: FakeDeathContext): unknown {
  return {
    oscillators: context.oscillators.map((node) => ({
      type: node.type,
      starts: node.starts,
      frequency: node.frequency.events,
    })),
    buffers: context.buffers.map((node) => ({
      starts: node.starts,
      playbackRate: node.playbackRate.events,
    })),
    filters: context.filters.map((node) => ({
      type: node.type,
      frequency: node.frequency.events,
      q: node.Q.events,
    })),
  };
}

describe('AudioEngine death audio', () => {
  it('fades a dedicated music envelope without overwriting user volume automation', () => {
    const { engine, fade, music, effects, output } = createHarness();

    expect(engine.fadeOutMusic(1.8)).toBe(1.8);
    expect(fade.events).toEqual([
      ['hold', 1, 12],
      ['set', 1, 12],
      ['ramp', 0.0001, 13.8],
      ['set', 0, 13.8],
    ]);

    engine.setAudioSettings({ masterVolume: 0.6, musicVolume: 0.4, effectsVolume: 0.5, muted: false });
    expect(fade.events).toHaveLength(4);
    expect(music.events.at(-1)?.slice(0, 2)).toEqual(['target', 0.4]);
    expect(effects.events.at(-1)?.slice(0, 2)).toEqual(['target', 0.5]);
    expect(output.events.at(-1)?.slice(0, 2)).toEqual(['target', 0.6]);

    engine.resetMusicFade();
    expect(fade.events.slice(-2)).toEqual([
      ['cancel', 0, 12],
      ['set', 1, 12],
    ]);
  });

  it('builds a deterministic multi-layer explosion and varies repeat attempts', () => {
    const first = createHarness();
    const matching = createHarness();

    const firstTail = first.engine.playDeathExplosion(0x12345678, 1);
    const matchingTail = matching.engine.playDeathExplosion(0x12345678, 1);
    expect(firstTail).toBeGreaterThan(1);
    expect(firstTail).toBeCloseTo(matchingTail, 12);
    expect(first.context.buffers.length).toBeGreaterThanOrEqual(3);
    expect(first.context.oscillators.length).toBeGreaterThanOrEqual(5);
    expect(explosionSignature(first.context)).toEqual(explosionSignature(matching.context));
    expect(first.harness.activeSources.size).toBe(
      first.context.buffers.length + first.context.oscillators.length,
    );

    const initialSignature = explosionSignature(first.context);
    first.engine.playDeathExplosion(0x12345678, 1);
    expect(explosionSignature(first.context)).not.toEqual(initialSignature);
  });

  it('cleans every temporary explosion source and restores the music envelope on stop', () => {
    const { engine, harness, context, fade } = createHarness();
    engine.playDeathExplosion(99, Number.NaN);
    const sources = [...context.oscillators, ...context.buffers];

    engine.stop();

    expect(harness.activeSources.size).toBe(0);
    expect(sources.every((source) => source.stops.length >= 2)).toBe(true);
    expect(sources.every((source) => source.disconnectCount >= 1)).toBe(true);
    expect(fade.events.slice(-2)).toEqual([
      ['cancel', 1, 12],
      ['set', 1, 12],
    ]);
    expect(context.suspend).toHaveBeenCalledOnce();
  });

  it('does not start death audio while the audio context is inactive', () => {
    const { engine, harness, context } = createHarness();
    context.state = 'suspended';

    expect(engine.playDeathExplosion(7)).toBe(0);
    expect(context.oscillators).toEqual([]);
    expect(context.buffers).toEqual([]);

    context.state = 'running';
    harness.transportMode = 'preview';
    expect(engine.playDeathExplosion(7)).toBe(0);
    expect(context.oscillators).toEqual([]);
  });
});
