import { describe, expect, it, vi, type Mock } from 'vitest';
import type { TrackEvent } from '../core/types';
import { BallisticGame } from './Game';

interface ImpactHarness {
  hitObstacle: (event: TrackEvent, transportTime: number) => void;
  angle: number;
  angularVelocity: number;
  shield: number;
  maxShield: number;
  speed: number;
  heat: number;
  sync: number;
  score: number;
  phaseTimer: number;
  invulnerableTimer: number;
  damageKick: number;
  impactFlashTimer: number;
  impactSlide: number;
  audio: { playEffect: Mock };
  hooks: { onImpact: Mock; onToast: Mock };
  spawnImpactEffects: Mock;
  finishRun: Mock;
}

function obstacle(): TrackEvent {
  return {
    id: 7,
    kind: 'halfwall',
    distance: 800,
    angle: 0,
    gapWidth: 1.3,
    health: 1,
    resolved: false,
    destroyed: false,
    beatIndex: 12,
    musicTime: 10,
    trigger: 'beat',
    strength: 0.9,
    rotationRate: 0,
    rotationPhase: 0,
    armCount: 1,
    patternId: 3,
    warningDistance: 480,
    safeAngle: Math.PI,
  };
}

function harness(overrides: Partial<ImpactHarness> = {}): ImpactHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    angle: 0,
    angularVelocity: 0,
    shield: 3,
    maxShield: 3,
    speed: 100,
    heat: 91,
    sync: 8,
    score: 10,
    phaseTimer: 0,
    invulnerableTimer: 0,
    damageKick: 0,
    impactFlashTimer: 0,
    impactSlide: 0,
    audio: { playEffect: vi.fn() },
    hooks: { onImpact: vi.fn(), onToast: vi.fn() },
    spawnImpactEffects: vi.fn(),
    finishRun: vi.fn(),
    ...overrides,
  }) as unknown as ImpactHarness;
}

describe('BallisticGame obstacle impact wiring', () => {
  it('applies a recoverable deflection and every damage signal once', () => {
    const game = harness();
    const event = obstacle();

    game.hitObstacle(event, event.musicTime);

    expect(event.resolved).toBe(true);
    expect(game.shield).toBe(2);
    expect(game.speed).toBeCloseTo(72, 10);
    expect(game.heat).toBe(100);
    expect(game.sync).toBe(0);
    expect(game.invulnerableTimer).toBe(0.9);
    expect(game.damageKick).toBe(1);
    expect(game.impactFlashTimer).toBe(0.46);
    expect(Math.abs(game.impactSlide)).toBe(1);
    expect(Math.sign(game.angularVelocity)).toBe(game.impactSlide);
    expect(game.audio.playEffect).toHaveBeenCalledWith('impact');
    expect(game.spawnImpactEffects).toHaveBeenCalledWith(event, 0, game.impactSlide);
    expect(game.hooks.onImpact).toHaveBeenCalledWith(game.impactSlide);
    expect(game.hooks.onToast).toHaveBeenCalledWith(
      'IMPACT // DEFLECT',
      'AUTO-SLIDE // SHIELD 2/3',
      'red',
    );
    expect(game.finishRun).not.toHaveBeenCalled();
  });

  it.each([
    ['phase', { phaseTimer: 0.4, invulnerableTimer: 0 }],
    ['invulnerability', { phaseTimer: 0, invulnerableTimer: 0.4 }],
  ])('resolves a contact during %s without stacking damage or effects', (_label, timers) => {
    const game = harness(timers);
    const event = obstacle();

    game.hitObstacle(event, event.musicTime);

    expect(event.resolved).toBe(true);
    expect(game.score).toBe(170);
    expect(game.shield).toBe(3);
    expect(game.speed).toBe(100);
    expect(game.spawnImpactEffects).not.toHaveBeenCalled();
    expect(game.hooks.onImpact).not.toHaveBeenCalled();
    expect(game.hooks.onToast).toHaveBeenCalledWith('PHASED', expect.any(String), 'cyan');
  });

  it('still emits the impact package before handing a fatal hit to finishRun', () => {
    const game = harness({ shield: 1 });
    const event = obstacle();

    game.hitObstacle(event, event.musicTime);

    expect(game.shield).toBe(0);
    expect(game.spawnImpactEffects).toHaveBeenCalledOnce();
    expect(game.hooks.onImpact).toHaveBeenCalledOnce();
    expect(game.hooks.onToast).toHaveBeenCalledWith('IMPACT // DEFLECT', 'HULL FAILURE', 'red');
    expect(game.finishRun).toHaveBeenCalledWith(false);
  });
});
