import { clamp } from '../core/math';

export const MUSIC_SYNC_MAX_LEAD_SECONDS = 0.012;
export const MUSIC_SYNC_MAX_LAG_SECONDS = 0.035;
export const MUSIC_EVENT_CONTACT_LEAD_SECONDS = 0.008;
export const MUSIC_EVENT_STALE_SECONDS = 0.12;

export type MusicEventTiming = 'future' | 'active' | 'stale';

export function classifyMusicEventTiming(
  eventTime: number,
  audibleTime: number,
  previousAudibleTime = audibleTime,
): MusicEventTiming {
  const sweepStart = Math.min(previousAudibleTime, audibleTime);
  if (eventTime > audibleTime + MUSIC_EVENT_CONTACT_LEAD_SECONDS) return 'future';
  if (eventTime < sweepStart - MUSIC_EVENT_STALE_SECONDS) return 'stale';
  return 'active';
}

export function isInsideMusicEventWindow(eventTime: number, audibleTime: number, windowSeconds = 0.08): boolean {
  return Math.abs(audibleTime - eventTime) <= Math.max(0, windowSeconds);
}

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
