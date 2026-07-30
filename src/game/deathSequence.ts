import { clamp } from '../core/math';

/** Keep the damaged hull intact briefly so the fatal contact remains readable. */
export const DEATH_BREAKUP_DELAY = 0.12;

/** Music reaches silence shortly before the result overlay is allowed to open. */
export const DEATH_MUSIC_FADE_DURATION = 1.35;

/** Full fatal-impact presentation before the result is delivered. */
export const DEATH_SEQUENCE_DURATION = 1.55;

export interface DeathSequenceState {
  readonly elapsed: number;
  readonly resultIssued: boolean;
}

export interface DeathSequenceStep {
  readonly state: DeathSequenceState;
  /** Normalized animation clock, useful for driving destruction visuals. */
  readonly progress: number;
  /** A one-frame pulse that can safely gate the result callback. */
  readonly resultReady: boolean;
}

export function createDeathSequenceState(): DeathSequenceState {
  return { elapsed: 0, resultIssued: false };
}

/**
 * Advance the fatal-impact clock without timers or side effects. `resultReady`
 * becomes true exactly once, on the first step that reaches the presentation
 * duration; the returned state remembers that the result has been issued.
 */
export function stepDeathSequence(
  state: Readonly<DeathSequenceState>,
  dt: number,
): DeathSequenceStep {
  const previousElapsed = clamp(
    Number.isFinite(state.elapsed) ? state.elapsed : 0,
    0,
    DEATH_SEQUENCE_DURATION,
  );
  const safeDt = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const elapsed = clamp(previousElapsed + safeDt, 0, DEATH_SEQUENCE_DURATION);
  const resultReady = !state.resultIssued && elapsed >= DEATH_SEQUENCE_DURATION;
  const nextState: DeathSequenceState = {
    elapsed,
    resultIssued: state.resultIssued || resultReady,
  };

  return {
    state: nextState,
    progress: elapsed / DEATH_SEQUENCE_DURATION,
    resultReady,
  };
}
