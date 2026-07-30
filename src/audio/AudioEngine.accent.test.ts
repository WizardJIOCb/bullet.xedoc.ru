import { describe, expect, it, vi, type Mock } from 'vitest';
import type { MusicProfile } from '../core/types';
import { createDefaultMusicProfile } from '../game/track';
import { AudioEngine } from './AudioEngine';

type ParamEvent = readonly [kind: 'hold' | 'cancel' | 'set' | 'ramp', value: number, time: number];

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

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push(['ramp', value, time]);
  }
}

interface AccentHarness {
  accentMusic(amount?: number): void;
  stop(): void;
  context: AudioContext & { currentTime: number; state: AudioContextState; suspend: Mock };
  musicAccentGain: { gain: AudioParam };
  musicAccentFilter: { gain: AudioParam };
  profile: MusicProfile;
  transportMode: 'idle' | 'preview' | 'game';
  running: boolean;
}

function harness(state: AudioContextState = 'running'): {
  engine: AccentHarness;
  gain: FakeAudioParam;
  eq: FakeAudioParam;
} {
  const gain = new FakeAudioParam(1);
  const eq = new FakeAudioParam(0);
  const engine = Object.assign(Object.create(AudioEngine.prototype) as object, {
    context: { currentTime: 10, state, suspend: vi.fn(async () => undefined) },
    musicAccentGain: { gain: gain as unknown as AudioParam },
    musicAccentFilter: { gain: eq as unknown as AudioParam },
    profile: { ...createDefaultMusicProfile(), bpm: 148 },
    transportMode: 'game',
    running: true,
    previewGeneration: 0,
    previewPlaying: false,
    previewOffset: 0,
    trackSource: null,
    activeSources: new Map(),
  }) as unknown as AccentHarness;
  return { engine, gain, eq };
}

describe('AudioEngine music accent', () => {
  it('automates only persistent music gain and EQ with a beat-scaled return to baseline', () => {
    const { engine, gain, eq } = harness();

    engine.accentMusic(0.45);

    expect(gain.events[0]).toEqual(['hold', 1, 10]);
    expect(eq.events[0]).toEqual(['hold', 0, 10]);
    expect(gain.events[1][0]).toBe('ramp');
    expect(gain.events[1][1]).toBeCloseTo(1.072, 12);
    expect(eq.events[1][1]).toBeCloseTo(1.17, 12);
    expect(gain.events[1][2]).toBeGreaterThan(10);
    expect(gain.events[2]).toEqual(['ramp', 1, expect.any(Number)]);
    expect(eq.events[2]).toEqual(['ramp', 0, gain.events[2][2]]);
    expect(gain.events[2][2]).toBeGreaterThan(gain.events[1][2]);
  });

  it('does not cancel a stronger scheduled peak when a weak accent lands in the same frame', () => {
    const { engine, gain, eq } = harness();

    engine.accentMusic(1);
    engine.accentMusic(0.45);

    expect(gain.events[1][1]).toBeCloseTo(1.16, 12);
    expect(eq.events[1][1]).toBeCloseTo(2.6, 12);
    expect(gain.events[4][1]).toBeCloseTo(1.16, 12);
    expect(eq.events[4][1]).toBeCloseTo(2.6, 12);
    expect(gain.events[5][1]).toBe(1);
    expect(eq.events[5][1]).toBe(0);
  });

  it.each([
    ['suspended context', 'suspended' as AudioContextState, 'game' as const, true, 1],
    ['idle transport', 'running' as AudioContextState, 'idle' as const, true, 1],
    ['paused game', 'running' as AudioContextState, 'game' as const, false, 1],
    ['invalid intensity', 'running' as AudioContextState, 'game' as const, true, Number.NaN],
  ])('is a no-op for %s', (_label, state, mode, running, amount) => {
    const { engine, gain, eq } = harness(state);
    engine.transportMode = mode;
    engine.running = running;

    engine.accentMusic(amount);

    expect(gain.events).toEqual([]);
    expect(eq.events).toEqual([]);
  });

  it('cancels the envelope and restores neutral music processing on stop', () => {
    const { engine, gain, eq } = harness();
    gain.value = 1.14;
    eq.value = 2.2;

    engine.stop();

    expect(gain.events).toEqual([
      ['cancel', 1.14, 10],
      ['set', 1, 10],
    ]);
    expect(eq.events).toEqual([
      ['cancel', 2.2, 10],
      ['set', 0, 10],
    ]);
    expect(engine.context.suspend).toHaveBeenCalledOnce();
  });
});
