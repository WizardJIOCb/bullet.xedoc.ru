import * as THREE from 'three';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { LocalRaceSnapshot, RemoteRacerState, RunStats } from '../core/types';
import { BallisticGame } from './Game';

interface AiHarness {
  createRivals(): void;
  config: { aiOpponents?: number } | null;
  rivals: Array<{ distance: number; angle: number; speedFactor: number }>;
  dynamicLayer: THREE.Group;
  createCraft: Mock;
  removeAndDispose: Mock;
}

interface RemoteHarness {
  setRemoteRacers(states: readonly RemoteRacerState[]): void;
  remoteRacers: Map<string, {
    mesh: THREE.Group;
    targetProgress: number;
    name: string;
    colorIndex: number;
    active: boolean;
  }>;
  dynamicLayer: THREE.Group;
  createRemoteRacerMesh: Mock;
  removeAndDispose: Mock;
}

interface SnapshotHarness {
  getLocalRaceSnapshot(): LocalRaceSnapshot;
  getStats: Mock<() => RunStats>;
  state: 'menu' | 'countdown' | 'playing' | 'dying' | 'finished';
  angle: number;
  shield: number;
}

function aiHarness(aiOpponents?: number): AiHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    config: { aiOpponents },
    rivals: [],
    dynamicLayer: new THREE.Group(),
    createCraft: vi.fn(() => ({ group: new THREE.Group() })),
    removeAndDispose: vi.fn(),
  }) as unknown as AiHarness;
}

function remoteHarness(): RemoteHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    remoteRacers: new Map(),
    dynamicLayer: new THREE.Group(),
    createRemoteRacerMesh: vi.fn(() => new THREE.Group()),
    removeAndDispose: vi.fn((mesh: THREE.Object3D) => mesh.parent?.remove(mesh)),
  }) as unknown as RemoteHarness;
}

const stats: RunStats = {
  speed: 2460,
  maxSpeed: 3200,
  progress: 0.42,
  shield: 2,
  maxShield: 3,
  heat: 37,
  flux: 81,
  sync: 4,
  score: 12_345,
  rank: 2,
  abilityCooldown: 0,
  weaponCooldown: 0,
  section: 2,
  rhythmPulse: 0.8,
  phaseActive: false,
  overheated: false,
};

describe('BallisticGame multiplayer gameplay hooks', () => {
  it.each([
    ['classic solo default', undefined, 3],
    ['no local bots', 0, 0],
    ['configured field', 5, 5],
    ['server maximum', 7, 7],
    ['clamped overflow', 99, 7],
    ['clamped negative', -4, 0],
  ])('creates %s AI rivals', (_label, configured, expected) => {
    const game = aiHarness(configured);

    game.createRivals();

    expect(game.rivals).toHaveLength(expected);
    expect(game.createCraft).toHaveBeenCalledTimes(expected);
    expect(game.dynamicLayer.children).toHaveLength(expected);
    if (configured === undefined) {
      expect(game.rivals.map((rival) => rival.distance)).toEqual([32, -24, 65]);
    }
  });

  it('returns a serialization-safe snapshot with explicit lifecycle flags', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      state: 'playing',
      angle: 0.73,
      shield: 2,
      getStats: vi.fn(() => stats),
    }) as unknown as SnapshotHarness;

    expect(game.getLocalRaceSnapshot()).toEqual({
      progress: 0.42,
      angle: 0.73,
      speed: 2460,
      shield: 2,
      heat: 37,
      flux: 81,
      score: 12_345,
      rank: 2,
      section: 2,
      active: true,
      running: true,
      destroyed: false,
      finished: false,
    });

    game.state = 'dying';
    expect(game.getLocalRaceSnapshot()).toMatchObject({ active: true, running: false, destroyed: true, finished: false });
    game.state = 'finished';
    game.shield = 0;
    expect(game.getLocalRaceSnapshot()).toMatchObject({ active: false, running: false, destroyed: true, finished: true });
  });

  it('reconciles remote racers, updates metadata and disposes players missing from the next frame', () => {
    const game = remoteHarness();
    game.setRemoteRacers([
      { id: 'alpha', name: '  Neon   Fox  ', progress: 0.2, angle: 0.3, speed: 2200, shield: 3 },
      { id: 'beta', name: 'Ion', progress: 0.6, angle: -0.4, speed: 2300, shield: 2 },
    ]);

    expect(game.remoteRacers.size).toBe(2);
    expect(game.dynamicLayer.children).toHaveLength(2);
    expect(game.remoteRacers.get('alpha')?.name).toBe('Neon Fox');
    expect(game.remoteRacers.get('alpha')?.mesh.userData.remoteRacer).toMatchObject({
      id: 'alpha',
      name: 'Neon Fox',
      progress: 0.2,
    });
    expect(game.remoteRacers.get('alpha')?.colorIndex).not.toBe(game.remoteRacers.get('beta')?.colorIndex);

    game.setRemoteRacers([
      { id: 'alpha', name: 'Neon Fox', progress: 0.72, angle: 0.7, speed: 2800, shield: 1, active: true },
    ]);

    expect(game.createRemoteRacerMesh).toHaveBeenCalledTimes(2);
    expect(game.remoteRacers.size).toBe(1);
    expect(game.remoteRacers.get('alpha')?.targetProgress).toBe(0.72);
    expect(game.removeAndDispose).toHaveBeenCalledOnce();
    expect(game.dynamicLayer.children).toHaveLength(1);

    game.setRemoteRacers([]);
    expect(game.remoteRacers.size).toBe(0);
    expect(game.dynamicLayer.children).toHaveLength(0);
  });
});
