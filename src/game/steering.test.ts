import { describe, expect, it } from 'vitest';
import { angularDistance } from '../core/math';
import {
  steeringInputTowardAngle,
  stepWallRideSteering,
  type WallRideSteeringState,
} from './steering';

const FIXED_STEP = 1 / 120;

function follow(
  initial: WallRideSteeringState,
  targetAngle: number,
  duration: number,
  handling = 0.94,
): WallRideSteeringState {
  let state = initial;
  for (let elapsed = 0; elapsed < duration - 0.0000001; elapsed += FIXED_STEP) {
    const dt = Math.min(FIXED_STEP, duration - elapsed);
    state = stepWallRideSteering(
      state,
      steeringInputTowardAngle(state, targetAngle),
      handling,
      0,
      dt,
    );
  }
  return state;
}

describe('wall-ride steering model', () => {
  it('matches the gameplay impulse, damping and integration order exactly', () => {
    const initial = { angle: 0.4, angularVelocity: -0.15 };
    const dt = 1 / 60;
    const expectedVelocity = (-0.15 + 6.8 * 1.05 * 1.05 * dt) * Math.exp(-dt * 4.5);
    const result = stepWallRideSteering(initial, 1, 1.05, 2, dt);

    expect(result.angularVelocity).toBeCloseTo(expectedVelocity, 12);
    expect(result.angle).toBeCloseTo(initial.angle + expectedVelocity * dt, 12);
  });

  it('can follow and reverse a conservative generated corridor on the least agile route', () => {
    const first = follow({ angle: 0, angularVelocity: 0 }, 1.45, 3.2);
    const reversed = follow(first, -1.2, 4.8);

    expect(angularDistance(first.angle, 1.45)).toBeLessThan(0.08);
    expect(Math.abs(first.angularVelocity)).toBeLessThan(0.12);
    expect(angularDistance(reversed.angle, -1.2)).toBeLessThan(0.08);
    expect(Math.abs(reversed.angularVelocity)).toBeLessThan(0.12);
  });
});
