import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ACCOUNT_LIMITS,
  type AccountAchievement,
  type AccountGarageUpgradeRequest,
  type AccountGarageUpgradeResponse,
  type AccountLegacyImportRequest,
  type AccountLoginRequest,
  type AccountProfile,
  type AccountRecoveryRequest,
  type AccountRegisterRequest,
  type AccountRunFinishRequest,
  type AccountRunFinishResponse,
  type AccountRunStartRequest,
  type AccountRunTicket,
  type GarageModuleId,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardScope,
} from '../../src/account/protocol.ts';
import { evaluateAchievements, materializeAchievements, type AchievementSnapshot } from '../../src/account/achievements.ts';
import {
  ABILITIES,
  TRACKS,
  WEAPONS,
  type GarageState,
  type RunResult,
  type TrackId,
} from '../../src/core/types.ts';
import { PasswordHasher, type PasswordCost } from './PasswordHasher.ts';
import { runAccountMigrations } from './migrations.ts';

const TRACK_IDS = Object.freeze(Object.keys(TRACKS) as TrackId[]);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RUN_TTL_MS = 30 * 60 * 1_000;
const MAX_SESSIONS_PER_ACCOUNT = 8;
const DEFAULT_GARAGE: GarageState = {
  credits: 900,
  engine: 0,
  cooling: 0,
  shield: 0,
  weapon: 0,
  bestScore: 0,
  runs: 0,
};

export interface AccountStoreOptions {
  path: string;
  now?: () => number;
  idFactory?: () => string;
  tokenFactory?: () => string;
  seedFactory?: () => number;
  passwordPepper?: string;
  scryptCost?: number | Partial<PasswordCost>;
}

export interface AccountAuthGrant {
  authenticated: true;
  sessionToken: string;
  csrfToken: string;
  profile: AccountProfile;
  recoveryCode?: string;
}

export interface AccountSessionContext {
  authenticated: true;
  accountId: string;
  csrfToken: string;
  profile: AccountProfile;
}

export class AccountStoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  readonly profile?: AccountProfile;

  constructor(
    code: string,
    status: number,
    message: string,
    options: { retryAfter?: number; profile?: AccountProfile } = {},
  ) {
    super(message);
    this.name = 'AccountStoreError';
    this.code = code;
    this.status = status;
    this.retryAfter = options.retryAfter;
    this.profile = options.profile;
  }
}

interface AccountRow {
  id: string;
  handle: string;
  password_hash: string;
  created_at: number;
  last_login_at: number;
  disabled_at: number | null;
  legacy_imported_at: number | null;
}

interface ProgressRow {
  credits: number;
  engine: number;
  cooling: number;
  shield: number;
  weapon: number;
  total_runs: number;
  total_finishes: number;
  victories: number;
  total_score: number;
  best_score: number;
  max_speed: number;
  total_perfects: number;
  total_near_misses: number;
  total_kills: number;
  profile_version: number;
}

interface TrackProgressRow {
  track_id: TrackId;
  runs: number;
  finishes: number;
  wins: number;
  best_score: number;
  max_speed: number;
  best_accuracy: number;
  perfects: number;
  near_misses: number;
  kills: number;
}

interface RunRow {
  id: string;
  account_id: string;
  track_id: TrackId;
  seed: number;
  expires_at: number;
  status: 'started' | 'accepted' | 'rejected' | 'expired';
  ranked_eligible: number;
  result_hash: string | null;
  response_json: string | null;
}

interface SessionGrant {
  sessionToken: string;
  csrfToken: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeHandle(handle: string): { display: string; key: string } {
  const display = handle.normalize('NFC').trim();
  if (display.length < ACCOUNT_LIMITS.handleMin || display.length > ACCOUNT_LIMITS.handleMax) {
    throw new AccountStoreError('INVALID_HANDLE', 422, `Handle must be ${ACCOUNT_LIMITS.handleMin}-${ACCOUNT_LIMITS.handleMax} characters.`);
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(display)) {
    throw new AccountStoreError('INVALID_HANDLE', 422, 'Handle may contain letters, numbers, underscores, and hyphens.');
  }
  return { display, key: display.toLocaleLowerCase('en-US') };
}

function validatePassword(password: string): string {
  const normalized = password.normalize('NFC');
  if (normalized.length < ACCOUNT_LIMITS.passwordMin || normalized.length > ACCOUNT_LIMITS.passwordMax) {
    throw new AccountStoreError(
      'INVALID_PASSWORD',
      422,
      `Password must be ${ACCOUNT_LIMITS.passwordMin}-${ACCOUNT_LIMITS.passwordMax} characters.`,
    );
  }
  if (Buffer.byteLength(normalized, 'utf8') > 256) {
    throw new AccountStoreError('INVALID_PASSWORD', 422, 'Password is too large after UTF-8 encoding.');
  }
  return normalized;
}

function assertSafeInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AccountStoreError('INVALID_REQUEST', 422, `${name} is outside the accepted range.`);
  }
  return value;
}

