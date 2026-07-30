import { describe, expect, it } from 'vitest';
import { angularDistance } from '../core/math';
import {
  applyRivalHazardImpact,
  createRivalAIProfile,
  createRivalAIState,
  stepRivalAI,
  type RivalAIInput,
  type RivalAIProfile,
  type RivalAIRaceModel,
  type RivalAISnapshot,
  type RivalAIState,
} from './rivalAI';

const FIXED_STEP = 1 / 120;

function raceModel(overrides: Partial<RivalAIRaceModel> = {}): RivalAIRaceModel {
  return {
    length: 4_000,
    baseSpeed: 300,
    handling: 0.96,
    hazards: [],
    beats: [],
    transitions: [],
    ...overrides,
  };
}

function profile(index = 0, seed = 0x51a7, difficulty = 0.72): RivalAIProfile {
  return createRivalAIProfile(seed, index, 1, difficulty);
}

function stateFor(
  rival: RivalAIProfile,
  model: RivalAIRaceModel,
  overrides: Partial<RivalAIState> = {},
): RivalAIState {
  return {
    ...createRivalAIState(rival, { distance: 100, angle: 0 }, model.baseSpeed),
    ...overrides,
  };
}

function snapshot(
  id: string,
  distance: number,
  angle: number,
  overrides: Partial<RivalAISnapshot> = {},
): RivalAISnapshot {
  return { id, distance, angle, speed: 300, angularVelocity: 0, ...overrides };
}

function input(overrides: Partial<RivalAIInput> = {}): RivalAIInput {
  return {
    dt: FIXED_STEP,
    tick: 1,
    transportTime: 0,
    paceReference: 100,
    player: snapshot('player', 100, 1.8),
    traffic: [],
    allowPlayerTactics: true,
    ...overrides,
  };
}

function numericStateValues(state: RivalAIState): number[] {
  return Object.values(state).filter((value): value is number => typeof value === 'number');
}

