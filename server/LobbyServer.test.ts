import { describe, expect, it } from 'vitest';
import type { LobbyPeer } from './LobbyServer.ts';
import { LobbyServer } from './LobbyServer.ts';
import type { ClientMessage, OnlineLoadout, ServerMessage } from '../src/online/protocol.ts';
import { ONLINE_PROTOCOL_VERSION, decodeServerMessage, encodeOnlineMessage } from '../src/online/protocol.ts';

class FakePeer implements LobbyPeer {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly id: string) {}
  send(payload: string): void {
    const decoded = decodeServerMessage(payload);
    if (!decoded.ok) throw new Error(decoded.error);
    this.sent.push(decoded.value);
  }
  close(code: number, reason: string): void { this.closed = { code, reason }; }
  messages<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.sent.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.messages(type).at(-1);
  }
}

const loadout: OnlineLoadout = {
  weapon: 'pulse', ability: 'phase',
  garage: { credits: 25, engine: 1, cooling: 2, shield: 3, weapon: 4, bestScore: 500, runs: 6 },
};

function makeHarness(options: {
  maxRooms?: number;
  commandRatePerSecond?: number;
  commandRateBurst?: number;
} = {}) {
  let time = 10_000;
  const ids = new Map<string, number>();
  let code = 120;
  const server = new LobbyServer({
    now: () => time,
    random: () => 0.25,
    chatCooldownMs: 0,
    startDelayMs: 1_500,
    maxRooms: options.maxRooms,
    commandRatePerSecond: options.commandRatePerSecond,
    commandRateBurst: options.commandRateBurst,
    idFactory: (prefix) => {
      const next = (ids.get(prefix) ?? 0) + 1;
      ids.set(prefix, next);
      return `${prefix}-${next}`;
    },
    roomCodeFactory: () => `ROOM${code++}`,
  });
  const send = (peer: FakePeer, message: ClientMessage) => server.receive(peer.id, encodeOnlineMessage(message));
  const addPlayer = (id: string, name: string, playerLoadout = loadout) => {
    const peer = new FakePeer(id);
    server.connect(peer);
    send(peer, { type: 'hello', version: ONLINE_PROTOCOL_VERSION, name, loadout: playerLoadout });
    return peer;
  };
  return { server, send, addPlayer, advance: (ms: number) => { time += ms; } };
}

