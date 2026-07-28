import { describe, expect, it, vi, type Mock } from 'vitest';
import { BallisticGame } from './Game';

interface PerfectHarness {
  registerPerfect(label: string): void;
  perfects: number;
  sync: number;
  score: number;
  flux: number;
  heat: number;
  shield: number;
  maxShield: number;
  runUpgrades: Set<string>;
  audio: { accentMusic: Mock; playEffect: Mock };
  hooks: { onToast: Mock };
}

function harness(): PerfectHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    perfects: 0,
    sync: 0,
    score: 0,
    flux: 0,
    heat: 50,
    shield: 3,
    maxShield: 3,
    runUpgrades: new Set<string>(),
    audio: { accentMusic: vi.fn(), playEffect: vi.fn() },
    hooks: { onToast: vi.fn() },
  }) as unknown as PerfectHarness;
}

describe('BallisticGame perfect music feedback', () => {
  it('replaces the separate chime with three light accents and a stronger fourth beat', () => {
    const game = harness();

    game.registerPerfect('GATE SYNC');
    game.registerPerfect('WALL SYNC');
    game.registerPerfect('BLADE SYNC');
    game.registerPerfect('CROSS SYNC');

    expect(game.audio.accentMusic.mock.calls).toEqual([[0.45], [0.45], [0.45], [1]]);
    expect(game.audio.playEffect).not.toHaveBeenCalled();
    expect(game.perfects).toBe(4);
    expect(game.sync).toBe(4);
    expect(game.flux).toBe(20);
    expect(game.hooks.onToast).toHaveBeenCalledOnce();
  });
});
