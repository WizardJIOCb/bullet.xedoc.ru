import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  cloneSettings,
  isBindableCode,
  loadSettings,
  sanitizeGraphicsSettings,
  sanitizeSettings,
  saveSettings,
  type StorageLike,
} from './SettingsStore';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('SettingsStore', () => {
  it('returns isolated defaults when storage is empty', () => {
    const storage = new MemoryStorage();
    const first = loadSettings(storage);
    const second = loadSettings(storage);

    expect(first).toEqual(DEFAULT_SETTINGS);
    expect(second).toEqual(DEFAULT_SETTINGS);
    expect(first).not.toBe(second);
    expect(first.audio).not.toBe(second.audio);
    expect(first.controls.left).not.toBe(second.controls.left);

    first.audio.masterVolume = 0.1;
    first.controls.left[0] = 'KeyZ';
    expect(second.audio.masterVolume).toBe(0.9);
    expect(second.controls.left[0]).toBe('KeyA');
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.controls.left)).toBe(true);
  });

  it.each([
    '{broken-json',
    'null',
    '[]',
    JSON.stringify({ version: 2, graphics: { reducedFlashes: true } }),
  ])('falls back safely for corrupt or unsupported payload %s', (payload) => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_KEY, payload);

    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps volumes and sanitizes graphics fields without coercing types', () => {
    const settings = sanitizeSettings({
      version: 1,
      audio: {
        masterVolume: -0.4,
        musicVolume: 4,
        effectsVolume: '0.25',
        muted: 'yes',
      },
      graphics: {
        quality: 'cinematic',
        reducedFlashes: true,
        bloom: false,
        bloomIntensity: 1.8,
        brightness: -0.4,
        chromaticAberration: 0,
        cameraShake: false,
      },
      controls: {},
    });

    expect(settings.audio).toEqual({
      masterVolume: 0,
      musicVolume: 1,
      effectsVolume: 0.72,
      muted: false,
    });
    expect(settings.graphics).toEqual({
      quality: 'quality',
      reducedFlashes: true,
      bloom: false,
      bloomIntensity: 1,
      brightness: 0,
      chromaticAberration: true,
      cameraShake: false,
    });
  });

  it('migrates v1 graphics payloads that predate intensity controls', () => {
    const graphics = sanitizeGraphicsSettings({
      quality: 'balanced',
      reducedFlashes: true,
      bloom: true,
      chromaticAberration: false,
      cameraShake: false,
    });

    expect(graphics).toEqual({
      quality: 'balanced',
      reducedFlashes: true,
      bloom: true,
      bloomIntensity: DEFAULT_SETTINGS.graphics.bloomIntensity,
      brightness: DEFAULT_SETTINGS.graphics.brightness,
      chromaticAberration: false,
      cameraShake: false,
    });
  });

  it('rejects non-finite graphics intensities instead of poisoning the render pipeline', () => {
    const graphics = sanitizeGraphicsSettings({
      ...DEFAULT_SETTINGS.graphics,
      bloomIntensity: Number.NaN,
      brightness: Number.POSITIVE_INFINITY,
    });

    expect(graphics.bloomIntensity).toBe(DEFAULT_SETTINGS.graphics.bloomIntensity);
    expect(graphics.brightness).toBe(DEFAULT_SETTINGS.graphics.brightness);
  });

  it('accepts KeyboardEvent.code values and rejects unsafe or localized key values', () => {
    for (const code of ['KeyW', 'ArrowLeft', 'Space', 'ShiftLeft', 'Digit0', 'NumpadEnter', 'BracketRight']) {
      expect(isBindableCode(code)).toBe(true);
    }
    for (const code of ['w', 'ц', ' ', '', 'Escape', 'Tab', 'ControlLeft', 'AltRight', 'MetaLeft', 'F1', 'F12', 'NotAKey']) {
      expect(isBindableCode(code)).toBe(false);
    }
  });

  it('keeps upgrade number keys only on their corresponding upgrade action', () => {
    const source = cloneSettings();
    source.controls.left = ['Digit1', 'Numpad2'];
    source.controls.upgrade1 = ['Digit2', 'Numpad3'];
    source.controls.upgrade2 = ['Digit2', 'Numpad2'];
    source.controls.upgrade3 = ['KeyZ', null];

    const settings = sanitizeSettings(source);

    expect(settings.controls.left).toEqual(['KeyA', 'ArrowLeft']);
    expect(settings.controls.upgrade1).toEqual(['Digit1', 'Numpad1']);
    expect(settings.controls.upgrade2).toEqual(['Digit2', 'Numpad2']);
    expect(settings.controls.upgrade3).toEqual(['KeyZ', null]);
  });

  it('resolves duplicate bindings deterministically instead of storing conflicts', () => {
    const source = cloneSettings();
    source.controls.left = ['KeyA', 'ArrowLeft'];
    source.controls.right = ['KeyA', 'ArrowLeft'];
    source.controls.cool = ['KeyD', 'ArrowRight'];

    const settings = sanitizeSettings(source);
    const codes = Object.values(settings.controls).flat().filter((code): code is string => code !== null);

    expect(settings.controls.right).toEqual(['KeyD', 'ArrowRight']);
    expect(settings.controls.cool).toEqual(['KeyS', 'ArrowDown']);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('persists a canonical round trip across store instances', () => {
    const storage = new MemoryStorage();
    const source = cloneSettings();
    source.audio = { masterVolume: 0.44, musicVolume: 0.35, effectsVolume: 0.61, muted: true };
    source.graphics = {
      quality: 'balanced',
      reducedFlashes: true,
      bloom: false,
      bloomIntensity: 0.32,
      brightness: 0.71,
      chromaticAberration: false,
      cameraShake: false,
    };
    source.controls.boost = ['KeyB', null];

    const saved = saveSettings(source, storage);
    const loaded = loadSettings(storage);

    expect(loaded).toEqual(saved);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!)).toEqual(saved);
  });

  it('migrates legacy reduced effects only when the new settings key is absent', () => {
    const primary = new MemoryStorage();
    const legacy = new MemoryStorage();
    legacy.setItem('ballistic-edge-reduced-fx', '1');

    const migrated = loadSettings(primary, legacy);
    expect(migrated.graphics).toMatchObject({
      quality: 'quality',
      reducedFlashes: true,
      bloom: true,
      bloomIntensity: 0.6,
      brightness: 0.88,
      chromaticAberration: false,
      cameraShake: false,
    });
    expect(primary.getItem(SETTINGS_KEY)).not.toBeNull();

    const existing = cloneSettings();
    existing.graphics.reducedFlashes = false;
    primary.setItem(SETTINGS_KEY, JSON.stringify(existing));
    expect(loadSettings(primary, legacy).graphics.reducedFlashes).toBe(false);
  });

  it('does not throw when browser storage reads or writes fail', () => {
    const failingStorage: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    const changed = cloneSettings();
    changed.audio.masterVolume = 0.33;

    expect(() => loadSettings(failingStorage)).not.toThrow();
    expect(loadSettings(failingStorage)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(changed, failingStorage)).not.toThrow();
    expect(saveSettings(changed, failingStorage).audio.masterVolume).toBe(0.33);
  });
});
