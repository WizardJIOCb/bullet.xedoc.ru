import { describe, expect, it } from 'vitest';
import { TRACKS, type MusicProfile, type RhythmBeat } from '../core/types';
import { createDefaultMusicProfile, generateTrack, sampleTrackFrame } from './track';

function immutableEventPlan(profile: MusicProfile, seed = 1337) {
  return generateTrack(TRACKS.aurora, profile, seed).events.map((event) => ({
    id: event.id,
    kind: event.kind,
    distance: event.distance,
    angle: event.angle,
    gapWidth: event.gapWidth,
    beatIndex: event.beatIndex,
    musicTime: event.musicTime,
    strength: event.strength,
    rotationRate: event.rotationRate,
    rotationPhase: event.rotationPhase,
    armCount: event.armCount,
    patternId: event.patternId,
    warningDistance: event.warningDistance,
  }));
}

describe('procedural track generation', () => {
  it('builds deterministic, ordered and uniquely identified musical event plans', () => {
    const profile = createDefaultMusicProfile();
    const first = generateTrack(TRACKS.aurora, profile, 1337);
    const second = generateTrack(TRACKS.aurora, profile, 1337);

    expect(first.seed).toBe(second.seed);
    expect(first.length).toBeCloseTo(second.length, 8);
    expect(immutableEventPlan(profile)).toEqual(immutableEventPlan(profile));
    expect(first.events.length).toBeGreaterThanOrEqual(40);
    expect(first.events.length).toBeLessThan(150);
    expect(first.events.every((event, index, items) => index === 0 || event.distance >= items[index - 1].distance)).toBe(true);
    expect(new Set(first.events.map((event) => event.id)).size).toBe(first.events.length);
    expect(first.events.map((event) => event.id)).toEqual(first.events.map((_, index) => index));
    expect(first.events.every((event) => event.musicTime >= 0.7 && event.musicTime < first.runDuration)).toBe(true);
    expect(first.events.filter((event) => event.kind === 'gate').every((event) => event.gapWidth >= 0.7)).toBe(true);
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'mine', 'drone']);
    const patternIdsByBeat = new Map<number, Set<number>>();
    for (const event of first.events.filter((candidate) => hazardKinds.has(candidate.kind))) {
      const patternIds = patternIdsByBeat.get(event.beatIndex) || new Set<number>();
      patternIds.add(event.patternId);
      patternIdsByBeat.set(event.beatIndex, patternIds);
    }
    expect([...patternIdsByBeat.values()].every((patternIds) => patternIds.size === 1)).toBe(true);
  });

  it('uses the route hazard multiplier to control encounter density', () => {
    const profile = createDefaultMusicProfile();
    const aurora = generateTrack(TRACKS.aurora, profile, 44);
    const reactor = generateTrack(TRACKS.reactor, profile, 44);
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'mine', 'drone']);
    const countHazards = (plan: ReturnType<typeof generateTrack>): number => plan.events.filter((event) => hazardKinds.has(event.kind)).length;

    expect(countHazards(reactor)).toBeGreaterThan(countHazards(aurora));
  });

  it('maps beats, transitions and every encounter to the same music-time axis', () => {
    const profile = createDefaultMusicProfile();
    const plan = generateTrack(TRACKS.reactor, profile, 91);

    expect(plan.beatDistances.length).toBe(profile.beats.length);
    expect(plan.transitionDistances.length).toBe(profile.transitions.length);
    for (const beat of plan.beatDistances) {
      expect((beat.distance / plan.length) * plan.runDuration).toBeCloseTo(beat.time, 8);
    }
    for (const transition of plan.transitionDistances) {
      expect((transition.distance / plan.length) * plan.runDuration).toBeCloseTo(transition.time, 8);
    }
    for (const event of plan.events) {
      expect((event.distance / plan.length) * plan.runDuration).toBeCloseTo(event.musicTime, 8);
      expect(plan.beatDistances[event.beatIndex]?.time).toBeCloseTo(event.musicTime, 8);
    }
  });

  it('creates half-wall, twisted-blade and cross-spiral patterns with readable safe space', () => {
    const plan = generateTrack(TRACKS.void, createDefaultMusicProfile(), 712);
    const halfwalls = plan.events.filter((event) => event.kind === 'halfwall');
    const blades = plan.events.filter((event) => event.kind === 'blade');
    const crosses = plan.events.filter((event) => event.kind === 'cross');

    expect(halfwalls.length).toBeGreaterThanOrEqual(2);
    expect(blades.length).toBeGreaterThanOrEqual(3);
    expect(crosses.length).toBeGreaterThanOrEqual(2);
    expect(new Set(halfwalls.map((event) => event.patternId)).size).toBeLessThan(halfwalls.length);
    expect(new Set(blades.map((event) => event.patternId)).size).toBeLessThan(blades.length);
    expect(new Set(crosses.map((event) => event.patternId)).size).toBeLessThan(crosses.length);
    expect(halfwalls.every((event) => event.gapWidth < Math.PI / 2)).toBe(true);
    expect(blades.every((event) => event.armCount === 2 && event.gapWidth <= 0.24)).toBe(true);
    expect(crosses.every((event) => event.armCount === 4 && event.gapWidth <= 0.22)).toBe(true);
    expect([...blades, ...crosses].some((event) => Math.abs(event.rotationRate) > 0.05)).toBe(true);
  });

  it('uses beatOffset when a decoded profile has no explicit onset timeline', () => {
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      runDuration: 58,
      duration: 58,
      bpm: 120,
      beatOffset: 0.19,
      beats: [],
      transitions: [],
    };
    const plan = generateTrack(TRACKS.aurora, profile, 4);

    expect(plan.beatDistances[0].time).toBeCloseTo(0.19, 8);
    expect(plan.beatDistances[1].time - plan.beatDistances[0].time).toBeCloseTo(0.5, 8);
    expect(plan.events.every((event) => plan.beatDistances[event.beatIndex]?.time === event.musicTime)).toBe(true);
  });

  it('preserves an irregular real-beat timeline instead of replacing it with an average BPM grid', () => {
    const runDuration = 58;
    const realBeats: RhythmBeat[] = Array.from({ length: 112 }, (_, index) => ({
      time: 0.11 + index * 0.515 + (index % 7 === 0 ? 0.035 : 0),
      strength: index % 4 === 0 ? 0.94 : 0.58,
      bass: index % 4 === 0 ? 0.86 : 0.47,
      highs: index % 3 === 0 ? 0.72 : 0.38,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 116,
      beatOffset: 0.31,
      beats: realBeats,
      transitions: [{ time: 21.37, strength: 1, kind: 'drop' }],
    };
    const plan = generateTrack(TRACKS.reactor, profile, 77);

    expect(plan.beatDistances.slice(0, realBeats.length).map((beat) => beat.time))
      .toEqual(realBeats.map((beat) => beat.time));
    expect(plan.transitionDistances[0]).toMatchObject({ time: 21.37, strength: 1, kind: 'drop' });
    expect(plan.events.every((event) => realBeats.some((beat) => Math.abs(beat.time - event.musicTime) < 1e-8))).toBe(true);
  });

  it('makes the route react spatially to energy and transitions', () => {
    const source = createDefaultMusicProfile();
    const quiet: MusicProfile = {
      ...source,
      energy: source.energy.map(() => 0.12),
      bass: source.bass.map(() => 0.18),
      mids: source.mids.map(() => 0.12),
      highs: source.highs.map(() => 0.1),
      transitions: [],
    };
    const intense: MusicProfile = {
      ...source,
      energy: source.energy.map(() => 0.95),
      bass: source.bass.map(() => 0.9),
      mids: source.mids.map(() => 0.92),
      highs: source.highs.map(() => 0.88),
      transitions: [{ time: source.runDuration * 0.5, strength: 1, kind: 'drop' }],
    };
    const quietPlan = generateTrack(TRACKS.aurora, quiet, 22);
    const intensePlan = generateTrack(TRACKS.aurora, intense, 22);
    const quietMiddle = quietPlan.curve.getPointAt(0.58);
    const intenseMiddle = intensePlan.curve.getPointAt(0.58);

    expect(Math.hypot(intenseMiddle.x, intenseMiddle.y)).toBeGreaterThan(Math.hypot(quietMiddle.x, quietMiddle.y) + 25);
  });

  it('maintains an orthonormal transported frame', () => {
    const plan = generateTrack(TRACKS.void, createDefaultMusicProfile(), 7);
    for (const progress of [0, 0.1, 0.33, 0.67, 0.92]) {
      const frame = sampleTrackFrame(plan, progress);
      expect(frame.tangent.length()).toBeCloseTo(1, 4);
      expect(frame.normal.length()).toBeCloseTo(1, 4);
      expect(frame.binormal.length()).toBeCloseTo(1, 4);
      expect(Math.abs(frame.tangent.dot(frame.normal))).toBeLessThan(0.01);
      expect(Math.abs(frame.tangent.dot(frame.binormal))).toBeLessThan(0.01);
    }
  });
});
