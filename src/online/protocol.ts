import type {
  AbilityId,
  GarageState,
  RunConfig,
  RunStats,
  TrackId,
  WeaponId,
} from '../core/types';

export const ONLINE_PROTOCOL_VERSION = 2 as const;

export const ONLINE_LIMITS = {
  playerName: 24,
  chatMessage: 280,
  roomCode: 8,
  roomPlayersMin: 2,
  roomPlayersMax: 8,
  aiOpponentsMax: 7,
  chatHistory: 32,
  roomDirectoryMax: 48,
  clientMessageBytes: 16_384,
  serverMessageBytes: 65_536,
  stateHz: 24,
} as const;

export type PlayerId = string;
export type RoomId = string;
export type MatchId = string;

export type OnlineLoadout = Pick<RunConfig, 'weapon' | 'ability' | 'garage'>;

export interface OnlineRoomSettings {
  track: TrackId;
  aiOpponents: number;
  playerSlots: number;
}

export type OnlineRoomPhase = 'lobby' | 'racing';

export interface OnlinePlayer {
  id: PlayerId;
  name: string;
  isHost: boolean;
  ready: boolean;
  joinedAt: number;
}

export interface OnlineChatMessage {
  id: string;
  playerId: PlayerId;
  playerName: string;
  text: string;
  sentAt: number;
}

export interface OnlineRoomSnapshot {
  id: RoomId;
  code: string;
  hostId: PlayerId;
  phase: OnlineRoomPhase;
  settings: OnlineRoomSettings;
  players: OnlinePlayer[];
  chat: OnlineChatMessage[];
  createdAt: number;
  revision: number;
}

export interface OnlineRoomSummary {
  id: RoomId;
  code: string;
  hostName: string;
  track: TrackId;
  phase: OnlineRoomPhase;
  humans: number;
  playerSlots: number;
  aiOpponents: number;
}

export interface OnlineRaceHuman {
  kind: 'human';
  id: PlayerId;
  name: string;
  runConfig: RunConfig;
}

export interface OnlineRaceBot {
  kind: 'ai';
  id: string;
  name: string;
  difficulty: number;
}

/**
 * The server is the only writer of this object. In particular, the track,
 * seed and start timestamp never come from the host's browser.
 */
export interface AuthoritativeRaceConfig {
  id: MatchId;
  roomId: RoomId;
  roomCode: string;
  track: TrackId;
  seed: number;
  aiOpponents: number;
  startsAt: number;
  humans: OnlineRaceHuman[];
  bots: OnlineRaceBot[];
}

export type SharedRunState = Pick<
  RunStats,
  'progress' | 'speed' | 'shield' | 'heat' | 'flux' | 'score' | 'rank' | 'section'
>;

export interface ClientRaceState extends SharedRunState {
  matchId: MatchId;
  sequence: number;
  angle: number;
  destroyed: boolean;
  finished: boolean;
}

export interface ServerRaceState extends ClientRaceState {
  playerId: PlayerId;
  playerName: string;
  serverTime: number;
}

/** A server-stamped terminal state accepted as the player's final state for a match. */
export type TerminalServerRaceState = ServerRaceState & (
  | { destroyed: true }
  | { finished: true }
);

export function isTerminalServerRaceState(
  state: ServerRaceState,
): state is TerminalServerRaceState {
  return state.destroyed || state.finished;
}

interface WithRequestId {
  requestId?: string;
}

export type ClientMessage =
  | ({ type: 'hello'; version: typeof ONLINE_PROTOCOL_VERSION; name: string; loadout: OnlineLoadout } & WithRequestId)
  | ({ type: 'rooms:list' } & WithRequestId)
  | ({ type: 'room:create'; settings: OnlineRoomSettings } & WithRequestId)
  | ({ type: 'room:join'; code: string } & WithRequestId)
  | ({ type: 'room:leave' } & WithRequestId)
  | ({ type: 'room:settings'; settings: OnlineRoomSettings } & WithRequestId)
  | ({ type: 'player:ready'; ready: boolean } & WithRequestId)
  | ({ type: 'chat:send'; text: string } & WithRequestId)
  | ({ type: 'race:start' } & WithRequestId)
  | ({ type: 'race:state'; state: ClientRaceState } & WithRequestId)
  | ({ type: 'ping'; nonce: string } & WithRequestId);

