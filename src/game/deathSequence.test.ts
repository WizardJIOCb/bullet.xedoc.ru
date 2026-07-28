import { describe, expect, it } from 'vitest';
import {
  DEATH_BREAKUP_DELAY,
  DEATH_MUSIC_FADE_DURATION,
  DEATH_SEQUENCE_DURATION,
  createDeathSequenceState,
  stepDeathSequence,
  type DeathSequenceState,
} from './deathSequence';

function advance(
  initial: DeathSequenceState,
  dt: number,
  steps: number,
): { state: DeathSequenceState; readyCount: number } {
  let state = initial;
  let readyCount = 0;
  for (let index = 0; index < steps; index += 1) {
    const frame = stepDeathSequence(state, dt);
    state = frame.state;
    if (frame.resultReady) readyCount += 1;
  }
  return { state, readyCount };
}

describe('death sequence clock', () => {
  it('keeps presentation phases ordered and emits result readiness once', () => {
    expect(DEATH_BREAKUP_DELAY).toBeGreaterThan(0);
    expect(DEATH_MUSIC_FADE_DURATION).toBeGreaterThan(DEATH_BREAKUP_DELAY);
    expect(DEATH_SEQUENCE_DURATION).toBeGreaterThan(DEATH_MUSIC_FADE_DURATION);

    const initial = createDeathSequenceState();
    const beforeFinish = stepDeathSequence(initial, DEATH_SEQUENCE_DURATION - 0.01);
    const finish = stepDeathSequence(beforeFinish.state, 0.02);
    const afterFinish = stepDeathSequence(finish.state, 10);

    expect(beforeFinish.resultReady).toBe(false);
    expect(finish.resultReady).toBe(true);
    expect(finish.progress).toBe(1);
    expect(finish.state.resultIssued).toBe(true);
    expect(afterFinish.resultReady).toBe(false);
    expect(afterFinish.state).toEqual(finish.state);
    expect(initial).toEqual({ elapsed: 0, resultIssued: false });
  });

  it('is frame-rate independent and never emits more than one result pulse', () => {
    const at60Hz = advance(createDeathSequenceState(), 1 / 60, 120);
    const at120Hz = advance(createDeathSequenceState(), 1 / 120, 240);

    expect(at60Hz.state).toEqual(at120Hz.state);
    expect(at60Hz.state.elapsed).toBe(DEATH_SEQUENCE_DURATION);
    expect(at60Hz.readyCount).toBe(1);
    expect(at120Hz.readyCount).toBe(1);
  });

  it('clamps negative and invalid input without rewinding or poisoning state', () => {
    const current: DeathSequenceState = { elapsed: 0.6, resultIssued: false };

    expect(stepDeathSequence(current, -1).state.elapsed).toBe(0.6);
    expect(stepDeathSequence(current, Number.NaN).state.elapsed).toBe(0.6);
    expect(stepDeathSequence(current, Number.POSITIVE_INFINITY).state.elapsed).toBe(0.6);

    const repaired = stepDeathSequence({ elapsed: Number.NaN, resultIssued: false }, 0.25);
    expect(repaired.state.elapsed).toBe(0.25);
    expect(Number.isFinite(repaired.progress)).toBe(true);
  });

  it('handles a large frame and an already-complete restored state safely', () => {
    const skipped = stepDeathSequence(createDeathSequenceState(), 50);
    const restored = stepDeathSequence({ elapsed: 99, resultIssued: false }, 0);

    expect(skipped).toMatchObject({ progress: 1, resultReady: true });
    expect(restored).toMatchObject({ progress: 1, resultReady: true });
    expect(stepDeathSequence(restored.state, 0).resultReady).toBe(false);
  });
});
