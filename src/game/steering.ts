import { clamp, wrapAngle } from '../core/math';

export const WALL_RIDE_STEERING_ACCELERATION = 6.8;
export const WALL_RIDE_STEERING_DAMPING = 4.5;
export const WALL_RIDE_MAX_ANGULAR_VELOCITY = 2.65;
export const DEFAULT_CORRIDOR_FOLLOW_MAX_TARGET_SPEED = 0.72;
export const DEFAULT_CORRIDOR_FOLLOW_POSITION_GAIN = 1.35;
export const DEFAULT_CORRIDOR_FOLLOW_VELOCITY_DEADBAND = 0.04;

export type SteeringInput = -1 | 0 | 1;

export interface WallRideSteeringState {
  readonly angle: number;
  readonly angularVelocity: number;
}

export interface CorridorFollowOptions {
  readonly maxTargetSpeed?: number;
  readonly positionGain?: number;
  readonly velocityDeadband?: number;
}

/**
 * Advances the wall-ride steering state by one simulation step.
 *
 * The operation order intentionally mirrors the gameplay loop: apply the
 * steering impulse, damp velocity, clamp it, then integrate and wrap angle.
 */
export function stepWallRideSteering(
  state: Readonly<WallRideSteeringState>,
  steering: SteeringInput,
  handling: number,
  engineLevel: number,
  dt: number,
): WallRideSteeringState {
  const steeringForce = WALL_RIDE_STEERING_ACCELERATION * handling * (1 + engineLevel * 0.025);
  const dampedVelocity = (state.angularVelocity + steering * steeringForce * dt)
    * Math.exp(-dt * WALL_RIDE_STEERING_DAMPING);
  const angularVelocity = clamp(
    dampedVelocity,
    -WALL_RIDE_MAX_ANGULAR_VELOCITY,
    WALL_RIDE_MAX_ANGULAR_VELOCITY,
  );

  return {
    angle: wrapAngle(state.angle + angularVelocity * dt),
    angularVelocity,
  };
}

/**
 * Deterministic velocity-tracking input for corridor simulations and assists.
 * Angular error sets a bounded target velocity; the input then closes the
 * velocity error, avoiding the persistent overshoot of position-only bang-bang.
 */
export function steeringInputTowardAngle(
  state: Readonly<WallRideSteeringState>,
  targetAngle: number,
  options: Readonly<CorridorFollowOptions> = {},
): SteeringInput {
  const error = wrapAngle(targetAngle - state.angle);
  const maxTargetSpeed = Math.max(
    0,
    options.maxTargetSpeed ?? DEFAULT_CORRIDOR_FOLLOW_MAX_TARGET_SPEED,
  );
  const positionGain = Math.max(
    0,
    options.positionGain ?? DEFAULT_CORRIDOR_FOLLOW_POSITION_GAIN,
  );
  const velocityDeadband = Math.max(
    0,
    options.velocityDeadband ?? DEFAULT_CORRIDOR_FOLLOW_VELOCITY_DEADBAND,
  );
  const targetVelocity = clamp(
    error * positionGain,
    -maxTargetSpeed,
    maxTargetSpeed,
  );
  const velocityError = targetVelocity - state.angularVelocity;
  if (velocityError > velocityDeadband) return 1;
  if (velocityError < -velocityDeadband) return -1;
  return 0;
}
