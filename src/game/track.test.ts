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
    trigger: event.trigger,
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
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);
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
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);
    const countHazards = (plan: ReturnType<typeof generateTrack>): number => plan.events.filter((event) => hazardKinds.has(event.kind)).length;

    expect(countHazards(reactor)).toBeGreaterThan(countHazards(aurora));
  });

  it('maps beats, transitions and every encounter to the same music-time axis', () => {
    const profile = createDefaultMusicProfile();
    const plan = generateTrack(TRACKS.reactor, profile, 91);

    expect(plan.beatDistances.length).toBeGreaterThanOrEqual(profile.beats.length);
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

  it('never generates the removed small mine hazards on any route', () => {
    const profile = createDefaultMusicProfile();
    for (const track of Object.values(TRACKS)) {
      for (const seed of [1, 17, 91, 712]) {
        expect(generateTrack(track, profile, seed).events.map((event) => event.kind)).not.toContain('mine');
      }
    }
  });

  it('turns a strong off-downbeat onset into a large obstacle pattern', () => {
    const runDuration = 58;
    const accentIndex = 27;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: index === accentIndex ? 0.7 : 0.34,
      bass: index === accentIndex ? 0.96 : 0.3,
      highs: index === accentIndex ? 0.18 : 0.28,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.45),
      bass: Array(192).fill(0.45),
      mids: Array(192).fill(0.4),
      highs: Array(192).fill(0.32),
      beats,
      transitions: [],
    };
    const plan = generateTrack(TRACKS.aurora, profile, 53);
    const largeKinds = new Set(['gate', 'halfwall', 'blade', 'cross']);

    expect(beats[accentIndex].barBeat).not.toBe(0);
    expect(plan.events.some((event) => event.beatIndex === accentIndex && largeKinds.has(event.kind))).toBe(true);
  });

  it('turns detected kicks and transients into hazards at their exact hit times', () => {
    const runDuration = 58;
    const kickIndex = 21;
    const transientIndex = 29;
    const weakIndex = 23;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: index === kickIndex || index === transientIndex ? 0.96 : 0.24,
      bass: index === kickIndex ? 0.98 : 0.28,
      highs: index === transientIndex ? 0.98 : 0.25,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
      cue: index === kickIndex ? 'kick' as const : index === transientIndex ? 'transient' as const : 'beat' as const,
      onset: index === kickIndex || index === transientIndex ? 1 : 0.08,
      kick: index === kickIndex ? 1 : 0,
      transient: index === transientIndex ? 1 : 0,
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.58),
      bass: Array(192).fill(0.48),
      mids: Array(192).fill(0.44),
      highs: Array(192).fill(0.42),
      beats,
      transitions: [],
    };
    const plan = generateTrack(TRACKS.aurora, profile, 2048);
    const kickHazards = new Set(['gate', 'halfwall', 'cross']);
    const transientHazards = new Set(['blade', 'halfwall', 'drone']);

    expect(plan.events.some((event) => event.musicTime === beats[kickIndex].time && kickHazards.has(event.kind))).toBe(true);
    expect(plan.events.some((event) => event.musicTime === beats[transientIndex].time && transientHazards.has(event.kind))).toBe(true);
    expect(plan.events.some((event) => event.musicTime === beats[weakIndex].time && kickHazards.has(event.kind))).toBe(false);
  });

  it('keeps multi-part patterns on readable grid beats when an off-grid hit is nearby', () => {
    const runDuration = 58;
    const grid: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: index === 20 ? 1 : 0.2,
      bass: 0.24,
      highs: index === 20 ? 1 : 0.24,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
      gridBeat: true,
      cue: index === 20 ? 'transient' as const : 'beat' as const,
      onset: index === 20 ? 1 : 0,
      kick: 0,
      transient: index === 20 ? 1 : 0,
    })).filter((beat) => beat.time <= runDuration);
    grid.push({
      time: 10.32,
      strength: 0.24,
      bass: 0.2,
      highs: 0.26,
      barBeat: 0,
      gridBeat: false,
      cue: 'beat' as const,
      onset: 0.08,
      kick: 0,
      transient: 0,
    });
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.52),
      bass: Array(192).fill(0.32),
      mids: Array(192).fill(0.44),
      highs: Array(192).fill(0.48),
      beats: grid,
      transitions: [],
    };
    const plan = generateTrack(TRACKS.aurora, profile, 606);
    const firstBlade = plan.events.find((event) => event.musicTime === 10.25 && event.kind === 'blade');
    const pattern = plan.events
      .filter((event) => event.patternId === firstBlade?.patternId && event.kind === 'blade')
      .sort((left, right) => left.musicTime - right.musicTime);

    expect(pattern.length).toBeGreaterThanOrEqual(2);
    expect(pattern.some((event) => event.musicTime === 10.32)).toBe(false);
    expect(pattern.every((event, index) => index === 0 || event.musicTime - pattern[index - 1].musicTime >= 0.3)).toBe(true);
  });

  it('leaves a loud but rhythmically flat section free of synthetic hazards', () => {
    const runDuration = 58;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: 0.28,
      bass: 0.58,
      highs: 0.52,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
      gridBeat: true,
      cue: 'beat' as const,
      onset: 0,
      kick: 0,
      transient: 0,
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      energy: Array(192).fill(0.88),
      bass: Array(192).fill(0.76),
      mids: Array(192).fill(0.7),
      highs: Array(192).fill(0.66),
      beats,
      transitions: [],
    };
    const hazards = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);

    expect(generateTrack(TRACKS.reactor, profile, 707).events.some((event) => hazards.has(event.kind))).toBe(false);
  });

  it('leaves recovery space between a pattern tail and the next exact transition', () => {
    const runDuration = 58;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: index === 20 ? 1 : 0.2,
      bass: 0.3,
      highs: index === 20 ? 1 : 0.24,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
      gridBeat: true,
      cue: index === 20 ? 'transient' as const : 'beat' as const,
      onset: index === 20 ? 1 : 0,
      kick: 0,
      transient: index === 20 ? 1 : 0,
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      beats,
      transitions: [{ time: 11.35, strength: 1, kind: 'drop' }],
    };
    const plan = generateTrack(TRACKS.reactor, profile, 909);
    const sourcePattern = plan.events.find((event) => event.musicTime === 10.25 && event.kind === 'blade');
    const sourceTail = Math.max(...plan.events
      .filter((event) => event.patternId === sourcePattern?.patternId)
      .map((event) => event.musicTime));
    const dropStart = Math.min(...plan.events
      .filter((event) => event.trigger === 'drop')
      .map((event) => event.musicTime));

    expect(sourceTail).toBeLessThanOrEqual(10.75);
    expect(dropStart - sourceTail).toBeGreaterThanOrEqual(0.275 - 1e-8);
  });

  it('anchors a drop pattern to the nearest detected beat instead of a distant downbeat', () => {
    const runDuration = 58;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: 0.42,
      bass: 0.4,
      highs: 0.36,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
    })).filter((beat) => beat.time <= runDuration);
    const targetIndexes = [26, 29, 30, 33];
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.55),
      bass: Array(192).fill(0.52),
      mids: Array(192).fill(0.5),
      highs: Array(192).fill(0.48),
      beats,
      transitions: targetIndexes.map((targetIndex) => ({
        time: beats[targetIndex].time + 0.12,
        strength: 1,
        kind: 'drop' as const,
      })),
    };
    const plan = generateTrack(TRACKS.reactor, profile, 81);

    for (const targetIndex of targetIndexes) {
      expect(beats[targetIndex].barBeat).not.toBe(0);
      const transitionTime = beats[targetIndex].time + 0.12;
      expect(plan.events.some((event) => (
        event.musicTime === transitionTime
        && event.kind === 'cross'
        && event.trigger === 'drop'
      ))).toBe(true);
    }
  });

  it('gives a nearby transition priority over the onset accent immediately before it', () => {
    const runDuration = 58;
    const accentIndex = 29;
    const dropIndex = 30;
    const beats: RhythmBeat[] = Array.from({ length: 116 }, (_, index) => ({
      time: 0.25 + index * 0.5,
      strength: index === accentIndex ? 0.72 : 0.34,
      bass: index === accentIndex ? 0.88 : 0.38,
      highs: index === accentIndex ? 0.7 : 0.32,
      barBeat: (index % 4) as RhythmBeat['barBeat'],
    })).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.55),
      bass: Array(192).fill(0.5),
      mids: Array(192).fill(0.48),
      highs: Array(192).fill(0.46),
      beats,
      transitions: [{ time: beats[dropIndex].time + 0.12, strength: 1, kind: 'drop' }],
    };
    const plan = generateTrack(TRACKS.reactor, profile, 118);
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);

    expect(plan.events.some((event) => event.beatIndex === accentIndex && hazardKinds.has(event.kind))).toBe(false);
    expect(plan.events.some((event) => event.musicTime === beats[dropIndex].time + 0.12 && event.kind === 'cross')).toBe(true);
  });

  it('keeps high-BPM syncopated accents readable while preserving route density and variety', () => {
    const runDuration = 58;
    const bpm = 200;
    const interval = 60 / bpm;
    const beats: RhythmBeat[] = Array.from({ length: Math.floor(runDuration / interval) }, (_, index) => {
      const accent = index % 3 === 1;
      return {
        time: 0.12 + index * interval,
        strength: accent ? 0.84 : 0.34,
        bass: accent ? 0.78 : 0.3,
        highs: accent ? 0.72 : 0.26,
        barBeat: (index % 4) as RhythmBeat['barBeat'],
      };
    }).filter((beat) => beat.time <= runDuration);
    const profile: MusicProfile = {
      ...createDefaultMusicProfile(),
      duration: runDuration,
      runDuration,
      bpm,
      beatOffset: 0.12,
      energy: Array(192).fill(0.64),
      bass: Array(192).fill(0.58),
      mids: Array(192).fill(0.54),
      highs: Array(192).fill(0.56),
      beats,
      transitions: [],
    };
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);
    const patternStarts = (plan: ReturnType<typeof generateTrack>): number[] => {
      const starts = new Map<number, number>();
      for (const event of plan.events.filter((candidate) => hazardKinds.has(candidate.kind))) {
        starts.set(event.patternId, Math.min(starts.get(event.patternId) ?? Number.POSITIVE_INFINITY, event.musicTime));
      }
      return [...starts.values()].sort((a, b) => a - b);
    };
    const aurora = generateTrack(TRACKS.aurora, profile, 99);
    const reactor = generateTrack(TRACKS.reactor, profile, 99);
    const auroraStarts = patternStarts(aurora);
    const reactorStarts = patternStarts(reactor);
    const minimumGap = Math.min(1.25, Math.max(0.78, 1.05 / TRACKS.aurora.hazardRate));

    expect(auroraStarts.every((time, index) => index === 0 || time - auroraStarts[index - 1] >= minimumGap - 1e-8)).toBe(true);
    expect(reactorStarts.length).toBeGreaterThan(auroraStarts.length);
    expect(new Set(reactor.events.filter((event) => hazardKinds.has(event.kind)).map((event) => event.kind)).size).toBeGreaterThanOrEqual(4);
  });

  it('turns the same-seed music profile into materially different encounter density and time bins', () => {
    const runDuration = 64;
    const profileSeed = 0x6acced;
    const beats: RhythmBeat[] = Array.from({ length: 128 }, (_, index) => {
      const time = 0.25 + index * 0.5;
      const activeSection = time >= 24;
      const kick = activeSection && index % 4 === 0;
      const transient = activeSection && index % 4 === 2;
      return {
        time,
        strength: kick ? 0.98 : transient ? 0.9 : activeSection ? 0.36 : 0.2,
        bass: kick ? 0.96 : transient ? 0.5 : activeSection ? 0.34 : 0.12,
        highs: transient ? 0.96 : kick ? 0.48 : activeSection ? 0.34 : 0.1,
        barBeat: (index % 4) as RhythmBeat['barBeat'],
        cue: (kick ? 'kick' : transient ? 'transient' : 'beat') as RhythmBeat['cue'],
        onset: kick ? 0.98 : transient ? 0.92 : activeSection ? 0.24 : 0.08,
        kick: kick ? 0.98 : 0,
        transient: transient ? 0.96 : 0,
      };
    }).filter((beat) => beat.time <= runDuration);
    const band = (quiet: number, active: number): number[] => Array.from(
      { length: 192 },
      (_, index) => (index / 191) * runDuration >= 24 ? active : quiet,
    );
    const quietProfile: MusicProfile = {
      ...createDefaultMusicProfile(),
      id: 'same-seed-quiet',
      duration: runDuration,
      runDuration,
      bpm: 120,
      beatOffset: 0.25,
      energy: Array(192).fill(0.12),
      bass: Array(192).fill(0.12),
      mids: Array(192).fill(0.12),
      highs: Array(192).fill(0.1),
      beats: beats.map((beat) => ({
        ...beat,
        strength: 0.2,
        bass: 0.12,
        highs: 0.1,
        cue: 'beat',
        onset: 0.08,
        kick: 0,
        transient: 0,
      })),
      transitions: [],
      seed: profileSeed,
    };
    const dynamicProfile: MusicProfile = {
      ...quietProfile,
      id: 'same-seed-dynamic',
      energy: band(0.12, 0.92),
      bass: band(0.12, 0.86),
      mids: band(0.12, 0.78),
      highs: band(0.1, 0.84),
      beats,
      transitions: [
        { time: 31.25, strength: 0.76, kind: 'build' },
        { time: 39.25, strength: 0.96, kind: 'drop' },
        { time: 47.25, strength: 0.82, kind: 'fill' },
        { time: 55.25, strength: 0.72, kind: 'break' },
      ],
    };
    const hazardKinds = new Set(['gate', 'halfwall', 'blade', 'cross', 'drone']);
    const summarize = (plan: ReturnType<typeof generateTrack>) => {
      const starts = new Map<number, { time: number; kind: string }>();
      for (const event of plan.events.filter((candidate) => hazardKinds.has(candidate.kind))) {
        const current = starts.get(event.patternId);
        if (!current || event.musicTime < current.time) starts.set(event.patternId, { time: event.musicTime, kind: event.kind });
      }
      const histogram = [...starts.values()].reduce<Record<string, number>>((counts, pattern) => {
        counts[pattern.kind] = (counts[pattern.kind] ?? 0) + 1;
        return counts;
      }, {});
      const timeBins = Array.from({ length: 8 }, (_, bin) => (
        [...starts.values()].filter((pattern) => Math.floor(pattern.time / 8) === bin).length
      ));
      return { patterns: [...starts.values()], histogram, timeBins };
    };
    const quietPlan = generateTrack(TRACKS.reactor, quietProfile, 404);
    const dynamicPlan = generateTrack(TRACKS.reactor, dynamicProfile, 404);
    const quiet = summarize(quietPlan);
    const dynamic = summarize(dynamicPlan);
    const quietSectionEvents = dynamicPlan.events.filter((event) => event.musicTime >= 4 && event.musicTime < 24);

    expect(dynamicPlan.seed).toBe(quietPlan.seed);
    expect(quiet.patterns).toHaveLength(0);
    expect(dynamic.patterns.length).toBeGreaterThanOrEqual(quiet.patterns.length + 12);
    expect(Object.keys(dynamic.histogram).length).toBeGreaterThanOrEqual(3);
    expect(dynamic.timeBins).not.toEqual(quiet.timeBins);
    expect(dynamic.timeBins.filter((count) => count > 0).length).toBeGreaterThanOrEqual(4);
    expect(dynamic.patterns.filter((pattern) => pattern.time >= 24).length).toBe(dynamic.patterns.length);
    expect(quietSectionEvents.every((event) => !hazardKinds.has(event.kind))).toBe(true);
    expect(quietPlan.events.every((event) => !hazardKinds.has(event.kind))).toBe(true);
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

    expect(realBeats.every((beat) => plan.beatDistances.some((mapped) => mapped.time === beat.time))).toBe(true);
    expect(plan.transitionDistances[0]).toMatchObject({ time: 21.37, strength: 1, kind: 'drop' });
    expect(plan.events.every((event) => (
      realBeats.some((beat) => Math.abs(beat.time - event.musicTime) < 1e-8)
      || Math.abs(event.musicTime - 21.37) < 1e-8
    ))).toBe(true);
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
