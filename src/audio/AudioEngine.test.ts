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
  beatAnchor: number;
  lastBeatAt: number;
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
    harness.beatAnchor = 0;
    harness.lastBeatAt = -10;

    expect(engine.isInsideBeatWindow(0.04)).toBe(false);
    harness.context = { currentTime: 1.1 };
    expect(engine.isInsideBeatWindow(0.04)).toBe(true);
    harness.context = { currentTime: 1.17 };
    expect(engine.isInsideBeatWindow(0.04)).toBe(false);
  });
});