describe('rival AI', () => {
  it('is deterministic for an identical seed and immutable race snapshot', () => {
    const model = raceModel({
      hazards: [{
        id: 3,
        kind: 'cross',
        distance: 430,
        safeAngle: 1.05,
        safeHalfWidth: 0.42,
        safeAngularVelocity: 0,
        warningDistance: 280,
        strength: 0.9,
      }],
      beats: [
        { id: 0, time: 0.25, strength: 0.82, barBeat: 0 },
        { id: 1, time: 0.5, strength: 0.58, barBeat: 1 },
      ],
      transitions: [{ id: 0, time: 0.75, kind: 'drop', strength: 0.94 }],
    });
    const leftProfile = profile(1, 913);
    const rightProfile = profile(1, 913);
    let left = stateFor(leftProfile, model);
    let right = stateFor(rightProfile, model);

    for (let tick = 1; tick <= 360; tick += 1) {
      const frame = input({
        tick,
        transportTime: tick * FIXED_STEP,
        paceReference: 100 + tick * model.baseSpeed * FIXED_STEP,
        player: snapshot('player', 135 + tick * 2.2, Math.sin(tick * 0.013) * 0.4),
        traffic: [snapshot('other', 118 + tick * 2.1, -0.35)],
      });
      const leftOutput = stepRivalAI(model, leftProfile, left, frame);
      const rightOutput = stepRivalAI(model, rightProfile, right, frame);
      expect(leftOutput).toEqual(rightOutput);
      left = leftOutput.state;
      right = rightOutput.state;
    }
  });

  it('assigns the four distinct driving archetypes to the first four rivals', () => {
    expect([0, 1, 2, 3].map((index) => profile(index).archetype)).toEqual([
      'apex-reader',
      'pulse-striker',
      'slipstream-hunter',
      'edge-gambler',
    ]);
  });

  it('prioritizes a visible hazard over drafting and steers toward its safe corridor', () => {
    const model = raceModel({
      hazards: [{
        id: 71,
        kind: 'bastion',
        distance: 250,
        safeAngle: 1.35,
        safeHalfWidth: 0.34,
        safeAngularVelocity: 0,
        warningDistance: 300,
        strength: 1,
      }],
    });
    const hunter = profile(2);
    const initial = stateFor(hunter, model, { laneCenter: -0.8, draftCharge: 1 });
    const result = stepRivalAI(model, hunter, initial, input({
      paceReference: 200,
      player: snapshot('player', 130, 0),
    }));

    expect(result.activeHazardId).toBe(71);
    expect(result.state.mode).toBe('read');
    expect(result.steering).toBe(1);
    expect(angularDistance(result.targetAngle, 1.35)).toBeLessThan(
      angularDistance(initial.laneCenter, 1.35),
    );
  });

  it('consumes every beat only once even when transport time does not advance', () => {
    const model = raceModel({
      beats: [{ id: 8, time: 0.1, strength: 1, barBeat: 0 }],
    });
    const striker = profile(1);
    const first = stepRivalAI(model, striker, stateFor(striker, model), input({
      transportTime: 0.1,
    }));
    const second = stepRivalAI(model, striker, first.state, input({
      tick: 2,
      transportTime: 0.1,
    }));

    expect(first.state.beatCursor).toBe(1);
    expect(first.state.beatImpulse).toBeGreaterThan(0);
    expect(second.state.beatCursor).toBe(1);
    expect(second.state.beatImpulse).toBeLessThan(first.state.beatImpulse);
  });

  it('turns an accepted music drop into a bounded boost with finite heat and flux', () => {
    const model = raceModel({
      transitions: [{ id: 2, time: 0, kind: 'drop', strength: 1 }],
    });
    let selectedProfile: RivalAIProfile | null = null;
    let selectedState: RivalAIState | null = null;

    for (let seed = 1; seed <= 128 && !selectedProfile; seed += 1) {
      const candidate = profile(1, seed, 0.9);
      const output = stepRivalAI(model, candidate, stateFor(candidate, model), input());
      if (output.state.dropBoostTimer > 0) {
        selectedProfile = candidate;
        selectedState = output.state;
      }
    }

    expect(selectedProfile).not.toBeNull();
    expect(selectedState).not.toBeNull();
    let current = selectedState!;
    let peakBoost = current.boost;
    let minimumFlux = current.flux;
    let peakHeat = current.heat;
    for (let tick = 2; tick <= 360; tick += 1) {
      current = stepRivalAI(model, selectedProfile!, current, input({
        tick,
        transportTime: tick * FIXED_STEP,
        paceReference: current.distance + 80,
      })).state;
      peakBoost = Math.max(peakBoost, current.boost);
      minimumFlux = Math.min(minimumFlux, current.flux);
      peakHeat = Math.max(peakHeat, current.heat);
      expect(current.flux).toBeGreaterThanOrEqual(0);
      expect(current.flux).toBeLessThanOrEqual(100);
      expect(current.heat).toBeGreaterThanOrEqual(0);
      expect(current.heat).toBeLessThanOrEqual(100);
      expect(current.boost).toBeGreaterThanOrEqual(0);
      expect(current.boost).toBeLessThanOrEqual(1);
    }

    expect(current.transitionCursor).toBe(1);
    expect(peakBoost).toBeGreaterThan(0);
    expect(minimumFlux).toBeLessThan(100);
    expect(peakHeat).toBeGreaterThan(0);
  });

  it('lets every archetype convert an accepted drop into real thrust', () => {
    const model = raceModel({
      transitions: [{ id: 4, time: 0, kind: 'drop', strength: 1 }],
    });

    for (let index = 0; index < 4; index += 1) {
      let acceptedBoost = 0;
      for (let seed = 1; seed <= 512 && acceptedBoost === 0; seed += 1) {
        const rival = profile(index, seed, 0.9);
        const output = stepRivalAI(model, rival, stateFor(rival, model), input());
        if (output.state.dropBoostTimer > 0) acceptedBoost = output.state.boost;
      }
      expect(acceptedBoost, `archetype index ${index}`).toBeGreaterThan(0);
    }
  });

  it('reports crossed hazards, keeps the cleared corridor as its new line and applies recovery penalties', () => {
    const model = raceModel({
      hazards: [{
        id: 17,
        kind: 'gate',
        distance: 101,
        safeAngle: 1.2,
        safeHalfWidth: 0.28,
        safeAngularVelocity: 0.1,
        warningDistance: 160,
        strength: 0.9,
      }],
    });
    const reader = profile(0, 88, 0.85);
    const clear = stepRivalAI(model, reader, stateFor(reader, model, {
      distance: 100,
      speed: 300,
      angle: 1.2,
      laneCenter: 0,
    }), input({ paceReference: 102 }));
    expect(clear.hitHazard).toBe(false);
    expect(clear.crossedHazardIds).toEqual([17]);
    expect(clear.state.laneCenter).toBeCloseTo(1.2, 6);

    const crossedOffLine = stepRivalAI(model, reader, stateFor(reader, model, {
      distance: 100,
      speed: 300,
      angle: -1.2,
      laneCenter: -1.2,
    }), input({ paceReference: 102 }));
    const missed = applyRivalHazardImpact(crossedOffLine.state, reader);
    expect(crossedOffLine.crossedHazardIds).toEqual([17]);
    expect(missed.mode).toBe('vent');
    expect(missed.impactTimer).toBeGreaterThan(0);
    expect(missed.heat).toBeGreaterThan(0);
    expect(missed.flux).toBeLessThan(100);
  });

  it('does not boost while recovering from an impact even if a drop timer is active', () => {
    const model = raceModel();
    const striker = profile(1, 75, 0.9);
    const recovering = stateFor(striker, model, {
      mode: 'vent',
      modeTime: 0.2,
      impactTimer: 0.4,
      dropBoostTimer: 0.7,
      boost: 0.8,
      flux: 80,
      heat: 50,
    });
    const output = stepRivalAI(model, striker, recovering, input({ tick: 2 }));

    expect(output.state.mode).toBe('vent');
    expect(output.state.boost).toBeLessThan(recovering.boost);
    expect(output.state.flux).toBeGreaterThan(recovering.flux);
    expect(output.state.heat).toBeLessThan(recovering.heat);
  });

  it('lets the hunter charge a slipstream and commit to an overtake', () => {
    const model = raceModel();
    const hunter = profile(2, 612, 0.9);
    let current = stateFor(hunter, model);
    let sawDraft = false;
    let sawOvertake = false;

    for (let tick = 1; tick <= 240; tick += 1) {
      const output = stepRivalAI(model, hunter, current, input({
        tick,
        transportTime: tick * FIXED_STEP,
        paceReference: current.distance + 50,
        player: snapshot('player', current.distance + 30, current.angle),
      }));
      current = output.state;
      sawDraft ||= current.mode === 'draft';
      sawOvertake ||= current.mode === 'overtake';
    }

    expect(sawDraft).toBe(true);
    expect(sawOvertake).toBe(true);
  });

  it('produces the same avoidance decision regardless of traffic array order', () => {
    const model = raceModel();
    const rival = profile(0);
    const current = stateFor(rival, model, { laneCenter: 0.15, modeTime: 1 });
    const traffic = [
      snapshot('zeta', 111, 0.08),
      snapshot('alpha', 94, -0.16),
      snapshot('mid', 126, 0.31),
    ];
    const frame = input({ traffic, allowPlayerTactics: false });

    const forward = stepRivalAI(model, rival, current, frame);
    const reversed = stepRivalAI(model, rival, current, { ...frame, traffic: [...traffic].reverse() });

    expect(forward).toEqual(reversed);
  });

  it('clamps oversized frame time and advances by a physically bounded distance', () => {
    const model = raceModel();
    const rival = profile(0);
    const current = stateFor(rival, model);
    const output = stepRivalAI(model, rival, current, input({
      dt: 5,
      paceReference: 20_000,
      allowPlayerTactics: false,
    }));

    expect(output.state.distance).toBeGreaterThan(current.distance);
    expect(output.state.distance - current.distance).toBeLessThanOrEqual(model.baseSpeed * 1.16 / 30);

    const paused = stepRivalAI(model, rival, output.state, input({ dt: -1, tick: 2 }));
    expect(paused.state).toEqual(output.state);
  });

  it('records its finish tick once and freezes after crossing the finish line', () => {
    const model = raceModel({ length: 105 });
    const rival = profile(0);
    const nearFinish = stateFor(rival, model, { distance: 104.9, speed: 300 });
    const finished = stepRivalAI(model, rival, nearFinish, input({ tick: 42 })).state;
    const afterFinish = stepRivalAI(model, rival, finished, input({ tick: 99, transportTime: 3 })).state;

    expect(finished.distance).toBe(105);
    expect(finished.speed).toBe(0);
    expect(finished.finishTick).toBe(42);
    expect(afterFinish).toEqual(finished);
  });

  it('keeps the complete long-run state finite, monotonic and within resource bounds', () => {
    const model = raceModel({
      length: 12_000,
      hazards: [
        { id: 0, kind: 'gate', distance: 900, safeAngle: 1.1, safeHalfWidth: 0.4, safeAngularVelocity: 0, warningDistance: 300, strength: 0.8 },
        { id: 1, kind: 'blade', distance: 1_800, safeAngle: -1.3, safeHalfWidth: 0.32, safeAngularVelocity: 0.15, warningDistance: 340, strength: 1 },
        { id: 2, kind: 'cross', distance: 2_700, safeAngle: 2.2, safeHalfWidth: 0.38, safeAngularVelocity: -0.1, warningDistance: 360, strength: 0.95 },
      ],
      beats: Array.from({ length: 80 }, (_, id) => ({
        id,
        time: id * 0.25,
        strength: 0.35 + (id % 5) * 0.14,
        barBeat: (id % 4) as 0 | 1 | 2 | 3,
      })),
      transitions: [
        { id: 0, time: 2, kind: 'build', strength: 0.7 },
        { id: 1, time: 4, kind: 'drop', strength: 1 },
        { id: 2, time: 8, kind: 'break', strength: 0.85 },
        { id: 3, time: 11, kind: 'drop', strength: 0.92 },
      ],
    });
    const gambler = profile(3, 0xabc, 0.96);
    let current = stateFor(gambler, model);

    for (let tick = 1; tick <= 3_600; tick += 1) {
      const beforeDistance = current.distance;
      const output = stepRivalAI(model, gambler, current, input({
        tick,
        transportTime: tick * FIXED_STEP,
        paceReference: 100 + tick * model.baseSpeed * FIXED_STEP,
        player: snapshot(
          'player',
          current.distance + Math.sin(tick * 0.02) * 70,
          Math.sin(tick * 0.011) * 2.4,
          { angularVelocity: Math.cos(tick * 0.011) * 0.35 },
        ),
        traffic: [
          snapshot('oracle', current.distance + 18, current.angle + 0.09),
          snapshot('shade', current.distance - 24, current.angle - 0.17),
        ],
      }));
      current = output.state;

      expect(numericStateValues(current).every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(output.targetAngle)).toBe(true);
      expect(Number.isFinite(output.targetSpeed)).toBe(true);
      expect(current.distance).toBeGreaterThanOrEqual(beforeDistance);
      expect(current.distance).toBeLessThanOrEqual(model.length);
      expect(current.speed).toBeGreaterThanOrEqual(0);
      expect(current.angle).toBeGreaterThanOrEqual(-Math.PI);
      expect(current.angle).toBeLessThan(Math.PI);
      expect(current.flux).toBeGreaterThanOrEqual(0);
      expect(current.flux).toBeLessThanOrEqual(100);
      expect(current.heat).toBeGreaterThanOrEqual(0);
      expect(current.heat).toBeLessThanOrEqual(100);
      expect(current.boost).toBeGreaterThanOrEqual(0);
      expect(current.boost).toBeLessThanOrEqual(1);
      expect(current.draftCharge).toBeGreaterThanOrEqual(0);
      expect(current.draftCharge).toBeLessThanOrEqual(1.2);
      expect(current.hazardCursor).toBeGreaterThanOrEqual(0);
      expect(current.hazardCursor).toBeLessThanOrEqual(model.hazards.length);
      expect(current.beatCursor).toBeGreaterThanOrEqual(0);
      expect(current.beatCursor).toBeLessThanOrEqual(model.beats.length);
      expect(current.transitionCursor).toBeGreaterThanOrEqual(0);
      expect(current.transitionCursor).toBeLessThanOrEqual(model.transitions.length);
    }
  });
});
