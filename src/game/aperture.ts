import { TAU } from '../core/math';

export interface ApertureBulkheadLayout {
  readonly outerRadius: number;
  readonly innerRadius: number;
  readonly centerCapRadius: number;
  readonly routeRadius: number;
  readonly safeStart: number;
  readonly safeArc: number;
  readonly blockedStart: number;
  readonly blockedArc: number;
}

/**
 * Pure geometry shared by the rendered aperture and its invariant tests.
 * The safe arc deliberately uses the event gap without visual clamping so the
 * illuminated slot and collision corridor have identical angular boundaries.
 */
export function getApertureBulkheadLayout(
  tunnelRadius: number,
  eventAngle: number,
  gapWidth: number,
): ApertureBulkheadLayout {
  if (!Number.isFinite(tunnelRadius) || tunnelRadius <= 4) {
    throw new RangeError('Aperture tunnel radius must be finite and greater than four.');
  }
  if (!Number.isFinite(eventAngle)) {
    throw new RangeError('Aperture angle must be finite.');
  }
  if (!Number.isFinite(gapWidth) || gapWidth <= 0 || gapWidth >= Math.PI) {
    throw new RangeError('Aperture gap must be between zero and PI.');
  }

  const outerRadius = tunnelRadius - 0.16;
  const innerRadius = Math.min(2.35, Math.max(1.8, tunnelRadius * 0.18));
  const centerCapRadius = innerRadius + 0.1;
  const routeRadius = tunnelRadius - 1.8;
  const safeArc = gapWidth * 2;

  return {
    outerRadius,
    innerRadius,
    centerCapRadius,
    routeRadius,
    safeStart: eventAngle - gapWidth,
    safeArc,
    blockedStart: eventAngle + gapWidth,
    blockedArc: TAU - safeArc,
  };
}