describe('LobbyServer rooms', () => {
  it('creates, joins, chats and starts with a server-authored RunConfig', () => {
    const { send, addPlayer } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    const guest = addPlayer('c-guest', 'Guest', { ...loadout, weapon: 'rail' });
    send(host, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 2, playerSlots: 4 } });
    const created = host.last('room:snapshot')!.room;
    send(guest, { type: 'room:join', code: created.code });
    expect(host.last('room:snapshot')!.room.players).toHaveLength(2);

    send(guest, { type: 'room:settings', settings: { track: 'void', aiOpponents: 1, playerSlots: 3 } });
    expect(guest.last('error')?.code).toBe('HOST_ONLY');
    send(host, { type: 'room:settings', settings: { track: 'void', aiOpponents: 1, playerSlots: 3 } });
    send(guest, { type: 'chat:send', text: '  ready\n  now  ' });
    expect(host.last('chat:message')?.message.text).toBe('ready now');

    // Ready flags are advisory: the user's rule is that the host may start at
    // any time once more than one human is present.
    send(host, { type: 'race:start' });
    const race = host.last('race:started')!.config;
    expect(race).toEqual(expect.objectContaining({
      track: 'void', aiOpponents: 1, seed: 0x40000000, startsAt: 11_500,
    }));
    expect(race.humans).toHaveLength(2);
    expect(race.humans[0].runConfig).toEqual(expect.objectContaining({ track: 'void', seed: race.seed }));
    expect(race.humans[1].runConfig.weapon).toBe('rail');
    expect(race.humans[0].runConfig.garage).not.toBe(loadout.garage);
    expect(host.last('room:snapshot')!.room.phase).toBe('racing');
  });

  it('requires two humans and rejects joins after the authoritative start', () => {
    const { send, addPlayer } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    send(host, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 0, playerSlots: 2 } });
    const code = host.last('room:snapshot')!.room.code;
    send(host, { type: 'race:start' });
    expect(host.last('error')?.code).toBe('NOT_ENOUGH_PLAYERS');

    const guest = addPlayer('c-guest', 'Guest');
    send(guest, { type: 'room:join', code });
    send(host, { type: 'race:start' });
    const late = addPlayer('c-late', 'Late');
    send(late, { type: 'room:join', code });
    expect(late.last('error')?.code).toBe('ROOM_RUNNING');
  });

  it('migrates host ownership to the earliest remaining player', () => {
    const { server, send, addPlayer } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    const second = addPlayer('c-second', 'Second');
    const third = addPlayer('c-third', 'Third');
    send(host, { type: 'room:create', settings: { track: 'reactor', aiOpponents: 0, playerSlots: 4 } });
    const code = host.last('room:snapshot')!.room.code;
    send(second, { type: 'room:join', code });
    send(third, { type: 'room:join', code });
    const secondId = second.last('welcome')!.playerId;

    server.disconnect(host.id);
    expect(second.last('host:changed')).toEqual(expect.objectContaining({ hostId: secondId }));
    expect(second.last('room:snapshot')!.room.players.find((player) => player.id === secondId)?.isHost).toBe(true);
    send(second, { type: 'room:settings', settings: { track: 'void', aiOpponents: 3, playerSlots: 4 } });
    expect(second.last('room:snapshot')!.room.settings.track).toBe('void');
  });

  it('caps concurrently allocated rooms', () => {
    const { send, addPlayer } = makeHarness({ maxRooms: 1 });
    const first = addPlayer('c-first', 'First');
    const second = addPlayer('c-second', 'Second');
    send(first, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 0, playerSlots: 2 } });
    send(second, { type: 'room:create', settings: { track: 'void', aiOpponents: 0, playerSlots: 2 } });
    expect(first.last('room:snapshot')?.room.code).toBeTruthy();
    expect(second.last('error')?.code).toBe('RATE_LIMITED');
  });

  it('lists only joinable lobby rooms with the newest activity first', () => {
    const { server, send, addPlayer, advance } = makeHarness();
    const oldHost = addPlayer('c-old', 'Old host');
    const newHost = addPlayer('c-new', 'New host');
    const filler = addPlayer('c-fill', 'Filler');
    send(oldHost, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 0, playerSlots: 3 } });
    const oldCode = oldHost.last('room:snapshot')!.room.code;
    advance(100);
    send(newHost, { type: 'room:create', settings: { track: 'void', aiOpponents: 0, playerSlots: 2 } });
    const newCode = newHost.last('room:snapshot')!.room.code;

    expect(server.listRoomSummaries().map((room) => room.code)).toEqual([newCode, oldCode]);
    send(filler, { type: 'room:join', code: newCode });
    expect(server.listRoomSummaries().map((room) => room.code)).toEqual([oldCode]);
  });

  it('expires idle rooms and releases their connected members', () => {
    const { server, send, addPlayer, advance } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    send(host, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 0, playerSlots: 3 } });
    const code = host.last('room:snapshot')!.room.code;

    advance(999);
    expect(server.expireIdleRooms(1_000)).toBe(0);
    send(host, { type: 'player:ready', ready: true });
    advance(999);
    expect(server.expireIdleRooms(1_000)).toBe(0);
    advance(1);
    expect(server.expireIdleRooms(1_000)).toBe(1);
    expect(host.last('room:left')).toEqual(expect.objectContaining({ reason: 'closed' }));
    expect(server.getRoomSnapshot(code)).toBeNull();
  });

  it('rate-limits command bursts per connection', () => {
    const { send, addPlayer } = makeHarness({ commandRatePerSecond: 1, commandRateBurst: 2 });
    const player = addPlayer('c-player', 'Player');
    send(player, { type: 'rooms:list', requestId: 'allowed' });
    send(player, { type: 'rooms:list', requestId: 'limited' });
    expect(player.last('error')).toEqual(expect.objectContaining({
      code: 'RATE_LIMITED', requestId: 'limited',
    }));
  });
});

