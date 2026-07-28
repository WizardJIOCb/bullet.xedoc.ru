import * as THREE from 'three';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { LocalRaceSnapshot, RemoteRacerState, RunResult, RunStats, TrackEvent } from '../core/types';
import { BallisticGame } from './Game';
import {
  createRivalAIProfile,
  createRivalAIState,
  stepRivalAI,
  type RivalAIRaceModel,
  type RivalAIOutput,
  type RivalAIProfile,
  type RivalAIState,
} from './rivalAI';

interface AiHarness {
  createRivals(): void;
  config: { aiOpponents?: number } | null;
  rivals: Array<{
    ai: { distance: number; angle: number };
    profile: { archetype: string; callSign: string };
  }>;
  dynamicLayer: THREE.Group;
  createCraft: Mock;
  createRacerNameplate: Mock;
  createRivalBeacon: Mock;
  createRivalLocator: Mock;
  prepareOpponentVisual: Mock;
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

interface RankHarness {
  getRank(): number;
  distance: number;
  plan: { length: number };
  simulationTick: number;
  rivalAiTick: number;
  onlineTimeProvider: (() => number) | null;
  localFinishTime: number | null;
  localFinishAiTick: number | null;
  rivals: Array<{ ai: { distance: number; finishTick: number | null } }>;
  remoteRacers: Map<string, {
    destroyed: boolean;
    active: boolean;
    finished: boolean;
    targetProgress: number;
    finishedAt: number | null;
  }>;
}

interface AiStepHarness {
  updateRivals(dt: number, paceReference: number, transportTime: number): void;
  onlineRivalsReadyForResult(): boolean;
  rivals: Array<{ ai: RivalAIState }>;
  rivalAiTick: number;
  rivalAiCatchupBudget: number;
}

interface HazardResolveHarness {
  resolveRivalHazards(
    rival: { profile: RivalAIProfile; ai: RivalAIState },
    output: RivalAIOutput,
    transportTime: number,
  ): RivalAIOutput;
}

interface ResultHarness {
  refreshRunResultPlacement(result: Readonly<RunResult>): RunResult;
  raceCompetitorCount: number;
  kills: number;
  getRank: Mock<() => number>;
}

interface TerminalAckHarness {
  confirmAuthoritativeTerminal(serverTime: number): void;
  onlineRun: boolean;
  distance: number;
  plan: { length: number; runDuration: number };
  onlineRaceOriginTime: number | null;
  rivalAiTick: number;
  pendingResult: RunResult | null;
  localFinishTime: number | null;
  localFinishAiTick: number | null;
  awaitingTerminalAck: boolean;
  terminalAckTimeout: number;
}

function aiHarness(
  aiOpponents?: number,
  aiRivals: Array<{ id?: string; name?: string; difficulty?: number }> = [],
): AiHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    config: { aiOpponents },
    plan: { seed: 0x51a1 },
    rivalAiModel: {
      length: 10_000,
      baseSpeed: 170,
      handling: 1,
      hazards: [],
      beats: [],
      transitions: [],
    },
    aiRivals,
    rivals: [],
    dynamicLayer: new THREE.Group(),
    createCraft: vi.fn(() => ({
      group: new THREE.Group(),
      engineGlow: new THREE.Group(),
      thrustTrails: [],
    })),
    createRacerNameplate: vi.fn(() => null),
    createRivalBeacon: vi.fn(() => new THREE.Sprite()),
    createRivalLocator: vi.fn(() => new THREE.Sprite()),
    prepareOpponentVisual: vi.fn(() => ({ kind: 'ai' })),
    removeAndDispose: vi.fn(),
  }) as unknown as AiHarness;
}

function remoteHarness(): RemoteHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    remoteRacers: new Map(),
    dynamicLayer: new THREE.Group(),
    createRemoteRacerMesh: vi.fn(() => ({
      mesh: new THREE.Group(),
      visual: { kind: 'remote' },
    })),
    removeAndDispose: vi.fn((mesh: THREE.Object3D) => mesh.parent?.remove(mesh)),
  }) as unknown as RemoteHarness;
}

