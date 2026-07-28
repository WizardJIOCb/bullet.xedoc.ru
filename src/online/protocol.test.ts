import { describe, expect, it } from 'vitest';
import type { OnlineLoadout, ServerMessage } from './protocol';
import {
  ONLINE_LIMITS,
  ONLINE_PROTOCOL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encodeOnlineMessage,
  normalizeChatText,
  normalizePlayerName,
} from './protocol';

const loadout: OnlineLoadout = {
  weapon: 'pulse',
  ability: 'phase',
  garage: {
    credits: 100,
    engine: 1,
    cooling: 2,
    shield: 3,
    weapon: 4,
    bestScore: 5_000,
    runs: 6,
  },
};

describe('online protocol boundary', () => {
  it('accepts a complete hello and rejects malformed nested loadouts', () => {
    const valid = decodeClientMessage(JSON.stringify({
      type: 'hello',
      version: ONLINE_PROTOCOL_VERSION,
      name: 'Nova',
      loadout,
    }));
    expect(valid.ok).toBe(true);

    const invalid = decodeClientMessage({
      type: 'hello',
      version: ONLINE_PROTOCOL_VERSION,
      name: 'Nova',
      loadout: { ...loadout, garage: { ...loadout.garage, shield: Number.NaN } },
    });
    expect(invalid).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects invalid room and race state ranges', () => {
    expect(decodeClientMessage({
      type: 'room:create',
      settings: { track: 'missing', aiOpponents: 0, playerSlots: 4 },
    }).ok).toBe(false);

    expect(decodeClientMessage({
      type: 'race:state',
      state: {
        matchId: 'm1', sequence: 1, angle: 0, progress: 4, speed: 100,
        shield: 2, heat: 0, flux: 100, score: 20, rank: 1, section: 1,
        destroyed: false, finished: false,
      },
    }).ok).toBe(false);
  });

  it('round-trips validated server room messages', () => {
    const message: ServerMessage = {
      type: 'room:snapshot',
      room: {
        id: 'room-1',
        code: 'ABC234',
        hostId: 'player-1',
        phase: 'lobby',
        settings: { track: 'aurora', aiOpponents: 2, playerSlots: 4 },
        players: [{ id: 'player-1', name: 'Nova', isHost: true, ready: false, joinedAt: 10 }],
        chat: [],
        createdAt: 10,
        revision: 1,
      },
    };
    expect(decodeServerMessage(encodeOnlineMessage(message))).toEqual({ ok: true, value: message });
  });

  it('normalizes display strings without allowing control characters', () => {
    expect(normalizePlayerName('  Nova\n\tPrime  ')).toBe('Nova Prime');
    expect(normalizeChatText(' boost\u0000   now ')).toBe('boost now');
  });

  it('accepts legal large server snapshots while keeping client frames at 16 KiB', () => {
    const chat = Array.from({ length: ONLINE_LIMITS.chatHistory }, (_, index) => ({
      id: `chat-${index}-${'x'.repeat(65)}`,
      playerId: `player-${index}-${'y'.repeat(63)}`,
      playerName: `Pilot ${index}`.padEnd(ONLINE_LIMITS.playerName, 'Z'),
      text: 'm'.repeat(ONLINE_LIMITS.chatMessage),
      sentAt: 100 + index,
    }));
    const message: ServerMessage = {
      type: 'room:snapshot',
      room: {
        id: 'room-large', code: 'BIG234', hostId: 'player-host', phase: 'lobby',
        settings: { track: 'void', aiOpponents: 3, playerSlots: 4 },
        players: [{ id: 'player-host', name: 'Host', isHost: true, ready: false, joinedAt: 10 }],
        chat, createdAt: 10, revision: 3,
      },
    };
    const encoded = encodeOnlineMessage(message);
    expect(encoded.length).toBeGreaterThan(ONLINE_LIMITS.clientMessageBytes);
    expect(encoded.length).toBeLessThan(ONLINE_LIMITS.serverMessageBytes);
    expect(decodeServerMessage(encoded)).toEqual({ ok: true, value: message });
    expect(decodeClientMessage(encoded).ok).toBe(false);
  });
});
