import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACCOUNT_API_PREFIX,
  ACCOUNT_LIMITS,
  type AccountGarageUpgradeRequest,
  type AccountLegacyImportRequest,
  type AccountLoginRequest,
  type AccountMusicSource,
  type AccountRecoveryRequest,
  type AccountRegisterRequest,
  type AccountRunFinishRequest,
  type AccountRunStartRequest,
  type AccountSessionResponse,
  type AuthenticatedAccountSession,
  type GarageModuleId,
  type LeaderboardScope,
} from '../../src/account/protocol.ts';
import type { GarageState, RunResult, TrackId } from '../../src/core/types.ts';

export interface AccountAuthGrant extends AuthenticatedAccountSession {
  sessionToken: string;
  recoveryCode?: string;
}

export interface AccountSessionContext extends AuthenticatedAccountSession {
  accountId: string;
}

export interface AccountStoreLike {
  register(request: AccountRegisterRequest): Promise<AccountAuthGrant>;
  login(request: AccountLoginRequest): Promise<AccountAuthGrant>;
  recover(request: AccountRecoveryRequest): Promise<AccountAuthGrant>;
  authenticate(sessionToken: string): AccountSessionContext | null | Promise<AccountSessionContext | null>;
  logout(sessionToken: string): void | Promise<void>;
  getProfile(accountId: string): AccountSessionContext['profile'] | Promise<AccountSessionContext['profile']>;
  upgradeGarage(accountId: string, request: AccountGarageUpgradeRequest): unknown | Promise<unknown>;
  importLegacy(accountId: string, request: AccountLegacyImportRequest): unknown | Promise<unknown>;
  startRun(accountId: string, request: AccountRunStartRequest): unknown | Promise<unknown>;
  finishRun(accountId: string, runId: string, request: AccountRunFinishRequest): unknown | Promise<unknown>;
  leaderboard(scope: LeaderboardScope, currentAccountId: string | null, limit: number): unknown | Promise<unknown>;
}

