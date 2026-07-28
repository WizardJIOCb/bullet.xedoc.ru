import { clamp } from '../core/math';

export const BOOST_VISUAL_NORMAL = 1;
export const BOOST_VISUAL_OVERDRIVE = 1.2;
export const BOOST_VISUAL_ATTACK = 8.5;
export const BOOST_VISUAL_RELEASE = 3.8;

/** Resolve visual thrust from actual boost intent, never from cruise speed. */
export function resolveBoostVisualTarget(boosting: boolean, overdrive: boolean): number {
  if (overdrive) return BOOST_VISUAL_OVERDRIVE;
  return boosting ? BOOST_VISUAL_NORMAL : 0;
}

/** Frame-rate-independent attack/release envelope for every boost visual. */
export function stepBoostVisualIntensity(current: number, target: number, dt: number): number {
  const safeCurrent = clamp(Number.isFinite(current) ? current : 0, 0, BOOST_VISUAL_OVERDRIVE);
  const safeTarget = clamp(Number.isFinite(target) ? target : 0, 0, BOOST_VISUAL_OVERDRIVE);
  const safeDt = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const rate = safeTarget > safeCurrent ? BOOST_VISUAL_ATTACK : BOOST_VISUAL_RELEASE;
  return clamp(
    safeTarget + (safeCurrent - safeTarget) * Math.exp(-rate * safeDt),
    0,
    BOOST_VISUAL_OVERDRIVE,
  );
}
