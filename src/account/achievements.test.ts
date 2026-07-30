import { describe, expect, it } from 'vitest';
import type { TrackId } from '../core/types';
import {
  achievementKey,
  evaluateAchievements,
  materializeAchievements,
  type AchievementSnapshot,
} from './achievements';

function snapshot(): AchievementSnapshot {
  const tracks = Object.fromEntries((['aurora', 'reactor', 'void', 'forge', 'skyline', 'abyss'] as TrackId[]).map((trackId) => [
    trackId,
    { finishes: 0, wins: 0, bestScore: 0 },
  ])) as AchievementSnapshot['tracks'];
  return {
    runs: 0,
    victories: 0,
    bestScore: 0,
    totalScore: 0,
    maxSpeed: 0,
    totalPerfects: 0,
    totalNearMisses: 0,
    totalKills: 0,
    garage: { credits: 900, engine: 0, cooling: 0, shield: 0, weapon: 0, bestScore: 0, runs: 0 },
    tracks,
  };
}

describe('account achievements', () => {
  it('expands profile and route-scoped achievements deterministically', () => {
    const evaluations = evaluateAchievements(snapshot());

    expect(evaluations).toHaveLength(30);
    expect(evaluations.map((achievement) => achievement.key)).toContain('route-clear:forge');
    expect(new Set(evaluations.map((achievement) => achievement.key)).size).toBe(evaluations.length);
  });

  it('tracks route mastery independently for every course', () => {
    const state = snapshot();
    state.tracks.aurora = { finishes: 1, wins: 1, bestScore: 61_000 };
    state.tracks.forge = { finishes: 1, wins: 0, bestScore: 80_000 };
    const evaluations = evaluateAchievements(state);

    expect(evaluations.find((item) => item.key === achievementKey('route-master', 'aurora'))?.met).toBe(true);
    expect(evaluations.find((item) => item.key === achievementKey('route-master', 'forge'))?.met).toBe(false);
    expect(evaluations.find((item) => item.key === achievementKey('all-routes', null))?.progress).toBe(2);
  });

  it('keeps progress visible while unlocking only server-recorded keys', () => {
    const state = snapshot();
    state.runs = 12;
    const unlocked = new Map<string, number>([['first-run', 1234]]);
    const achievements = materializeAchievements(state, unlocked);

    expect(achievements.find((item) => item.id === 'first-run')?.unlockedAt).toBe(1234);
    expect(achievements.find((item) => item.id === 'veteran-10')).toMatchObject({ progress: 12, unlockedAt: null });
  });
});
