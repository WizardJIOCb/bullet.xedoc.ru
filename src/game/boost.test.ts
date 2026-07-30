import { describe, expect, it } from 'vitest';
import {
  BOOST_VISUAL_NORMAL,
  BOOST_VISUAL_OVERDRIVE,
  resolveBoostVisualTarget,
  stepBoostVisualIntensity,
} from './boost';

function advance(current: number, target: number, dt: number, steps: number): number {
  let value = current;
  for (let index = 0; index < steps; index += 1) {
    value = stepBoostVisualIntensity(value, target, dt);
  }
  return value;
}

describe('boost visual envelope', () => {
  it('responds only to valid boost intent and lets overdrive lead', () => {
    expect(resolveBoostVisualTarget(false, false)).toBe(0);
    expect(resolveBoostVisualTarget(true, false)).toBe(BOOST_VISUAL_NORMAL);
    expect(resolveBoostVisualTarget(false, true)).toBe(BOOST_VISUAL_OVERDRIVE);
    expect(resolveBoostVisualTarget(true, true)).toBe(BOOST_VISUAL_OVERDRIVE);
  });

  it('attacks quickly and releases monotonically without snapping', () => {
    const firstFrame = stepBoostVisualIntensity(0, BOOST_VISUAL_NORMAL, 1 / 60);
    const charged = advance(firstFrame, BOOST_VISUAL_NORMAL, 1 / 60, 59);
    const firstRelease = stepBoostVisualIntensity(charged, 0, 1 / 60);
    const released = advance(firstRelease, 0, 1 / 60, 119);

    expect(firstFrame).toBeGreaterThan(0);
    expect(firstFrame).toBeLessThan(BOOST_VISUAL_NORMAL);
    expect(charged).toBeGreaterThan(0.999);
    expect(firstRelease).toBeLessThan(charged);
    expect(firstRelease).toBeGreaterThan(0);
    expect(released).toBeLessThan(0.001);
  });

  it('is invariant to 60 Hz versus 120 Hz stepping', () => {
    const at60Hz = advance(0, BOOST_VISUAL_OVERDRIVE, 1 / 60, 60);
    const at120Hz = advance(0, BOOST_VISUAL_OVERDRIVE, 1 / 120, 120);
    const release60Hz = advance(at60Hz, 0, 1 / 60, 60);
    const release120Hz = advance(at120Hz, 0, 1 / 120, 120);

    expect(at60Hz).toBeCloseTo(at120Hz, 12);
    expect(release60Hz).toBeCloseTo(release120Hz, 12);
  });

  it('clamps invalid and oversized values to a finite range', () => {
    expect(stepBoostVisualIntensity(Number.NaN, Number.POSITIVE_INFINITY, 1 / 60)).toBe(0);
    expect(stepBoostVisualIntensity(50, 50, 1)).toBe(BOOST_VISUAL_OVERDRIVE);
    expect(stepBoostVisualIntensity(-4, -2, -1)).toBe(0);
  });
});
