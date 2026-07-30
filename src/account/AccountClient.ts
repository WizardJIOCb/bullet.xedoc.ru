import type { GarageState, RunResult } from '../core/types';
import {
  ACCOUNT_API_PREFIX,
  type AccountApiErrorPayload,
  type AccountGarageUpgradeResponse,
  type AccountLegacyImportRequest,
  type AccountProfile,
  type AccountRecoveryRequest,
  type AccountRecoveryResponse,
  type AccountRegisterRequest,
  type AccountRegisterResponse,
  type AccountRunFinishRequest,
  type AccountRunFinishResponse,
  type AccountRunStartRequest,
  type AccountRunTicket,
  type AccountSessionResponse,
  type GarageModuleId,
  type LeaderboardResponse,
  type LeaderboardScope,
} from './protocol';

export type AccountClientStatus = 'loading' | 'guest' | 'authenticated' | 'error';

export interface AccountClientSnapshot {
  status: AccountClientStatus;
  profile: AccountProfile | null;
  error: AccountApiError | null;
}

export interface AccountStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AccountClientOptions {
  apiBase?: string;
  fetch?: typeof fetch;
  storage?: AccountStorage | null;
  now?: () => number;
}

interface PendingFinish {
  accountId: string;
  runId: string;
  request: AccountRunFinishRequest;
  queuedAt: number;
}

interface SessionGuard {
  generation: number;
  accountId: string;
}

type SnapshotListener = (snapshot: AccountClientSnapshot) => void;

const PENDING_FINISH_KEY = 'ballistic-edge-account-finishes-v1';
const MAX_PENDING_FINISHES = 8;

export class AccountApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | null;
  readonly profile: AccountProfile | null;

  constructor(
    message: string,
    options: { status?: number; code?: string; retryAfter?: number; profile?: AccountProfile } = {},
  ) {
    super(message);
    this.name = 'AccountApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'NETWORK_ERROR';
    this.retryAfter = options.retryAfter ?? null;
    this.profile = options.profile ?? null;
  }
}

/**
 * Same-origin account API controller. Session tokens stay in the HttpOnly
 * cookie; only the short-lived CSRF value is retained in memory.
 */
export class AccountClient {
  private readonly apiBase: string;
  private readonly fetcher: typeof fetch;
  private readonly storage: AccountStorage | null;
  private readonly now: () => number;
  private readonly listeners = new Set<SnapshotListener>();
  private csrfToken: string | null = null;
  private sessionGeneration = 0;
  private snapshot: AccountClientSnapshot = { status: 'loading', profile: null, error: null };

  constructor(options: AccountClientOptions = {}) {
    this.apiBase = (options.apiBase ?? ACCOUNT_API_PREFIX).replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage = options.storage === undefined
      ? (typeof localStorage === 'undefined' ? null : localStorage)
      : options.storage;
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): AccountClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async bootstrap(signal?: AbortSignal): Promise<AccountClientSnapshot> {
    const generation = ++this.sessionGeneration;
    this.setSnapshot({ ...this.snapshot, status: 'loading', error: null });
    try {
      const session = await this.request<AccountSessionResponse>('/auth/session', { signal }, false);
      if (generation !== this.sessionGeneration) return this.snapshot;
      this.applySession(session);
      if (session.authenticated) void this.retryPendingFinishes();
    } catch (error) {
      if (generation !== this.sessionGeneration) return this.snapshot;
      const apiError = toAccountApiError(error);
      this.csrfToken = null;
      this.setSnapshot({ status: 'error', profile: null, error: apiError });
    }
    return this.snapshot;
  }

