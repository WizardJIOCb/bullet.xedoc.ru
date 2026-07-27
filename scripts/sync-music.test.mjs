import { describe, expect, it } from 'vitest';
import { importedFilename, isSupported } from './sync-music.mjs';

describe('music catalog sync', () => {
  it('keeps content-hashed build output idempotent', () => {
    const hash = '1234abcd5678ef00';
    expect(importedFilename('Future Track.mp3', hash)).toBe('future-track-1234abcd.mp3');
    expect(importedFilename('future-track-1234abcd.mp3', hash)).toBe('future-track-1234abcd.mp3');
  });

  it('accepts the documented browser audio extensions', () => {
    for (const name of ['track.mp3', 'track.wav', 'track.ogg', 'track.m4a', 'track.aac', 'track.flac', 'track.webm']) {
      expect(isSupported(name)).toBe(true);
    }
    expect(isSupported('cover.png')).toBe(false);
  });
});
