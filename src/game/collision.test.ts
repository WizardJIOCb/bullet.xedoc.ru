import { describe, expect, it } from 'vitest';
import { angularDistance, TAU, wrapAngle } from '../core/math';
import type { TrackEvent } from '../core/types';
import {
  computeObstacleKnockback,
  isObstacleCollision,
  OBSTACLE_ESCAPE_SAFE_INSET,
  OBSTACLE_KNOCKBACK_ESCAPE_SPEED,
  OBSTACLE_KNOCKBACK_MAX_NUDGE,
  OBSTACLE_KNOCKBACK_MAX_SPEED,
} from './collision';
import {
  getTrackEventSafeCorridors,
} from './track';

function eventFixture(
  kind: TrackEvent['kind'],
  overrides: Partial<TrackEvent> = {},
): TrackEvent {
  return {
    id: 1,
    kind,
    distance: 900,
    angle: 0,
    gapWidth: kind === 'aperture' ? 0.5 : kind === 'gate' ? 0.8 : kind === 'halfwall' ? 1.3 : 0.22,
    health: 1,
    resolved: false,
    destroyed: false,
    beatIndex: 8,
    musicTime: 10,
    trigger: 'beat',
    strength: 0.8,
    rotationRate: 0,
    rotationPhase: 0,
    armCount: kind === 'cross' ? 4 : kind === 'blade' ? 2 : 1,
    patternId: 2,
    warningDistance: 480,
    ...overrides,
  };
}

function clearanceAt(event: TrackEvent, angle: number, transportTime = event.musicTime): number {
  return Math.max(
    ...getTrackEventSafeCorridors(event, transportTime).map((corridor) => (
      corridor.halfWidth - angularDistance(angle, corridor.center)
    )),
  );
}

function expectStandardKnockbackBounds(result: NonNullable<ReturnType<typeof computeObstacleKnockback>>): void {
  expect(Math.abs(result.angularVelocity)).toBeGreaterThanOrEqual(OBSTACLE_KNOCKBACK_ESCAPE_SPEED - 1e-10);
  expect(Math.abs(result.angularVelocity)).toBeLessThanOrEqual(OBSTACLE_KNOCKBACK_MAX_SPEED + 1e-10);
  expect(Math.sign(result.angularVelocity)).toBe(result.direction);
}

