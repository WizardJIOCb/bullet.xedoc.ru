import { describe, expect, it } from 'vitest';
import {
  classifyMusicEventTiming,
  isInsideMusicEventWindow,
  MUSIC_EVENT_CONTACT_LEAD_SECONDS,
  MUSIC_EVENT_STALE_SECONDS,
  MUSIC_SYNC_MAX_LAG_SECONDS,
  MUSIC_SYNC_MAX_LEAD_SECONDS,
  synchronizeDistanceToMusic,
} from './rhythm';

describe('music event contact timing', () => {
  it('opens a narrow contact window around audible music time', () => {
    const eventTime = 10;
    expect(classifyMusicEventTiming(eventTime, eventTime - MUSIC_EVENT_CONTACT_LEAD_SECONDS - 0.001)).toBe('future');
    expect(classifyMusicEventTiming(eventTime, eventTime - MUSIC_EVENT_CONTACT_LEAD_SECONDS)).toBe('active');
    expect(classifyMusicEventTiming(eventTime, eventTime + MUSIC_EVENT_STALE_SECONDS)).toBe('active');
    expect(classifyMusicEventTiming(eventTime, eventTime + MUSIC_EVENT_STALE_SECONDS + 0.001)).toBe('stale');
  });

  it('sweeps across an event instead of dropping it after a long rendered frame', () => {
    const eventTime = 10;
    expect(classifyMusicEventTiming(eventTime, 10.13, 9.87)).toBe('active');
    expect(classifyMusicEventTiming(eventTime, 10.13, 10.125)).toBe('stale');
  });

  it('scores the exact obstacle cue even when it is off the regular beat grid', () => {
    expect(isInsideMusicEventWindow(10.137, 10.18)).toBe(true);
    expect(isInsideMusicEventWindow(10.137, 10.23)).toBe(false);
  });
});

describe('music-distance synchronization', () => {
  const nominalSpeed = 170;

  it('limits boost lead and cooling lag to a tight musical window', () => {
    const musicDistance = 120;
    const boosted = synchronizeDistanceToMusic(100, 160, musicDistance, nominalSpeed);
    const cooled = synchronizeDistanceToMusic(100, 102, musicDistance, nominalSpeed);

    expect((boosted - musicDistance) / nominalSpeed).toBeCloseTo(MUSIC_SYNC_MAX_LEAD_SECONDS, 8);
    expect((musicDistance - cooled) / nominalSpeed).toBeCloseTo(MUSIC_SYNC_MAX_LAG_SECONDS, 8);
  });

  it('never moves the craft backwards while the music clock catches up', () => {
    expect(synchronizeDistanceToMusic(130, 145, 120, nominalSpeed)).toBe(130);
  });

  it('leaves travel untouched while it is already close to the beat clock', () => {
    expect(synchronizeDistanceToMusic(100, 111, 110, nominalSpeed)).toBe(111);
  });

  it.each([
    ['continuous boost', nominalSpeed * 1.43],
    ['continuous cooling', nominalSpeed * 0.68],
    ['impact slowdown', nominalSpeed * 0.58],
  ])('stays beat-locked during %s', (_label, travelSpeed) => {
    const dt = 1 / 120;
    let distance = 0;
    let musicDistance = 0;
    for (let step = 0; step < 1200; step += 1) {
      musicDistance += nominalSpeed * dt;
      distance = synchronizeDistanceToMusic(
        distance,
        distance + travelSpeed * dt,
        musicDistance,
        nominalSpeed,
      );
      expect((distance - musicDistance) / nominalSpeed).toBeLessThanOrEqual(MUSIC_SYNC_MAX_LEAD_SECONDS + 1e-8);
      expect((musicDistance - distance) / nominalSpeed).toBeLessThanOrEqual(MUSIC_SYNC_MAX_LAG_SECONDS + 1e-8);
    }
  });
});