  async register(request: AccountRegisterRequest, signal?: AbortSignal): Promise<AccountRegisterResponse> {
    const generation = ++this.sessionGeneration;
    const response = await this.request<AccountRegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    }, false);
    this.assertAuthFlowCurrent(generation);
    this.applySession(response);
    return response;
  }

  async login(handle: string, password: string, signal?: AbortSignal): Promise<AccountProfile> {
    const generation = ++this.sessionGeneration;
    const response = await this.request<AccountSessionResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ handle, password }),
      signal,
    }, false);
    this.assertAuthFlowCurrent(generation);
    if (!response.authenticated) throw new AccountApiError('Authentication failed.', { code: 'AUTH_FAILED' });
    this.applySession(response);
    void this.retryPendingFinishes();
    return response.profile;
  }

  async recover(request: AccountRecoveryRequest, signal?: AbortSignal): Promise<AccountRecoveryResponse> {
    const generation = ++this.sessionGeneration;
    const response = await this.request<AccountRecoveryResponse>('/auth/recover', {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
    }, false);
    this.assertAuthFlowCurrent(generation);
    this.applySession(response);
    void this.retryPendingFinishes();
    return response;
  }

  async logout(signal?: AbortSignal): Promise<void> {
    const generation = ++this.sessionGeneration;
    if (this.csrfToken) {
      await this.request<void>('/auth/logout', { method: 'POST', signal });
    }
    if (generation !== this.sessionGeneration) return;
    this.csrfToken = null;
    this.setSnapshot({ status: 'guest', profile: null, error: null });
  }

  async refreshProfile(signal?: AbortSignal): Promise<AccountProfile> {
    const guard = this.captureSession();
    try {
      const response = await this.request<AccountProfile | { profile: AccountProfile }>('/me/profile', { signal });
      const profile = 'profile' in response ? response.profile : response;
      this.setAuthenticatedProfile(profile, guard);
      return profile;
    } catch (error) {
      throw this.handleGuardedError(error, guard);
    }
  }

  async importLegacy(garage: GarageState, signal?: AbortSignal): Promise<AccountProfile> {
    const guard = this.captureSession();
    const request: AccountLegacyImportRequest = { garage };
    try {
      const response = await this.request<AccountProfile | { profile: AccountProfile }>('/me/import-legacy', {
        method: 'POST',
        body: JSON.stringify(request),
        signal,
      });
      const profile = 'profile' in response ? response.profile : response;
      this.setAuthenticatedProfile(profile, guard);
      return profile;
    } catch (error) {
      throw this.handleGuardedError(error, guard);
    }
  }

  async upgradeGarage(
    module: GarageModuleId,
    profileVersion = this.requireProfile().profileVersion,
    signal?: AbortSignal,
  ): Promise<AccountGarageUpgradeResponse> {
    const guard = this.captureSession();
    try {
      const response = await this.request<AccountGarageUpgradeResponse>('/me/garage/upgrade', {
        method: 'POST',
        body: JSON.stringify({ module, profileVersion }),
        signal,
      });
      this.setAuthenticatedProfile(response.profile, guard);
      return response;
    } catch (error) {
      throw this.handleGuardedError(error, guard);
    }
  }

  async startRun(request: AccountRunStartRequest, signal?: AbortSignal): Promise<AccountRunTicket> {
    const guard = this.captureSession();
    try {
      return await this.request<AccountRunTicket>('/runs/start', {
        method: 'POST',
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw this.handleGuardedError(error, guard);
    }
  }

  async finishRun(
    runId: string,
    result: RunResult,
    signal?: AbortSignal,
  ): Promise<AccountRunFinishResponse> {
    const profile = this.requireProfile();
    const guard = this.captureSession();
    const pending: PendingFinish = {
      accountId: profile.accountId,
      runId,
      request: { result },
      queuedAt: this.now(),
    };
    this.queuePendingFinish(pending);
    try {
      const response = await this.submitFinish(pending, signal);
      this.removePendingFinish(pending.accountId, pending.runId);
      this.setAuthenticatedProfile(response.profile, guard);
      return response;
    } catch (error) {
      const apiError = toAccountApiError(error);
      this.handleGuardedError(apiError, guard);
      if (apiError.status >= 400 && apiError.status < 500 && apiError.status !== 401 && apiError.status !== 429) {
        this.removePendingFinish(pending.accountId, pending.runId);
      }
      throw apiError;
    }
  }

  async retryPendingFinishes(signal?: AbortSignal): Promise<AccountRunFinishResponse[]> {
    const profile = this.snapshot.profile;
    if (!profile || !this.csrfToken) return [];
    const guard = this.captureSession();
    const responses: AccountRunFinishResponse[] = [];
    for (const pending of this.readPendingFinishes().filter((item) => item.accountId === profile.accountId)) {
      if (!this.isSessionCurrent(guard)) break;
      try {
        const response = await this.submitFinish(pending, signal);
        this.removePendingFinish(pending.accountId, pending.runId);
        this.setAuthenticatedProfile(response.profile, guard);
        responses.push(response);
      } catch (error) {
        const apiError = toAccountApiError(error);
        this.handleGuardedError(apiError, guard);
        if (apiError.status >= 400 && apiError.status < 500 && apiError.status !== 401 && apiError.status !== 429) {
          this.removePendingFinish(pending.accountId, pending.runId);
          continue;
        }
        break;
      }
    }
    return responses;
  }

  async leaderboard(
    scope: LeaderboardScope,
    limit = 25,
    signal?: AbortSignal,
  ): Promise<LeaderboardResponse> {
    const params = new URLSearchParams({ scope, limit: String(limit) });
    return this.request<LeaderboardResponse>(`/leaderboards?${params}`, { signal }, false);
  }

  private requireProfile(): AccountProfile {
    const profile = this.snapshot.profile;
    if (!profile || !this.csrfToken) {
      throw new AccountApiError('Sign in to continue.', { status: 401, code: 'AUTH_REQUIRED' });
    }
    return profile;
  }

  private captureSession(): SessionGuard {
    return { generation: this.sessionGeneration, accountId: this.requireProfile().accountId };
  }

  private isSessionCurrent(guard: SessionGuard): boolean {
    return guard.generation === this.sessionGeneration
      && this.snapshot.status === 'authenticated'
      && this.snapshot.profile?.accountId === guard.accountId
      && Boolean(this.csrfToken);
  }

  private assertAuthFlowCurrent(generation: number): void {
    if (generation !== this.sessionGeneration) {
      throw new AccountApiError('Account action was superseded.', { code: 'STALE_ACCOUNT_ACTION' });
    }
  }

  private handleGuardedError(error: unknown, guard: SessionGuard): AccountApiError {
    const apiError = toAccountApiError(error);
    if (!this.isSessionCurrent(guard)) return apiError;
    if (apiError.status === 401) {
      this.csrfToken = null;
      this.sessionGeneration += 1;
      this.setSnapshot({ status: 'guest', profile: null, error: null });
    } else if (apiError.profile?.accountId === guard.accountId) {
      this.setAuthenticatedProfile(apiError.profile, guard);
    }
    return apiError;
  }

  private async submitFinish(pending: PendingFinish, signal?: AbortSignal): Promise<AccountRunFinishResponse> {
    return this.request<AccountRunFinishResponse>(`/runs/${encodeURIComponent(pending.runId)}/finish`, {
      method: 'POST',
      body: JSON.stringify(pending.request),
      signal,
    });
  }

  private applySession(session: AccountSessionResponse): void {
    if (!session.authenticated) {
      this.csrfToken = null;
      this.setSnapshot({ status: 'guest', profile: null, error: null });
      return;
    }
    this.csrfToken = session.csrfToken;
    this.setSnapshot({ status: 'authenticated', profile: session.profile, error: null });
  }

  private setAuthenticatedProfile(profile: AccountProfile, guard?: SessionGuard): void {
    if (guard && !this.isSessionCurrent(guard)) return;
    if (guard && profile.accountId !== guard.accountId) return;
    const current = this.snapshot.profile;
    if (current?.accountId === profile.accountId && current.profileVersion > profile.profileVersion) return;
    this.setSnapshot({ status: 'authenticated', profile, error: null });
  }

  private setSnapshot(snapshot: AccountClientSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (authenticated) {
      this.requireProfile();
      headers.set('X-CSRF-Token', this.csrfToken!);
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBase}${path}`, {
        ...init,
        headers,
        credentials: 'same-origin',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new AccountApiError('Account service is unreachable.', { code: 'NETWORK_ERROR' });
    }
    const raw = response.status === 204 ? '' : await response.text();
    let payload: unknown = undefined;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      const body = isApiErrorPayload(payload) ? payload.error : null;
      throw new AccountApiError(body?.message ?? `Account request failed (${response.status}).`, {
        status: response.status,
        code: body?.code ?? 'HTTP_ERROR',
        retryAfter: body?.retryAfter,
        profile: body?.profile,
      });
    }
    return payload as T;
  }

  private readPendingFinishes(): PendingFinish[] {
    if (!this.storage) return [];
    try {
      const parsed = JSON.parse(this.storage.getItem(PENDING_FINISH_KEY) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPendingFinish).slice(-MAX_PENDING_FINISHES);
    } catch {
      return [];
    }
  }

  private writePendingFinishes(items: PendingFinish[]): void {
    if (!this.storage) return;
    try {
      if (items.length === 0) {
        this.storage.removeItem(PENDING_FINISH_KEY);
        return;
      }
      this.storage.setItem(PENDING_FINISH_KEY, JSON.stringify(items.slice(-MAX_PENDING_FINISHES)));
    } catch {
      // A blocked or full storage area must never prevent the live API request.
    }
  }

  private queuePendingFinish(pending: PendingFinish): void {
    const remaining = this.readPendingFinishes().filter(
      (item) => item.accountId !== pending.accountId || item.runId !== pending.runId,
    );
    remaining.push(pending);
    this.writePendingFinishes(remaining);
  }

  private removePendingFinish(accountId: string, runId: string): void {
    this.writePendingFinishes(this.readPendingFinishes().filter(
      (item) => item.accountId !== accountId || item.runId !== runId,
    ));
  }
}

function toAccountApiError(error: unknown): AccountApiError {
  if (error instanceof AccountApiError) return error;
  if (error instanceof Error) return new AccountApiError(error.message);
  return new AccountApiError('Unknown account error.');
}

function isApiErrorPayload(value: unknown): value is AccountApiErrorPayload {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error);
}

function isPendingFinish(value: unknown): value is PendingFinish {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingFinish>;
  return typeof item.accountId === 'string'
    && typeof item.runId === 'string'
    && typeof item.queuedAt === 'number'
    && Boolean(item.request?.result && typeof item.request.result.score === 'number');
}
