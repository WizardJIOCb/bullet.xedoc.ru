import { describe, expect, it } from 'vitest';
import type { TrackTimeline, TimelinePatternMarker } from '../game/timeline';
import { createRaceCourseMarkers } from './RaceTimeline';

function pattern(
  patternId: number,
  kind: TimelinePatternMarker['kind'],
  startTime: number,
  endTime = startTime,
  category: TimelinePatternMarker['category'] = 'hazard',
): TimelinePatternMarker {
  return {
    type: 'pattern',
    id: `feedbeef:pattern:${patternId}`,
    patternId,
    category,
    kind,
    musicTime: startTime,
    startTime,
    endTime,
    eventTimes: endTime === startTime ? [startTime] : [startTime, endTime],
    strength: 0.5 + patternId * 0.03,
    count: endTime === startTime ? 1 : 2,
    beatIndex: patternId,
    cue: 'kick',
    trigger: 'kick',
  };
}

function timeline(patterns: TimelinePatternMarker[]): TrackTimeline {
  return {
    planSeed: 0xfeedbeef,
    profileId: 'test',
    title: 'TEST',
    bpm: 128,
    duration: 100,
    samples: [],
    patterns,
    transitions: [],
    downbeats: [],
  };
}

describe('race HUD course markers', () => {
  it('projects every hazard kind while filtering rewards', () => {
    const markers = createRaceCourseMarkers(timeline([
      pattern(1, 'gate', 10),
      pattern(2, 'aperture', 20),
      pattern(3, 'halfwall', 30, 31),
      pattern(4, 'blade', 40, 41),
      pattern(5, 'cross', 50, 52),
      pattern(6, 'bastion', 60),
      pattern(7, 'boost', 70, 70, 'reward'),
    ]));

    expect(markers.map((marker) => marker.kind)).toEqual(['gate', 'aperture', 'halfwall', 'blade', 'cross', 'bastion']);
    expect(markers.map((marker) => marker.startProgress)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(markers[4]).toMatchObject({ endProgress: 0.52, count: 2, label: 'CROSS, series of 2' });
    expect(Object.isFrozen(markers)).toBe(true);
    expect(markers.every(Object.isFrozen)).toBe(true);
  });

  it('keeps distinct close patterns and staggers them deterministically', () => {
    const markers = createRaceCourseMarkers(timeline([
      pattern(3, 'cross', 11.2),
      pattern(1, 'gate', 10),
      pattern(2, 'blade', 10.7),
      pattern(4, 'bastion', 18),
    ]));

    expect(markers.map((marker) => marker.id)).toEqual([
      'feedbeef:pattern:1',
      'feedbeef:pattern:2',
      'feedbeef:pattern:3',
      'feedbeef:pattern:4',
    ]);
    expect(markers.slice(0, 3).map((marker) => marker.lane)).toEqual([0, 1, 2]);
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(4);
  });
});
