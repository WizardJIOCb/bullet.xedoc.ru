import { clamp } from '../core/math';
import type {
  ObstaclePerformance,
  RaceStanding,
  RaceStandingStatus,
  TrackEventKind,
} from '../core/types';

const MAJOR_OBSTACLE_KINDS = new Set<TrackEventKind>([
  'gate',
  'aperture',
  'halfwall',
  'blade',
  'cross',
  'bastion',
]);

const STATUS_ORDER: Readonly<Record<RaceStandingStatus, number>> = {
  finished: 0,
  racing: 1,
  destroyed: 2,
  dnf: 3,
};

export function isMajorObstacle(kind: TrackEventKind): boolean {
  return MAJOR_OBSTACLE_KINDS.has(kind);
}

export function createObstaclePerformance(
  total: number,
  encountered: number,
  collisions: number,
): ObstaclePerformance {
  const safeTotal = Math.max(0, Math.trunc(Number.isFinite(total) ? total : 0));
  const safeEncountered = clamp(
    Math.trunc(Number.isFinite(encountered) ? encountered : 0),
    0,
    safeTotal,
  );
  const safeCollisions = clamp(
    Math.trunc(Number.isFinite(collisions) ? collisions : 0),
    0,
    safeEncountered,
  );
  const cleared = safeEncountered - safeCollisions;
  return {
    total: safeTotal,
    encountered: safeEncountered,
    cleared,
    collisions: safeCollisions,
    clearance: safeEncountered > 0 ? cleared / safeEncountered : 0,
  };
}

export interface CourseQualityInput {
  survived: boolean;
  progress: number;
  obstaclePerformance: ObstaclePerformance;
  perfects: number;
  nearMisses: number;
}

export function calculateCourseQuality(input: Readonly<CourseQualityInput>): number {
  const progress = clamp(Number.isFinite(input.progress) ? input.progress : 0, 0, 1);
  const clearance = clamp(input.obstaclePerformance.clearance, 0, 1);
  const encountered = Math.max(1, input.obstaclePerformance.encountered);
  const rhythm = clamp(
    (Math.max(0, input.perfects) + Math.max(0, input.nearMisses) * 0.45) / (encountered * 0.55),
    0,
    1,
  );
  return clamp(
    progress * 0.32
      + clearance * 0.48
      + rhythm * 0.12
      + (input.survived ? 0.08 : 0),
    0,
    1,
  );
}

export type CourseGrade = 'S' | 'A' | 'B' | 'C' | 'D';

export function courseGradeFromQuality(quality: number): CourseGrade {
  const safeQuality = clamp(Number.isFinite(quality) ? quality : 0, 0, 1);
  if (safeQuality >= 0.94) return 'S';
  if (safeQuality >= 0.82) return 'A';
  if (safeQuality >= 0.68) return 'B';
  if (safeQuality >= 0.46) return 'C';
  return 'D';
}

function compareStanding(left: Readonly<RaceStanding>, right: Readonly<RaceStanding>): number {
  const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (statusDifference !== 0) return statusDifference;
  if (left.status === 'finished' && right.status === 'finished') {
    const leftTime = left.elapsedTime ?? Number.POSITIVE_INFINITY;
    const rightTime = right.elapsedTime ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
  }
  if (left.progress !== right.progress) return right.progress - left.progress;
  if ((left.score ?? -1) !== (right.score ?? -1)) return (right.score ?? -1) - (left.score ?? -1);
  return left.id.localeCompare(right.id);
}

/**
 * Sorts opponent telemetry and then anchors the local craft at the authoritative
 * HUD position. This keeps the final table consistent with online terminal
 * timestamps and the placement bonus already awarded by the simulation.
 */
export function orderRaceStandings(
  entries: readonly RaceStanding[],
  playerRank: number,
): RaceStanding[] {
  const sanitized = entries.map((entry) => ({
    ...entry,
    progress: clamp(Number.isFinite(entry.progress) ? entry.progress : 0, 0, 1),
    elapsedTime: entry.elapsedTime !== null && Number.isFinite(entry.elapsedTime)
      ? Math.max(0, entry.elapsedTime)
      : null,
  }));
  const player = sanitized.find((entry) => entry.kind === 'player');
  const opponents = sanitized.filter((entry) => entry !== player).sort(compareStanding);
  if (player) {
    opponents.splice(clamp(Math.trunc(playerRank) - 1, 0, opponents.length), 0, player);
  }
  return opponents.map((entry, index) => ({ ...entry, place: index + 1 }));
}
