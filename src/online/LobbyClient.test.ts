import { describe, expect, it, vi } from 'vitest';
import type { LobbySocket, LobbySocketEvent } from './LobbyClient';
import { LobbyClient } from './LobbyClient';
import type { OnlineLoadout, ServerMessage } from './protocol';
import { encodeOnlineMessage, ONLINE_PROTOCOL_VERSION } from './protocol';

class FakeSocket implements LobbySocket {
  readyState = 0;
  binaryType = '';
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: LobbySocketEvent) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: LobbySocketEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: LobbySocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  open(): void { this.readyState = 1; this.emit('open', {}); }
  message(message: ServerMessage | string): void {
    this.emit('message', { data: typeof message === 'string' ? message : encodeOnlineMessage(message) });
  }
  private emit(type: string, event: LobbySocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const loadout: OnlineLoadout = {
  weapon: 'rail', ability: 'emp',
  garage: { credits: 0, engine: 1, cooling: 1, shield: 1, weapon: 1, bestScore: 0, runs: 0 },
};

function roomSnapshot(code = 'ABC234'): Extract<ServerMessage, { type: 'room:snapshot' }> {
  return {
    type: 'room:snapshot',
    room: {
      id: 'r1', code, hostId: 'p1', phase: 'lobby',
      settings: { track: 'aurora', aiOpponents: 1, playerSlots: 4 },
      players: [{ id: 'p1', name: 'Nova', isHost: true, ready: false, joinedAt: 10 }],
      chat: [], createdAt: 10, revision: 1,
    },
  };
}

describe('LobbyClient', () => {
  it('handshakes before becoming online and emits typed room snapshots', async () => {
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: '  Nova  ', loadout,
      socketFactory: () => socket, autoReconnect: false,
    });
    const roomListener = vi.fn();
    client.on('room', roomListener);
    const connected = client.connect();
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual(expect.objectContaining({
      type: 'hello', name: 'Nova', loadout,
    }));
    expect(client.connectionState).toBe('connecting');

    socket.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
    await connected;
    expect(client.connectionState).toBe('online');
    expect(client.playerId).toBe('p1');

    const room = roomSnapshot();
    socket.message(room);
    expect(roomListener).toHaveBeenCalledWith(room);
  });

  it('throttles moving states and sends exactly one terminal state per match', async () => {
    let now = 1_000;
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: 'Nova', loadout,
      socketFactory: () => socket, autoReconnect: false, now: () => now,
    });
    const connected = client.connect();
    socket.open();
    socket.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
    await connected;
    const state = {
      matchId: 'm1', angle: 0, progress: 0.2, speed: 2_000, shield: 3,
      heat: 10, flux: 80, score: 200, rank: 2, section: 1,
      destroyed: false, finished: false,
    };
    expect(client.sendRaceState(state)).toBe(true);
    now += 5;
    expect(client.sendRaceState(state)).toBe(false);
    expect(client.sendRaceState({ ...state, destroyed: true })).toBe(true);
    expect(client.sendRaceState({ ...state, destroyed: true })).toBe(false);
    now += 100;
    expect(client.sendRaceState(state)).toBe(false);
    const states = socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'race:state');
    expect(states.map((message) => message.state.sequence)).toEqual([1, 2]);
  });

  it('emits and caches authoritative terminal echoes on the server clock', async () => {
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: 'Nova', loadout,
      socketFactory: () => socket, autoReconnect: false,
    });
    const terminalListener = vi.fn();
    client.on('raceTerminal', terminalListener);
    const connected = client.connect();
    socket.open();
    socket.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
    await connected;

    const baseState = {
      matchId: 'm1', sequence: 2, angle: 0, progress: 1, speed: 0, shield: 1,
      heat: 20, flux: 40, score: 2_000, rank: 1, section: 3,
      destroyed: false as const, finished: true as const,
    };
    socket.message({
      type: 'race:state',
      state: { ...baseState, playerId: 'p1', playerName: 'Nova', serverTime: 1_500 },
    });
    socket.message({
      type: 'race:state',
      state: {
        ...baseState,
        sequence: 4,
        playerId: 'p2',
        playerName: 'Rift',
        serverTime: 1_490,
      },
    });

    expect(client.getOwnTerminalRaceState('m1')).toEqual(expect.objectContaining({
      playerId: 'p1', serverTime: 1_500, finished: true,
    }));
    expect(client.getTerminalRaceStates('m1').map((state) => state.playerId)).toEqual(['p2', 'p1']);
    expect(terminalListener).toHaveBeenNthCalledWith(1, expect.objectContaining({
      own: true,
      state: expect.objectContaining({ playerId: 'p1', serverTime: 1_500 }),
    }));
    expect(terminalListener).toHaveBeenNthCalledWith(2, expect.objectContaining({
      own: false,
      terminalStates: expect.arrayContaining([
        expect.objectContaining({ playerId: 'p1' }),
        expect.objectContaining({ playerId: 'p2' }),
      ]),
    }));
  });

  it('only reports ROOM_RUNNING as a rejoin failure when it answers the automatic join', async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeSocket();
      const second = new FakeSocket();
      const sockets = [first, second];
      const client = new LobbyClient({
        url: 'ws://test/multiplayer', name: 'Nova', loadout,
        socketFactory: () => sockets.shift()!, reconnectBaseMs: 10, reconnectMaxMs: 10,
      });
      const rejoinFailed = vi.fn();
      client.on('rejoinFailed', rejoinFailed);
      const connected = client.connect();
      first.open();
      first.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
      await connected;
      first.message(roomSnapshot());

      first.message({
        type: 'error', code: 'ROOM_RUNNING', message: 'Ready arrived after start.', requestId: 'ready-command',
      });
      expect(rejoinFailed).not.toHaveBeenCalled();

      first.close(1006, 'network lost');
      vi.advanceTimersByTime(10);
      second.open();
      second.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p2', serverTime: 20 });
      const join = second.sent.map((raw) => JSON.parse(raw)).find((message) => message.type === 'room:join');
      expect(join).toEqual(expect.objectContaining({ code: 'ABC234' }));

      second.message({
        type: 'error', code: 'ROOM_RUNNING', message: 'Race is active.', requestId: join.requestId,
      });
      expect(rejoinFailed).toHaveBeenCalledOnce();
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an explicit leave cancel automatic rejoin while disconnected', async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeSocket();
      const second = new FakeSocket();
      const sockets = [first, second];
      const client = new LobbyClient({
        url: 'ws://test/multiplayer', name: 'Nova', loadout,
        socketFactory: () => sockets.shift()!, reconnectBaseMs: 10, reconnectMaxMs: 10,
      });
      const connected = client.connect();
      first.open();
      first.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
      await connected;
      first.message(roomSnapshot());
      first.close(1006, 'network lost');

      client.cancelRoomRejoin();
      vi.advanceTimersByTime(10);
      second.open();
      second.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p2', serverTime: 20 });
      expect(second.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'room:join')).toEqual([]);
      client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports invalid server frames without dispatching them', async () => {
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: 'Nova', loadout,
      socketFactory: () => socket, autoReconnect: false,
    });
    const protocolError = vi.fn();
    client.on('protocolError', protocolError);
    const connected = client.connect();
    socket.open();
    socket.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10 });
    await connected;
    socket.message('{not-json');
    expect(protocolError).toHaveBeenCalledOnce();
    client.disconnect();
  });

  it('converts authoritative server timestamps into a local countdown delay', async () => {
    let wallNow = 10_000;
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: 'Nova', loadout,
      socketFactory: () => socket, autoReconnect: false, wallNow: () => wallNow,
    });
    const connected = client.connect();
    socket.open();
    socket.message({ type: 'welcome', version: ONLINE_PROTOCOL_VERSION, playerId: 'p1', serverTime: 10_250 });
    await connected;
    expect(client.serverClockOffsetMs).toBe(250);
    expect(client.delayUntil(11_000)).toBe(750);

    client.ping('clock');
    wallNow = 10_100;
    socket.message({ type: 'pong', nonce: 'clock', serverTime: 10_250 });
    expect(client.serverClockOffsetMs).toBeCloseTo(237.5);
  });

  it('rejects connect when the server refuses the handshake', async () => {
    const socket = new FakeSocket();
    const client = new LobbyClient({
      url: 'ws://test/multiplayer', name: 'Nova', loadout,
      socketFactory: () => socket,
    });
    const connected = client.connect();
    socket.open();
    socket.message({
      type: 'error',
      code: 'VERSION_MISMATCH',
      message: 'Protocol version is unsupported.',
    });
    await expect(connected).rejects.toThrow('unsupported');
    expect(client.connectionState).toBe('closed');
    expect(socket.readyState).toBe(3);
  });
});
