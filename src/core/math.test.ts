import { describe, expect, it } from 'vitest';
import { angularDistance, hashString, mulberry32, wrapAngle } from './math';

describe('track math', () => {
  it('wraps angles across the seam', () => {
    expect(angularDistance(0.05, Math.PI * 2 - 0.05)).toBeCloseTo(0.1, 5);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
  });

  it('keeps seeded runs deterministic', () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    expect(Array.from({ length: 8 }, first)).toEqual(Array.from({ length: 8 }, second));
    expect(hashString('pulse-run')).toBe(hashString('pulse-run'));
  });
});
