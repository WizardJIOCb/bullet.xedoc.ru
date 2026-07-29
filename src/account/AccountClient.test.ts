import { describe, expect, it, vi } from 'vitest';
import type { AccountProfile } from './protocol';
import { AccountClient, type AccountStorage } from './AccountClient';

function profile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    accountId: 'pilot-1',
    handle: 'NEONPILOT',
    createdAt: 1,
    lastLoginAt: 2,
    legacyImported: false,
    garage: { credits: 900, engine: 0, cooling: 0, shield: 0, weapon: 0, bestScore: 0, runs: 0 },
    totalFinishes: 0,
    victories: 0,
    totalScore: 0,
    maxSpeed: 0,
    totalPerfects: 0,
    totalNearMisses: 0,
    totalKills: 0,
    profileVersion: 1,
    globalScore: 0,
    globalRank: null,
    tracks: [],
    achievements: [],
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function memoryStorage(): AccountStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe('AccountClient', () => {
  it('bootstraps an HttpOnly-cookie session without persisting its CSRF token', async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      authenticated: true,
      csrfToken: 'csrf-one',
      profile: profile(),
    }));
    const client = new AccountClient({ fetch: fetcher, storage });

    await client.bootstrap();

    expect(client.getSnapshot()).toMatchObject({ status: 'authenticated', profile: { handle: 'NEONPILOT' } });
    expect(fetcher).toHaveBeenCalledWith('/api/v1/auth/session', expect.objectContaining({ credentials: 'same-origin' }));
    expect(storage.getItem('csrf-one')).toBeNull();
  });

  it('adds CSRF to authenticated mutations and reconciles the returned profile', async () => {
    const upgraded = profile({ profileVersion: 2, garage: { credits: 650, engine: 1, cooling: 0, shield: 0, weapon: 0, bestScore: 0, runs: 0 } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'csrf-two', profile: profile() }))
      .mockResolvedValueOnce(json({ profile: upgraded, newlyUnlocked: [] }));
    const client = new AccountClient({ fetch: fetcher, storage: null });
    await client.bootstrap();

    await client.upgradeGarage('engine');

    const [, request] = fetcher.mock.calls[1];
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf-two');
    expect(client.getSnapshot().profile?.garage.engine).toBe(1);
  });

  it('queues an interrupted finish and retries it after the next session bootstrap', async () => {
    const storage = memoryStorage();
    const result = {
      score: 1234,
      credits: 80,
      maxSpeed: 2600,
      accuracy: 0.5,
      perfects: 3,
      nearMisses: 2,
      kills: 1,
      rank: 2,
      survived: true,
      trackName: 'Aurora Spine',
      seed: 42,
    };
    const firstFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'csrf-a', profile: profile() }))
      .mockRejectedValueOnce(new TypeError('offline'));
    const first = new AccountClient({ fetch: firstFetch, storage });
    await first.bootstrap();
    await expect(first.finishRun('run-42', result)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    const completed = profile({ totalScore: 1234, profileVersion: 2 });
    const secondFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'csrf-b', profile: profile() }))
      .mockResolvedValueOnce(json({ profile: completed, newlyUnlocked: [], creditsAwarded: 80, ranked: true, trackRank: 1, globalRank: 1 }));
    const second = new AccountClient({ fetch: secondFetch, storage });
    await second.bootstrap();
    await vi.waitFor(() => expect(second.getSnapshot().profile?.totalScore).toBe(1234));
    expect(secondFetch.mock.calls[1]?.[0]).toBe('/api/v1/runs/run-42/finish');
  });

  it('surfaces structured service errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ authenticated: false }))
      .mockResolvedValueOnce(json({ error: { code: 'HANDLE_TAKEN', message: 'Handle unavailable.' } }, 409));
    const client = new AccountClient({ fetch: fetcher, storage: null });
    await client.bootstrap();

    await expect(client.register({ handle: 'pilot', password: 'long-enough-password' }))
      .rejects.toMatchObject({ status: 409, code: 'HANDLE_TAKEN' });
  });

  it('does not resurrect a stale profile when a finish returns after logout', async () => {
    let resolveFinish!: (response: Response) => void;
    const finishResponse = new Promise<Response>((resolve) => { resolveFinish = resolve; });
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) {
        return Promise.resolve(json({ authenticated: true, csrfToken: 'csrf-stale', profile: profile() }));
      }
      if (url.includes('/runs/run-stale/finish')) return finishResponse;
      if (url.endsWith('/auth/logout')) return Promise.resolve(json(undefined, 204));
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new AccountClient({ fetch: fetcher, storage: memoryStorage() });
    await client.bootstrap();
    const finishing = client.finishRun('run-stale', {
      score: 100,
      credits: 10,
      maxSpeed: 2000,
      accuracy: 0.5,
      perfects: 1,
      nearMisses: 1,
      kills: 0,
      rank: 2,
      survived: true,
      trackName: 'Aurora Spine',
      seed: 7,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await client.logout();
    resolveFinish(json({
      profile: profile({ profileVersion: 2, totalScore: 100 }),
      newlyUnlocked: [],
      creditsAwarded: 90,
      ranked: true,
      trackRank: 1,
      globalRank: 1,
    }));
    await finishing;

    expect(client.getSnapshot()).toMatchObject({ status: 'guest', profile: null });
  });

  it('still submits a finish when browser storage is blocked', async () => {
    const blockedStorage: AccountStorage = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'csrf-blocked', profile: profile() }))
      .mockResolvedValueOnce(json({
        profile: profile({ profileVersion: 2, totalScore: 50 }),
        newlyUnlocked: [],
        creditsAwarded: 90,
        ranked: false,
        trackRank: null,
        globalRank: null,
      }));
    const client = new AccountClient({ fetch: fetcher, storage: blockedStorage });
    await client.bootstrap();

    await expect(client.finishRun('run-blocked', {
      score: 50,
      credits: 1,
      maxSpeed: 1800,
      accuracy: 0.25,
      perfects: 0,
      nearMisses: 0,
      kills: 0,
      rank: 4,
      survived: false,
      trackName: 'Solar Rupture',
      seed: 9,
    })).resolves.toMatchObject({ creditsAwarded: 90 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
