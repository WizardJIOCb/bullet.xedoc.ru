import type {
  AuthoritativeRaceConfig,
  ClientMessage,
  ClientRaceState,
  OnlineChatMessage,
  OnlineLoadout,
  OnlinePlayer,
  OnlineRoomSettings,
  OnlineRoomSnapshot,
  OnlineRoomSummary,
  PlayerId,
  ServerMessage,
} from '../src/online/protocol.ts';
import {
  ONLINE_LIMITS,
  ONLINE_PROTOCOL_VERSION,
  decodeClientMessage,
  encodeOnlineMessage,
  normalizeChatText,
  normalizePlayerName,
} from '../src/online/protocol.ts';

export interface LobbyPeer {
  id: string;
  send(payload: string): void;
  close?(code: number, reason: string): void;
}

export interface LobbyServerOptions {
  now?: () => number;
  random?: () => number;
  idFactory?: (prefix: 'player' | 'room' | 'match' | 'chat') => string;
  roomCodeFactory?: () => string;
  chatCooldownMs?: number;
  startDelayMs?: number;
  stateRateLimitHz?: number;
  commandRatePerSecond?: number;
  commandRateBurst?: number;
  maxRooms?: number;
}

interface PlayerSession {
  connectionId: string;
  peer: LobbyPeer;
  playerId: PlayerId | null;
  name: string | null;
  loadout: OnlineLoadout | null;
  roomId: string | null;
  lastChatAt: number;
  commandTokens: number;
  lastCommandAt: number;
}

interface RoomMember {
  session: PlayerSession;
  ready: boolean;
  joinedAt: number;
  joinOrder: number;
  lastStateSequence: number;
  lastStateAt: number;
  finished: boolean;
  terminalMatchId: string | null;
}

