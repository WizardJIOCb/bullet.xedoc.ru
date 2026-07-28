import type { ClientMessage, OnlineLoadout, OnlineRoomSettings, ClientRaceState, ServerMessage } from './protocol';
import {
  ONLINE_LIMITS,
  ONLINE_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeOnlineMessage,
  normalizePlayerName,
} from './protocol';

export type LobbyConnectionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface LobbySocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface LobbySocket {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: LobbySocketEvent) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: LobbySocketEvent) => void): void;
}

export type LobbySocketFactory = (url: string) => LobbySocket;

export interface LobbyClientOptions {
  url: string;
  name: string;
  loadout: OnlineLoadout;
  socketFactory?: LobbySocketFactory;
  autoReconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
  wallNow?: () => number;
}

export interface LobbyConnectionEvent {
  state: LobbyConnectionState;
  attempt: number;
  reason?: string;
}

export interface LobbyProtocolError {
  message: string;
  raw?: unknown;
}

export interface LobbyClientEvents {
  connection: LobbyConnectionEvent;
  message: ServerMessage;
  rooms: Extract<ServerMessage, { type: 'rooms' }>;
  room: Extract<ServerMessage, { type: 'room:snapshot' }>;
  roomLeft: Extract<ServerMessage, { type: 'room:left' }>;
  chat: Extract<ServerMessage, { type: 'chat:message' }>;
  hostChanged: Extract<ServerMessage, { type: 'host:changed' }>;
  raceStarted: Extract<ServerMessage, { type: 'race:started' }>;
  raceState: Extract<ServerMessage, { type: 'race:state' }>;
  rejoinFailed: Extract<ServerMessage, { type: 'error' }>;
  serverError: Extract<ServerMessage, { type: 'error' }>;
  protocolError: LobbyProtocolError;
}

type Listener<K extends keyof LobbyClientEvents> = (event: LobbyClientEvents[K]) => void;
type ListenerRegistry = { [K in keyof LobbyClientEvents]: Set<Listener<K>> };

const SOCKET_OPEN = 1;

function browserSocketFactory(url: string): LobbySocket {
  return new WebSocket(url) as unknown as LobbySocket;
}

