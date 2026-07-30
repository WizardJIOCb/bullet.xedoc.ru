import type {
  AbilityId,
  GarageState,
  RunResult,
  TrackId,
  WeaponId,
} from '../core/types';

export const ACCOUNT_API_VERSION = 1 as const;
export const ACCOUNT_API_PREFIX = `/api/v${ACCOUNT_API_VERSION}`;

export const ACCOUNT_LIMITS = {
  handleMin: 3,
  handleMax: 20,
  passwordMin: 10,
  passwordMax: 128,
  leaderboardMax: 50,
  requestBytes: 32_768,
} as const;

export type GarageModuleId = 'engine' | 'cooling' | 'shield' | 'weapon';
export type AccountRunMode = 'solo' | 'online';
export type AccountMusicSource = 'synthetic' | 'catalog' | 'local';

export type AccountAchievementId =
  | 'first-run'
  | 'first-win'
  | 'veteran-10'
  | 'legend-50'
  | 'score-breaker'
  | 'career-million'
  | 'velocity-3200'
  | 'perfect-100'
  | 'hunter-50'
  | 'near-miss-50'
  | 'garage-max'
  | 'all-routes'
  | 'route-clear'
  | 'route-win'
  | 'route-master';

export type AchievementTone = 'cyan' | 'gold' | 'red' | 'violet';

export interface AccountAchievement {
  key: string;
  id: AccountAchievementId;
  trackId: TrackId | null;
  progress: number;
  target: number;
  unlockedAt: number | null;
  tone: AchievementTone;
  icon: string;
}

export interface AccountTrackProgress {
  trackId: TrackId;
  runs: number;
  finishes: number;
  wins: number;
  bestScore: number;
  bestRankedScore: number;
  maxSpeed: number;
  bestAccuracy: number;
  perfects: number;
  nearMisses: number;
  kills: number;
  rank: number | null;
}

export interface AccountProfile {
  accountId: string;
  handle: string;
  createdAt: number;
  lastLoginAt: number;
  legacyImported: boolean;
  garage: GarageState;
  totalFinishes: number;
  victories: number;
  totalScore: number;
  maxSpeed: number;
  totalPerfects: number;
  totalNearMisses: number;
  totalKills: number;
  profileVersion: number;
  globalScore: number;
  globalRank: number | null;
  tracks: AccountTrackProgress[];
  achievements: AccountAchievement[];
}

export interface AuthenticatedAccountSession {
  authenticated: true;
  csrfToken: string;
  profile: AccountProfile;
}

export interface GuestAccountSession {
  authenticated: false;
}

export type AccountSessionResponse = AuthenticatedAccountSession | GuestAccountSession;

export interface AccountRegisterRequest {
  handle: string;
  password: string;
  legacyGarage?: GarageState;
}

export interface AccountRegisterResponse extends AuthenticatedAccountSession {
  recoveryCode: string;
}

export interface AccountLoginRequest {
  handle: string;
  password: string;
}

export interface AccountRecoveryRequest {
  handle: string;
  recoveryCode: string;
  newPassword: string;
}

export interface AccountRecoveryResponse extends AuthenticatedAccountSession {
  recoveryCode: string;
}

export interface AccountRunStartRequest {
  trackId: TrackId;
  weapon: WeaponId;
  ability: AbilityId;
  mode: AccountRunMode;
  musicSource: AccountMusicSource;
  musicId: string;
  requestedSeed: number;
  aiOpponents: number;
}

export interface AccountRunTicket {
  runId: string;
  trackId: TrackId;
  seed: number;
  rankedEligible: boolean;
  expiresAt: number;
  garage: GarageState;
}

export interface AccountRunFinishRequest {
  result: RunResult;
}

export interface AccountRunFinishResponse {
  profile: AccountProfile;
  newlyUnlocked: AccountAchievement[];
  creditsAwarded: number;
  ranked: boolean;
  trackRank: number | null;
  globalRank: number | null;
}

export interface AccountGarageUpgradeRequest {
  module: GarageModuleId;
  profileVersion: number;
}

export interface AccountGarageUpgradeResponse {
  profile: AccountProfile;
  newlyUnlocked: AccountAchievement[];
}

export interface AccountLegacyImportRequest {
  garage: GarageState;
}

export type LeaderboardScope = 'global' | TrackId;

export interface LeaderboardEntry {
  rank: number;
  accountId: string;
  handle: string;
  score: number;
  runs: number;
  victories: number;
  maxSpeed: number;
  achievedAt: number;
  isCurrentPlayer: boolean;
}

export interface LeaderboardResponse {
  scope: LeaderboardScope;
  provisional: true;
  entries: LeaderboardEntry[];
  ownEntry: LeaderboardEntry | null;
}

export interface AccountApiErrorPayload {
  error: {
    code: string;
    message: string;
    retryAfter?: number;
    profile?: AccountProfile;
  };
}

export interface AccountRunContext {
  ticket: AccountRunTicket;
  startedAt: number;
}
