import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AccountRunFinishRequest,
  AccountRunStartRequest,
  LeaderboardScope,
} from '../../src/account/protocol.ts';
import type { GarageState, RunResult, TrackId } from '../../src/core/types.ts';
import { AccountStore, AccountStoreError } from './AccountStore.ts';

const temporaryDirectories: string[] = [];

function sequence(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}-${String(++count).padStart(8, '0')}`;
}

function createStore(overrides: Partial<ConstructorParameters<typeof AccountStore>[0]> = {}): AccountStore {
  return new AccountStore({
    path: ':memory:',
    now: () => 1_750_000_000_000,
    idFactory: sequence('object'),
    tokenFactory: sequence('secret-token-material-long-enough'),
    seedFactory: () => 0xc0decafe,
    scryptCost: 1_024,
    ...overrides,
  });
}

function startRequest(
  trackId: TrackId = 'aurora',
  overrides: Partial<AccountRunStartRequest> = {},
): AccountRunStartRequest {
  return {
    trackId,
    weapon: 'pulse',
    ability: 'phase',
    mode: 'solo',
    musicSource: 'synthetic',
    musicId: 'edge-signal',
    requestedSeed: 0xa01a,
    aiOpponents: 3,
    ...overrides,
  };
}

function finishRequest(
  seed = 0xa01a,
  overrides: Partial<RunResult> = {},
): AccountRunFinishRequest {
  return {
    result: {
      score: 72_000,
      credits: 999_999_999,
      maxSpeed: 3_450,
      accuracy: 0.82,
      perfects: 12,
      nearMisses: 4,
      kills: 6,
      rank: 1,
      survived: true,
      trackName: 'Untrusted client label',
      seed,
      ...overrides,
    },
  };
}

async function register(store: AccountStore, handle = 'PilotOne') {
  return store.register({ handle, password: 'correct horse battery' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AccountStore auth and persistence', () => {
  it('runs migrations idempotently and keeps profiles through a reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ballistic-account-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'account.sqlite');
    const first = createStore({ path });
    const grant = await register(first);
    first.close();

    const second = createStore({ path, idFactory: sequence('second-object'), tokenFactory: sequence('second-secret-material') });
    const profile = await second.getProfile(grant.profile.accountId);
    expect(profile).toMatchObject({ handle: 'PilotOne', garage: { credits: 900, engine: 0 } });
    const migrations = second.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(migrations.count).toBe(1);
    second.close();
  });

  it('uses case-insensitive handles and stores no plaintext auth secrets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ballistic-auth-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'account.sqlite');
    const store = createStore({ path });
    const grant = await register(store, 'Night_Rider');

    await expect(register(store, 'night_rider')).rejects.toMatchObject({ code: 'HANDLE_TAKEN', status: 409 });
    const login = await store.login({ handle: 'NIGHT_RIDER', password: 'correct horse battery' });
    expect(login.profile.accountId).toBe(grant.profile.accountId);
    const session = await store.authenticate(login.sessionToken);
    expect(session).toMatchObject({ authenticated: true, csrfToken: login.csrfToken });

    const account = store.database.prepare('SELECT password_hash FROM accounts').get() as { password_hash: string };
    const storedSession = store.database.prepare('SELECT token_hash, csrf_hash FROM sessions ORDER BY created_at DESC LIMIT 1')
      .get() as { token_hash: string; csrf_hash: string };
    const recovery = store.database.prepare('SELECT token_hash FROM recovery_credentials').get() as { token_hash: string };
    expect(account.password_hash).toMatch(/^scrypt\$/);
    expect(account.password_hash).not.toContain('correct horse battery');
    expect(storedSession.token_hash).not.toBe(login.sessionToken);
    expect(storedSession.csrf_hash).not.toBe(login.csrfToken);
    expect(recovery.token_hash).not.toContain(grant.recoveryCode!);
    store.close();
    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from('correct horse battery'))).toBe(false);
    expect(bytes.includes(Buffer.from(login.sessionToken))).toBe(false);
    expect(bytes.includes(Buffer.from(login.csrfToken))).toBe(false);
  });

  it('returns generic login failures, expires sessions, and revokes logout', async () => {
    let now = 10_000;
    const store = createStore({ now: () => now });
    const grant = await register(store);
    await expect(store.login({ handle: 'PilotOne', password: 'totally-wrong-password' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    await expect(store.login({ handle: 'MissingPilot', password: 'totally-wrong-password' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });

    await store.logout(grant.sessionToken);
    await expect(store.authenticate(grant.sessionToken)).resolves.toBeNull();
    const fresh = await store.login({ handle: 'PilotOne', password: 'correct horse battery' });
    now += 31 * 24 * 60 * 60 * 1_000;
    await expect(store.authenticate(fresh.sessionToken)).resolves.toBeNull();
    store.close();
  });

  it('consumes and rotates the recovery shard while revoking existing sessions', async () => {
    const store = createStore();
    const grant = await register(store);
    const recovered = await store.recover({
      handle: 'pilotone',
      recoveryCode: grant.recoveryCode!,
      newPassword: 'replacement hyperdrive',
    });
    expect(recovered.recoveryCode).not.toBe(grant.recoveryCode);
    await expect(store.authenticate(grant.sessionToken)).resolves.toBeNull();
    await expect(store.login({ handle: 'PilotOne', password: 'correct horse battery' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(store.login({ handle: 'PilotOne', password: 'replacement hyperdrive' })).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(store.recover({
      handle: 'PilotOne',
      recoveryCode: grant.recoveryCode!,
      newPassword: 'another replacement pass',
    })).rejects.toMatchObject({ code: 'INVALID_RECOVERY' });
    store.close();
  });
});

describe('AccountStore progress, runs, and leaderboards', () => {
  it('makes garage upgrades optimistic and atomic across two tabs', async () => {
    const store = createStore();
    const grant = await register(store);
    const version = grant.profile.profileVersion;
    const outcomes = await Promise.allSettled([
      store.upgradeGarage(grant.profile.accountId, { module: 'engine', profileVersion: version }),
      store.upgradeGarage(grant.profile.accountId, { module: 'engine', profileVersion: version }),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'PROFILE_CONFLICT', status: 409 });
    const profile = await store.getProfile(grant.profile.accountId);
    expect(profile.garage).toMatchObject({ engine: 1, credits: 650 });
    expect(profile.profileVersion).toBe(version + 1);
    store.close();
  });

  it('imports legacy progress only once without ranking or retroactive score achievements', async () => {
    const store = createStore();
    const grant = await register(store);
    const garage: GarageState = {
      credits: 90_000,
      engine: 5,
      cooling: 5,
      shield: 5,
      weapon: 5,
      bestScore: 999_000,
      runs: 120,
    };
    const imported = await store.importLegacy(grant.profile.accountId, { garage });
    expect(imported.profile).toMatchObject({ legacyImported: true, garage });
    expect(imported.profile.globalScore).toBe(0);
    expect(imported.profile.achievements.find((item) => item.id === 'score-breaker')?.unlockedAt).toBeNull();
    await expect(store.importLegacy(grant.profile.accountId, { garage }))
      .rejects.toMatchObject({ code: 'LEGACY_ALREADY_IMPORTED', status: 409 });
    store.close();
  });

  it('finalizes a ticket once, ignores client credits, and returns the stored response on retry', async () => {
    const store = createStore();
    const grant = await register(store);
    const ticket = await store.startRun(grant.profile.accountId, startRequest());
    expect(ticket.seed).toBe(0xc0decafe);
    expect(ticket.seed).not.toBe(startRequest().requestedSeed);
    const request = finishRequest(ticket.seed);
    const first = await store.finishRun(grant.profile.accountId, ticket.runId, request);
    const second = await store.finishRun(grant.profile.accountId, ticket.runId, request);

    expect(first).toEqual(second);
    expect(first.creditsAwarded).toBe(Math.round(72_000 / 42 + 6 * 8));
    expect(first.profile.garage.credits).toBe(900 + first.creditsAwarded);
    expect(first.profile.garage.runs).toBe(1);
    expect(first.ranked).toBe(true);
    expect(first.newlyUnlocked.map((item) => item.id)).toEqual(expect.arrayContaining([
      'first-run', 'first-win', 'velocity-3200', 'route-clear', 'route-win', 'route-master',
    ]));
    await expect(store.finishRun(
      grant.profile.accountId,
      ticket.runId,
      finishRequest(ticket.seed, { score: 72_001 }),
    )).rejects.toMatchObject({ code: 'RUN_RESULT_CONFLICT', status: 409 });
    store.close();
  });

  it('keeps catalog, local, and online runs unranked', async () => {
    const store = createStore();
    const grant = await register(store);
    const variants: Array<Partial<AccountRunStartRequest>> = [
      { musicSource: 'catalog' },
      { musicSource: 'local' },
      { mode: 'online', musicSource: 'synthetic' },
    ];
    for (const variant of variants) {
      const ticket = await store.startRun(grant.profile.accountId, startRequest('reactor', variant));
      expect(ticket.rankedEligible).toBe(false);
      expect(ticket.seed).toBe(0xa01a);
      const response = await store.finishRun(grant.profile.accountId, ticket.runId, finishRequest(ticket.seed));
      expect(response.ranked).toBe(false);
    }
    const board = await store.leaderboard('reactor', grant.profile.accountId, 10);
    expect(board.entries).toEqual([]);
    expect(board.ownEntry).toBeNull();
    store.close();
  });

  it('builds global score from the four synthetic solo PBs and resolves ties deterministically', async () => {
    let now = 5_000;
    const store = createStore({ now: () => now });
    const alpha = await register(store, 'AlphaPilot');
    now += 1;
    const beta = await register(store, 'BetaPilot');

    async function score(accountId: string, track: TrackId, value: number): Promise<void> {
      const ticket = await store.startRun(accountId, startRequest(track, { requestedSeed: 42 }));
      await store.finishRun(accountId, ticket.runId, finishRequest(ticket.seed, { score: value, maxSpeed: 2_000 }));
      now += 1;
    }
    for (const track of ['aurora', 'reactor', 'void', 'forge'] as TrackId[]) await score(alpha.profile.accountId, track, 10_000);
    for (const track of ['aurora', 'reactor', 'void', 'forge'] as TrackId[]) await score(beta.profile.accountId, track, 10_000);

    const global = await store.leaderboard('global', beta.profile.accountId, 1);
    expect(global.entries).toHaveLength(1);
    expect(global.entries[0]).toMatchObject({ handle: 'AlphaPilot', score: 40_000, rank: 1 });
    expect(global.ownEntry).toMatchObject({ handle: 'BetaPilot', score: 40_000, rank: 2, isCurrentPlayer: true });
    const betaProfile = await store.getProfile(beta.profile.accountId);
    expect(betaProfile.globalScore).toBe(40_000);
    expect(betaProfile.globalRank).toBe(2);
    store.close();
  });

  it.each<LeaderboardScope>(['global', 'aurora'])('returns an empty %s board before ranked finishes', async (scope) => {
    const store = createStore();
    const board = await store.listLeaderboard(scope, null, 5);
    expect(board).toEqual({ scope, provisional: true, entries: [], ownEntry: null });
    store.close();
  });

  it('rejects expired tickets and seed substitution', async () => {
    let now = 100;
    const store = createStore({ now: () => now });
    const grant = await register(store);
    const wrongSeedTicket = await store.startRun(grant.profile.accountId, startRequest());
    await expect(store.finishRun(
      grant.profile.accountId,
      wrongSeedTicket.runId,
      finishRequest(wrongSeedTicket.seed + 1),
    )).rejects.toMatchObject({ code: 'RUN_SEED_MISMATCH' });
    const expiredTicket = await store.startRun(grant.profile.accountId, startRequest());
    now += 31 * 60 * 1_000;
    await expect(store.finishRun(
      grant.profile.accountId,
      expiredTicket.runId,
      finishRequest(expiredTicket.seed),
    )).rejects.toMatchObject({ code: 'RUN_EXPIRED' });
    store.close();
  });

  it('exposes structured store errors to the HTTP adapter', () => {
    const error = new AccountStoreError('RATE_LIMITED', 429, 'Slow down.', { retryAfter: 12 });
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: 12 });
  });
});
