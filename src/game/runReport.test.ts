import { describe, expect, it } from 'vitest';
import type { RaceStanding } from '../core/types';
import {
  calculateCourseQuality,
  courseGradeFromQuality,
  createObstaclePerformance,
  orderRaceStandings,
} from './runReport';

function standing(overrides: Partial<RaceStanding>): RaceStanding {
  return {
    id: 'rival',
    name: 'RIVAL',
    kind: 'ai',
    status: 'racing',
    place: 0,
    progress: 0.5,
    elapsedTime: null,
    score: null,
    obstaclePerformance: null,
    ...overrides,
  };
}

describe('run report telemetry', () => {
  it('builds a bounded obstacle report from noisy counters', () => {
    expect(createObstaclePerformance(12, 9, 2)).toEqual({
      total: 12,
      encountered: 9,
      cleared: 7,
      collisions: 2,
      clearance: 7 / 9,
    });
    expect(createObstaclePerformance(4, 99, 99)).toEqual({
      total: 4,
      encountered: 4,
      cleared: 0,
      collisions: 4,
      clearance: 0,
    });
  });

  it('turns completion, clearance and rhythm into stable course grades', () => {
    const obstaclePerformance = createObstaclePerformance(40, 40, 0);
    const quality = calculateCourseQuality({
      survived: true,
      progress: 1,
      obstaclePerformance,
      perfects: 24,
      nearMisses: 4,
    });
    expect(courseGradeFromQuality(quality)).toBe('S');
    expect(courseGradeFromQuality(0.83)).toBe('A');
    expect(courseGradeFromQuality(0.5)).toBe('C');
    expect(courseGradeFromQuality(Number.NaN)).toBe('D');
  });

  it('sorts opponents while preserving the authoritative local rank', () => {
    const result = orderRaceStandings([
      standing({ id: 'player', name: 'YOU', kind: 'player', status: 'finished', progress: 1, elapsedTime: 70, score: 9000 }),
      standing({ id: 'fast', status: 'finished', progress: 1, elapsedTime: 65 }),
      standing({ id: 'slow', status: 'finished', progress: 1, elapsedTime: 80 }),
      standing({ id: 'wreck', status: 'destroyed', progress: 0.8 }),
    ], 2);

    expect(result.map((entry) => [entry.place, entry.id])).toEqual([
      [1, 'fast'],
      [2, 'player'],
      [3, 'slow'],
      [4, 'wreck'],
    ]);
  });

  it('keeps active racers ahead of terminal wrecks and disconnected pilots', () => {
    const result = orderRaceStandings([
      standing({ id: 'player', kind: 'player', status: 'destroyed', progress: 0.7 }),
      standing({ id: 'active', status: 'racing', progress: 0.8 }),
      standing({ id: 'wreck', status: 'destroyed', progress: 0.75, elapsedTime: 32 }),
      standing({ id: 'drop', status: 'dnf', progress: 0.9 }),
    ], 2);

    expect(result.map((entry) => [entry.place, entry.id, entry.status])).toEqual([
      [1, 'active', 'racing'],
      [2, 'player', 'destroyed'],
      [3, 'wreck', 'destroyed'],
      [4, 'drop', 'dnf'],
    ]);
  });
});