export function defaultLobbyUrl(locationLike: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/multiplayer`;
}

export class LobbyClient {
  private readonly options: Required<Pick<LobbyClientOptions,
    'autoReconnect' | 'reconnectBaseMs' | 'reconnectMaxMs' | 'now' | 'wallNow'
  >> & LobbyClientOptions;

  private readonly listeners: ListenerRegistry = {
    connection: new Set(),
    message: new Set(),
    rooms: new Set(),
    room: new Set(),
    roomLeft: new Set(),
    chat: new Set(),
    hostChanged: new Set(),
    raceStarted: new Set(),
    raceState: new Set(),
    rejoinFailed: new Set(),
    serverError: new Set(),
    protocolError: new Set(),
  };

  private socket: LobbySocket | null = null;
  private state: LobbyConnectionState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private requestSequence = 0;
  private raceSequence = 0;
  private lastRaceStateAt = Number.NEGATIVE_INFINITY;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private desiredRoomCode: string | null = null;
  private pendingJoin: { requestId: string; code: string; rejoin: boolean } | null = null;
  private terminalMatchId: string | null = null;
  private awaitingWelcome = false;
  private readonly pendingPings = new Map<string, number>();

  playerId: string | null = null;
  serverClockOffsetMs = 0;

  constructor(options: LobbyClientOptions) {
    const name = normalizePlayerName(options.name);
    if (!name) throw new Error('Online player name must not be empty.');
    this.options = {
      ...options,
      name,
      autoReconnect: options.autoReconnect ?? true,
      reconnectBaseMs: options.reconnectBaseMs ?? 600,
      reconnectMaxMs: options.reconnectMaxMs ?? 8_000,
      now: options.now ?? (() => performance.now()),
      wallNow: options.wallNow ?? Date.now,
    };
  }

  get connectionState(): LobbyConnectionState {
    return this.state;
  }

  estimatedServerTime(): number {
    return this.options.wallNow() + this.serverClockOffsetMs;
  }

  delayUntil(serverTimestamp: number): number {
    return Math.max(0, serverTimestamp - this.estimatedServerTime());
  }

  on<K extends keyof LobbyClientEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener as never);
    return () => this.listeners[event].delete(listener as never);
  }

  connect(): Promise<void> {
    if (this.state === 'online') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.intentionallyClosed = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.openSocket(false);
    return this.connectPromise;
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.cancelRoomRejoin();
    this.awaitingWelcome = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.detachSocket();
    if (socket && socket.readyState <= SOCKET_OPEN) socket.close(1000, 'client disconnect');
    this.rejectPendingConnect(new Error('Lobby connection was closed.'));
    this.setState('closed', 'client disconnect');
  }

  listRooms(): void {
    this.send({ type: 'rooms:list', requestId: this.nextRequestId() });
  }

  createRoom(settings: OnlineRoomSettings): void {
    this.cancelRoomRejoin();
    this.send({ type: 'room:create', settings, requestId: this.nextRequestId() });
  }

  joinRoom(code: string): void {
    this.requestRoomJoin(code, false);
  }

  leaveRoom(): void {
    this.cancelRoomRejoin();
    this.send({ type: 'room:leave', requestId: this.nextRequestId() });
  }

  /** Cancels a queued automatic room rejoin even while the socket is offline. */
  cancelRoomRejoin(): void {
    this.desiredRoomCode = null;
    this.pendingJoin = null;
  }

  updateRoomSettings(settings: OnlineRoomSettings): void {
    this.send({ type: 'room:settings', settings, requestId: this.nextRequestId() });
  }

  setReady(ready: boolean): void {
    this.send({ type: 'player:ready', ready, requestId: this.nextRequestId() });
  }

  sendChat(text: string): void {
    this.send({ type: 'chat:send', text, requestId: this.nextRequestId() });
  }

  startRace(): void {
    this.send({ type: 'race:start', requestId: this.nextRequestId() });
  }

  /**
   * Sends at most ONLINE_LIMITS.stateHz snapshots per second. The first
   * terminal state bypasses the throttle, then that match is terminal locally.
   */
  sendRaceState(state: Omit<ClientRaceState, 'sequence'>): boolean {
    const now = this.options.now();
    const interval = 1_000 / ONLINE_LIMITS.stateHz;
    const terminal = state.destroyed || state.finished;
    if (this.terminalMatchId === state.matchId) return false;
    if (!terminal && now - this.lastRaceStateAt < interval) return false;
    this.lastRaceStateAt = now;
    this.raceSequence += 1;
    this.send({ type: 'race:state', state: { ...state, sequence: this.raceSequence } });
    if (terminal) this.terminalMatchId = state.matchId;
    return true;
  }

  ping(nonce = `${this.options.wallNow().toString(36)}-${this.requestSequence.toString(36)}`): void {
    this.pendingPings.set(nonce, this.options.wallNow());
    if (this.pendingPings.size > 8) this.pendingPings.delete(this.pendingPings.keys().next().value as string);
    this.send({ type: 'ping', nonce });
  }

  private openSocket(reconnecting: boolean): void {
    if (this.intentionallyClosed) return;
    this.setState(reconnecting ? 'reconnecting' : 'connecting');
    this.awaitingWelcome = true;
    const factory = this.options.socketFactory ?? browserSocketFactory;
    let socket: LobbySocket;
    try {
      socket = factory(this.options.url);
    } catch (error) {
      this.handleConnectionFailure(error instanceof Error ? error.message : 'Unable to create WebSocket.');
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  private readonly handleOpen = (): void => {
    this.rawSend({
      type: 'hello',
      version: ONLINE_PROTOCOL_VERSION,
      name: this.options.name,
      loadout: this.options.loadout,
      requestId: this.nextRequestId(),
    });
  };

  private readonly handleMessage = (event: LobbySocketEvent): void => {
    let raw = event.data;
    if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
    if (typeof raw !== 'string') {
      this.emit('protocolError', { message: 'Lobby server sent a non-text frame.', raw });
      return;
    }
    const decoded = decodeServerMessage(raw);
    if (!decoded.ok) {
      this.emit('protocolError', { message: decoded.error, raw });
      return;
    }
    const message = decoded.value;
    this.emit('message', message);
    switch (message.type) {
      case 'welcome':
        this.awaitingWelcome = false;
        this.playerId = message.playerId;
        this.serverClockOffsetMs = message.serverTime - this.options.wallNow();
        this.reconnectAttempt = 0;
        this.setState('online');
        this.resolvePendingConnect();
        if (this.desiredRoomCode) this.requestRoomJoin(this.desiredRoomCode, true);
        break;
      case 'rooms': this.emit('rooms', message); break;
      case 'room:snapshot':
        this.pendingJoin = null;
        this.desiredRoomCode = message.room.code;
        this.emit('room', message);
        break;
      case 'room:left':
        this.cancelRoomRejoin();
        this.emit('roomLeft', message);
        break;
      case 'chat:message': this.emit('chat', message); break;
      case 'host:changed': this.emit('hostChanged', message); break;
      case 'race:started':
        this.raceSequence = 0;
        this.lastRaceStateAt = Number.NEGATIVE_INFINITY;
        this.terminalMatchId = null;
        this.emit('raceStarted', message);
        break;
      case 'race:state': this.emit('raceState', message); break;
      case 'error': {
        const failedJoin = Boolean(
          this.pendingJoin
          && message.requestId === this.pendingJoin.requestId
          && ['ROOM_NOT_FOUND', 'ROOM_FULL', 'ROOM_RUNNING'].includes(message.code),
        );
        const failedRejoin = failedJoin && this.pendingJoin?.rejoin === true;
        if (failedJoin) {
          this.cancelRoomRejoin();
          if (failedRejoin) this.emit('rejoinFailed', message);
        }
        this.emit('serverError', message);
        if (this.awaitingWelcome && ['VERSION_MISMATCH', 'BAD_MESSAGE', 'ALREADY_IDENTIFIED'].includes(message.code)) {
          this.intentionallyClosed = true;
          this.awaitingWelcome = false;
          const socket = this.socket;
          this.detachSocket();
          socket?.close(1002, message.code.toLowerCase());
          this.rejectPendingConnect(new Error(message.message));
          this.setState('closed', message.message);
        }
        break;
      }
      case 'pong': {
        const sentAt = this.pendingPings.get(message.nonce);
        if (sentAt !== undefined) {
          const midpoint = (sentAt + this.options.wallNow()) * 0.5;
          const sample = message.serverTime - midpoint;
          this.serverClockOffsetMs = this.serverClockOffsetMs * 0.75 + sample * 0.25;
          this.pendingPings.delete(message.nonce);
        }
        break;
      }
    }
  };

  private readonly handleClose = (event: LobbySocketEvent): void => {
    this.detachSocket();
    if (this.intentionallyClosed) return;
    this.awaitingWelcome = false;
    this.playerId = null;
    const reason = event.reason || (event.code ? `socket closed (${event.code})` : 'socket closed');
    this.handleConnectionFailure(reason);
  };

  private readonly handleError = (): void => {
    // Browsers deliberately hide WebSocket error details; close carries the
    // actionable state and is the single place that schedules reconnects.
  };

  private handleConnectionFailure(reason: string): void {
    if (!this.options.autoReconnect || this.intentionallyClosed) {
      this.rejectPendingConnect(new Error(reason));
      this.setState('closed', reason);
      return;
    }
    this.reconnectAttempt += 1;
    this.setState('reconnecting', reason);
    const exponential = this.options.reconnectBaseMs * 2 ** (this.reconnectAttempt - 1);
    const delay = Math.min(exponential, this.options.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private send(message: ClientMessage): void {
    if (this.state !== 'online') throw new Error('LobbyClient is not online.');
    this.rawSend(message);
  }

  private requestRoomJoin(code: string, rejoin: boolean): void {
    const normalized = code.trim().toUpperCase();
    const requestId = this.nextRequestId();
    this.desiredRoomCode = normalized;
    this.pendingJoin = { requestId, code: normalized, rejoin };
    this.send({ type: 'room:join', code: normalized, requestId });
  }

  private rawSend(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      throw new Error('Lobby WebSocket is not open.');
    }
    this.socket.send(encodeOnlineMessage(message));
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `c${this.requestSequence.toString(36)}`;
  }

  private setState(state: LobbyConnectionState, reason?: string): void {
    if (this.state === state && !reason) return;
    this.state = state;
    this.emit('connection', { state, attempt: this.reconnectAttempt, reason });
  }

  private emit<K extends keyof LobbyClientEvents>(event: K, payload: LobbyClientEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload as never);
  }

  private detachSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener('open', this.handleOpen);
    socket.removeEventListener('message', this.handleMessage);
    socket.removeEventListener('close', this.handleClose);
    socket.removeEventListener('error', this.handleError);
    this.socket = null;
  }

  private resolvePendingConnect(): void {
    this.resolveConnect?.();
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  private rejectPendingConnect(error: Error): void {
    this.rejectConnect?.(error);
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }
}