function validateGarage(value: GarageState): GarageState {
  return {
    credits: assertSafeInteger(value.credits, 0, 1_000_000_000, 'credits'),
    engine: assertSafeInteger(value.engine, 0, 5, 'engine'),
    cooling: assertSafeInteger(value.cooling, 0, 5, 'cooling'),
    shield: assertSafeInteger(value.shield, 0, 5, 'shield'),
    weapon: assertSafeInteger(value.weapon, 0, 5, 'weapon'),
    bestScore: assertSafeInteger(value.bestScore, 0, 1_000_000_000, 'bestScore'),
    runs: assertSafeInteger(value.runs, 0, 1_000_000_000, 'runs'),
  };
}

function validateRunResult(result: RunResult, expectedSeed: number): RunResult {
  if (result.seed !== expectedSeed) throw new AccountStoreError('RUN_SEED_MISMATCH', 409, 'Run seed does not match its ticket.');
  if (typeof result.survived !== 'boolean') {
    throw new AccountStoreError('INVALID_REQUEST', 422, 'survived must be a boolean.');
  }
  if (typeof result.trackName !== 'string' || result.trackName.length < 1 || result.trackName.length > 96) {
    throw new AccountStoreError('INVALID_REQUEST', 422, 'trackName is outside the accepted range.');
  }
  const validated: RunResult = {
    score: assertSafeInteger(result.score, 0, 1_000_000_000, 'score'),
    credits: assertSafeInteger(result.credits, 0, 1_000_000_000, 'credits'),
    maxSpeed: result.maxSpeed,
    accuracy: result.accuracy,
    perfects: assertSafeInteger(result.perfects, 0, 1_000_000, 'perfects'),
    nearMisses: assertSafeInteger(result.nearMisses, 0, 1_000_000, 'nearMisses'),
    kills: assertSafeInteger(result.kills, 0, 1_000_000, 'kills'),
    rank: assertSafeInteger(result.rank, 1, 32, 'rank'),
    survived: result.survived,
    trackName: result.trackName,
    seed: result.seed,
  };
  if (!Number.isFinite(validated.maxSpeed) || validated.maxSpeed < 0 || validated.maxSpeed > 20_000) {
    throw new AccountStoreError('INVALID_REQUEST', 422, 'maxSpeed is outside the accepted range.');
  }
  if (!Number.isFinite(validated.accuracy) || validated.accuracy < 0 || validated.accuracy > 1) {
    throw new AccountStoreError('INVALID_REQUEST', 422, 'accuracy is outside the accepted range.');
  }
  return validated;
}

function resultHash(result: RunResult): string {
  return sha256(JSON.stringify([
    result.score,
    result.maxSpeed,
    result.accuracy,
    result.perfects,
    result.nearMisses,
    result.kills,
    result.rank,
    result.survived,
    result.seed,
  ]));
}

