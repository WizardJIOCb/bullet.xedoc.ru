import { clamp } from '../core/math';
import type { MusicProfile, MusicTransition, RhythmCue, TrackEvent, TrackEventKind, TrackEventTrigger } from '../core/types';
import type { TrackPlan } from './track';

export type TimelineHazardKind = Extract<TrackEventKind, 'gate' | 'halfwall' | 'blade' | 'cross' | 'bastion'>;
export type TimelineRewardKind = Extract<TrackEventKind, 'boost' | 'coolant'>;
export type TimelinePatternKind = TimelineHazardKind | TimelineRewardKind;

export interface TimelinePatternMarker {
  readonly type: 'pattern';
  readonly id: string;
  readonly patternId: number;
  readonly category: 'hazard' | 'reward';
  readonly kind: TimelinePatternKind;
  readonly musicTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly eventTimes: readonly number[];
  readonly strength: number;
  readonly count: number;
  readonly beatIndex: number;
  readonly cue: RhythmCue;
  readonly trigger: TrackEventTrigger;
}

export interface TimelineTransitionMarker {
  readonly type: 'transition';
  readonly id: string;
  readonly transitionIndex: number;
  readonly kind: MusicTransition['kind'];
  readonly musicTime: number;
  readonly strength: number;
}

export interface TimelineBeat {
  readonly id: string;
  readonly beatIndex: number;
  readonly musicTime: number;
  readonly strength: number;
  readonly bass: number;
  readonly highs: number;
  readonly barBeat: 0;
}

export interface TimelineEnergySample {
  readonly musicTime: number;
  readonly energy: number;
  readonly bass: number;
  readonly mids: number;
  readonly highs: number;
  readonly onset: number;
  readonly kick: number;
  readonly transient: number;
}

export interface TrackTimeline {
  readonly planSeed: number;
  readonly profileId: string;
  readonly title: string;
  readonly bpm: number;
  readonly duration: number;
  readonly samples: readonly TimelineEnergySample[];
  readonly patterns: readonly TimelinePatternMarker[];
  readonly transitions: readonly TimelineTransitionMarker[];
  readonly downbeats: readonly TimelineBeat[];
}

export interface TrackTimelineOptions {
  readonly includeRewards?: boolean;
}

const HAZARD_KINDS = new Set<TrackEventKind>(['gate', 'halfwall', 'blade', 'cross', 'bastion']);
const REWARD_KINDS = new Set<TrackEventKind>(['boost', 'coolant']);

function seedLabel(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0');
}

function freezeItems<T extends object>(items: T[]): readonly Readonly<T>[] {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
}

function sampleSeries(values: readonly number[], progress: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return clamp(values[0], 0, 1);
  const scaled = clamp(progress, 0, 1) * (values.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(left + 1, values.length - 1);
  const mix = scaled - left;
  return clamp(values[left] + (values[right] - values[left]) * mix, 0, 1);
}

function createEnergySamples(profile: MusicProfile, duration: number): readonly TimelineEnergySample[] {
  const sampleCount = Math.max(profile.energy.length, profile.bass.length, profile.mids.length, profile.highs.length);
  if (sampleCount === 0) return Object.freeze([]);
  const samples: TimelineEnergySample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const courseProgress = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    const musicTime = courseProgress * duration;
    const sourceDuration = clamp(profile.duration || duration, 0.001, duration);
    const sourceTime = sourceDuration < duration ? musicTime % sourceDuration : musicTime;
    const progress = clamp(sourceTime / sourceDuration, 0, 1);
    samples.push({
      musicTime,
      energy: sampleSeries(profile.energy, progress),
      bass: sampleSeries(profile.bass, progress),
      mids: sampleSeries(profile.mids, progress),
      highs: sampleSeries(profile.highs, progress),
      onset: sampleSeries(profile.onsets ?? [], progress),
      kick: sampleSeries(profile.kicks ?? [], progress),
      transient: sampleSeries(profile.transients ?? [], progress),
    });
  }
  return freezeItems(samples);
}