export interface AccountApiOptions {
  allowedOrigins: ReadonlySet<string>;
  secureCookies?: boolean;
  cookieName?: string;
  now?: () => number;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

interface ApiFailureLike {
  code?: unknown;
  status?: unknown;
  retryAfter?: unknown;
  profile?: unknown;
  message?: unknown;
}

const TRACK_IDS = new Set<TrackId>(['aurora', 'reactor', 'void', 'forge', 'skyline', 'abyss']);
const GARAGE_MODULES = new Set<GarageModuleId>(['engine', 'cooling', 'shield', 'weapon']);
const MUSIC_SOURCES = new Set<AccountMusicSource>(['synthetic', 'catalog', 'local']);
const WEAPONS = new Set(['pulse', 'scatter', 'rail']);
const ABILITIES = new Set(['phase', 'emp', 'overdrive']);
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isHandle(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= ACCOUNT_LIMITS.handleMin
    && value.length <= ACCOUNT_LIMITS.handleMax
    && /^[\p{L}\p{N}_-]+$/u.test(value);
}

function isPassword(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= ACCOUNT_LIMITS.passwordMin
    && value.length <= ACCOUNT_LIMITS.passwordMax
    && Buffer.byteLength(value, 'utf8') <= 256;
}

function isGarageState(value: unknown): value is GarageState {
  if (!isRecord(value)) return false;
  return isInteger(value.credits, 0, 1_000_000_000)
    && isInteger(value.engine, 0, 5)
    && isInteger(value.cooling, 0, 5)
    && isInteger(value.shield, 0, 5)
    && isInteger(value.weapon, 0, 5)
    && isInteger(value.bestScore, 0, 1_000_000_000)
    && isInteger(value.runs, 0, 1_000_000_000);
}

function isRegisterRequest(value: unknown): value is AccountRegisterRequest {
  return isRecord(value)
    && isHandle(value.handle)
    && isPassword(value.password)
    && (value.legacyGarage === undefined || isGarageState(value.legacyGarage));
}

function isLoginRequest(value: unknown): value is AccountLoginRequest {
  return isRecord(value) && isHandle(value.handle) && isPassword(value.password);
}

function isRecoveryRequest(value: unknown): value is AccountRecoveryRequest {
  return isRecord(value)
    && isHandle(value.handle)
    && typeof value.recoveryCode === 'string'
    && value.recoveryCode.length >= 20
    && value.recoveryCode.length <= 128
    && isPassword(value.newPassword);
}

function isGarageUpgradeRequest(value: unknown): value is AccountGarageUpgradeRequest {
  return isRecord(value)
    && typeof value.module === 'string'
    && GARAGE_MODULES.has(value.module as GarageModuleId)
    && isInteger(value.profileVersion, 0, Number.MAX_SAFE_INTEGER);
}

function isLegacyImportRequest(value: unknown): value is AccountLegacyImportRequest {
  return isRecord(value) && isGarageState(value.garage);
}

function isRunStartRequest(value: unknown): value is AccountRunStartRequest {
  return isRecord(value)
    && typeof value.trackId === 'string' && TRACK_IDS.has(value.trackId as TrackId)
    && typeof value.weapon === 'string' && WEAPONS.has(value.weapon)
    && typeof value.ability === 'string' && ABILITIES.has(value.ability)
    && (value.mode === 'solo' || value.mode === 'online')
    && typeof value.musicSource === 'string' && MUSIC_SOURCES.has(value.musicSource as AccountMusicSource)
    && typeof value.musicId === 'string' && value.musicId.trim().length > 0 && value.musicId.length <= 128
    && isInteger(value.requestedSeed, 0, 0xffff_ffff)
    && isInteger(value.aiOpponents, 0, 7);
}

function isRunResult(value: unknown): value is RunResult {
  if (!isRecord(value)) return false;
  return isInteger(value.score, 0, 1_000_000_000)
    && isInteger(value.credits, 0, 1_000_000_000)
    && isFiniteNumber(value.maxSpeed, 0, 20_000)
    && isFiniteNumber(value.accuracy, 0, 1)
    && isInteger(value.perfects, 0, 1_000_000)
    && isInteger(value.nearMisses, 0, 1_000_000)
    && isInteger(value.kills, 0, 1_000_000)
    && isInteger(value.rank, 1, 32)
    && typeof value.survived === 'boolean'
    && typeof value.trackName === 'string' && value.trackName.length > 0 && value.trackName.length <= 96
    && isInteger(value.seed, 0, 0xffff_ffff);
}

function isRunFinishRequest(value: unknown): value is AccountRunFinishRequest {
  return isRecord(value) && isRunResult(value.result);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header || header.length > 8_192) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key && value) result.set(key, value);
  }
  return result;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

