import { describe, expect, it } from 'vitest';
import { angularDistance, wrapAngle } from '../core/math';
import {
  TRACKS,
  type MusicProfile,
  type RhythmBeat,
  type TrackEvent,
  type TrackTheme,
} from '../core/types';
import {
  createDefaultMusicProfile,
  generateTrack,
  getTrackEventSafeCorridors,
} from './track';
import {
  steeringInputTowardAngle,
  stepWallRideSteering,
  type WallRideSteeringState,
} from './steering';

const SIMULATION_STEP = 1 / 120;
const TIME_EPSILON = 1e-9;
const MIN_FOLLOWER_CLEARANCE = 0.2;
const HAZARD_KINDS = new Set<TrackEvent['kind']>([
  'gate',
  'halfwall',
  'blade',
  'cross',
  'bastion',
]);

interface FollowedHazard {
  event: TrackEvent;
  state: WallRideSteeringState;
  clearance: number;
}

function hazardEvents(events: readonly TrackEvent[]): TrackEvent[] {
  return events
    .filter((event) => HAZARD_KINDS.has(event.kind))
    .sort((left, right) => left.musicTime - right.musicTime || left.id - right.id);
}

function corridorClearance(event: TrackEvent, angle: number): number {
  return Math.max(
    ...getTrackEventSafeCorridors(event).map((corridor) => (
      corridor.halfWidth - angularDistance(angle, corridor.center)
    )),
  );
}

/**
 * Drives one continuous bolide state through the complete event plan. This is
 * intentionally the same fixed 120 Hz input/controller/physics chain as the
 * game; the state is never reset at a pattern boundary or music transition.
 */
function followReachableCorridors(
  events: readonly TrackEvent[],
  theme: TrackTheme,
): FollowedHazard[] {
  const hazards = hazardEvents(events);
  const followed: FollowedHazard[] = [];
  let state: WallRideSteeringState = { angle: 0, angularVelocity: 0 };
  let time = 0;

  for (const event of hazards) {
    expect(event.safeAngle, `${theme.id} event ${event.id} has no reachable target`).toBeTypeOf('number');
    expect(event.safeAngularVelocity, `${theme.id} event ${event.id} has no reachable velocity`).toBeTypeOf('number');
    const targetAngle = event.safeAngle as number;
    let remaining = event.musicTime - time;

    expect(remaining, `${theme.id} event times must be ordered`).toBeGreaterThanOrEqual(-TIME_EPSILON);
    while (remaining > TIME_EPSILON) {
      const dt = Math.min(SIMULATION_STEP, remaining);
      state = stepWallRideSteering(
        state,
        steeringInputTowardAngle(state, targetAngle),
        theme.handling,
        0,
        dt,
      );
      time += dt;
      remaining = event.musicTime - time;
    }
    time = event.musicTime;

    followed.push({
      event,
      state,
      clearance: corridorClearance(event, state.angle),
    });
  }

  return followed;
}

function createHighBpmProfile(variant: 'dense' | 'transitions'): MusicProfile {
  // generateTrack intentionally normalizes courses to at least 58 seconds;
  // matching that duration keeps these explicit decoded beats authoritative.
  const runDuration = 58;
  const bpm = 200;
  const beatInterval = 60 / bpm;
  const beats: RhythmBeat[] = Array.from(
    { length: Math.ceil(runDuration / beatInterval) },
    (_, index) => {
      const denseAccent = index % 3 === 0;
      const kick = denseAccent && index % 6 === 0;
      const compressionKick = kick && index % 12 === 0;
      const transient = denseAccent && !kick;
      return {
        time: 0.125 + index * beatInterval,
        strength: denseAccent ? (compressionKick ? 0.99 : kick ? 0.84 : 0.94) : 0.31,
        bass: compressionKick ? 0.99 : kick ? 0.86 : transient ? 0.44 : 0.28,
        highs: transient ? 0.99 : kick ? 0.42 : 0.3,
        barBeat: (index % 4) as RhythmBeat['barBeat'],
        gridBeat: true,
        cue: kick ? 'kick' as const : transient ? 'transient' as const : 'beat' as const,
        onset: denseAccent ? (kick && !compressionKick ? 0.84 : 0.98) : 0.08,
        kick: compressionKick ? 0.99 : kick ? 0.82 : 0,
        transient: transient ? 0.98 : 0,
      };
    },
  ).filter((beat) => beat.time <= runDuration);
  const samples = 192;
  const modulatedBand = (low: number, high: number, phase: number): number[] => Array.from(
    { length: samples },
    (_, index) => low + (high - low) * (0.5 + Math.sin(index * 0.29 + phase) * 0.5),
  );

  return {
    ...createDefaultMusicProfile(),
    id: `reachability-${variant}-200`,
    title: `Reachability ${variant}`,
    duration: runDuration,
    runDuration,
    bpm,
    beatOffset: 0.125,
    energy: modulatedBand(0.72, 0.94, 0),
    bass: modulatedBand(0.75, 0.92, 0.8),
    mids: modulatedBand(0.4, 0.86, 1.7),
    highs: modulatedBand(0.4, 0.93, 2.4),
    beats,
    transitions: variant === 'transitions'
      ? [
          { time: 8.225, strength: 0.94, kind: 'build' },
          { time: 13.025, strength: 0.96, kind: 'fill' },
          { time: 17.825, strength: 1, kind: 'drop' },
          { time: 22.625, strength: 0.91, kind: 'break' },
          { time: 31.625, strength: 0.98, kind: 'drop' },
          { time: 40.625, strength: 0.95, kind: 'fill' },
          { time: 49.625, strength: 0.97, kind: 'drop' },
        ]
      : [],
    seed: variant === 'dense' ? 0xd35e : 0x7a451710,
  };
}