function representativeKind(events: readonly TrackEvent[]): {
  category: TimelinePatternMarker['category'];
  kind: TimelinePatternKind;
} | null {
  const hazard = events.find((event) => HAZARD_KINDS.has(event.kind));
  if (hazard) return { category: 'hazard', kind: hazard.kind as TimelineHazardKind };
  const reward = events.find((event) => REWARD_KINDS.has(event.kind));
  if (reward) return { category: 'reward', kind: reward.kind as TimelineRewardKind };
  return null;
}

function createPatternMarkers(
  plan: TrackPlan,
  includeRewards: boolean,
): readonly TimelinePatternMarker[] {
  const grouped = new Map<number, TrackEvent[]>();
  for (const event of plan.events) {
    const group = grouped.get(event.patternId);
    if (group) group.push(event);
    else grouped.set(event.patternId, [event]);
  }

  const seed = seedLabel(plan.seed);
  const patterns: TimelinePatternMarker[] = [];
  for (const [patternId, sourceEvents] of grouped) {
    const events = [...sourceEvents].sort((left, right) => left.musicTime - right.musicTime || left.id - right.id);
    const representative = representativeKind(events);
    if (!representative || (representative.category === 'reward' && !includeRewards)) continue;
    const markerEvents = representative.category === 'hazard'
      ? events.filter((event) => HAZARD_KINDS.has(event.kind))
      : events.filter((event) => event.kind === representative.kind);
    const eventTimes = Object.freeze(markerEvents.map((event) => event.musicTime));
    const startTime = eventTimes[0];
    const endTime = eventTimes[eventTimes.length - 1];
    patterns.push({
      type: 'pattern',
      id: `${seed}:pattern:${patternId}`,
      patternId,
      category: representative.category,
      kind: representative.kind,
      musicTime: startTime,
      startTime,
      endTime,
      eventTimes,
      strength: markerEvents.reduce((maximum, event) => Math.max(maximum, event.strength), 0),
      count: markerEvents.length,
      beatIndex: markerEvents[0].beatIndex,
      cue: plan.beatDistances[markerEvents[0].beatIndex]?.cue ?? 'beat',
      trigger: markerEvents[0].trigger,
    });
  }

  patterns.sort((left, right) => left.startTime - right.startTime || left.patternId - right.patternId);
  return freezeItems(patterns);
}

function createTransitionMarkers(plan: TrackPlan): readonly TimelineTransitionMarker[] {
  const seed = seedLabel(plan.seed);
  return freezeItems(plan.transitionDistances.map((transition) => ({
    type: 'transition' as const,
    id: `${seed}:transition:${transition.transitionIndex}`,
    transitionIndex: transition.transitionIndex,
    kind: transition.kind,
    musicTime: transition.time,
    strength: transition.strength,
  })));
}

function createDownbeats(plan: TrackPlan): readonly TimelineBeat[] {
  const seed = seedLabel(plan.seed);
  return freezeItems(plan.beatDistances
    .filter((beat): beat is typeof beat & { barBeat: 0 } => beat.gridBeat !== false && beat.barBeat === 0)
    .map((beat) => ({
      id: `${seed}:beat:${beat.beatIndex}`,
      beatIndex: beat.beatIndex,
      musicTime: beat.time,
      strength: beat.strength,
      bass: beat.bass,
      highs: beat.highs,
      barBeat: 0 as const,
    })));
}

export function createTrackTimeline(
  plan: TrackPlan,
  profile: MusicProfile,
  options: TrackTimelineOptions = {},
): TrackTimeline {
  const timeline: TrackTimeline = {
    planSeed: plan.seed,
    profileId: profile.id,
    title: profile.title,
    bpm: profile.bpm,
    duration: plan.runDuration,
    samples: createEnergySamples(profile, plan.runDuration),
    patterns: createPatternMarkers(plan, options.includeRewards ?? true),
    transitions: createTransitionMarkers(plan),
    downbeats: createDownbeats(plan),
  };
  return Object.freeze(timeline);
}
