import { clamp } from '../core/math';
import type { RhythmCue } from '../core/types';

export interface MusicNoveltyFrame {
  readonly onset: number;
  readonly kick: number;
  readonly transient: number;
}

export interface MusicAccent {
  readonly frame: number;
  readonly time: number;
  readonly strength: number;
  readonly onset: number;
  readonly kick: number;
  readonly transient: number;
  readonly cue: Exclude<RhythmCue, 'beat' | 'transition'>;
}

export interface MusicNoveltyMap {
  readonly frames: readonly MusicNoveltyFrame[];
  readonly accents: readonly MusicAccent[];
}

export interface NormalizedMusicBands {
  readonly energy: number[];
  readonly bass: number[];
  readonly mids: number[];
  readonly highs: number[];
}

/**
 * Uses one acoustic ceiling for every RMS band. Independent normalization
 * destroys their relative balance and can turn tiny low-frequency leakage
 * into a false kick.
 */
export function normalizeMusicBands(
  energyInput: readonly number[],
  bassInput: readonly number[],
  midsInput: readonly number[],
  highsInput: readonly number[],
): NormalizedMusicBands {
  const sortedEnergy = [...energyInput].filter(Number.isFinite).sort((left, right) => left - right);
  const percentileIndex = Math.min(sortedEnergy.length - 1, Math.floor(sortedEnergy.length * 0.94));
  let fallbackMaximum = 0;
  for (const values of [energyInput, bassInput, midsInput, highsInput]) {
    for (const value of values) {
      if (Number.isFinite(value)) fallbackMaximum = Math.max(fallbackMaximum, value);
    }
  }
  const percentileCeiling = sortedEnergy[percentileIndex] ?? 0;
  const ceiling = Math.max(0.000001, percentileCeiling || fallbackMaximum || 1);
  const normalize = (values: readonly number[]): number[] => values.map((value) => clamp(value / ceiling, 0, 1));
  return {
    energy: normalize(energyInput),
    bass: normalize(bassInput),
    mids: normalize(midsInput),
    highs: normalize(highsInput),
  };
}

export function poolMusicCurve(
  values: readonly number[],
  bins: number,
  mode: 'mean' | 'peak' = 'mean',
): number[] {
  const safeBins = Math.max(1, Math.floor(bins));
  if (values.length === 0) return new Array<number>(safeBins).fill(0);
  return Array.from({ length: safeBins }, (_, index) => {
    const start = Math.floor((index / safeBins) * values.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / safeBins) * values.length));
    const safeEnd = Math.min(end, values.length);
    if (mode === 'peak') {
      let peak = 0;
      for (let cursor = start; cursor < safeEnd; cursor += 1) peak = Math.max(peak, values[cursor]);
      return peak;
    }
    let total = 0;
    for (let cursor = start; cursor < safeEnd; cursor += 1) total += values[cursor];
    return total / Math.max(1, safeEnd - start);
  });
}

function logCompress(value: number): number {
  return Math.log1p(clamp(value, 0, 1) * 12) / Math.log(13);
}

function previousMean(values: readonly number[], index: number, window: number): number {
  let sum = 0;
  let count = 0;
  for (let cursor = Math.max(0, index - window); cursor < index; cursor += 1) {
    sum += values[cursor];
    count += 1;
  }
  return count > 0 ? sum / count : values[index] ?? 0;
}

function adaptiveScores(values: readonly number[], frameDuration: number): number[] {
  const window = Math.max(4, Math.round(1.5 / Math.max(frameDuration, 0.001)));
  const scores = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) {
    const start = Math.max(0, index - window);
    let sum = 0;
    let squareSum = 0;
    let count = 0;
    for (let cursor = start; cursor < index; cursor += 1) {
      const value = values[cursor];
      sum += value;
      squareSum += value * value;
      count += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    const variance = count > 0 ? Math.max(0, squareSum / count - mean * mean) : 0;
    const deviation = Math.sqrt(variance);
    const excess = values[index] - mean - deviation * 0.72;
    const scale = Math.max(0.035, mean * 0.7, deviation * 2.45);
    scores[index] = clamp(excess / scale, 0, 1);
  }
  return scores;
}

/**
 * Builds volume-adaptive percussion novelty from already normalized RMS bands.
 * Only positive band flux is used, so a sudden fade is never mistaken for a hit.
 */
