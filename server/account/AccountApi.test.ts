import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountGarageUpgradeRequest,
  AccountLegacyImportRequest,
  AccountLoginRequest,
  AccountProfile,
  AccountRecoveryRequest,
  AccountRegisterRequest,
  AccountRunFinishRequest,
  AccountRunStartRequest,
  LeaderboardScope,
} from '../../src/account/protocol.ts';
import { AccountApi, type AccountAuthGrant, type AccountSessionContext, type AccountStoreLike } from './AccountApi.ts';

const profile: AccountProfile = {
  accountId: 'account-1',
  handle: 'NEON_FOX',
  createdAt: 1_000,
  lastLoginAt: 1_000,
  legacyImported: false,
  garage: { credits: 900, engine: 0, cooling: 0, shield: 0, weapon: 0, bestScore: 0, runs: 0 },
  totalFinishes: 0,
  victories: 0,
  totalScore: 0,
  maxSpeed: 0,
  totalPerfects: 0,
  totalNearMisses: 0,
  totalKills: 0,
  profileVersion: 0,
  globalScore: 0,
  globalRank: null,
  tracks: [],
  achievements: [],
};

const grant: AccountAuthGrant = {
  authenticated: true,
  csrfToken: 'csrf-token-which-is-long-and-random',
  sessionToken: 'session_token_which_is_long_enough_1234567890',
  recoveryCode: 'BE-RECOVERY-CODE-WITH-ENOUGH-ENTROPY',
  profile,
};

function makeStore(): AccountStoreLike & Record<string, ReturnType<typeof vi.fn>> {
  const session: AccountSessionContext = { authenticated: true, accountId: 'account-1', csrfToken: grant.csrfToken, profile };
  return {
    register: vi.fn(async (_request: AccountRegisterRequest) => grant),
    login: vi.fn(async (_request: AccountLoginRequest) => grant),
    recover: vi.fn(async (_request: AccountRecoveryRequest) => grant),
    authenticate: vi.fn(async (token: string) => token === grant.sessionToken ? session : null),
    logout: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => profile),
    upgradeGarage: vi.fn(async (_accountId: string, _request: AccountGarageUpgradeRequest) => ({ profile, newlyUnlocked: [] })),
    importLegacy: vi.fn(async (_accountId: string, _request: AccountLegacyImportRequest) => ({ profile })),
    startRun: vi.fn(async (_accountId: string, _request: AccountRunStartRequest) => ({ runId: 'run-1' })),
    finishRun: vi.fn(async (_accountId: string, _runId: string, _request: AccountRunFinishRequest) => ({ profile })),
    leaderboard: vi.fn(async (scope: LeaderboardScope) => ({ scope, provisional: true, entries: [], ownEntry: null })),
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function makeHarness(now = () => 10_000) {
  const store = makeStore();
  const api = new AccountApi(store, {
    allowedOrigins: new Set(['https://bullet.xedoc.ru']),
    secureCookies: false,
    now,
  });
  const server = createServer((request, response) => {
    void api.handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) response.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return { store, base: `http://127.0.0.1:${address.port}` };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Origin: 'https://bullet.xedoc.ru',
    Cookie: `be_session=${grant.sessionToken}`,
    'X-CSRF-Token': grant.csrfToken,
    'Content-Type': 'application/json',
    ...extra,
  };
}

describe('AccountApi', () => {
  it('returns a guest session without creating browser-readable credentials', async () => {
    const { base } = await makeHarness();
    const response = await fetch(`${base}/api/v1/auth/session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('registers, sets an HttpOnly cookie and never serializes the session token', async () => {
    const { base, store } = await makeHarness();
    const response = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'https://bullet.xedoc.ru', 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'NEON_FOX', password: 'correct horse battery staple' }),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('be_session=session_token_which_is_long_enough_1234567890');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(body).not.toHaveProperty('sessionToken');
    expect(body.recoveryCode).toBe(grant.recoveryCode);
    expect(store.register).toHaveBeenCalledOnce();
  });

  it('requires both the allowed Origin and session CSRF token for mutations', async () => {
    const { base, store } = await makeHarness();
    const missingCsrf = await fetch(`${base}/api/v1/me/garage/upgrade`, {
      method: 'POST',
      headers: {
        Origin: 'https://bullet.xedoc.ru',
        Cookie: `be_session=${grant.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ module: 'engine', profileVersion: 0 }),
    });
    expect(missingCsrf.status).toBe(403);
    expect((await missingCsrf.json() as { error: { code: string } }).error.code).toBe('CSRF_FAILED');

    const foreignOrigin = await fetch(`${base}/api/v1/me/garage/upgrade`, {
      method: 'POST',
      headers: authHeaders({ Origin: 'https://attacker.invalid' }),
      body: JSON.stringify({ module: 'engine', profileVersion: 0 }),
    });
    expect(foreignOrigin.status).toBe(403);
    expect(store.upgradeGarage).not.toHaveBeenCalled();
  });

  it('routes server-issued run tickets and validated idempotent finishes', async () => {
    const { base, store } = await makeHarness();
    const started = await fetch(`${base}/api/v1/runs/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trackId: 'aurora', weapon: 'pulse', ability: 'phase', mode: 'solo',
        musicSource: 'synthetic', musicId: 'edge-signal', requestedSeed: 123, aiOpponents: 3,
      }),
    });
    expect(started.status).toBe(201);
    expect(store.startRun).toHaveBeenCalledWith('account-1', expect.objectContaining({ trackId: 'aurora' }));

    const finished = await fetch(`${base}/api/v1/runs/run-12345678/finish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ result: {
        score: 12_000, credits: 400, maxSpeed: 3_100, accuracy: 0.75,
        perfects: 9, nearMisses: 4, kills: 2, rank: 1, survived: true,
        trackName: 'Aurora Spine', seed: 123,
      } }),
    });
    expect(finished.status).toBe(200);
    expect(store.finishRun).toHaveBeenCalledWith('account-1', 'run-12345678', expect.any(Object));
  });

  it('keeps leaderboards public while including authenticated identity when available', async () => {
    const { base, store } = await makeHarness();
    const publicResponse = await fetch(`${base}/api/v1/leaderboards?scope=forge&limit=999`);
    expect(publicResponse.status).toBe(200);
    expect(store.leaderboard).toHaveBeenLastCalledWith('forge', null, 50);

    const privateResponse = await fetch(`${base}/api/v1/leaderboards?scope=global&limit=10`, {
      headers: { Cookie: `be_session=${grant.sessionToken}` },
    });
    expect(privateResponse.status).toBe(200);
    expect(store.leaderboard).toHaveBeenLastCalledWith('global', 'account-1', 10);
  });

  it('enforces a bounded JSON body and generic 500 responses', async () => {
    const { base, store } = await makeHarness();
    const tooLarge = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://bullet.xedoc.ru', 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'NEON_FOX', password: 'x'.repeat(40_000) }),
    });
    expect(tooLarge.status).toBe(413);

    (store.getProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('sensitive database path'));
    const failed = await fetch(`${base}/api/v1/me/profile`, {
      headers: { Cookie: `be_session=${grant.sessionToken}` },
    });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('sensitive database path');
  });
});