function onlineAiStepHarness(serverElapsedMs?: number): AiStepHarness {
  const model: RivalAIRaceModel = {
    length: 18_000,
    baseSpeed: 300,
    handling: 1,
    hazards: [],
    beats: [{ id: 0, time: 1, strength: 0.9, barBeat: 0 }],
    transitions: [{ id: 0, time: 1.5, kind: 'drop', strength: 0.95 }],
  };
  const profile = createRivalAIProfile(991, 1, 1, 0.75);
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    rivalAiModel: model,
    rivals: [{
      mesh: new THREE.Group(),
      engineGlow: new THREE.Group(),
      thrustTrails: [],
      profile,
      ai: createRivalAIState(profile, { distance: 100, angle: 0 }, model.baseSpeed),
      lastOutput: null,
      color: 0xff00ff,
    }],
    rivalDraftCooldown: 0,
    rivalCalloutCooldown: 0,
    rivalContactCooldown: 0,
    rivalDraftCharge: 0,
    simulationTick: 240,
    rivalAiTick: 0,
    rivalAiCatchupBudget: 120,
    onlineRun: true,
    onlineTimeProvider: serverElapsedMs === undefined ? null : () => serverElapsedMs,
    onlineRaceOriginTime: serverElapsedMs === undefined ? null : 0,
    distance: 500,
    speed: 300,
    angle: 2,
    angularVelocity: 0,
    plan: { length: 18_000, runDuration: 60 },
    flux: 100,
    score: 0,
    audio: { accentMusic: vi.fn(), playEffect: vi.fn() },
    hooks: { onToast: vi.fn(), onImpact: vi.fn() },
  }) as unknown as AiStepHarness;
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
      expect(game.rivals.map((rival) => rival.ai.distance)).toEqual([32, -24, 65]);
      expect(game.rivals.map((rival) => rival.profile.archetype)).toEqual([
        'apex-reader',
        'pulse-striker',
        'slipstream-hunter',
      ]);
    }
  });

  it('preserves authoritative online bot identities while retaining personality archetypes', () => {
    const game = aiHarness(2, [
      { id: 'ai-room-1', name: 'GHOST 01', difficulty: 0.5 },
      { id: 'ai-room-2', name: 'GHOST 02', difficulty: 0.82 },
    ]);

    game.createRivals();

    expect(game.rivals.map((rival) => rival.profile.callSign)).toEqual(['GHOST 01', 'GHOST 02']);
    expect(game.rivals.map((rival) => rival.profile.archetype)).toEqual(['apex-reader', 'pulse-striker']);
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

  it('counts bots and humans that actually finished before the local player', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      distance: 1_000,
      plan: { length: 1_000 },
      simulationTick: 600,
      rivalAiTick: 700,
      onlineTimeProvider: () => 50_000,
      localFinishTime: 50_000,
      localFinishAiTick: 600,
      rivals: [
        { ai: { distance: 1_000, finishTick: 590 } },
        { ai: { distance: 1_000, finishTick: 600 } },
      ],
      remoteRacers: new Map([
        ['early', { destroyed: false, active: false, finished: true, targetProgress: 1, finishedAt: 49_900 }],
        ['late', { destroyed: false, active: false, finished: true, targetProgress: 1, finishedAt: 50_100 }],
      ]),
    }) as unknown as RankHarness;

    expect(game.getRank()).toBe(3);
  });

  it('recalculates placement rewards from the stable starting grid', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      raceCompetitorCount: 5,
      kills: 2,
      getRank: vi.fn(() => 3),
    }) as unknown as ResultHarness;
    const initial: RunResult = {
      score: 8_600,
      credits: 221,
      maxSpeed: 3_100,
      accuracy: 0.5,
      perfects: 4,
      nearMisses: 2,
      kills: 2,
      rank: 2,
      survived: true,
      trackName: 'AURORA SPINE',
      seed: 42,
    };

    expect(game.refreshRunResultPlacement(initial)).toMatchObject({
      rank: 3,
      score: 7_400,
      credits: 192,
    });
  });

  it('accepts the authoritative finish echo and releases the bounded result wait', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      onlineRun: true,
      distance: 1_000,
      plan: { length: 1_000, runDuration: 60 },
      onlineRaceOriginTime: 9_000,
      rivalAiTick: 100,
      pendingResult: { survived: true },
      localFinishTime: 9_900,
      localFinishAiTick: 108,
      awaitingTerminalAck: true,
      terminalAckTimeout: 1.2,
    }) as unknown as TerminalAckHarness;

    game.confirmAuthoritativeTerminal(10_004);

    expect(game.localFinishTime).toBe(10_004);
    expect(game.localFinishAiTick).toBe(120);
    expect(game.awaitingTerminalAck).toBe(false);
    expect(game.terminalAckTimeout).toBe(0);
  });

  it('uses the fixed simulation clock for online AI instead of each client audio clock', () => {
    const earlyAudioClient = onlineAiStepHarness();
    const lateAudioClient = onlineAiStepHarness();

    earlyAudioClient.updateRivals(1 / 120, 80, 0.25);
    lateAudioClient.updateRivals(1 / 120, 4_000, 8.5);

    expect(earlyAudioClient.rivals[0].ai).toEqual(lateAudioClient.rivals[0].ai);
  });

  it('deterministically fast-forwards online AI after missed render frames', () => {
    const steadyClient = onlineAiStepHarness();
    const resumedClient = onlineAiStepHarness(2_000);

    for (let tick = 0; tick < 240; tick += 1) {
      steadyClient.rivalAiCatchupBudget = 120;
      steadyClient.updateRivals(1 / 120, 0, 0);
    }
    resumedClient.updateRivals(1 / 120, 9_999, 99);
    expect(resumedClient.rivalAiTick).toBe(120);
    expect(resumedClient.rivalAiCatchupBudget).toBe(0);
    expect(resumedClient.onlineRivalsReadyForResult()).toBe(false);
    resumedClient.rivalAiCatchupBudget = 120;
    resumedClient.updateRivals(1 / 120, 9_999, 99);

    expect(resumedClient.rivalAiTick).toBe(240);
    expect(resumedClient.onlineRivalsReadyForResult()).toBe(true);
    expect(resumedClient.rivals[0].ai).toEqual(steadyClient.rivals[0].ai);
  });

  it('uses the shared rotating-obstacle classifier and ignores destroyed solo hazards', () => {
    const event: TrackEvent = {
      id: 17,
      kind: 'cross',
      distance: 101,
      angle: 0,
      gapWidth: 0.2,
      health: 1,
      resolved: false,
      destroyed: false,
      beatIndex: 0,
      musicTime: 0,
      trigger: 'beat',
      strength: 1,
      rotationRate: 1,
      rotationPhase: 0,
      armCount: 2,
      patternId: 0,
      warningDistance: 180,
      safeAngle: Math.PI / 2,
      safeAngularVelocity: 0,
    };
    const model: RivalAIRaceModel = {
      length: 4_000,
      baseSpeed: 300,
      handling: 1,
      hazards: [{
        id: event.id,
        kind: event.kind,
        distance: event.distance,
        safeAngle: event.safeAngle as number,
        safeHalfWidth: Math.PI / 2 - event.gapWidth,
        safeAngularVelocity: 0,
        warningDistance: event.warningDistance,
        strength: event.strength,
      }],
      beats: [],
      transitions: [],
    };
    const profile = createRivalAIProfile(45, 0, 1, 0.8);
    const ai = createRivalAIState(profile, { distance: 100, angle: 0 }, model.baseSpeed);
    const crossed = stepRivalAI(model, profile, { ...ai, speed: 300 }, {
      dt: 1 / 120,
      tick: 1,
      transportTime: 0,
      paceReference: 101,
      player: { id: 'player', distance: 0, speed: 300, angle: 2 },
      traffic: [],
      allowPlayerTactics: false,
    });
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      trackEventsById: new Map([[event.id, event]]),
      onlineRun: false,
    }) as unknown as HazardResolveHarness;
    const rival = { profile, ai };

    expect(game.resolveRivalHazards(rival, crossed, 0).hitHazard).toBe(true);
    expect(game.resolveRivalHazards(rival, crossed, Math.PI / 2).hitHazard).toBe(false);
    event.destroyed = true;
    expect(game.resolveRivalHazards(rival, crossed, 0).hitHazard).toBe(false);
  });
});