function recoveryKey(code: string): string {
  return code.normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function displayRecoveryCode(token: string): string {
  const compact = createHash('sha256').update(`recovery-display\0${token}`, 'utf8')
    .digest('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 32);
  return compact.match(/.{1,4}/g)?.join('-') ?? compact;
}

function boardKey(scope: LeaderboardScope): string {
  return scope === 'global' ? 'global' : `track:${scope}`;
}

export class AccountStore {
  readonly database: DatabaseSync;

  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly seedFactory: () => number;
  private readonly passwordHasher: PasswordHasher;
  private readonly csrfSecret: Buffer;
  private closed = false;

  constructor(options: AccountStoreOptions) {
    if (!options.path) throw new TypeError('AccountStore path is required');
    if (options.path !== ':memory:' && !options.path.startsWith('file:')) {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o750 });
    }
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.seedFactory = options.seedFactory ?? (() => randomBytes(4).readUInt32BE(0));
    const pepper = options.passwordPepper
      ?? process.env.ACCOUNT_PASSWORD_PEPPER
      ?? process.env.BALLISTIC_EDGE_PASSWORD_PEPPER
      ?? process.env.PASSWORD_PEPPER
      ?? '';
    this.passwordHasher = new PasswordHasher({ pepper, cost: options.scryptCost, concurrency: 2 });
    this.csrfSecret = createHash('sha256').update(`ballistic-edge-csrf\0${pepper}`).digest();
    this.database = new DatabaseSync(options.path);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec('PRAGMA journal_mode = WAL');
    runAccountMigrations(this.database, this.now());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async register(request: AccountRegisterRequest): Promise<AccountAuthGrant> {
    this.assertOpen();
    const handle = normalizeHandle(request.handle);
    const password = validatePassword(request.password);
    const duplicate = this.database.prepare('SELECT 1 FROM accounts WHERE handle_key = ?').get(handle.key);
    if (duplicate) throw new AccountStoreError('HANDLE_TAKEN', 409, 'This pilot handle is already registered.');
    const passwordHash = await this.passwordHasher.hash(password);
    const accountId = this.idFactory();
    const timestamp = this.now();
    const legacy = request.legacyGarage ? validateGarage(request.legacyGarage) : null;
    const recoveryCode = displayRecoveryCode(this.tokenFactory());

    return this.transaction(() => {
      try {
        this.database.prepare(`
          INSERT INTO accounts(
            id, handle, handle_key, password_hash, created_at, updated_at, last_login_at, legacy_imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          accountId,
          handle.display,
          handle.key,
          passwordHash,
          timestamp,
          timestamp,
          timestamp,
          legacy ? timestamp : null,
        );
      } catch (error) {
        if (String(error).includes('UNIQUE')) {
          throw new AccountStoreError('HANDLE_TAKEN', 409, 'This pilot handle is already registered.');
        }
        throw error;
      }
      const garage = legacy ?? DEFAULT_GARAGE;
      this.database.prepare(`
        INSERT INTO player_progress(
          account_id, credits, engine, cooling, shield, weapon,
          total_runs, best_score, profile_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        accountId,
        garage.credits,
        garage.engine,
        garage.cooling,
        garage.shield,
        garage.weapon,
        garage.runs,
        garage.bestScore,
        timestamp,
      );
      this.ensureTrackRows(accountId);
      this.database.prepare(`
        INSERT INTO recovery_credentials(token_hash, account_id, created_at) VALUES (?, ?, ?)
      `).run(sha256(recoveryKey(recoveryCode)), accountId, timestamp);
      const session = this.createSession(accountId, timestamp);
      return {
        authenticated: true as const,
        ...session,
        profile: this.readProfile(accountId),
        recoveryCode,
      };
    });
  }

  async login(request: AccountLoginRequest): Promise<AccountAuthGrant> {
    this.assertOpen();
    const handle = normalizeHandle(request.handle);
    const password = validatePassword(request.password);
    const account = this.database.prepare(`
      SELECT id, handle, password_hash, created_at, last_login_at, disabled_at, legacy_imported_at
      FROM accounts WHERE handle_key = ?
    `).get(handle.key) as unknown as AccountRow | undefined;
    if (!account) {
      await this.passwordHasher.verifyDummy(password);
      throw new AccountStoreError('INVALID_CREDENTIALS', 401, 'Handle or password is incorrect.');
    }
    const valid = await this.passwordHasher.verify(password, account.password_hash);
    if (!valid || account.disabled_at !== null) {
      throw new AccountStoreError('INVALID_CREDENTIALS', 401, 'Handle or password is incorrect.');
    }
    const timestamp = this.now();
    return this.transaction(() => {
      this.database.prepare('UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, account.id);
      const session = this.createSession(account.id, timestamp);
      return { authenticated: true as const, ...session, profile: this.readProfile(account.id) };
    });
  }

  async recover(request: AccountRecoveryRequest): Promise<AccountAuthGrant> {
    this.assertOpen();
    const handle = normalizeHandle(request.handle);
    const newPassword = validatePassword(request.newPassword);
    const passwordHash = await this.passwordHasher.hash(newPassword);
    const account = this.database.prepare(`
      SELECT id, handle, password_hash, created_at, last_login_at, disabled_at, legacy_imported_at
      FROM accounts WHERE handle_key = ?
    `).get(handle.key) as unknown as AccountRow | undefined;
    const suppliedHash = sha256(recoveryKey(request.recoveryCode));
    const credential = account
      ? this.database.prepare(`
          SELECT token_hash FROM recovery_credentials
          WHERE account_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1
        `).get(account.id) as { token_hash: string } | undefined
      : undefined;
    if (!account || account.disabled_at !== null || !credential || !constantTimeHashEqual(credential.token_hash, suppliedHash)) {
      throw new AccountStoreError('INVALID_RECOVERY', 401, 'Recovery credentials are invalid.');
    }
    const timestamp = this.now();
    const recoveryCode = displayRecoveryCode(this.tokenFactory());
    return this.transaction(() => {
      const consumed = this.database.prepare(`
        UPDATE recovery_credentials SET used_at = ?
        WHERE token_hash = ? AND account_id = ? AND used_at IS NULL
      `).run(timestamp, suppliedHash, account.id);
      if (Number(consumed.changes) !== 1) {
        throw new AccountStoreError('INVALID_RECOVERY', 401, 'Recovery credentials are invalid.');
      }
      this.database.prepare('UPDATE accounts SET password_hash = ?, updated_at = ?, last_login_at = ? WHERE id = ?')
        .run(passwordHash, timestamp, timestamp, account.id);
      this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
        .run(timestamp, account.id);
      this.database.prepare(`
        INSERT INTO recovery_credentials(token_hash, account_id, created_at) VALUES (?, ?, ?)
      `).run(sha256(recoveryKey(recoveryCode)), account.id, timestamp);
      const session = this.createSession(account.id, timestamp);
      return {
        authenticated: true as const,
        ...session,
        profile: this.readProfile(account.id),
        recoveryCode,
      };
    });
  }

  async authenticate(sessionToken: string): Promise<AccountSessionContext | null> {
    this.assertOpen();
    if (!sessionToken || sessionToken.length > 256) return null;
    const timestamp = this.now();
    const tokenHash = sha256(sessionToken);
    const row = this.database.prepare(`
      SELECT s.account_id, s.csrf_hash, s.expires_at, s.last_seen_at, a.disabled_at
      FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(tokenHash) as {
      account_id: string;
      csrf_hash: string;
      expires_at: number;
      last_seen_at: number;
      disabled_at: number | null;
    } | undefined;
    if (!row || row.disabled_at !== null) return null;
    if (row.expires_at <= timestamp) {
      this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .run(timestamp, tokenHash);
      return null;
    }
    const csrfToken = this.csrfForSession(sessionToken);
    if (!constantTimeHashEqual(row.csrf_hash, sha256(csrfToken))) return null;
    if (timestamp - row.last_seen_at >= 60_000) {
      this.database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(timestamp, tokenHash);
    }
    return {
      authenticated: true,
      accountId: row.account_id,
      csrfToken,
      profile: this.readProfile(row.account_id),
    };
  }

  async getSession(sessionToken: string): Promise<AccountSessionContext | null> {
    return this.authenticate(sessionToken);
  }

  async logout(sessionToken: string): Promise<void> {
    this.assertOpen();
    if (!sessionToken || sessionToken.length > 256) return;
    this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.now(), sha256(sessionToken));
  }

  async getProfile(accountId: string): Promise<AccountProfile> {
    this.assertOpen();
    return this.readProfile(accountId);
  }

  async upgradeGarage(
    accountId: string,
    request: AccountGarageUpgradeRequest,
  ): Promise<AccountGarageUpgradeResponse> {
    this.assertOpen();
    const modules: readonly GarageModuleId[] = ['engine', 'cooling', 'shield', 'weapon'];
    if (!modules.includes(request.module)) throw new AccountStoreError('INVALID_MODULE', 422, 'Garage module is invalid.');
    assertSafeInteger(request.profileVersion, 1, Number.MAX_SAFE_INTEGER, 'profileVersion');
    return this.transaction(() => {
      const current = this.readProfile(accountId);
      if (current.profileVersion !== request.profileVersion) {
        throw new AccountStoreError('PROFILE_CONFLICT', 409, 'Profile changed in another session.', { profile: current });
      }
      const level = current.garage[request.module];
      if (level >= 5) throw new AccountStoreError('MODULE_MAXED', 409, 'Garage module is already at maximum level.');
      const cost = 250 + level * 300;
      if (current.garage.credits < cost) throw new AccountStoreError('INSUFFICIENT_CREDITS', 409, 'Not enough credits.');
      const timestamp = this.now();
      const update = this.database.prepare(`
        UPDATE player_progress
        SET ${request.module} = ${request.module} + 1,
            credits = credits - ?, profile_version = profile_version + 1, updated_at = ?
        WHERE account_id = ? AND profile_version = ? AND ${request.module} < 5 AND credits >= ?
      `).run(cost, timestamp, accountId, request.profileVersion, cost);
      if (Number(update.changes) !== 1) {
        throw new AccountStoreError('PROFILE_CONFLICT', 409, 'Profile changed in another session.', {
          profile: this.readProfile(accountId),
        });
      }
      const unlockedKeys = this.syncAchievements(accountId, null, timestamp);
      const profile = this.readProfile(accountId);
      return { profile, newlyUnlocked: profile.achievements.filter((item) => unlockedKeys.has(item.key)) };
    });
  }

  async importLegacy(accountId: string, request: AccountLegacyImportRequest): Promise<{ profile: AccountProfile }> {
    this.assertOpen();
    const garage = validateGarage(request.garage);
    return this.transaction(() => {
      const account = this.requireAccount(accountId);
      if (account.legacy_imported_at !== null) {
        throw new AccountStoreError('LEGACY_ALREADY_IMPORTED', 409, 'Legacy progress was already imported.');
      }
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE player_progress
        SET credits = MAX(credits, ?), engine = MAX(engine, ?), cooling = MAX(cooling, ?),
            shield = MAX(shield, ?), weapon = MAX(weapon, ?),
            total_runs = MAX(total_runs, ?), best_score = MAX(best_score, ?),
            profile_version = profile_version + 1, updated_at = ?
        WHERE account_id = ?
      `).run(
        garage.credits,
        garage.engine,
        garage.cooling,
        garage.shield,
        garage.weapon,
        garage.runs,
        garage.bestScore,
        timestamp,
        accountId,
      );
      this.database.prepare('UPDATE accounts SET legacy_imported_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, accountId);
      // Imported scores intentionally do not enter track boards or unlock score achievements.
      return { profile: this.readProfile(accountId) };
    });
  }

  async startRun(accountId: string, request: AccountRunStartRequest): Promise<AccountRunTicket> {
    this.assertOpen();
    this.requireAccount(accountId);
    if (!TRACK_IDS.includes(request.trackId)) throw new AccountStoreError('INVALID_TRACK', 422, 'Track is invalid.');
    if (!Object.hasOwn(WEAPONS, request.weapon)) throw new AccountStoreError('INVALID_WEAPON', 422, 'Weapon is invalid.');
    if (!Object.hasOwn(ABILITIES, request.ability)) throw new AccountStoreError('INVALID_ABILITY', 422, 'Ability is invalid.');
    if (request.mode !== 'solo' && request.mode !== 'online') throw new AccountStoreError('INVALID_MODE', 422, 'Run mode is invalid.');
    if (!['synthetic', 'catalog', 'local'].includes(request.musicSource)) {
      throw new AccountStoreError('INVALID_MUSIC_SOURCE', 422, 'Music source is invalid.');
    }
    if (!request.musicId.trim() || request.musicId.length > 128) {
      throw new AccountStoreError('INVALID_MUSIC', 422, 'Music identifier is invalid.');
    }
    assertSafeInteger(request.requestedSeed, 0, 0xffff_ffff, 'requestedSeed');
    assertSafeInteger(request.aiOpponents, 0, 7, 'aiOpponents');
    const timestamp = this.now();
    const expiresAt = timestamp + RUN_TTL_MS;
    const runId = this.idFactory();
    const garage = this.readProfile(accountId).garage;
    // Only deterministic synthetic solo runs can enter provisional rankings.
    const rankedEligible = request.mode === 'solo' && request.musicSource === 'synthetic';
    const seed = rankedEligible
      ? assertSafeInteger(this.seedFactory(), 0, 0xffff_ffff, 'serverSeed')
      : request.requestedSeed;
    this.transaction(() => {
      this.database.prepare(`
        UPDATE runs SET status = 'expired'
        WHERE account_id = ? AND status = 'started' AND expires_at <= ?
      `).run(accountId, timestamp);
      this.database.prepare(`
        INSERT INTO runs(
          id, account_id, mode, track_id, music_source, music_id, seed,
          weapon, ability, ai_opponents, garage_json, started_at, expires_at, status, ranked_eligible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
      `).run(
        runId,
        accountId,
        request.mode,
        request.trackId,
        request.musicSource,
        request.musicId,
        seed,
        request.weapon,
        request.ability,
        request.aiOpponents,
        JSON.stringify(garage),
        timestamp,
        expiresAt,
        rankedEligible ? 1 : 0,
      );
    });
    return {
      runId,
      trackId: request.trackId,
      seed,
      rankedEligible,
      expiresAt,
      garage,
    };
  }

  async finishRun(
    accountId: string,
    runId: string,
    request: AccountRunFinishRequest,
  ): Promise<AccountRunFinishResponse> {
    this.assertOpen();
    const initial = this.readRun(accountId, runId);
    if (!initial) throw new AccountStoreError('RUN_NOT_FOUND', 404, 'Run ticket was not found.');
    const result = validateRunResult(request.result, initial.seed);
    const hash = resultHash(result);
    if (initial.status === 'accepted') return this.readIdempotentRunResponse(initial, hash);
    if (initial.status !== 'started') throw new AccountStoreError('RUN_CLOSED', 409, 'Run ticket is no longer active.');
    const timestamp = this.now();
    if (initial.expires_at <= timestamp) {
      this.database.prepare("UPDATE runs SET status = 'expired' WHERE id = ? AND status = 'started'").run(runId);
      throw new AccountStoreError('RUN_EXPIRED', 409, 'Run ticket has expired.');
    }

    return this.transaction(() => {
      const run = this.readRun(accountId, runId);
      if (!run) throw new AccountStoreError('RUN_NOT_FOUND', 404, 'Run ticket was not found.');
      if (run.status === 'accepted') return this.readIdempotentRunResponse(run, hash);
      if (run.status !== 'started') throw new AccountStoreError('RUN_CLOSED', 409, 'Run ticket is no longer active.');

      const ranked = run.ranked_eligible === 1 && result.survived;
      const victory = result.survived && result.rank === 1;
      const creditsAwarded = Math.min(50_000, Math.max(90, Math.round(result.score / 42 + result.kills * 8)));
      this.database.prepare(`
        UPDATE player_progress
        SET credits = credits + ?, total_runs = total_runs + 1,
            total_finishes = total_finishes + ?, victories = victories + ?,
            total_score = total_score + ?, best_score = MAX(best_score, ?), max_speed = MAX(max_speed, ?),
            total_perfects = total_perfects + ?, total_near_misses = total_near_misses + ?,
            total_kills = total_kills + ?, profile_version = profile_version + 1, updated_at = ?
        WHERE account_id = ?
      `).run(
        creditsAwarded,
        result.survived ? 1 : 0,
        victory ? 1 : 0,
        result.score,
        result.score,
        result.maxSpeed,
        result.perfects,
        result.nearMisses,
        result.kills,
        timestamp,
        accountId,
      );
      this.database.prepare(`
        INSERT INTO track_progress(
          account_id, track_id, runs, finishes, wins, best_score, max_speed,
          best_accuracy, perfects, near_misses, kills
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, track_id) DO UPDATE SET
          runs = runs + 1,
          finishes = finishes + excluded.finishes,
          wins = wins + excluded.wins,
          best_score = MAX(best_score, excluded.best_score),
          max_speed = MAX(max_speed, excluded.max_speed),
          best_accuracy = MAX(best_accuracy, excluded.best_accuracy),
          perfects = perfects + excluded.perfects,
          near_misses = near_misses + excluded.near_misses,
          kills = kills + excluded.kills
      `).run(
        accountId,
        run.track_id,
        result.survived ? 1 : 0,
        victory ? 1 : 0,
        result.score,
        result.maxSpeed,
        result.accuracy,
        result.perfects,
        result.nearMisses,
        result.kills,
      );
      this.database.prepare(`
        UPDATE runs SET finished_at = ?, status = 'accepted', ranked = ?, result_hash = ?, result_json = ?
        WHERE id = ? AND status = 'started'
      `).run(timestamp, ranked ? 1 : 0, hash, JSON.stringify(result), runId);

      if (ranked) this.updateLeaderboards(accountId, runId, run.track_id, result.score, timestamp);
      const unlockedKeys = this.syncAchievements(accountId, runId, timestamp);
      const profile = this.readProfile(accountId);
      const track = profile.tracks.find((item) => item.trackId === run.track_id);
      const response: AccountRunFinishResponse = {
        profile,
        newlyUnlocked: profile.achievements.filter((item) => unlockedKeys.has(item.key)),
        creditsAwarded,
        ranked,
        trackRank: ranked ? (track?.rank ?? null) : null,
        globalRank: ranked ? profile.globalRank : null,
      };
      this.database.prepare('UPDATE runs SET response_json = ? WHERE id = ?').run(JSON.stringify(response), runId);
      return response;
    });
  }

  async leaderboard(
    scope: LeaderboardScope,
    currentAccountId: string | null,
    limit = 25,
  ): Promise<LeaderboardResponse> {
    this.assertOpen();
    if (scope !== 'global' && !TRACK_IDS.includes(scope)) {
      throw new AccountStoreError('INVALID_SCOPE', 422, 'Leaderboard scope is invalid.');
    }
    const safeLimit = Math.min(ACCOUNT_LIMITS.leaderboardMax, assertSafeInteger(limit, 1, ACCOUNT_LIMITS.leaderboardMax, 'limit'));
    const key = boardKey(scope);
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT lb.account_id, lb.score, lb.achieved_at,
               ROW_NUMBER() OVER (ORDER BY lb.score DESC, lb.achieved_at ASC, lb.account_id ASC) AS rank
        FROM leaderboard_best lb WHERE lb.board_key = ?
      )
      SELECT ranked.rank, ranked.account_id, a.handle, ranked.score, p.total_runs, p.victories,
             p.max_speed, ranked.achieved_at
      FROM ranked
      JOIN accounts a ON a.id = ranked.account_id
      JOIN player_progress p ON p.account_id = ranked.account_id
      ORDER BY ranked.rank ASC LIMIT ?
    `).all(key, safeLimit) as unknown as Array<{
      rank: number;
      account_id: string;
      handle: string;
      score: number;
      total_runs: number;
      victories: number;
      max_speed: number;
      achieved_at: number;
    }>;
    const entries = rows.map((row) => this.toLeaderboardEntry(row, currentAccountId));
    let ownEntry = entries.find((entry) => entry.isCurrentPlayer) ?? null;
    if (!ownEntry && currentAccountId) ownEntry = this.readLeaderboardEntry(key, currentAccountId);
    return { scope, provisional: true, entries, ownEntry };
  }

  async listLeaderboard(
    scope: LeaderboardScope,
    currentAccountId: string | null,
    limit = 25,
  ): Promise<LeaderboardResponse> {
    return this.leaderboard(scope, currentAccountId, limit);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AccountStore is closed');
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireAccount(accountId: string): AccountRow {
    const row = this.database.prepare(`
      SELECT id, handle, password_hash, created_at, last_login_at, disabled_at, legacy_imported_at
      FROM accounts WHERE id = ?
    `).get(accountId) as unknown as AccountRow | undefined;
    if (!row || row.disabled_at !== null) throw new AccountStoreError('ACCOUNT_NOT_FOUND', 404, 'Account was not found.');
    return row;
  }

  private readProgress(accountId: string): ProgressRow {
    const row = this.database.prepare(`
      SELECT credits, engine, cooling, shield, weapon, total_runs, total_finishes, victories,
             total_score, best_score, max_speed, total_perfects, total_near_misses,
             total_kills, profile_version
      FROM player_progress WHERE account_id = ?
    `).get(accountId) as unknown as ProgressRow | undefined;
    if (!row) throw new AccountStoreError('ACCOUNT_NOT_FOUND', 404, 'Account progress was not found.');
    return row;
  }

  private ensureTrackRows(accountId: string): void {
    const insert = this.database.prepare('INSERT OR IGNORE INTO track_progress(account_id, track_id) VALUES (?, ?)');
    for (const trackId of TRACK_IDS) insert.run(accountId, trackId);
  }

  private readTrackRows(accountId: string): TrackProgressRow[] {
    this.ensureTrackRows(accountId);
    return this.database.prepare(`
      SELECT track_id, runs, finishes, wins, best_score, max_speed, best_accuracy,
             perfects, near_misses, kills
      FROM track_progress WHERE account_id = ? ORDER BY track_id
    `).all(accountId) as unknown as TrackProgressRow[];
  }

  private readProfile(accountId: string): AccountProfile {
    const account = this.requireAccount(accountId);
    const progress = this.readProgress(accountId);
    const trackRows = this.readTrackRows(accountId);
    const snapshot = this.achievementSnapshot(progress, trackRows);
    const unlockedRows = this.database.prepare(`
      SELECT achievement_key, unlocked_at FROM achievement_progress
      WHERE account_id = ? AND unlocked_at IS NOT NULL
    `).all(accountId) as unknown as Array<{ achievement_key: string; unlocked_at: number }>;
    const unlocked = new Map(unlockedRows.map((row) => [row.achievement_key, row.unlocked_at]));
    const global = this.database.prepare(`
      SELECT score, achieved_at FROM leaderboard_best WHERE board_key = 'global' AND account_id = ?
    `).get(accountId) as { score: number; achieved_at: number } | undefined;

    const tracks = TRACK_IDS.map((trackId) => {
      const row = trackRows.find((item) => item.track_id === trackId)!;
      const ranked = this.database.prepare(`
        SELECT score, achieved_at FROM leaderboard_best WHERE board_key = ? AND account_id = ?
      `).get(boardKey(trackId), accountId) as { score: number; achieved_at: number } | undefined;
      return {
        trackId,
        runs: row.runs,
        finishes: row.finishes,
        wins: row.wins,
        bestScore: row.best_score,
        bestRankedScore: ranked?.score ?? 0,
        maxSpeed: row.max_speed,
        bestAccuracy: row.best_accuracy,
        perfects: row.perfects,
        nearMisses: row.near_misses,
        kills: row.kills,
        rank: ranked ? this.readBoardRank(boardKey(trackId), accountId, ranked.score, ranked.achieved_at) : null,
      };
    });
    return {
      accountId,
      handle: account.handle,
      createdAt: account.created_at,
      lastLoginAt: account.last_login_at,
      legacyImported: account.legacy_imported_at !== null,
      garage: {
        credits: progress.credits,
        engine: progress.engine,
        cooling: progress.cooling,
        shield: progress.shield,
        weapon: progress.weapon,
        bestScore: progress.best_score,
        runs: progress.total_runs,
      },
      totalFinishes: progress.total_finishes,
      victories: progress.victories,
      totalScore: progress.total_score,
      maxSpeed: progress.max_speed,
      totalPerfects: progress.total_perfects,
      totalNearMisses: progress.total_near_misses,
      totalKills: progress.total_kills,
      profileVersion: progress.profile_version,
      globalScore: global?.score ?? 0,
      globalRank: global ? this.readBoardRank('global', accountId, global.score, global.achieved_at) : null,
      tracks,
      achievements: materializeAchievements(snapshot, unlocked),
    };
  }

  private achievementSnapshot(progress: ProgressRow, trackRows: TrackProgressRow[]): AchievementSnapshot {
    const tracks = Object.fromEntries(TRACK_IDS.map((trackId) => {
      const row = trackRows.find((item) => item.track_id === trackId)!;
      return [trackId, { finishes: row.finishes, wins: row.wins, bestScore: row.best_score }];
    })) as AchievementSnapshot['tracks'];
    return {
      runs: progress.total_runs,
      victories: progress.victories,
      // Imported local PBs live only on player_progress; route stats contain server-observed runs.
      bestScore: Math.max(...trackRows.map((track) => track.best_score), 0),
      totalScore: progress.total_score,
      maxSpeed: progress.max_speed,
      totalPerfects: progress.total_perfects,
      totalNearMisses: progress.total_near_misses,
      totalKills: progress.total_kills,
      garage: {
        credits: progress.credits,
        engine: progress.engine,
        cooling: progress.cooling,
        shield: progress.shield,
        weapon: progress.weapon,
        bestScore: progress.best_score,
        runs: progress.total_runs,
      },
      tracks,
    };
  }

  private syncAchievements(accountId: string, runId: string | null, timestamp: number): Set<string> {
    const progress = this.readProgress(accountId);
    const evaluations = evaluateAchievements(this.achievementSnapshot(progress, this.readTrackRows(accountId)));
    const current = new Map((this.database.prepare(`
      SELECT achievement_key, unlocked_at FROM achievement_progress WHERE account_id = ?
    `).all(accountId) as unknown as Array<{ achievement_key: string; unlocked_at: number | null }>).map((row) => [
      row.achievement_key,
      row.unlocked_at,
    ]));
    const upsert = this.database.prepare(`
      INSERT INTO achievement_progress(
        account_id, achievement_key, current_value, target_value, unlocked_at, run_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, achievement_key) DO UPDATE SET
        current_value = excluded.current_value,
        target_value = excluded.target_value,
        unlocked_at = COALESCE(achievement_progress.unlocked_at, excluded.unlocked_at),
        run_id = CASE
          WHEN achievement_progress.unlocked_at IS NULL AND excluded.unlocked_at IS NOT NULL THEN excluded.run_id
          ELSE achievement_progress.run_id
        END
    `);
    const newlyUnlocked = new Set<string>();
    for (const evaluation of evaluations) {
      const unlockAt = evaluation.met ? (current.get(evaluation.key) ?? timestamp) : null;
      if (evaluation.met && (current.get(evaluation.key) ?? null) === null) newlyUnlocked.add(evaluation.key);
      upsert.run(accountId, evaluation.key, evaluation.progress, evaluation.target, unlockAt, unlockAt ? runId : null);
    }
    return newlyUnlocked;
  }

  private csrfForSession(sessionToken: string): string {
    return createHmac('sha256', this.csrfSecret).update(`csrf\0${sessionToken}`, 'utf8').digest('base64url');
  }

  private createSession(accountId: string, timestamp: number): SessionGrant {
    const sessionToken = this.tokenFactory();
    const csrfToken = this.csrfForSession(sessionToken);
    const tokenHash = sha256(sessionToken);
    this.database.prepare(`
      INSERT INTO sessions(token_hash, account_id, csrf_hash, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenHash, accountId, sha256(csrfToken), timestamp, timestamp, timestamp + SESSION_TTL_MS);
    this.database.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE token_hash IN (
        SELECT token_hash FROM sessions
        WHERE account_id = ? AND token_hash <> ? AND revoked_at IS NULL
        ORDER BY created_at DESC, token_hash DESC
        LIMIT -1 OFFSET ?
      )
    `).run(timestamp, accountId, tokenHash, MAX_SESSIONS_PER_ACCOUNT - 1);
    this.database.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?')
      .run(timestamp - SESSION_TTL_MS, timestamp - SESSION_TTL_MS);
    return { sessionToken, csrfToken };
  }

  private readRun(accountId: string, runId: string): RunRow | undefined {
    return this.database.prepare(`
      SELECT id, account_id, track_id, seed, expires_at, status, ranked_eligible, result_hash, response_json
      FROM runs WHERE id = ? AND account_id = ?
    `).get(runId, accountId) as unknown as RunRow | undefined;
  }

  private readIdempotentRunResponse(run: RunRow, hash: string): AccountRunFinishResponse {
    if (run.result_hash !== hash || !run.response_json) {
      throw new AccountStoreError('RUN_RESULT_CONFLICT', 409, 'Run was already finalized with a different result.');
    }
    return JSON.parse(run.response_json) as AccountRunFinishResponse;
  }

  private updateLeaderboards(
    accountId: string,
    runId: string,
    trackId: TrackId,
    score: number,
    timestamp: number,
  ): void {
    this.database.prepare(`
      INSERT INTO leaderboard_best(board_key, account_id, run_id, score, achieved_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(board_key, account_id) DO UPDATE SET
        run_id = excluded.run_id, score = excluded.score, achieved_at = excluded.achieved_at
      WHERE excluded.score > leaderboard_best.score
    `).run(boardKey(trackId), accountId, runId, score, timestamp);
    const globalScore = (this.database.prepare(`
      SELECT COALESCE(SUM(score), 0) AS score FROM leaderboard_best
      WHERE account_id = ? AND board_key LIKE 'track:%'
    `).get(accountId) as { score: number }).score;
    this.database.prepare(`
      INSERT INTO leaderboard_best(board_key, account_id, run_id, score, achieved_at)
      VALUES ('global', ?, ?, ?, ?)
      ON CONFLICT(board_key, account_id) DO UPDATE SET
        run_id = excluded.run_id, score = excluded.score, achieved_at = excluded.achieved_at
      WHERE excluded.score > leaderboard_best.score
    `).run(accountId, runId, globalScore, timestamp);
  }

  private readBoardRank(key: string, accountId: string, score: number, achievedAt: number): number {
    const row = this.database.prepare(`
      SELECT 1 + COUNT(*) AS rank FROM leaderboard_best
      WHERE board_key = ? AND (
        score > ? OR
        (score = ? AND achieved_at < ?) OR
        (score = ? AND achieved_at = ? AND account_id < ?)
      )
    `).get(key, score, score, achievedAt, score, achievedAt, accountId) as { rank: number };
    return row.rank;
  }

  private toLeaderboardEntry(
    row: {
      rank: number;
      account_id: string;
      handle: string;
      score: number;
      total_runs: number;
      victories: number;
      max_speed: number;
      achieved_at: number;
    },
    currentAccountId: string | null,
  ): LeaderboardEntry {
    return {
      rank: row.rank,
      accountId: row.account_id,
      handle: row.handle,
      score: row.score,
      runs: row.total_runs,
      victories: row.victories,
      maxSpeed: row.max_speed,
      achievedAt: row.achieved_at,
      isCurrentPlayer: row.account_id === currentAccountId,
    };
  }

  private readLeaderboardEntry(key: string, accountId: string): LeaderboardEntry | null {
    const row = this.database.prepare(`
      WITH ranked AS (
        SELECT lb.account_id, lb.score, lb.achieved_at,
               ROW_NUMBER() OVER (ORDER BY lb.score DESC, lb.achieved_at ASC, lb.account_id ASC) AS rank
        FROM leaderboard_best lb WHERE lb.board_key = ?
      )
      SELECT ranked.rank, ranked.account_id, a.handle, ranked.score, p.total_runs, p.victories,
             p.max_speed, ranked.achieved_at
      FROM ranked
      JOIN accounts a ON a.id = ranked.account_id
      JOIN player_progress p ON p.account_id = ranked.account_id
      WHERE ranked.account_id = ?
    `).get(key, accountId) as unknown as {
      rank: number;
      account_id: string;
      handle: string;
      score: number;
      total_runs: number;
      victories: number;
      max_speed: number;
      achieved_at: number;
    } | undefined;
    return row ? this.toLeaderboardEntry(row, accountId) : null;
  }
}
