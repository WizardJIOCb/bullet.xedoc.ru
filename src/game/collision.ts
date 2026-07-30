import { angularDistance, clamp, wrapAngle } from '../core/math';
import type { TrackEvent } from '../core/types';
import {
  getTrackEventSafeCorridors,
  type TrackSafeCorridor,
} from './track';

/** Keep the rebound target visibly clear of the collision boundary. */
export const OBSTACLE_ESCAPE_SAFE_INSET = 0.1;
/** Avoid teleporting the bolide even when it struck the middle of a large wall. */
export const OBSTACLE_KNOCKBACK_MAX_NUDGE = 0.14;
/** A firm but counter-steerable lateral rebound under the normal steering damping. */
export const OBSTACLE_KNOCKBACK_ESCAPE_SPEED = 1.35;
/** Prevent an already favourable turn from becoming an uncontrollable spin. */
export const OBSTACLE_KNOCKBACK_MAX_SPEED = 1.75;

const COMPARISON_EPSILON = 1e-9;

export type ObstacleKnockbackDirection = -1 | 1;

export interface ObstacleKnockback {
  /** Angular position after the small instantaneous separation nudge. */
  readonly angle: number;
  /** Angular velocity pointing into the selected free corridor. */
  readonly angularVelocity: number;
  /** Shortest wrapped direction from impact toward the selected corridor. */
  readonly direction: ObstacleKnockbackDirection;
  /** Inset point on the nearest safe interval that the rebound heads toward. */
  readonly targetAngle: number;
  /** Wrapped angular distance from the impact position to targetAngle. */
  readonly distanceToSafety: number;
}

interface EscapeCandidate {
  readonly targetAngle: number;
  readonly delta: number;
  readonly distance: number;
  readonly routeDistance: number;
  readonly followsVelocity: boolean;
}

function isInsideSafeCorridor(angle: number, corridor: Readonly<TrackSafeCorridor>): boolean {
  return angularDistance(angle, corridor.center) <= corridor.halfWidth + COMPARISON_EPSILON;
}

/** Shared hazard classifier so damage and rebound use identical boundaries. */
export function isObstacleCollision(
  event: Readonly<TrackEvent>,
  angle: number,
  transportTime: number,
): boolean {
  const corridors = getTrackEventSafeCorridors(event, transportTime);
  return corridors.length > 0
    && !corridors.some((corridor) => isInsideSafeCorridor(angle, corridor));
}

function createCandidate(
  targetAngle: number,
  angle: number,
  angularVelocity: number,
  preferredRouteAngle: number | undefined,
): EscapeCandidate | null {
  const wrappedTarget = wrapAngle(targetAngle);
  const delta = wrapAngle(wrappedTarget - angle);
  const distance = Math.abs(delta);
  if (distance <= COMPARISON_EPSILON) return null;
  const direction = delta > 0 ? 1 : -1;

  return {
    targetAngle: wrappedTarget,
    delta,
    distance,
    routeDistance: preferredRouteAngle === undefined
      ? Number.POSITIVE_INFINITY
      : angularDistance(wrappedTarget, preferredRouteAngle),
    followsVelocity: Math.abs(angularVelocity) > COMPARISON_EPSILON
      && Math.sign(angularVelocity) === direction,
  };
}

function isBetterCandidate(candidate: EscapeCandidate, incumbent: EscapeCandidate | undefined): boolean {
  if (!incumbent) return true;
  if (Math.abs(candidate.distance - incumbent.distance) > COMPARISON_EPSILON) {
    return candidate.distance < incumbent.distance;
  }
  if (Math.abs(candidate.routeDistance - incumbent.routeDistance) > COMPARISON_EPSILON) {
    return candidate.routeDistance < incumbent.routeDistance;
  }
  if (candidate.followsVelocity !== incumbent.followsVelocity) return candidate.followsVelocity;

  const candidateIsPositive = candidate.delta > 0;
  const incumbentIsPositive = incumbent.delta > 0;
  if (candidateIsPositive !== incumbentIsPositive) return candidateIsPositive;
  return candidate.targetAngle < incumbent.targetAngle;
}

/**
 * Computes a deterministic angular rebound from an obstacle into its nearest
 * collision-free interval. It is intentionally pure so gameplay and tests can
 * share exactly the same wrap, moving-rotor and tie-breaking behaviour.
 *
 * Returns null for pickups, already-safe positions, or malformed hazards with
 * no safe interval. Callers should apply it only after phase/invulnerability
 * guards so simultaneous contacts cannot stack multiple impulses.
 */
export function computeObstacleKnockback(
  event: Readonly<TrackEvent>,
  angle: number,
  angularVelocity: number,
  transportTime: number,
): ObstacleKnockback | null {
  const corridors = getTrackEventSafeCorridors(event, transportTime);
  if (!isObstacleCollision(event, angle, transportTime)) {
    return null;
  }

  const preferredRouteAngle = event.safeAngle === undefined
    ? undefined
    : event.kind === 'blade' || event.kind === 'cross'
      ? wrapAngle(event.safeAngle + event.rotationRate * (transportTime - event.musicTime))
      : event.safeAngle;

  let nearest: EscapeCandidate | undefined;
  for (const corridor of corridors) {
    const insetHalfWidth = Math.max(0, corridor.halfWidth - OBSTACLE_ESCAPE_SAFE_INSET);
    const offsets = insetHalfWidth <= COMPARISON_EPSILON
      ? [0]
      : [-insetHalfWidth, insetHalfWidth];

    for (const offset of offsets) {
      const candidate = createCandidate(
        corridor.center + offset,
        angle,
        angularVelocity,
        preferredRouteAngle,
      );
      if (candidate && isBetterCandidate(candidate, nearest)) nearest = candidate;
    }
  }

  if (!nearest) return null;
  const direction: ObstacleKnockbackDirection = nearest.delta > 0 ? 1 : -1;
  const nudge = Math.min(OBSTACLE_KNOCKBACK_MAX_NUDGE, nearest.distance);
  const alignedVelocity = direction * angularVelocity;
  const reboundSpeed = clamp(
    Math.max(alignedVelocity, OBSTACLE_KNOCKBACK_ESCAPE_SPEED),
    OBSTACLE_KNOCKBACK_ESCAPE_SPEED,
    OBSTACLE_KNOCKBACK_MAX_SPEED,
  );

  return {
    angle: wrapAngle(angle + direction * nudge),
    angularVelocity: direction * reboundSpeed,
    direction,
    targetAngle: nearest.targetAngle,
    distanceToSafety: nearest.distance,
  };
}