interface LobbyRoom {
  id: string;
  code: string;
  hostId: PlayerId;
  phase: 'lobby' | 'racing';
  settings: OnlineRoomSettings;
  members: Map<PlayerId, RoomMember>;
  chat: OnlineChatMessage[];
  createdAt: number;
  lastActivityAt: number;
  revision: number;
  match: AuthoritativeRaceConfig | null;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function defaultIdFactory(prefix: 'player' | 'room' | 'match' | 'chat'): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function cloneLoadout(loadout: OnlineLoadout): OnlineLoadout {
  return {
    weapon: loadout.weapon,
    ability: loadout.ability,
    garage: { ...loadout.garage },
  };
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export class LobbyServer {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly idFactory: NonNullable<LobbyServerOptions['idFactory']>;
  private readonly roomCodeFactory?: () => string;
  private readonly chatCooldownMs: number;
  private readonly startDelayMs: number;
  private readonly stateIntervalMs: number;
  private readonly commandRatePerSecond: number;
  private readonly commandRateBurst: number;
  private readonly maxRooms: number;
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly rooms = new Map<string, LobbyRoom>();
  private readonly roomIdsByCode = new Map<string, string>();
  private joinOrder = 0;

  constructor(options: LobbyServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.roomCodeFactory = options.roomCodeFactory;
    this.chatCooldownMs = Math.max(0, options.chatCooldownMs ?? 350);
    this.startDelayMs = Math.max(300, options.startDelayMs ?? 1_500);
    this.stateIntervalMs = 1_000 / Math.max(1, options.stateRateLimitHz ?? ONLINE_LIMITS.stateHz + 8);
    this.commandRatePerSecond = Math.max(1, options.commandRatePerSecond ?? 12);
    this.commandRateBurst = Math.max(1, options.commandRateBurst ?? 24);
    this.maxRooms = Math.max(1, Math.trunc(options.maxRooms ?? 256));
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  isIdentified(connectionId: string): boolean {
    return Boolean(this.sessions.get(connectionId)?.playerId);
  }

  connect(peer: LobbyPeer): void {
    if (this.sessions.has(peer.id)) {
      peer.close?.(1008, 'duplicate connection id');
      return;
    }
    const now = this.now();
    this.sessions.set(peer.id, {
      connectionId: peer.id,
      peer,
      playerId: null,
      name: null,
      loadout: null,
      roomId: null,
      lastChatAt: Number.NEGATIVE_INFINITY,
      commandTokens: this.commandRateBurst,
      lastCommandAt: now,
    });
  }

  disconnect(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    if (session.roomId) this.removeFromRoom(session, 'disconnected', false);
    this.sessions.delete(connectionId);
  }

  receive(connectionId: string, raw: string | unknown): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) {
      const version = this.readHelloVersion(raw);
      this.sendError(
        session,
        version !== null && version !== ONLINE_PROTOCOL_VERSION ? 'VERSION_MISMATCH' : 'BAD_MESSAGE',
        version !== null && version !== ONLINE_PROTOCOL_VERSION
          ? `Protocol ${version} is unsupported; server expects ${ONLINE_PROTOCOL_VERSION}.`
          : decoded.error,
      );
      return;
    }

    const message = decoded.value;
    if (message.type !== 'race:state' && !this.consumeCommandToken(session)) {
      this.sendError(session, 'RATE_LIMITED', 'Lobby commands are being sent too quickly.', message.requestId);
      return;
    }
    if (message.type === 'hello') {
      this.handleHello(session, message);
      return;
    }
    if (!session.playerId || !session.name || !session.loadout) {
      this.sendError(session, 'NOT_IDENTIFIED', 'Send hello before lobby commands.', message.requestId);
      return;
    }

    switch (message.type) {
      case 'rooms:list':
        this.send(session, { type: 'rooms', rooms: this.listRoomSummaries() });
        break;
      case 'room:create':
        this.createRoom(session, message.settings, message.requestId);
        break;
      case 'room:join':
        this.joinRoom(session, message.code, message.requestId);
        break;
      case 'room:leave':
        this.leaveRoom(session, message.requestId);
        break;
      case 'room:settings':
        this.updateSettings(session, message.settings, message.requestId);
        break;
      case 'player:ready':
        this.updateReady(session, message.ready, message.requestId);
        break;
      case 'chat:send':
        this.sendChat(session, message.text, message.requestId);
        break;
      case 'race:start':
        this.startRace(session, message.requestId);
        break;
      case 'race:state':
        this.relayRaceState(session, message.state, message.requestId);
        break;
      case 'ping':
        this.send(session, { type: 'pong', nonce: message.nonce, serverTime: this.now() });
        break;
    }
  }

  listRoomSummaries(): OnlineRoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.phase === 'lobby' && room.members.size < room.settings.playerSlots)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, ONLINE_LIMITS.roomDirectoryMax)
      .map((room) => {
        const host = room.members.get(room.hostId);
        return {
          id: room.id,
          code: room.code,
          hostName: host?.session.name ?? 'HOST MIGRATING',
          track: room.settings.track,
          phase: room.phase,
          humans: room.members.size,
          playerSlots: room.settings.playerSlots,
          aiOpponents: room.settings.aiOpponents,
        };
      });
  }

  /** Closes rooms with no accepted member activity during the supplied window. */
  expireIdleRooms(maxIdleMs: number): number {
    const now = this.now();
    const idleWindow = Math.max(0, maxIdleMs);
    const expired = [...this.rooms.values()]
      .filter((room) => now - room.lastActivityAt >= idleWindow);
    for (const room of expired) {
      this.rooms.delete(room.id);
      this.roomIdsByCode.delete(room.code);
      for (const member of room.members.values()) {
        member.session.roomId = null;
        this.send(member.session, { type: 'room:left', roomId: room.id, reason: 'closed' });
      }
    }
    if (expired.length > 0) this.broadcastRoomList();
    return expired.length;
  }

  getRoomSnapshot(idOrCode: string): OnlineRoomSnapshot | null {
    const normalized = idOrCode.trim().toUpperCase();
    const room = this.rooms.get(idOrCode)
      ?? this.rooms.get(this.roomIdsByCode.get(normalized) ?? '');
    return room ? this.snapshot(room) : null;
  }

  private handleHello(session: PlayerSession, message: Extract<ClientMessage, { type: 'hello' }>): void {
    if (session.playerId) {
      this.sendError(session, 'ALREADY_IDENTIFIED', 'This connection already completed hello.', message.requestId);
      return;
    }
    const name = normalizePlayerName(message.name);
    if (!name) {
      this.sendError(session, 'BAD_MESSAGE', 'Player name is empty.', message.requestId);
      return;
    }
    session.playerId = this.idFactory('player');
    session.name = name;
    session.loadout = cloneLoadout(message.loadout);
    this.send(session, {
      type: 'welcome',
      version: ONLINE_PROTOCOL_VERSION,
      playerId: session.playerId,
      serverTime: this.now(),
    });
    this.send(session, { type: 'rooms', rooms: this.listRoomSummaries() });
  }

  private createRoom(session: PlayerSession, settings: OnlineRoomSettings, requestId?: string): void {
    if (session.roomId) {
      this.sendError(session, 'ALREADY_IN_ROOM', 'Leave the current room first.', requestId);
      return;
    }
    if (this.rooms.size >= this.maxRooms) {
      this.sendError(session, 'RATE_LIMITED', 'The online room capacity is temporarily full.', requestId);
      return;
    }
    const playerId = session.playerId as PlayerId;
    const createdAt = this.now();
    const room: LobbyRoom = {
      id: this.idFactory('room'),
      code: this.makeUniqueRoomCode(),
      hostId: playerId,
      phase: 'lobby',
      settings: { ...settings },
      members: new Map(),
      chat: [],
      createdAt,
      lastActivityAt: createdAt,
      revision: 1,
      match: null,
    };
    room.members.set(playerId, this.makeMember(session));
    session.roomId = room.id;
    this.rooms.set(room.id, room);
    this.roomIdsByCode.set(room.code, room.id);
    this.broadcastSnapshot(room);
    this.broadcastRoomList();
  }

  private joinRoom(session: PlayerSession, rawCode: string, requestId?: string): void {
    if (session.roomId) {
      this.sendError(session, 'ALREADY_IN_ROOM', 'Leave the current room first.', requestId);
      return;
    }
    const code = rawCode.trim().toUpperCase();
    const room = this.rooms.get(this.roomIdsByCode.get(code) ?? '');
    if (!room) {
      this.sendError(session, 'ROOM_NOT_FOUND', 'Room code does not exist.', requestId);
      return;
    }
    if (room.phase !== 'lobby') {
      this.sendError(session, 'ROOM_RUNNING', 'This race has already started.', requestId);
      return;
    }
    if (room.members.size >= room.settings.playerSlots) {
      this.sendError(session, 'ROOM_FULL', 'All human slots are occupied.', requestId);
      return;
    }
    const playerId = session.playerId as PlayerId;
    room.members.set(playerId, this.makeMember(session));
    session.roomId = room.id;
    this.touchRoom(room);
    room.revision += 1;
    this.broadcastSnapshot(room);
    this.broadcastRoomList();
  }

  private leaveRoom(session: PlayerSession, requestId?: string): void {
    if (!session.roomId) {
      this.sendError(session, 'NOT_IN_ROOM', 'The player is not in a room.', requestId);
      return;
    }
    this.removeFromRoom(session, 'left', true);
  }

  private updateSettings(session: PlayerSession, settings: OnlineRoomSettings, requestId?: string): void {
    const room = this.requireRoom(session, requestId);
    if (!room) return;
    if (!this.requireHost(room, session, requestId)) return;
    if (room.phase !== 'lobby') {
      this.sendError(session, 'ROOM_RUNNING', 'Settings are locked after race start.', requestId);
      return;
    }
    if (settings.playerSlots < room.members.size) {
      this.sendError(session, 'INVALID_SETTINGS', 'Player slots cannot be lower than current occupancy.', requestId);
      return;
    }
    room.settings = { ...settings };
    for (const member of room.members.values()) member.ready = false;
    room.revision += 1;
    this.touchRoom(room);
    this.broadcastSnapshot(room);
    this.broadcastRoomList();
  }

  private updateReady(session: PlayerSession, ready: boolean, requestId?: string): void {
    const room = this.requireRoom(session, requestId);
    if (!room) return;
    if (room.phase !== 'lobby') {
      this.sendError(session, 'ROOM_RUNNING', 'Ready state is locked after race start.', requestId);
      return;
    }
    const member = room.members.get(session.playerId as PlayerId);
    if (!member) return;
    member.ready = ready;
    room.revision += 1;
    this.touchRoom(room);
    this.broadcastSnapshot(room);
  }

  private sendChat(session: PlayerSession, rawText: string, requestId?: string): void {
    const room = this.requireRoom(session, requestId);
    if (!room) return;
    const now = this.now();
    if (now - session.lastChatAt < this.chatCooldownMs) {
      this.sendError(session, 'RATE_LIMITED', 'Chat messages are being sent too quickly.', requestId);
      return;
    }
    const text = normalizeChatText(rawText);
    if (!text) {
      this.sendError(session, 'BAD_MESSAGE', 'Chat message is empty.', requestId);
      return;
    }
    session.lastChatAt = now;
    this.touchRoom(room, now);
    const message: OnlineChatMessage = {
      id: this.idFactory('chat'),
      playerId: session.playerId as PlayerId,
      playerName: session.name as string,
      text,
      sentAt: now,
    };
    room.chat.push(message);
    if (room.chat.length > ONLINE_LIMITS.chatHistory) room.chat.splice(0, room.chat.length - ONLINE_LIMITS.chatHistory);
    this.broadcast(room, { type: 'chat:message', roomId: room.id, message });
  }

  private startRace(session: PlayerSession, requestId?: string): void {
    const room = this.requireRoom(session, requestId);
    if (!room) return;
    if (!this.requireHost(room, session, requestId)) return;
    if (room.phase !== 'lobby') {
      this.sendError(session, 'ROOM_RUNNING', 'This room already has an active race.', requestId);
      return;
    }
    if (room.members.size < 2) {
      this.sendError(session, 'NOT_ENOUGH_PLAYERS', 'At least two human players are required.', requestId);
      return;
    }

    const seed = Math.floor(this.random() * 0x1_0000_0000) >>> 0;
    const config: AuthoritativeRaceConfig = {
      id: this.idFactory('match'),
      roomId: room.id,
      roomCode: room.code,
      track: room.settings.track,
      seed,
      aiOpponents: room.settings.aiOpponents,
      startsAt: this.now() + this.startDelayMs,
      humans: [...room.members.entries()].map(([playerId, member]) => ({
        kind: 'human',
        id: playerId,
        name: member.session.name as string,
        runConfig: {
          track: room.settings.track,
          seed,
          ...cloneLoadout(member.session.loadout as OnlineLoadout),
        },
      })),
      bots: Array.from({ length: room.settings.aiOpponents }, (_, index) => ({
        kind: 'ai',
        id: `ai-${room.id}-${index + 1}`,
        name: `GHOST ${String(index + 1).padStart(2, '0')}`,
        difficulty: Math.min(1, 0.5 + index * 0.07),
      })),
    };

    room.phase = 'racing';
    room.match = config;
    room.revision += 1;
    this.touchRoom(room);
    for (const member of room.members.values()) {
      member.lastStateSequence = -1;
      member.lastStateAt = Number.NEGATIVE_INFINITY;
      member.finished = false;
    }
    this.broadcastSnapshot(room);
    this.broadcast(room, { type: 'race:started', config });
    this.broadcastRoomList();
  }

  private relayRaceState(session: PlayerSession, state: ClientRaceState, requestId?: string): void {
    const room = this.requireRoom(session, requestId);
    if (!room) return;
    const member = room.members.get(session.playerId as PlayerId);
    if (!member) return;
    const terminal = state.destroyed || state.finished;
    if (terminal && member.terminalMatchId === state.matchId) return;
    if (room.phase !== 'racing' || !room.match || room.match.id !== state.matchId) {
      this.sendError(session, 'MATCH_MISMATCH', 'State does not belong to the active match.', requestId);
      return;
    }
    if (member.finished) return;
    if (state.sequence <= member.lastStateSequence) {
      this.sendError(session, 'STALE_STATE', 'Race state sequence is stale.', requestId);
      return;
    }
    const now = this.now();
    if (!terminal && now - member.lastStateAt < this.stateIntervalMs) return;
    member.lastStateSequence = state.sequence;
    member.lastStateAt = now;
    member.finished = terminal;
    if (terminal) member.terminalMatchId = state.matchId;
    this.touchRoom(room, now);

    const safeState = {
      ...state,
      angle: normalizeAngle(state.angle),
      progress: Math.min(1, state.progress),
      score: Math.floor(state.score),
      playerId: session.playerId as PlayerId,
      playerName: session.name as string,
      serverTime: now,
    };
    this.broadcast(room, { type: 'race:state', state: safeState }, session.playerId as PlayerId);
    if (terminal) this.finishRaceIfComplete(room);
  }

  private requireRoom(session: PlayerSession, requestId?: string): LobbyRoom | null {
    const room = session.roomId ? this.rooms.get(session.roomId) : null;
    if (!room) {
      session.roomId = null;
      this.sendError(session, 'NOT_IN_ROOM', 'The player is not in a room.', requestId);
      return null;
    }
    return room;
  }

  private requireHost(room: LobbyRoom, session: PlayerSession, requestId?: string): boolean {
    if (room.hostId === session.playerId) return true;
    this.sendError(session, 'HOST_ONLY', 'Only the room host can perform this action.', requestId);
    return false;
  }

  private removeFromRoom(session: PlayerSession, reason: 'left' | 'disconnected', notifyLeavingPlayer: boolean): void {
    const room = this.rooms.get(session.roomId as string);
    const playerId = session.playerId as PlayerId;
    session.roomId = null;
    if (!room) return;
    room.members.delete(playerId);
    room.revision += 1;
    if (notifyLeavingPlayer) this.send(session, { type: 'room:left', roomId: room.id, reason });

    if (room.members.size === 0) {
      this.rooms.delete(room.id);
      this.roomIdsByCode.delete(room.code);
      this.broadcastRoomList();
      return;
    }

    this.touchRoom(room);

    if (room.hostId === playerId) {
      const nextHost = [...room.members.entries()]
        .sort((a, b) => a[1].joinOrder - b[1].joinOrder)[0]?.[0];
      if (nextHost) {
        room.hostId = nextHost;
        this.broadcast(room, { type: 'host:changed', roomId: room.id, hostId: nextHost });
      }
    }
    if (this.finishRaceIfComplete(room)) return;
    this.broadcastSnapshot(room);
    this.broadcastRoomList();
  }

  private finishRaceIfComplete(room: LobbyRoom): boolean {
    if (room.phase !== 'racing'
      || room.members.size === 0
      || ![...room.members.values()].every((candidate) => candidate.finished)) return false;
    room.phase = 'lobby';
    room.match = null;
    room.revision += 1;
    this.touchRoom(room);
    for (const candidate of room.members.values()) {
      candidate.finished = false;
      candidate.ready = false;
      candidate.lastStateSequence = -1;
      candidate.lastStateAt = Number.NEGATIVE_INFINITY;
    }
    this.broadcastSnapshot(room);
    this.broadcastRoomList();
    return true;
  }

  private makeMember(session: PlayerSession): RoomMember {
    this.joinOrder += 1;
    return {
      session,
      ready: false,
      joinedAt: this.now(),
      joinOrder: this.joinOrder,
      lastStateSequence: -1,
      lastStateAt: Number.NEGATIVE_INFINITY,
      finished: false,
      terminalMatchId: null,
    };
  }

  private snapshot(room: LobbyRoom): OnlineRoomSnapshot {
    const players: OnlinePlayer[] = [...room.members.entries()]
      .sort((a, b) => a[1].joinOrder - b[1].joinOrder)
      .map(([playerId, member]) => ({
        id: playerId,
        name: member.session.name as string,
        isHost: playerId === room.hostId,
        ready: member.ready,
        joinedAt: member.joinedAt,
      }));
    return {
      id: room.id,
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      settings: { ...room.settings },
      players,
      chat: room.chat.map((message) => ({ ...message })),
      createdAt: room.createdAt,
      revision: room.revision,
    };
  }

  private broadcastSnapshot(room: LobbyRoom): void {
    this.broadcast(room, { type: 'room:snapshot', room: this.snapshot(room) });
  }

  private broadcastRoomList(): void {
    const message: ServerMessage = { type: 'rooms', rooms: this.listRoomSummaries() };
    for (const session of this.sessions.values()) {
      if (session.playerId) this.send(session, message);
    }
  }

  private broadcast(room: LobbyRoom, message: ServerMessage, excludePlayerId?: PlayerId): void {
    const payload = encodeOnlineMessage(message);
    for (const [playerId, member] of room.members) {
      if (playerId !== excludePlayerId) member.session.peer.send(payload);
    }
  }

  private send(session: PlayerSession, message: ServerMessage): void {
    session.peer.send(encodeOnlineMessage(message));
  }

  private sendError(
    session: PlayerSession,
    code: Extract<ServerMessage, { type: 'error' }>['code'],
    message: string,
    requestId?: string,
  ): void {
    this.send(session, { type: 'error', code, message, requestId });
  }

  private consumeCommandToken(session: PlayerSession): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - session.lastCommandAt);
    session.lastCommandAt = now;
    session.commandTokens = Math.min(
      this.commandRateBurst,
      session.commandTokens + elapsed * this.commandRatePerSecond / 1_000,
    );
    if (session.commandTokens < 1) return false;
    session.commandTokens -= 1;
    return true;
  }

  private touchRoom(room: LobbyRoom, at = this.now()): void {
    room.lastActivityAt = at;
  }

  private makeUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      let code = this.roomCodeFactory?.().trim().toUpperCase() ?? '';
      if (!code) {
        code = Array.from({ length: 6 }, () => {
          const index = Math.floor(this.random() * ROOM_CODE_ALPHABET.length);
          return ROOM_CODE_ALPHABET[Math.max(0, Math.min(ROOM_CODE_ALPHABET.length - 1, index))];
        }).join('');
      }
      code = code.replace(/[^A-Z0-9-]/g, '').slice(0, ONLINE_LIMITS.roomCode);
      if (code.length >= 4 && !this.roomIdsByCode.has(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code.');
  }

  private readHelloVersion(raw: string | unknown): number | null {
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
      if (typeof value !== 'object' || value === null) return null;
      const record = value as Record<string, unknown>;
      return record.type === 'hello' && typeof record.version === 'number' ? record.version : null;
    } catch {
      return null;
    }
  }
}
