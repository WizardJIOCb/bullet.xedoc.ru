import { describe, expect, it } from 'vitest';
import { TRACKS, type MusicProfile, type TrackEvent } from '../core/types';
import { createDefaultMusicProfile, generateTrack, type TrackPlan } from './track';
import { createTrackTimeline } from './timeline';

function replaceEvents(plan: TrackPlan, events: TrackEvent[]): TrackPlan {
  return { ...plan, events };
}

function eventAt(
  template: TrackEvent,
  id: number,
  patternId: number,
  kind: TrackEvent['kind'],
  musicTime: number,
  strength: number,
): TrackEvent {
  return {
    ...template,
    id,
    patternId,
    kind,
    musicTime,
    distance: musicTime,
    strength,
    beatIndex: id,
    resolved: false,
    destroyed: false,
  };
}

describe('track timeline snapshots', () => {
  it('groups events by pattern, prioritizes hazards and hides shard-only groups', () => {
    const profile = createDefaultMusicProfile();
    const source = generateTrack(TRACKS.aurora, profile, 713);
    const template = source.events[0];
    const plan = replaceEvents(source, [
      eventAt(template, 0, 7, 'shard', 5, 0.24),
      eventAt(template, 1, 7, 'bastion', 4, 0.91),
      eventAt(template, 2, 8, 'shard', 6.5, 0.8),
      eventAt(template, 3, 9, 'shard', 8, 0.38),
      eventAt(template, 4, 9, 'coolant', 9, 0.66),
      eventAt(template, 5, 10, 'boost', 11, 0.72),
    ]);

    const timeline = createTrackTimeline(plan, profile);

    expect(timeline.patterns.map((marker) => marker.patternId)).toEqual([7, 9, 10]);
    expect(timeline.patterns[0]).toMatchObject({
      category: 'hazard',
      kind: 'bastion',
      musicTime: 4,
      startTime: 4,
      endTime: 4,
      strength: 0.91,
      count: 1,
    });
    expect(timeline.patterns[0].eventTimes).toEqual([4]);
    expect(timeline.patterns[1]).toMatchObject({
      category: 'reward',
      kind: 'coolant',
      musicTime: 9,
      startTime: 9,
      endTime: 9,
      count: 1,
    });
    expect(timeline.patterns[1].eventTimes).toEqual([9]);
    expect(timeline.patterns[2].kind).toBe('boost');
    expect(timeline.patterns[0].id).toBe(`${plan.seed.toString(16).padStart(8, '0')}:pattern:7`);
  });

  it('can omit rewards while retaining every hazard pattern', () => {
    const profile = createDefaultMusicProfile();
    const source = generateTrack(TRACKS.reactor, profile, 99);
    const template = source.events[0];
    const plan = replaceEvents(source, [
      eventAt(template, 0, 1, 'gate', 4, 0.7),
      eventAt(template, 1, 2, 'halfwall', 7, 0.8),
      eventAt(template, 2, 3, 'blade', 10, 0.82),
      eventAt(template, 3, 4, 'cross', 13, 0.9),
      eventAt(template, 4, 5, 'bastion', 16, 0.76),
      eventAt(template, 5, 6, 'boost', 19, 0.7),
      eventAt(template, 6, 7, 'coolant', 22, 0.7),
    ]);

    const timeline = createTrackTimeline(plan, profile, { includeRewards: false });

    expect(timeline.patterns.map((marker) => marker.kind)).toEqual(['gate', 'halfwall', 'blade', 'cross', 'bastion']);
    expect(timeline.patterns.every((marker) => marker.category === 'hazard')).toBe(true);
  });

  it('copies energy, processed downbeats and transitions onto the course time axis', () => {
    const source = createDefaultMusicProfile();
    const profile: MusicProfile = {
      ...source,
      energy: [0.1, 0.5, 0.9],
      bass: [0.2],
      mids: [0.3, 0.7],
      highs: [0.4, 0.6, 0.8],
      onsets: [0, 0.5, 0],
      kicks: [0, 0.8, 0],
      transients: [0, 0.3, 0],
    };
    const plan = generateTrack(TRACKS.void, profile, 42);
    const timeline = createTrackTimeline(plan, profile);

    expect(timeline.duration).toBe(plan.runDuration);
    expect(timeline.samples).toEqual([
      { musicTime: 0, energy: 0.1, bass: 0.2, mids: 0.3, highs: 0.4, onset: 0, kick: 0, transient: 0 },
      { musicTime: plan.runDuration / 2, energy: 0.5, bass: 0.2, mids: 0.5, highs: 0.6, onset: 0.5, kick: 0.8, transient: 0.3 },
      { musicTime: plan.runDuration, energy: 0.9, bass: 0.2, mids: 0.7, highs: 0.8, onset: 0, kick: 0, transient: 0 },
    ]);
    expect(timeline.downbeats).toEqual(plan.beatDistances
      .filter((beat) => beat.gridBeat !== false && beat.barBeat === 0)
      .map((beat) => ({
        id: `${plan.seed.toString(16).padStart(8, '0')}:beat:${beat.beatIndex}`,
        beatIndex: beat.beatIndex,
        musicTime: beat.time,
        strength: beat.strength,
        bass: beat.bass,
        highs: beat.highs,
        barBeat: 0,
      })));
    expect(timeline.transitions).toEqual(plan.transitionDistances.map((transition) => ({
      type: 'transition',
      id: `${plan.seed.toString(16).padStart(8, '0')}:transition:${transition.transitionIndex}`,
      transitionIndex: transition.transitionIndex,
      kind: transition.kind,
      musicTime: transition.time,
      strength: transition.strength,
    })));
  });

  it('is deeply immutable and detached from mutable runtime event state', () => {
    const profile = createDefaultMusicProfile();
    const plan = generateTrack(TRACKS.aurora, profile, 1337);
    const timeline = createTrackTimeline(plan, profile);
    const firstMarker = timeline.patterns[0];
    const sourceEvent = plan.events.find((event) => event.patternId === firstMarker.patternId)!;
    const originalStrength = firstMarker.strength;

    sourceEvent.resolved = true;
    sourceEvent.destroyed = true;
    sourceEvent.strength = 0;

    expect(firstMarker.strength).toBe(originalStrength);
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(Object.isFrozen(timeline.samples)).toBe(true);
    expect(Object.isFrozen(timeline.samples[0])).toBe(true);
    expect(Object.isFrozen(timeline.patterns)).toBe(true);
    expect(Object.isFrozen(firstMarker)).toBe(true);
    expect(Object.isFrozen(firstMarker.eventTimes)).toBe(true);
    expect(Object.isFrozen(timeline.transitions)).toBe(true);
    expect(Object.isFrozen(timeline.downbeats)).toBe(true);
    expect('curve' in timeline).toBe(false);
    expect('frames' in timeline).toBe(false);
  });

  it('produces stable snapshots for the same plan and profile', () => {
    const profile = createDefaultMusicProfile();
    const plan = generateTrack(TRACKS.reactor, profile, 8080);

    expect(createTrackTimeline(plan, profile)).toEqual(createTrackTimeline(plan, profile));
  });

  it('preserves the detected musical cue behind every pattern marker', () => {
    const profile = createDefaultMusicProfile();
    const plan = generateTrack(TRACKS.reactor, profile, 505);
    const timeline = createTrackTimeline(plan, profile);

    expect(timeline.patterns.some((marker) => marker.cue === 'kick')).toBe(true);
    expect(timeline.patterns.some((marker) => marker.cue === 'transient')).toBe(true);
    for (const marker of timeline.patterns) {
      expect(marker.cue).toBe(plan.beatDistances[marker.beatIndex]?.cue ?? 'beat');
      expect(marker.trigger).toBe(plan.events.find((event) => event.patternId === marker.patternId && event.kind === marker.kind)?.trigger);
    }
    expect(timeline.patterns.some((marker) => marker.trigger === 'drop')).toBe(true);
  });
});