function empty(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('Expected application/json.'), {
    code: 'UNSUPPORTED_MEDIA_TYPE', status: 415,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > ACCOUNT_LIMITS.requestBytes) {
      throw Object.assign(new Error('Request body is too large.'), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw Object.assign(new Error('Request body is required.'), { code: 'INVALID_REQUEST', status: 400 });
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON.'), { code: 'INVALID_JSON', status: 400 });
  }
}

export class AccountApi {
  private readonly store: AccountStoreLike;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly secureCookies: boolean;
  private readonly cookieName: string;
  private readonly now: () => number;
  private readonly rateWindows = new Map<string, RateWindow>();

  constructor(store: AccountStoreLike, options: AccountApiOptions) {
    this.store = store;
    this.allowedOrigins = options.allowedOrigins;
    this.secureCookies = options.secureCookies ?? true;
    this.cookieName = options.cookieName ?? (this.secureCookies ? '__Host-be_session' : 'be_session');
    this.now = options.now ?? Date.now;
  }

  /** Returns false when the request does not belong to the account API. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== ACCOUNT_API_PREFIX && !url.pathname.startsWith(`${ACCOUNT_API_PREFIX}/`)) return false;

    try {
      if (request.method === 'OPTIONS') {
        json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Cross-origin API access is disabled.' } });
        return true;
      }
      if (request.method && !['GET', 'HEAD'].includes(request.method)) this.requireOrigin(request);

      if (request.method === 'GET' && url.pathname === `${ACCOUNT_API_PREFIX}/auth/session`) {
        const session = await this.optionalSession(request);
        const body: AccountSessionResponse = session
          ? { authenticated: true, csrfToken: session.csrfToken, profile: session.profile }
          : { authenticated: false };
        json(response, 200, body);
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/auth/register`) {
        this.consumeRateLimit(`register:${this.clientAddress(request)}`, 5, 60 * 60_000);
        const body = await readJson(request);
        if (!isRegisterRequest(body)) this.invalidRequest('Registration data is invalid.');
        const grant = await this.store.register(body);
        this.setSessionCookie(response, grant.sessionToken);
        const { sessionToken: _token, recoveryCode, ...session } = grant;
        json(response, 201, { ...session, recoveryCode });
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/auth/login`) {
        this.consumeRateLimit(`login:${this.clientAddress(request)}`, 12, 10 * 60_000);
        const body = await readJson(request);
        if (!isLoginRequest(body)) this.invalidRequest('Login data is invalid.');
        const grant = await this.store.login(body);
        this.setSessionCookie(response, grant.sessionToken);
        const { sessionToken: _token, recoveryCode: _recovery, ...session } = grant;
        json(response, 200, session);
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/auth/recover`) {
        this.consumeRateLimit(`recover:${this.clientAddress(request)}`, 6, 60 * 60_000);
        const body = await readJson(request);
        if (!isRecoveryRequest(body)) this.invalidRequest('Recovery data is invalid.');
        const grant = await this.store.recover(body);
        this.setSessionCookie(response, grant.sessionToken);
        const { sessionToken: _token, ...responseBody } = grant;
        json(response, 200, responseBody);
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/auth/logout`) {
        const token = this.readSessionToken(request);
        if (token) {
          const session = await this.store.authenticate(token);
          if (session) this.requireCsrf(request, session.csrfToken);
          await this.store.logout(token);
        }
        this.clearSessionCookie(response);
        empty(response, 204);
        return true;
      }

      if (request.method === 'GET' && url.pathname === `${ACCOUNT_API_PREFIX}/me/profile`) {
        const session = await this.requireSession(request);
        json(response, 200, { profile: await this.store.getProfile(session.accountId) });
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/me/garage/upgrade`) {
        const session = await this.requireMutationSession(request);
        const body = await readJson(request);
        if (!isGarageUpgradeRequest(body)) this.invalidRequest('Garage upgrade data is invalid.');
        json(response, 200, await this.store.upgradeGarage(session.accountId, body));
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/me/import-legacy`) {
        const session = await this.requireMutationSession(request);
        const body = await readJson(request);
        if (!isLegacyImportRequest(body)) this.invalidRequest('Legacy progress is invalid.');
        json(response, 200, await this.store.importLegacy(session.accountId, body));
        return true;
      }

      if (request.method === 'POST' && url.pathname === `${ACCOUNT_API_PREFIX}/runs/start`) {
        const session = await this.requireMutationSession(request);
        this.consumeRateLimit(`run-start:${session.accountId}`, 30, 60_000);
        const body = await readJson(request);
        if (!isRunStartRequest(body)) this.invalidRequest('Run configuration is invalid.');
        json(response, 201, await this.store.startRun(session.accountId, body));
        return true;
      }

      const finishMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{8,128})\/finish$/.exec(url.pathname);
      if (request.method === 'POST' && finishMatch) {
        const session = await this.requireMutationSession(request);
        this.consumeRateLimit(`run-finish:${session.accountId}`, 60, 60_000);
        const body = await readJson(request);
        if (!isRunFinishRequest(body)) this.invalidRequest('Run result is invalid.');
        json(response, 200, await this.store.finishRun(session.accountId, finishMatch[1], body));
        return true;
      }

      if (request.method === 'GET' && url.pathname === `${ACCOUNT_API_PREFIX}/leaderboards`) {
        const rawScope = url.searchParams.get('scope') ?? 'global';
        if (rawScope !== 'global' && !TRACK_IDS.has(rawScope as TrackId)) this.invalidRequest('Leaderboard scope is invalid.');
        const rawLimit = Number(url.searchParams.get('limit') ?? 25);
        if (!Number.isInteger(rawLimit) || rawLimit < 1) this.invalidRequest('Leaderboard limit is invalid.');
        const session = await this.optionalSession(request);
        json(response, 200, await this.store.leaderboard(
          rawScope as LeaderboardScope,
          session?.accountId ?? null,
          Math.min(ACCOUNT_LIMITS.leaderboardMax, rawLimit),
        ));
        return true;
      }

      if (request.method === 'GET' && url.pathname === `${ACCOUNT_API_PREFIX}/achievements`) {
        const session = await this.requireSession(request);
        const profile = await this.store.getProfile(session.accountId);
        json(response, 200, { achievements: profile.achievements });
        return true;
      }

      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Account API route was not found.' } });
    } catch (error) {
      this.sendError(response, error);
    }
    return true;
  }

  private async optionalSession(request: IncomingMessage): Promise<AccountSessionContext | null> {
    const token = this.readSessionToken(request);
    return token ? this.store.authenticate(token) : null;
  }

  private async requireSession(request: IncomingMessage): Promise<AccountSessionContext> {
    const session = await this.optionalSession(request);
    if (!session) throw Object.assign(new Error('Authentication is required.'), { code: 'UNAUTHENTICATED', status: 401 });
    return session;
  }

  private async requireMutationSession(request: IncomingMessage): Promise<AccountSessionContext> {
    const session = await this.requireSession(request);
    this.requireCsrf(request, session.csrfToken);
    return session;
  }

  private requireCsrf(request: IncomingMessage, expected: string): void {
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || supplied.length > 256 || !constantTimeTextEqual(supplied, expected)) {
      throw Object.assign(new Error('CSRF verification failed.'), { code: 'CSRF_FAILED', status: 403 });
    }
  }

  private requireOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !this.allowedOrigins.has(origin)) {
      throw Object.assign(new Error('Request origin is not allowed.'), { code: 'ORIGIN_FORBIDDEN', status: 403 });
    }
  }

  private readSessionToken(request: IncomingMessage): string | null {
    const token = parseCookies(request.headers.cookie).get(this.cookieName);
    return token && SESSION_TOKEN_PATTERN.test(token) ? token : null;
  }

  private setSessionCookie(response: ServerResponse, token: string): void {
    if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('Account store returned an invalid session token.');
    const secure = this.secureCookies ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${this.cookieName}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=2592000`);
  }

  private clearSessionCookie(response: ServerResponse): void {
    const secure = this.secureCookies ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${this.cookieName}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`);
  }

  private consumeRateLimit(key: string, limit: number, windowMs: number): void {
    const now = this.now();
    const current = this.rateWindows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.rateWindows.set(key, { startedAt: now, count: 1 });
      if (this.rateWindows.size > 4_096) {
        for (const [candidate, value] of this.rateWindows) {
          if (now - value.startedAt >= 60 * 60_000) this.rateWindows.delete(candidate);
        }
      }
      return;
    }
    if (current.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1_000));
      throw Object.assign(new Error('Too many requests.'), { code: 'RATE_LIMITED', status: 429, retryAfter });
    }
    current.count += 1;
  }

  private clientAddress(request: IncomingMessage): string {
    const remote = request.socket.remoteAddress ?? 'unknown';
    const normalizedRemote = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
    const fromLoopback = normalizedRemote === '127.0.0.1' || normalizedRemote === '::1';
    const forwarded = request.headers['x-real-ip'];
    return fromLoopback && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : normalizedRemote;
  }

  private invalidRequest(message: string): never {
    throw Object.assign(new Error(message), { code: 'INVALID_REQUEST', status: 400 });
  }

  private sendError(response: ServerResponse, error: unknown): void {
    const failure = isRecord(error) ? error as ApiFailureLike : {};
    const status = typeof failure.status === 'number' && Number.isInteger(failure.status)
      ? Math.max(400, Math.min(599, failure.status))
      : 500;
    const code = typeof failure.code === 'string' ? failure.code : 'INTERNAL_ERROR';
    const message = status >= 500
      ? 'The account service could not complete the request.'
      : typeof failure.message === 'string' ? failure.message : 'The request failed.';
    const retryAfter = typeof failure.retryAfter === 'number' && Number.isFinite(failure.retryAfter)
      ? Math.max(1, Math.ceil(failure.retryAfter))
      : undefined;
    if (retryAfter) response.setHeader('Retry-After', String(retryAfter));
    json(response, status, {
      error: {
        code,
        message,
        ...(retryAfter ? { retryAfter } : {}),
        ...(failure.profile ? { profile: failure.profile } : {}),
      },
    });
  }
}