describe('computeObstacleKnockback', () => {
  it('takes the nearest gate edge correctly across the -PI/PI seam', () => {
    const event = eventFixture('gate', {
      angle: Math.PI - 0.04,
      gapWidth: 0.8,
      safeAngle: Math.PI - 0.04,
    });
    const impactAngle = -Math.PI + 0.96;
    const result = computeObstacleKnockback(event, impactAngle, 0.3, event.musicTime);

    expect(result).not.toBeNull();
    expect(result?.direction).toBe(-1);
    expect(result?.targetAngle).toBeCloseTo(wrapAngle(event.angle + 0.7), 10);
    expect(wrapAngle((result?.angle ?? 0) - impactAngle)).toBeCloseTo(-OBSTACLE_KNOCKBACK_MAX_NUDGE, 10);
    expect(clearanceAt(event, result?.targetAngle ?? 0)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('uses incoming velocity to resolve an exactly antipodal gate tie', () => {
    const event = eventFixture('gate', { angle: 0, gapWidth: 0.8, safeAngle: 0 });
    const result = computeObstacleKnockback(event, Math.PI, -0.7, event.musicTime);

    expect(result?.direction).toBe(-1);
    expect(result?.targetAngle).toBeCloseTo(0.7, 10);
    expect(result?.angularVelocity).toBeCloseTo(-OBSTACLE_KNOCKBACK_ESCAPE_SPEED, 10);
  });

  it('treats the aperture as one narrow static safe corridor', () => {
    const event = eventFixture('aperture', {
      angle: -0.45,
      gapWidth: 0.5,
      safeAngle: -0.45,
    });

    expect(isObstacleCollision(event, -0.45, event.musicTime)).toBe(false);
    expect(isObstacleCollision(event, 0.06, event.musicTime)).toBe(true);
    const result = computeObstacleKnockback(event, 1.1, -0.2, event.musicTime);
    expect(result).not.toBeNull();
    expect(clearanceAt(event, result?.targetAngle ?? 0)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('pushes a centered halfwall strike just beyond the panel edge', () => {
    const event = eventFixture('halfwall', {
      angle: 0.35,
      gapWidth: 1.3,
      safeAngle: wrapAngle(0.35 + Math.PI),
    });
    const result = computeObstacleKnockback(event, event.angle, 0.45, event.musicTime);

    expect(result?.direction).toBe(1);
    expect(result?.targetAngle).toBeCloseTo(event.angle + event.gapWidth + OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expect(clearanceAt(event, result?.targetAngle ?? 0)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('pushes a bastion strike toward the velocity-selected free side', () => {
    const event = eventFixture('bastion', {
      angle: -0.6,
      gapWidth: 0.36,
      safeAngle: wrapAngle(-0.6 + Math.PI),
    });
    const result = computeObstacleKnockback(event, event.angle, -0.5, event.musicTime);

    expect(result?.direction).toBe(-1);
    expect(result?.targetAngle).toBeCloseTo(event.angle - event.gapWidth - OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expect(clearanceAt(event, result?.targetAngle ?? 0)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('uses the live phase of a rotating two-arm blade', () => {
    const transportTime = 10.2;
    const phaseAtImpact = 0.2 + 1.5 * (transportTime - 10);
    const event = eventFixture('blade', {
      rotationPhase: 0.2,
      rotationRate: 1.5,
      gapWidth: 0.22,
      armCount: 2,
      safeAngle: wrapAngle(0.2 + Math.PI / 2),
    });
    const result = computeObstacleKnockback(event, phaseAtImpact, -0.8, transportTime);

    expect(result?.direction).toBe(1);
    expect(result?.targetAngle).toBeCloseTo(
      wrapAngle(phaseAtImpact + event.gapWidth + OBSTACLE_ESCAPE_SAFE_INSET),
      10,
    );
    expect(clearanceAt(event, result?.targetAngle ?? 0, transportTime)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('selects the planned side of a live rotating four-arm cross', () => {
    const transportTime = 10.3;
    const phaseAtImpact = wrapAngle(3 + (transportTime - 10));
    const interval = TAU / 4;
    const event = eventFixture('cross', {
      rotationPhase: 3,
      rotationRate: 1,
      gapWidth: 0.2,
      armCount: 4,
      safeAngle: wrapAngle(3 - interval / 2),
    });
    const result = computeObstacleKnockback(event, phaseAtImpact, 0.7, transportTime);

    expect(result?.direction).toBe(-1);
    expect(result?.targetAngle).toBeCloseTo(
      wrapAngle(phaseAtImpact - event.gapWidth - OBSTACLE_ESCAPE_SAFE_INSET),
      10,
    );
    expect(clearanceAt(event, result?.targetAngle ?? 0, transportTime)).toBeCloseTo(OBSTACLE_ESCAPE_SAFE_INSET, 10);
    expectStandardKnockbackBounds(result!);
  });

  it('preserves a favourable turn up to the rebound cap and reverses a hostile one', () => {
    const event = eventFixture('halfwall', { angle: 0, gapWidth: 1.3, safeAngle: Math.PI });
    const favourable = computeObstacleKnockback(event, 0.2, 2.2, event.musicTime);
    const hostile = computeObstacleKnockback(event, 0.2, -2.2, event.musicTime);

    expect(favourable?.direction).toBe(1);
    expect(favourable?.angularVelocity).toBe(OBSTACLE_KNOCKBACK_MAX_SPEED);
    expect(hostile?.direction).toBe(1);
    expect(hostile?.angularVelocity).toBe(OBSTACLE_KNOCKBACK_ESCAPE_SPEED);
  });

  it('does nothing for pickups and for an angle already inside a safe opening', () => {
    const pickup = eventFixture('shard');
    const gate = eventFixture('gate', { angle: 0.4, gapWidth: 0.8 });

    expect(computeObstacleKnockback(pickup, pickup.angle, 0, pickup.musicTime)).toBeNull();
    expect(computeObstacleKnockback(gate, gate.angle, 0, gate.musicTime)).toBeNull();
  });

  it('moves every hazard impact closer to free space without teleporting', () => {
    const cases: Array<{ event: TrackEvent; angle: number; time: number }> = [
      { event: eventFixture('gate', { angle: 0.2, gapWidth: 0.8 }), angle: 2.2, time: 10 },
      { event: eventFixture('aperture', { angle: -0.9, gapWidth: 0.5 }), angle: 0.2, time: 10 },
      { event: eventFixture('halfwall', { angle: -0.3, gapWidth: 1.3 }), angle: -0.1, time: 10 },
      { event: eventFixture('bastion', { angle: 0.7, gapWidth: 0.36 }), angle: 0.72, time: 10 },
      { event: eventFixture('blade', { rotationPhase: 0.4, rotationRate: 0.8, armCount: 3 }), angle: 0.56, time: 10.2 },
      { event: eventFixture('cross', { rotationPhase: -0.8, rotationRate: -0.7, armCount: 4 }), angle: -0.94, time: 10.2 },
    ];

    for (const sample of cases) {
      const before = clearanceAt(sample.event, sample.angle, sample.time);
      const result = computeObstacleKnockback(sample.event, sample.angle, -2.65, sample.time);
      expect(result, sample.event.kind).not.toBeNull();
      expect(clearanceAt(sample.event, result!.angle, sample.time), sample.event.kind).toBeGreaterThan(before);
      expect(angularDistance(result!.angle, sample.angle), sample.event.kind)
        .toBeLessThanOrEqual(OBSTACLE_KNOCKBACK_MAX_NUDGE + 1e-10);
      expect(Math.sign(result!.angularVelocity), sample.event.kind).toBe(result!.direction);
    }
  });

  it('uses identical non-blocking boundaries for damage and rebound on every hazard', () => {
    const transportTime = 10.2;
    const samples: Array<{ event: TrackEvent; boundary: number }> = [
      {
        event: eventFixture('gate', { angle: 0.4, gapWidth: 0.8 }),
        boundary: 1.2,
      },
      {
        event: eventFixture('aperture', { angle: -1.1, gapWidth: 0.5 }),
        boundary: -0.6,
      },
      {
        event: eventFixture('halfwall', { angle: -0.5, gapWidth: 1.3 }),
        boundary: 0.8,
      },
      {
        event: eventFixture('bastion', { angle: 2.8, gapWidth: 0.36 }),
        boundary: wrapAngle(2.8 + 0.36),
      },
      {
        event: eventFixture('blade', { rotationPhase: 0.2, rotationRate: 1.5, gapWidth: 0.22 }),
        boundary: 0.2 + 1.5 * 0.2 + 0.22,
      },
      {
        event: eventFixture('cross', { rotationPhase: -3, rotationRate: -0.8, gapWidth: 0.2 }),
        boundary: wrapAngle(-3 - 0.8 * 0.2 - 0.2),
      },
    ];

    for (const sample of samples) {
      const boundary = wrapAngle(sample.boundary);
      expect(isObstacleCollision(sample.event, boundary, transportTime), sample.event.kind).toBe(false);
      expect(computeObstacleKnockback(sample.event, boundary, 0, transportTime), sample.event.kind).toBeNull();
    }
  });

  it('shifts only rotating corridors when transport time advances', () => {
    const blade = eventFixture('blade', { rotationPhase: 0.4, rotationRate: 1.2, armCount: 2 });
    const gate = eventFixture('gate', { angle: -2.9 });
    const aperture = eventFixture('aperture', { angle: 1.7 });
    const dt = 0.075;
    const bladeAtBeat = getTrackEventSafeCorridors(blade, blade.musicTime);
    const bladeLater = getTrackEventSafeCorridors(blade, blade.musicTime + dt);
    const gateAtBeat = getTrackEventSafeCorridors(gate, gate.musicTime);
    const gateLater = getTrackEventSafeCorridors(gate, gate.musicTime + dt);
    const apertureAtBeat = getTrackEventSafeCorridors(aperture, aperture.musicTime);
    const apertureLater = getTrackEventSafeCorridors(aperture, aperture.musicTime + dt);

    for (let index = 0; index < bladeAtBeat.length; index += 1) {
      expect(wrapAngle(bladeLater[index].center - bladeAtBeat[index].center)).toBeCloseTo(blade.rotationRate * dt, 10);
    }
    expect(gateLater).toEqual(gateAtBeat);
    expect(apertureLater).toEqual(apertureAtBeat);
  });
});
