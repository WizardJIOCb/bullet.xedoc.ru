import { describe, expect, it } from 'vitest';
import { createMusicAccentEnvelope } from './musicAccent';

describe('music accent envelope', () => {
  it('turns a normal and fourth-sync reward into bounded music lifts', () => {
    const normal = createMusicAccentEnvelope(0.45, 148);
    const fourth = createMusicAccentEnvelope(1, 148);

    expect(normal.active).toBe(true);
    expect(normal.peakGain).toBeCloseTo(1.072, 12);
    expect(normal.peakLowShelfDb).toBeCloseTo(1.17, 12);
    expect(fourth.peakGain).toBeCloseTo(1.16, 12);
    expect(fourth.peakLowShelfDb).toBeCloseTo(2.6, 12);
    expect(fourth.attackSeconds).toBeLessThan(fourth.releaseSeconds);
  });

  it('scales its release with rhythm while staying short and click-safe', () => {
    const slow = createMusicAccentEnvelope(1, 60);
    const fast = createMusicAccentEnvelope(1, 220);

    expect(slow.releaseSeconds).toBe(0.24);
    expect(fast.releaseSeconds).toBe(0.13);
    expect(slow.attackSeconds).toBeGreaterThanOrEqual(0.008);
    expect(slow.attackSeconds).toBeLessThanOrEqual(0.014);
    expect(fast.attackSeconds).toBeGreaterThanOrEqual(0.008);
  });

  it('clamps invalid intensity and tempo to finite values', () => {
    const silent = createMusicAccentEnvelope(Number.NaN, Number.NaN);
    const clamped = createMusicAccentEnvelope(50, Number.POSITIVE_INFINITY);

    expect(silent).toMatchObject({ active: false, peakGain: 1, peakLowShelfDb: 0 });
    expect(Object.values(silent).every((value) => typeof value === 'boolean' || Number.isFinite(value))).toBe(true);
    expect(clamped.peakGain).toBe(1.24);
    expect(clamped.peakLowShelfDb).toBeCloseTo(3.9, 12);
    expect(clamped.releaseSeconds).toBeGreaterThan(0);
  });
});
