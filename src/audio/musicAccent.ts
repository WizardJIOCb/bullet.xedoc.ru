import { clamp } from '../core/math';

export interface MusicAccentEnvelope {
  readonly active: boolean;
  readonly peakGain: number;
  readonly peakLowShelfDb: number;
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
}

const DEFAULT_BPM = 128;

/** A short, beat-scaled lift made only from the currently playing music. */
export function createMusicAccentEnvelope(amount: number, bpm: number): MusicAccentEnvelope {
  const intensity = clamp(Number.isFinite(amount) ? amount : 0, 0, 1.5);
  const safeBpm = clamp(Number.isFinite(bpm) ? bpm : DEFAULT_BPM, 60, 220);
  const beatSeconds = 60 / safeBpm;

  return {
    active: intensity > 0,
    peakGain: 1 + intensity * 0.16,
    peakLowShelfDb: intensity * 2.6,
    attackSeconds: clamp(beatSeconds * 0.025, 0.008, 0.014),
    releaseSeconds: clamp(beatSeconds * 0.38, 0.13, 0.24),
  };
}