function expectFollowerInsideEveryCorridor(
  profile: MusicProfile,
  theme: TrackTheme,
  seed: number,
): FollowedHazard[] {
  const plan = generateTrack(theme, profile, seed);
  const followed = followReachableCorridors(plan.events, theme);

  expect(followed.length, `${profile.id}/${theme.id}/${seed} generated no hazards`).toBeGreaterThan(5);
  for (const sample of followed) {
    const label = [
      profile.id,
      theme.id,
      `seed=${seed >>> 0}`,
      `event=${sample.event.id}`,
      `pattern=${sample.event.patternId}`,
      `${sample.event.kind}/${sample.event.trigger}`,
      `t=${sample.event.musicTime.toFixed(3)}`,
      `angle=${sample.state.angle.toFixed(4)}`,
      `target=${sample.event.safeAngle?.toFixed(4)}`,
      `clearance=${sample.clearance.toFixed(5)}`,
    ].join(' ');
    expect(sample.clearance, label).toBeGreaterThanOrEqual(MIN_FOLLOWER_CLEARANCE);
  }
  return followed;
}

describe('generated track corridor reachability', () => {
  it('keeps dense 200 BPM music physically followable across routes and seeds', () => {
    const profiles = [createHighBpmProfile('dense'), createHighBpmProfile('transitions')];
    const seeds = [0, 1, 17, 91, 712, 0xdeadbeef];
    const coveredKinds = new Set<TrackEvent['kind']>();
    const coveredTriggers = new Set<TrackEvent['trigger']>();
    let followedHazards = 0;

    for (const profile of profiles) {
      for (const theme of Object.values(TRACKS)) {
        for (const seed of seeds) {
          const followed = expectFollowerInsideEveryCorridor(profile, theme, seed);
          followedHazards += followed.length;
          for (const sample of followed) {
            coveredKinds.add(sample.event.kind);
            coveredTriggers.add(sample.event.trigger);
          }
        }
      }
    }

    expect(followedHazards).toBeGreaterThan(350);
    expect(coveredKinds).toEqual(new Set(['gate', 'halfwall', 'blade', 'cross', 'bastion']));
    expect([...coveredTriggers]).toEqual(expect.arrayContaining([
      'kick',
      'transient',
      'build',
      'fill',
      'drop',
    ]));
  }, 20_000);

  it('follows wrapped openings and then reverses without resetting angular velocity', () => {
    const profile = createHighBpmProfile('transitions');
    let selected:
      | { theme: TrackTheme; seed: number; followed: FollowedHazard[]; wrapIndex: number; reversalIndex: number }
      | undefined;

    for (const theme of Object.values(TRACKS)) {
      for (let ordinal = 0; ordinal < 96 && !selected; ordinal += 1) {
        const seed = Math.imul(ordinal + 1, 0x9e3779b9) >>> 0;
        const followed = followReachableCorridors(generateTrack(theme, profile, seed).events, theme);
        const wrapIndex = followed.findIndex((sample, index) => index > 0 && (
          Math.abs(sample.state.angle - followed[index - 1].state.angle) > Math.PI
          && angularDistance(sample.state.angle, followed[index - 1].state.angle) < 0.8
        ));
        const reversalIndex = followed.findIndex((sample, index) => index > 0 && (
          Math.abs(sample.state.angularVelocity) > 0.08
          && Math.abs(followed[index - 1].state.angularVelocity) > 0.08
          && Math.sign(sample.state.angularVelocity) !== Math.sign(followed[index - 1].state.angularVelocity)
        ));
        if (wrapIndex >= 0 && reversalIndex >= 0) selected = { theme, seed, followed, wrapIndex, reversalIndex };
      }
    }

    expect(selected, 'fixed seed sweep must contain a wrap and a velocity reversal').toBeDefined();
    if (!selected) return;
    expect(selected.wrapIndex).toBeGreaterThan(0);
    expect(selected.reversalIndex).toBeGreaterThan(0);
    for (const sample of selected.followed) {
      expect(
        sample.clearance,
        `${selected.theme.id}/${selected.seed} event=${sample.event.id}`,
      ).toBeGreaterThanOrEqual(MIN_FOLLOWER_CLEARANCE);
    }

    const beforeWrap = selected.followed[selected.wrapIndex - 1].state.angle;
    const afterWrap = selected.followed[selected.wrapIndex].state.angle;
    expect(Math.abs(afterWrap - beforeWrap)).toBeGreaterThan(Math.PI);
    expect(Math.abs(wrapAngle(afterWrap - beforeWrap))).toBeLessThan(0.8);
  }, 20_000);
});
