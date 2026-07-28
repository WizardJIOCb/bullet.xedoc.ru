import { describe, expect, it } from 'vitest';
import { angularDistance, TAU } from '../core/math';
import { TRACKS, type TrackEvent } from '../core/types';
import { getApertureBulkheadLayout } from './aperture';
import { getTrackEventSafeCorridors } from './track';

function apertureEvent(angle: number, gapWidth: number): TrackEvent {
  return {
    id: 1,
    kind: 'aperture',
    distance: 100,
    angle,
    gapWidth,
    health: 1,
    resolved: false,
    destroyed: false,
    beatIndex: 8,
    musicTime: 4,
    trigger: 'kick',
    strength: 1,
    rotationRate: 0,
    rotationPhase: angle,
    armCount: 1,
    patternId: 2,
    warningDistance: 640,
  };
}

describe('aperture bulkhead geometry', () => {
  it('keeps every solid surface valid and the craft route inside the rendered annulus', () => {
    for (const track of Object.values(TRACKS)) {
      for (const gapWidth of [0.61, 0.635, 0.66]) {
        const layout = getApertureBulkheadLayout(track.radius, 2.4, gapWidth);

        expect(layout.innerRadius).toBeGreaterThan(0);
        expect(layout.centerCapRadius).toBeGreaterThan(layout.innerRadius);
        expect(layout.centerCapRadius).toBeLessThan(layout.routeRadius);
        expect(layout.routeRadius).toBeLessThan(layout.outerRadius);
        expect(layout.safeArc).toBe(gapWidth * 2);
        expect(layout.blockedArc).toBeCloseTo(TAU - gapWidth * 2, 12);
        expect(layout.safeArc + layout.blockedArc).toBeCloseTo(TAU, 12);
        expect(layout.blockedArc).toBeGreaterThan(0);
        expect(layout.blockedArc).toBeLessThan(TAU);
      }
    }
  });

  it('uses exactly the same angular slot boundaries as collision geometry', () => {
    const event = apertureEvent(-2.83, 0.62);
    const layout = getApertureBulkheadLayout(TRACKS.forge.radius, event.angle, event.gapWidth);
    const [corridor] = getTrackEventSafeCorridors(event);

    expect(layout.safeStart).toBe(event.angle - event.gapWidth);
    expect(layout.safeArc).toBe(event.gapWidth * 2);
    expect(corridor.halfWidth).toBe(layout.safeArc / 2);
    expect(angularDistance(layout.safeStart, corridor.center)).toBeCloseTo(corridor.halfWidth, 12);
    expect(angularDistance(layout.safeStart + layout.safeArc, corridor.center)).toBeCloseTo(corridor.halfWidth, 12);
  });

  it('rejects malformed dimensions before Three.js receives them', () => {
    expect(() => getApertureBulkheadLayout(3, 0, 0.62)).toThrow(RangeError);
    expect(() => getApertureBulkheadLayout(12, Number.NaN, 0.62)).toThrow(RangeError);
    expect(() => getApertureBulkheadLayout(12, 0, 0)).toThrow(RangeError);
    expect(() => getApertureBulkheadLayout(12, 0, Math.PI)).toThrow(RangeError);
  });
});