describe('LobbyServer race state relay', () => {
  it('broadcasts normalized sequenced state only to other racers', () => {
    const { send, addPlayer, advance } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    const guest = addPlayer('c-guest', 'Guest');
    send(host, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 0, playerSlots: 2 } });
    send(guest, { type: 'room:join', code: host.last('room:snapshot')!.room.code });
    send(host, { type: 'race:start' });
    const matchId = host.last('race:started')!.config.id;
    const state = {
      matchId, sequence: 1, angle: Math.PI * 3, progress: 0.5, speed: 2_400,
      shield: 3, heat: 20, flux: 80, score: 44.8, rank: 2, section: 1,
      destroyed: false, finished: false,
    };
    send(host, { type: 'race:state', state });
    expect(guest.last('race:state')?.state).toEqual(expect.objectContaining({
      score: 44, sequence: 1,
      playerId: host.last('welcome')!.playerId,
    }));
    expect(guest.last('race:state')!.state.angle).toBeCloseTo(Math.PI, 12);
    expect(host.messages('race:state')).toHaveLength(0);

    advance(100);
    send(host, { type: 'race:state', state });
    expect(host.last('error')?.code).toBe('STALE_STATE');
  });

  it('returns the room to the lobby after every human reaches a terminal state', () => {
    const { send, addPlayer, advance } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    const guest = addPlayer('c-guest', 'Guest');
    send(host, { type: 'room:create', settings: { track: 'aurora', aiOpponents: 1, playerSlots: 3 } });
    send(guest, { type: 'room:join', code: host.last('room:snapshot')!.room.code });
    send(host, { type: 'race:start' });
    const matchId = host.last('race:started')!.config.id;
    const terminal = {
      matchId, sequence: 1, angle: 0, progress: 1, speed: 0,
      shield: 1, heat: 0, flux: 20, score: 1200, rank: 1, section: 3,
      destroyed: false, finished: true,
    };
    send(host, { type: 'race:state', state: terminal });
    expect(host.last('room:snapshot')!.room.phase).toBe('racing');
    const guestRelayCount = guest.messages('race:state').length;
    const hostErrorCount = host.messages('error').length;
    send(host, { type: 'race:state', state: terminal });
    expect(guest.messages('race:state')).toHaveLength(guestRelayCount);
    expect(host.messages('error')).toHaveLength(hostErrorCount);
    advance(100);
    send(guest, { type: 'race:state', state: { ...terminal, rank: 2 } });
    expect(host.last('room:snapshot')!.room.phase).toBe('lobby');
    expect(guest.last('room:snapshot')!.room.players.every((player) => !player.ready)).toBe(true);
    const guestErrorCount = guest.messages('error').length;
    send(guest, { type: 'race:state', state: { ...terminal, rank: 2 } });
    expect(guest.messages('error')).toHaveLength(guestErrorCount);
  });

  it('finalizes a race when the only unfinished human disconnects', () => {
    const { server, send, addPlayer } = makeHarness();
    const host = addPlayer('c-host', 'Host');
    const guest = addPlayer('c-guest', 'Guest');
    send(host, { type: 'room:create', settings: { track: 'reactor', aiOpponents: 0, playerSlots: 2 } });
    send(guest, { type: 'room:join', code: host.last('room:snapshot')!.room.code });
    send(host, { type: 'race:start' });
    const matchId = host.last('race:started')!.config.id;
    send(host, {
      type: 'race:state',
      state: {
        matchId, sequence: 1, angle: 0, progress: 1, speed: 0,
        shield: 1, heat: 0, flux: 0, score: 900, rank: 1, section: 3,
        destroyed: false, finished: true,
      },
    });
    expect(host.last('room:snapshot')!.room.phase).toBe('racing');
    server.disconnect(guest.id);
    expect(host.last('room:snapshot')!.room.phase).toBe('lobby');
    expect(host.last('room:snapshot')!.room.players).toHaveLength(1);
  });
});