export function analyzeMusicNovelty(
  energyInput: readonly number[],
  bassInput: readonly number[],
  midsInput: readonly number[],
  highsInput: readonly number[],
  frameDuration: number,
): MusicNoveltyMap {
  const length = Math.max(energyInput.length, bassInput.length, midsInput.length, highsInput.length);
  if (length === 0) return { frames: Object.freeze([]), accents: Object.freeze([]) };

  const energy = Array.from({ length }, (_, index) => logCompress(energyInput[index] ?? 0));
  const bass = Array.from({ length }, (_, index) => logCompress(bassInput[index] ?? 0));
  const mids = Array.from({ length }, (_, index) => logCompress(midsInput[index] ?? 0));
  const highs = Array.from({ length }, (_, index) => logCompress(highsInput[index] ?? 0));
  const onsetRaw = new Array<number>(length).fill(0);
  const kickRaw = new Array<number>(length).fill(0);
  const transientRaw = new Array<number>(length).fill(0);

  for (let index = 1; index < length; index += 1) {
    const energyFlux = Math.max(0, energy[index] - previousMean(energy, index, 3));
    const bassFlux = Math.max(0, bass[index] - previousMean(bass, index, 3));
    const midsFlux = Math.max(0, mids[index] - previousMean(mids, index, 3));
    const highsFlux = Math.max(0, highs[index] - previousMean(highs, index, 3));
    const bassShare = bass[index] / Math.max(0.001, bass[index] + mids[index] + highs[index]);

    onsetRaw[index] = energyFlux * 0.32 + bassFlux * 0.3 + midsFlux * 0.22 + highsFlux * 0.16;
    kickRaw[index] = Math.max(0, bassFlux * 0.68 + energyFlux * 0.18 + energyFlux * bassShare * 0.14 - highsFlux * 0.12);
    transientRaw[index] = Math.max(0, midsFlux * 0.52 + highsFlux * 0.42 + energyFlux * 0.06 - bassFlux * 0.14);
  }

  const onsetScores = adaptiveScores(onsetRaw, frameDuration);
  const kickScores = adaptiveScores(kickRaw, frameDuration);
  const transientScores = adaptiveScores(transientRaw, frameDuration);
  for (let index = 0; index < length; index += 1) {
    const strongestBandRaw = Math.max(kickRaw[index], transientRaw[index]);
    if (strongestBandRaw <= 0) continue;
    kickScores[index] *= kickRaw[index] / strongestBandRaw;
    transientScores[index] *= transientRaw[index] / strongestBandRaw;
  }
  const frames = Object.freeze(Array.from({ length }, (_, index) => Object.freeze({
    onset: onsetScores[index],
    kick: kickScores[index],
    transient: transientScores[index],
  })));

  const accents: MusicAccent[] = [];
  for (let index = 1; index < length - 1; index += 1) {
    const onset = onsetScores[index];
    const kick = kickScores[index];
    const transient = transientScores[index];
    const peak = Math.max(kick, transient, onset * 0.78);
    const previousPeak = Math.max(kickScores[index - 1], transientScores[index - 1], onsetScores[index - 1] * 0.78);
    const nextPeak = Math.max(kickScores[index + 1], transientScores[index + 1], onsetScores[index + 1] * 0.78);
    if (peak < 0.5 || peak < previousPeak || peak <= nextPeak) continue;
    if (kick < 0.46 && transient < 0.5 && onset < 0.72) continue;

    const cue: MusicAccent['cue'] = kick >= Math.max(0.46, transient * 0.88) ? 'kick' : 'transient';
    const cueStrength = cue === 'kick' ? kick : transient;
    const accent = Object.freeze({
      frame: index,
      time: (index + 0.5) * frameDuration,
      strength: clamp(cueStrength * 0.76 + onset * 0.24, 0, 1),
      onset,
      kick,
      transient,
      cue,
    });
    const previous = accents[accents.length - 1];
    const refractory = cue === 'kick' || previous?.cue === 'kick' ? 0.105 : 0.08;
    if (previous && accent.time - previous.time < refractory) {
      if (accent.strength > previous.strength) accents[accents.length - 1] = accent;
      continue;
    }
    accents.push(accent);
  }

  return { frames, accents: Object.freeze(accents) };
}
