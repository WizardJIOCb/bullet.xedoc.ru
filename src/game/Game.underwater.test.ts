import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { angularDistance } from '../core/math';
import { BallisticGame } from './Game';
import { getTrackEventSafeCorridors, type TrackPlan } from './track';

interface UnderwaterForkHarness {
  plan: TrackPlan;
  addUnderwaterForkEvents: (seed: number) => void;
}

function createPlan(): TrackPlan {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, -12_000),
  ]);
  return {
    curve,
    frames: {
      positions: [new THREE.Vector3(), new THREE.Vector3(0, 0, -12_000)],
      tangents: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)],
      normals: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)],
      binormals: [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -1, 0)],
      segments: 1,
    },
    events: [],
    beatDistances: Array.from({ length: 16 }, (_, index) => ({
      beatIndex: index,
      time: index * 5,
      distance: index * 800,
      strength: 0.7,
      bass: 0.6,
      highs: 0.5,
      barBeat: (index % 4) as 0 | 1 | 2 | 3,
      gridBeat: true,
      cue: 'beat' as const,
    })),
    transitionDistances: [],
    length: 12_000,
    runDuration: 80,
    radius: 13.8,
    seed: 123,
  };
}

describe('Abyssal Divide forks', () => {
  it('creates three stationary two-route collision corridors', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      plan: createPlan(),
    }) as unknown as UnderwaterForkHarness;

    game.addUnderwaterForkEvents(0xab755);

    expect(game.plan.events).toHaveLength(3);
    for (const [index, event] of game.plan.events.entries()) {
      expect(event).toMatchObject({ id: index, kind: 'blade', armCount: 2, rotationRate: 0 });
      const corridors = getTrackEventSafeCorridors(event);
      expect(corridors).toHaveLength(2);
      expect(angularDistance(corridors[0].center, event.safeAngle ?? Number.NaN)).toBeCloseTo(0);
      expect(corridors[1].halfWidth).toBeGreaterThan(1.3);
    }
  });
});
