import { describe, expect, it } from 'vitest';
import { TRACKS } from '../core/types';
import { createDefaultMusicProfile, generateTrack, sampleTrackFrame } from './track';

describe('procedural track generation', () => {
  it('builds deterministic, ordered and traversable event plans', () => {
    const profile = createDefaultMusicProfile();
    const first = generateTrack(TRACKS.aurora, profile, 1337);
    const second = generateTrack(TRACKS.aurora, profile, 1337);

    expect(first.seed).toBe(second.seed);
    expect(first.length).toBeCloseTo(second.length, 6);
    expect(first.events.map((event) => [event.kind, event.distance, event.angle]))
      .toEqual(second.events.map((event) => [event.kind, event.distance, event.angle]));
    expect(first.events.length).toBeGreaterThan(40);
    expect(first.events.every((event, index, items) => index === 0 || event.distance >= items[index - 1].distance)).toBe(true);
    expect(first.events.filter((event) => event.kind === 'gate').every((event) => event.gapWidth >= 0.7)).toBe(true);
  });

  it('maintains an orthonormal transported frame', () => {
    const plan = generateTrack(TRACKS.void, createDefaultMusicProfile(), 7);
    for (const progress of [0, 0.1, 0.33, 0.67, 0.92]) {
      const frame = sampleTrackFrame(plan, progress);
      expect(frame.tangent.length()).toBeCloseTo(1, 4);
      expect(frame.normal.length()).toBeCloseTo(1, 4);
      expect(frame.binormal.length()).toBeCloseTo(1, 4);
      expect(Math.abs(frame.tangent.dot(frame.normal))).toBeLessThan(0.01);
      expect(Math.abs(frame.tangent.dot(frame.binormal))).toBeLessThan(0.01);
    }
  });
});
