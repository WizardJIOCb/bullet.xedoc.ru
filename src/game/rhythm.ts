import { clamp } from '../core/math';

export const MUSIC_SYNC_MAX_LEAD_SECONDS = 0.012;
export const MUSIC_SYNC_MAX_LAG_SECONDS = 0.035;

/**
 * Keeps spatial travel on the same clock as the decoded beat map while still
 * allowing thrust state to drive the HUD, camera and scoring. The asymmetric
 * window lets the craft react slightly late rather than visibly crossing an
 * obstacle before its sound, and never moves the craft backwards.
 */
export function synchronizeDistanceToMusic(
  previousDistance: number,
  proposedDistance: number,
  musicDistance: number,
  nominalSpeed: number,
): number {
  const speed = Math.max(0, nominalSpeed);
  const lowerBound = musicDistance - speed * MUSIC_SYNC_MAX_LAG_SECONDS;
  const upperBound = musicDistance + speed * MUSIC_SYNC_MAX_LEAD_SECONDS;
  return Math.max(previousDistance, clamp(proposedDistance, lowerBound, Math.max(lowerBound, upperBound)));
}