export type OnlineErrorCode =
  | 'BAD_MESSAGE'
  | 'VERSION_MISMATCH'
  | 'NOT_IDENTIFIED'
  | 'ALREADY_IDENTIFIED'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_RUNNING'
  | 'HOST_ONLY'
  | 'INVALID_SETTINGS'
  | 'NOT_ENOUGH_PLAYERS'
  | 'RATE_LIMITED'
  | 'MATCH_MISMATCH'
  | 'STALE_STATE';

export type ServerMessage =
  | {
      type: 'welcome';
      version: typeof ONLINE_PROTOCOL_VERSION;
      playerId: PlayerId;
      serverTime: number;
    }
  | { type: 'rooms'; rooms: OnlineRoomSummary[] }
  | { type: 'room:snapshot'; room: OnlineRoomSnapshot }
  | { type: 'room:left'; roomId: RoomId; reason: 'left' | 'disconnected' | 'closed' }
  | { type: 'chat:message'; roomId: RoomId; message: OnlineChatMessage }
  | { type: 'host:changed'; roomId: RoomId; hostId: PlayerId }
  | { type: 'race:started'; config: AuthoritativeRaceConfig }
  | { type: 'race:state'; state: ServerRaceState }
  | { type: 'pong'; nonce: string; serverTime: number }
  | { type: 'error'; code: OnlineErrorCode; message: string; requestId?: string };

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const TRACK_IDS: ReadonlySet<TrackId> = new Set(['aurora', 'reactor', 'void', 'forge']);
const WEAPON_IDS: ReadonlySet<WeaponId> = new Set(['pulse', 'scatter', 'rail']);
const ABILITY_IDS: ReadonlySet<AbilityId> = new Set(['phase', 'emp', 'overdrive']);
const ERROR_CODES: ReadonlySet<OnlineErrorCode> = new Set([
  'BAD_MESSAGE',
  'VERSION_MISMATCH',
  'NOT_IDENTIFIED',
  'ALREADY_IDENTIFIED',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_RUNNING',
  'HOST_ONLY',
  'INVALID_SETTINGS',
  'NOT_ENOUGH_PLAYERS',
  'RATE_LIMITED',
  'MATCH_MISMATCH',
  'STALE_STATE',
]);
const GARAGE_KEYS: ReadonlyArray<keyof GarageState> = [
  'credits',
  'engine',
  'cooling',
  'shield',
  'weapon',
  'bestScore',
  'runs',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isBoundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function hasValidRequestId(message: Record<string, unknown>): boolean {
  return message.requestId === undefined || isBoundedString(message.requestId, 64);
}

export function isTrackId(value: unknown): value is TrackId {
  return typeof value === 'string' && TRACK_IDS.has(value as TrackId);
}

export function isOnlineRoomSettings(value: unknown): value is OnlineRoomSettings {
  if (!isRecord(value)) return false;
  return isTrackId(value.track)
    && isIntegerIn(value.aiOpponents, 0, ONLINE_LIMITS.aiOpponentsMax)
    && isIntegerIn(value.playerSlots, ONLINE_LIMITS.roomPlayersMin, ONLINE_LIMITS.roomPlayersMax);
}

export function isOnlineLoadout(value: unknown): value is OnlineLoadout {
  if (!isRecord(value) || !isRecord(value.garage)) return false;
  if (typeof value.weapon !== 'string' || !WEAPON_IDS.has(value.weapon as WeaponId)) return false;
  if (typeof value.ability !== 'string' || !ABILITY_IDS.has(value.ability as AbilityId)) return false;
  const garage = value.garage;
  return GARAGE_KEYS.every((key) => isIntegerIn(garage[key], 0, 1_000_000_000));
}

export function isClientRaceState(value: unknown): value is ClientRaceState {
  if (!isRecord(value)) return false;
  return isBoundedString(value.matchId, 80)
    && isIntegerIn(value.sequence, 0, Number.MAX_SAFE_INTEGER)
    && isFiniteNumber(value.angle) && Math.abs(value.angle) <= Math.PI * 4
    && isFiniteNumber(value.progress) && value.progress >= 0 && value.progress <= 1.05
    && isFiniteNumber(value.speed) && value.speed >= 0 && value.speed <= 20_000
    && isFiniteNumber(value.shield) && value.shield >= 0 && value.shield <= 100
    && isFiniteNumber(value.heat) && value.heat >= 0 && value.heat <= 200
    && isFiniteNumber(value.flux) && value.flux >= 0 && value.flux <= 200
    && isFiniteNumber(value.score) && value.score >= 0 && value.score <= 1_000_000_000
    && isIntegerIn(value.rank, 1, 32)
    && isIntegerIn(value.section, 1, 1_000)
    && typeof value.destroyed === 'boolean'
    && typeof value.finished === 'boolean';
}

function parseJson(raw: string | unknown, maximumBytes: number): DecodeResult<unknown> {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  if (raw.length === 0 || raw.length > maximumBytes) {
    return { ok: false, error: 'Message size is outside the allowed range.' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: 'Message is not valid JSON.' };
  }
}

export function decodeClientMessage(raw: string | unknown): DecodeResult<ClientMessage> {
  const decoded = parseJson(raw, ONLINE_LIMITS.clientMessageBytes);
  if (!decoded.ok) return decoded;
  if (!isRecord(decoded.value) || typeof decoded.value.type !== 'string' || !hasValidRequestId(decoded.value)) {
    return { ok: false, error: 'Message envelope is invalid.' };
  }

  const message = decoded.value;
  let valid = false;
  switch (message.type) {
    case 'hello':
      valid = message.version === ONLINE_PROTOCOL_VERSION
        && isBoundedString(message.name, ONLINE_LIMITS.playerName)
        && isOnlineLoadout(message.loadout);
      break;
    case 'rooms:list':
    case 'room:leave':
    case 'race:start':
      valid = true;
      break;
    case 'room:create':
    case 'room:settings':
      valid = isOnlineRoomSettings(message.settings);
      break;
    case 'room:join':
      valid = isBoundedString(message.code, ONLINE_LIMITS.roomCode, 4)
        && /^[A-Za-z0-9-]+$/.test(message.code);
      break;
    case 'player:ready':
      valid = typeof message.ready === 'boolean';
      break;
    case 'chat:send':
      valid = isBoundedString(message.text, ONLINE_LIMITS.chatMessage);
      break;
    case 'race:state':
      valid = isClientRaceState(message.state);
      break;
    case 'ping':
      valid = isBoundedString(message.nonce, 64);
      break;
    default:
      valid = false;
  }

  return valid
    ? { ok: true, value: message as unknown as ClientMessage }
    : { ok: false, error: `Invalid payload for ${message.type}.` };
}

function isOnlinePlayer(value: unknown): value is OnlinePlayer {
  return isRecord(value)
    && isBoundedString(value.id, 80)
    && isBoundedString(value.name, ONLINE_LIMITS.playerName)
    && typeof value.isHost === 'boolean'
    && typeof value.ready === 'boolean'
    && isFiniteNumber(value.joinedAt);
}

function isChatMessage(value: unknown): value is OnlineChatMessage {
  return isRecord(value)
    && isBoundedString(value.id, 80)
    && isBoundedString(value.playerId, 80)
    && isBoundedString(value.playerName, ONLINE_LIMITS.playerName)
    && isBoundedString(value.text, ONLINE_LIMITS.chatMessage)
    && isFiniteNumber(value.sentAt);
}

function isRoomSnapshot(value: unknown): value is OnlineRoomSnapshot {
  if (!isRecord(value)) return false;
  const structurallyValid = isBoundedString(value.id, 80)
    && isBoundedString(value.code, ONLINE_LIMITS.roomCode, 4)
    && isBoundedString(value.hostId, 80)
    && (value.phase === 'lobby' || value.phase === 'racing')
    && isOnlineRoomSettings(value.settings)
    && Array.isArray(value.players) && value.players.every(isOnlinePlayer)
    && Array.isArray(value.chat) && value.chat.every(isChatMessage)
    && isFiniteNumber(value.createdAt)
    && isIntegerIn(value.revision, 0, Number.MAX_SAFE_INTEGER);
  if (!structurallyValid) return false;
  const players = value.players as OnlinePlayer[];
  const settings = value.settings as OnlineRoomSettings;
  return players.length <= settings.playerSlots
    && players.some((player) => player.id === value.hostId && player.isHost)
    && players.filter((player) => player.isHost).length === 1;
}

function isRoomSummary(value: unknown): value is OnlineRoomSummary {
  return isRecord(value)
    && isBoundedString(value.id, 80)
    && isBoundedString(value.code, ONLINE_LIMITS.roomCode, 4)
    && isBoundedString(value.hostName, ONLINE_LIMITS.playerName)
    && isTrackId(value.track)
    && (value.phase === 'lobby' || value.phase === 'racing')
    && isIntegerIn(value.humans, 0, ONLINE_LIMITS.roomPlayersMax)
    && isIntegerIn(value.playerSlots, ONLINE_LIMITS.roomPlayersMin, ONLINE_LIMITS.roomPlayersMax)
    && isIntegerIn(value.aiOpponents, 0, ONLINE_LIMITS.aiOpponentsMax);
}

function isRunConfig(value: unknown): value is RunConfig {
  return isRecord(value)
    && isTrackId(value.track)
    && isIntegerIn(value.seed, 0, 0xffffffff)
    && isOnlineLoadout(value);
}

function isRaceConfig(value: unknown): value is AuthoritativeRaceConfig {
  if (!isRecord(value)
    || !isBoundedString(value.id, 80)
    || !isBoundedString(value.roomId, 80)
    || !isBoundedString(value.roomCode, ONLINE_LIMITS.roomCode, 4)
    || !isTrackId(value.track)
    || !isIntegerIn(value.seed, 0, 0xffffffff)
    || !isIntegerIn(value.aiOpponents, 0, ONLINE_LIMITS.aiOpponentsMax)
    || !isFiniteNumber(value.startsAt)
    || !Array.isArray(value.humans)
    || !Array.isArray(value.bots)) return false;

  const humansValid = value.humans.length >= ONLINE_LIMITS.roomPlayersMin
    && value.humans.length <= ONLINE_LIMITS.roomPlayersMax
    && value.humans.every((human) => isRecord(human)
    && human.kind === 'human'
    && isBoundedString(human.id, 80)
    && isBoundedString(human.name, ONLINE_LIMITS.playerName)
    && isRunConfig(human.runConfig)
    && human.runConfig.track === value.track
    && human.runConfig.seed === value.seed);
  const botsValid = value.bots.length === value.aiOpponents
    && value.bots.every((bot) => isRecord(bot)
    && bot.kind === 'ai'
    && isBoundedString(bot.id, 80)
    && isBoundedString(bot.name, ONLINE_LIMITS.playerName)
    && isFiniteNumber(bot.difficulty)
    && bot.difficulty >= 0 && bot.difficulty <= 1);
  return humansValid && botsValid;
}

function isServerRaceState(value: unknown): value is ServerRaceState {
  return isClientRaceState(value)
    && isRecord(value)
    && isBoundedString(value.playerId, 80)
    && isBoundedString(value.playerName, ONLINE_LIMITS.playerName)
    && isFiniteNumber(value.serverTime);
}

export function decodeServerMessage(raw: string | unknown): DecodeResult<ServerMessage> {
  const decoded = parseJson(raw, ONLINE_LIMITS.serverMessageBytes);
  if (!decoded.ok) return decoded;
  if (!isRecord(decoded.value) || typeof decoded.value.type !== 'string') {
    return { ok: false, error: 'Server message envelope is invalid.' };
  }
  const message = decoded.value;
  let valid = false;
  switch (message.type) {
    case 'welcome':
      valid = message.version === ONLINE_PROTOCOL_VERSION
        && isBoundedString(message.playerId, 80)
        && isFiniteNumber(message.serverTime);
      break;
    case 'rooms':
      valid = Array.isArray(message.rooms) && message.rooms.every(isRoomSummary);
      break;
    case 'room:snapshot':
      valid = isRoomSnapshot(message.room);
      break;
    case 'room:left':
      valid = isBoundedString(message.roomId, 80)
        && (message.reason === 'left' || message.reason === 'disconnected' || message.reason === 'closed');
      break;
    case 'chat:message':
      valid = isBoundedString(message.roomId, 80) && isChatMessage(message.message);
      break;
    case 'host:changed':
      valid = isBoundedString(message.roomId, 80) && isBoundedString(message.hostId, 80);
      break;
    case 'race:started':
      valid = isRaceConfig(message.config);
      break;
    case 'race:state':
      valid = isServerRaceState(message.state);
      break;
    case 'pong':
      valid = isBoundedString(message.nonce, 64) && isFiniteNumber(message.serverTime);
      break;
    case 'error':
      valid = typeof message.code === 'string' && ERROR_CODES.has(message.code as OnlineErrorCode)
        && isBoundedString(message.message, 300)
        && (message.requestId === undefined || isBoundedString(message.requestId, 64));
      break;
    default:
      valid = false;
  }
  return valid
    ? { ok: true, value: message as ServerMessage }
    : { ok: false, error: `Invalid server payload for ${message.type}.` };
}

export function encodeOnlineMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function normalizePlayerName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ONLINE_LIMITS.playerName);
}

export function normalizeChatText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ONLINE_LIMITS.chatMessage);
}
