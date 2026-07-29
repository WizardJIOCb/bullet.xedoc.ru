import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../core/types';
import { BallisticGame } from './Game';
import { DEATH_MUSIC_FADE_DURATION } from './deathSequence';

interface DeathHarness {
  finishRun: (survived: boolean) => void;
  deliverPendingResult: () => void;
  state: 'playing' | 'dying' | 'finished';
  pendingResult: RunResult | null;
  resultDelay: number;
  deathSequence: { elapsed: number; resultIssued: boolean } | null;
  score: number;
  fixedAccumulator: number;
  boostVisualTarget: number;
  overdriveTimer: number;
  audio: {
    stop: Mock;
    fadeOutMusic: Mock;
    playDeathExplosion: Mock;
  };
  hooks: { onFinish: Mock; onTerminal: Mock };
  emitUpgradeState: Mock;
  releaseInputs: Mock;
  deathFx: { start: Mock; reset: Mock };
}

function harness(): DeathHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    state: 'playing',
    pendingResult: null,
    resultDelay: 0,
    deathSequence: null,
    pendingUpgradeOptions: [],
    queuedUpgradePicks: 0,
    fixedAccumulator: 0.04,
    boostVisualTarget: 1,
    overdriveTimer: 2,
    score: 1250,
    shots: 8,
    hits: 5,
    kills: 2,
    perfects: 3,
    nearMisses: 4,
    maxRunSpeed: 210,
    distance: 840,
    simulationTick: 7_200,
    obstacleCollisions: 1,
    trackId: 'aurora',
    plan: {
      seed: 0x1234abcd,
      length: 1_000,
      events: [
        { kind: 'gate', resolved: true, destroyed: false },
        { kind: 'cross', resolved: false, destroyed: false },
        { kind: 'boost', resolved: true, destroyed: false },
      ],
    },
    rivals: [],
    graphicsSettings: { quality: 'quality', reducedFlashes: false },
    impactSlide: -1,
    audio: {
      stop: vi.fn(),
      fadeOutMusic: vi.fn(),
      playDeathExplosion: vi.fn(),
    },
    hooks: { onFinish: vi.fn(), onTerminal: vi.fn() },
    emitUpgradeState: vi.fn(),
    releaseInputs: vi.fn(),
    deathFx: { start: vi.fn(() => 'reactor-bloom'), reset: vi.fn() },
  }) as unknown as DeathHarness;
}

describe('BallisticGame death sequence', () => {
  it('freezes gameplay, starts a music fade and keeps the result hidden during destruction', () => {
    const game = harness();

    game.finishRun(false);

    expect(game.state).toBe('dying');
    expect(game.deathSequence).toEqual({ elapsed: 0, resultIssued: false });
    expect(game.pendingResult).toMatchObject({ survived: false, score: expect.any(Number) });
    expect(game.pendingResult).toMatchObject({
      elapsedTime: 60,
      competitorCount: 1,
      courseProgress: 0.84,
      obstaclePerformance: {
        total: 2,
        encountered: 1,
        cleared: 0,
        collisions: 1,
        clearance: 0,
      },
      standings: [{ id: 'player', status: 'destroyed', place: 1 }],
    });
    expect(game.fixedAccumulator).toBe(0);
    expect(game.boostVisualTarget).toBe(0);
    expect(game.overdriveTimer).toBe(0);
    expect(game.releaseInputs).toHaveBeenCalledOnce();
    expect(game.audio.fadeOutMusic).toHaveBeenCalledWith(DEATH_MUSIC_FADE_DURATION);
    expect(game.audio.playDeathExplosion).toHaveBeenCalledWith(expect.any(Number), 1.08);
    expect(game.deathFx.start).toHaveBeenCalledWith({
      seed: expect.any(Number),
      quality: 'quality',
      reducedFlashes: false,
      impactDirection: -1,
    });
    expect(game.audio.stop).not.toHaveBeenCalled();
    expect(game.hooks.onTerminal).toHaveBeenCalledOnce();
    expect(game.hooks.onFinish).not.toHaveBeenCalled();
  });

  it('snapshots and delivers a fatal result exactly once after the sequence', () => {
    const game = harness();
    game.finishRun(false);
    const snapshot = game.pendingResult;
    game.score = 999_999;

    game.deliverPendingResult();
    game.deliverPendingResult();

    expect(game.state).toBe('finished');
    expect(game.pendingResult).toBeNull();
    expect(game.audio.stop).toHaveBeenCalledOnce();
    expect(game.hooks.onTerminal).toHaveBeenCalledOnce();
    expect(game.hooks.onFinish).toHaveBeenCalledOnce();
    expect(game.hooks.onFinish).toHaveBeenCalledWith(snapshot);
    expect(game.hooks.onFinish.mock.calls[0][0].score).not.toBe(999_999);
  });

  it('keeps the successful finish on the short non-explosive path', () => {
    const game = harness();

    game.finishRun(true);

    expect(game.state).toBe('finished');
    expect(game.resultDelay).toBe(0.42);
    expect(game.pendingResult).toMatchObject({ survived: true });
    expect(game.audio.stop).toHaveBeenCalledOnce();
    expect(game.audio.fadeOutMusic).not.toHaveBeenCalled();
    expect(game.audio.playDeathExplosion).not.toHaveBeenCalled();
  });
});
