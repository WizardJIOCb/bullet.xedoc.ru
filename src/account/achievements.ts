import { TRACKS, type GarageState, type TrackId } from '../core/types';
import type {
  AccountAchievement,
  AccountAchievementId,
  AchievementTone,
} from './protocol';

export interface AchievementTrackSnapshot {
  finishes: number;
  wins: number;
  bestScore: number;
}

export interface AchievementSnapshot {
  runs: number;
  victories: number;
  bestScore: number;
  totalScore: number;
  maxSpeed: number;
  totalPerfects: number;
  totalNearMisses: number;
  totalKills: number;
  garage: GarageState;
  tracks: Record<TrackId, AchievementTrackSnapshot>;
}

export interface AchievementEvaluation extends Omit<AccountAchievement, 'unlockedAt'> {
  met: boolean;
}

interface ProfileAchievementDefinition {
  id: Exclude<AccountAchievementId, 'route-clear' | 'route-win' | 'route-master'>;
  target: number;
  tone: AchievementTone;
  icon: string;
  progress: (snapshot: AchievementSnapshot) => number;
}

const PROFILE_ACHIEVEMENTS: readonly ProfileAchievementDefinition[] = [
  { id: 'first-run', target: 1, tone: 'cyan', icon: '01', progress: (state) => state.runs },
  { id: 'first-win', target: 1, tone: 'gold', icon: 'W', progress: (state) => state.victories },
  { id: 'veteran-10', target: 10, tone: 'violet', icon: '10', progress: (state) => state.runs },
  { id: 'legend-50', target: 50, tone: 'gold', icon: '50', progress: (state) => state.runs },
  { id: 'score-breaker', target: 100_000, tone: 'red', icon: 'S', progress: (state) => state.bestScore },
  { id: 'career-million', target: 1_000_000, tone: 'gold', icon: 'M', progress: (state) => state.totalScore },
  { id: 'velocity-3200', target: 3_200, tone: 'cyan', icon: 'V', progress: (state) => state.maxSpeed },
  { id: 'perfect-100', target: 100, tone: 'violet', icon: 'P', progress: (state) => state.totalPerfects },
  { id: 'hunter-50', target: 50, tone: 'red', icon: 'X', progress: (state) => state.totalKills },
  { id: 'near-miss-50', target: 50, tone: 'cyan', icon: 'N', progress: (state) => state.totalNearMisses },
  {
    id: 'garage-max',
    target: 20,
    tone: 'gold',
    icon: 'G',
    progress: (state) => state.garage.engine + state.garage.cooling + state.garage.shield + state.garage.weapon,
  },
  {
    id: 'all-routes',
    target: 6,
    tone: 'violet',
    icon: '6',
    progress: (state) => Object.values(state.tracks).filter((track) => track.finishes > 0).length,
  },
] as const;

const TRACK_MASTER_SCORES: Record<TrackId, number> = {
  aurora: 60_000,
  reactor: 70_000,
  void: 75_000,
  forge: 85_000,
  skyline: 78_000,
  abyss: 82_000,
};

export function achievementKey(id: AccountAchievementId, trackId: TrackId | null): string {
  return trackId ? `${id}:${trackId}` : id;
}

export function evaluateAchievements(snapshot: AchievementSnapshot): AchievementEvaluation[] {
  const evaluations: AchievementEvaluation[] = PROFILE_ACHIEVEMENTS.map((definition) => {
    const progress = Math.max(0, definition.progress(snapshot));
    return {
      key: achievementKey(definition.id, null),
      id: definition.id,
      trackId: null,
      progress,
      target: definition.target,
      tone: definition.tone,
      icon: definition.icon,
      met: progress >= definition.target,
    };
  });

  for (const trackId of Object.keys(TRACKS) as TrackId[]) {
    const track = snapshot.tracks[trackId];
    const definitions: Array<{
      id: 'route-clear' | 'route-win' | 'route-master';
      target: number;
      progress: number;
      tone: AchievementTone;
      icon: string;
    }> = [
      { id: 'route-clear', target: 1, progress: track.finishes, tone: 'cyan', icon: 'C' },
      { id: 'route-win', target: 1, progress: track.wins, tone: 'gold', icon: '1' },
      {
        id: 'route-master',
        target: TRACK_MASTER_SCORES[trackId],
        progress: track.bestScore,
        tone: trackId === 'forge' ? 'red' : 'violet',
        icon: 'M',
      },
    ];
    for (const definition of definitions) {
      evaluations.push({
        key: achievementKey(definition.id, trackId),
        id: definition.id,
        trackId,
        progress: Math.max(0, definition.progress),
        target: definition.target,
        tone: definition.tone,
        icon: definition.icon,
        met: definition.progress >= definition.target,
      });
    }
  }

  return evaluations;
}

export function materializeAchievements(
  snapshot: AchievementSnapshot,
  unlockedAt: ReadonlyMap<string, number>,
): AccountAchievement[] {
  return evaluateAchievements(snapshot).map(({ met: _met, ...achievement }) => ({
    ...achievement,
    unlockedAt: unlockedAt.get(achievement.key) ?? null,
  }));
}
