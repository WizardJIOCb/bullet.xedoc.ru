import { describe, expect, it } from 'vitest';
import { analyzeMusicNovelty, normalizeMusicBands, poolMusicCurve } from './musicAnalysis';

function flatBands(length = 120, level = 0.12) {
  return {
    energy: new Array<number>(length).fill(level),
    bass: new Array<number>(length).fill(level * 0.8),
    mids: new Array<number>(length).fill(level * 0.9),
    highs: new Array<number>(length).fill(level * 0.7),
  };
}

describe('music novelty analysis', () => {
  const frameDuration = 0.025;

  it('separates bass-dominant kicks from mid/high transients', () => {
    const bands = flatBands();
    bands.energy[20] = 0.95;
    bands.bass[20] = 1;
    bands.mids[20] = 0.18;
    bands.highs[20] = 0.12;
    bands.energy[42] = 0.82;
    bands.bass[42] = 0.11;
    bands.mids[42] = 0.98;
    bands.highs[42] = 1;

    const map = analyzeMusicNovelty(bands.energy, bands.bass, bands.mids, bands.highs, frameDuration);
    const kick = map.accents.find((accent) => Math.abs(accent.time - 0.5125) <= frameDuration);
    const transient = map.accents.find((accent) => Math.abs(accent.time - 1.0625) <= frameDuration);

    expect(kick).toMatchObject({ cue: 'kick' });
    expect(kick!.kick).toBeGreaterThan(kick!.transient);
    expect(transient).toMatchObject({ cue: 'transient' });
    expect(transient!.transient).toBeGreaterThan(transient!.kick);
  });

  it('does not turn a sustained bass bed or a sudden fade into repeated hits', () => {
    const bands = flatBands();
    for (let index = 18; index < 65; index += 1) {
      bands.energy[index] = 0.62;
      bands.bass[index] = 0.9;
    }
    for (let index = 80; index < bands.energy.length; index += 1) {
      bands.energy[index] = 0.025;
      bands.bass[index] = 0.02;
      bands.mids[index] = 0.02;
      bands.highs[index] = 0.02;
    }

    const map = analyzeMusicNovelty(bands.energy, bands.bass, bands.mids, bands.highs, frameDuration);
    const sustainedBassKicks = map.accents.filter((accent) => accent.cue === 'kick' && accent.time >= 0.4 && accent.time < 1.7);
    const fadeAccents = map.accents.filter((accent) => accent.time >= 2);

    expect(sustainedBassKicks).toHaveLength(1);
    expect(fadeAccents).toHaveLength(0);
  });

  it('detects relative hits in both quiet and loud sections', () => {
    const bands = flatBands(180, 0.035);
    bands.energy[24] = 0.18;
    bands.bass[24] = 0.2;
    for (let index = 80; index < bands.energy.length; index += 1) {
      bands.energy[index] = 0.55;
      bands.bass[index] = 0.48;
      bands.mids[index] = 0.42;
      bands.highs[index] = 0.36;
    }
    bands.energy[122] = 1;
    bands.bass[122] = 1;

    const map = analyzeMusicNovelty(bands.energy, bands.bass, bands.mids, bands.highs, frameDuration);

    expect(map.accents.some((accent) => Math.abs(accent.time - 0.6125) <= frameDuration)).toBe(true);
    expect(map.accents.some((accent) => Math.abs(accent.time - 3.0625) <= frameDuration)).toBe(true);
  });

  it('keeps frequency bands on one physical scale before cue classification', () => {
    const energy = new Array<number>(80).fill(0.2);
    const bass = new Array<number>(80).fill(0.002);
    const mids = new Array<number>(80).fill(0.12);
    const highs = new Array<number>(80).fill(0.1);
    energy[30] = 1;
    bass[30] = 0.004;
    mids[30] = 0.82;
    highs[30] = 0.74;

    const normalized = normalizeMusicBands(energy, bass, mids, highs);
    const map = analyzeMusicNovelty(
      normalized.energy,
      normalized.bass,
      normalized.mids,
      normalized.highs,
      frameDuration,
    );
    const accent = map.accents.find((candidate) => Math.abs(candidate.time - 0.7625) <= frameDuration);

    expect(normalized.bass[30]).toBeLessThan(0.03);
    expect(normalized.bass[30]).toBeLessThan(normalized.mids[30] * 0.03);
    expect(accent).toMatchObject({ cue: 'transient' });
  });

  it('retains isolated novelty spikes when compressing a long timeline', () => {
    const novelty = new Array<number>(1200).fill(0);
    novelty[617] = 1;

    expect(Math.max(...poolMusicCurve(novelty, 100, 'peak'))).toBe(1);
    expect(Math.max(...poolMusicCurve(novelty, 100, 'mean'))).toBeCloseTo(1 / 12, 8);
  });
});
