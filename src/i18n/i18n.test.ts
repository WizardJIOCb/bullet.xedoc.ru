import { afterEach, describe, expect, it } from 'vitest';
import { en } from './locales/en';
import { ru } from './locales/ru';
import { getLanguage, isLanguage, setLanguage, t } from '.';

afterEach(() => setLanguage('en'));

describe('i18n', () => {
  it('defaults to English and validates supported language codes', () => {
    expect(getLanguage()).toBe('en');
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('ru')).toBe(true);
    expect(isLanguage('de')).toBe(false);
  });

  it('keeps locale key sets in exact parity', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it('switches language and interpolates named values without mutating unknown tokens', () => {
    expect(t('preview.volumePercent', { percent: 82 })).toBe('82 percent');
    setLanguage('ru');
    expect(t('preview.volumePercent', { percent: 82 })).toBe('82 процентов');
    expect(t('preview.volumePercent')).toBe('{percent} процентов');
  });
});
