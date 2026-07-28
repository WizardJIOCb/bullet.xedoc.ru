import { describe, expect, it, vi, type Mock } from 'vitest';
import { cloneSettings, type GraphicsSettings } from '../settings/SettingsStore';
import { BallisticGame } from './Game';

interface GraphicsHarness {
  setGraphicsSettings: (settings: GraphicsSettings) => void;
  setBloomIntensity: (intensity: number) => void;
  setBrightness: (brightness: number) => void;
  graphicsSettings: GraphicsSettings;
  bloomStrengthSignal: number;
  exposureSignal: number;
  bloomPass: { enabled: boolean; strength: number };
  rgbPass: { enabled: boolean };
  renderer: { toneMappingExposure: number };
  resize: Mock;
}

function harness(): GraphicsHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    graphicsSettings: cloneSettings().graphics,
    bloomStrengthSignal: 1.6,
    exposureSignal: 1.1,
    bloomPass: { enabled: true, strength: 1.6 },
    rgbPass: { enabled: true },
    renderer: { toneMappingExposure: 1.1 },
    resize: vi.fn(),
  }) as unknown as GraphicsHarness;
}

describe('BallisticGame graphics intensity controls', () => {
  it('applies canonical graphics settings to the live post-processing signals', () => {
    const game = harness();
    const graphics = cloneSettings().graphics;
    graphics.bloomIntensity = 0.25;
    graphics.brightness = 0.7;
    graphics.chromaticAberration = false;

    game.setGraphicsSettings(graphics);

    expect(game.graphicsSettings).toEqual(graphics);
    expect(game.bloomPass.enabled).toBe(true);
    expect(game.bloomPass.strength).toBeCloseTo(0.4);
    expect(game.renderer.toneMappingExposure).toBeCloseTo(0.77);
    expect(game.rgbPass.enabled).toBe(false);
    expect(game.resize).toHaveBeenCalledOnce();
  });

  it('updates sliders live, clamps unsafe values and disables zero bloom work', () => {
    const game = harness();

    game.setBloomIntensity(-4);
    game.setBrightness(8);

    expect(game.graphicsSettings.bloomIntensity).toBe(0);
    expect(game.bloomPass.enabled).toBe(false);
    expect(game.bloomPass.strength).toBe(0);
    expect(game.graphicsSettings.brightness).toBe(1);
    expect(game.renderer.toneMappingExposure).toBeCloseTo(1.1);
    expect(game.resize).not.toHaveBeenCalled();
  });

  it('falls back from non-finite live values without passing NaN to WebGL', () => {
    const game = harness();

    game.setBloomIntensity(Number.NaN);
    game.setBrightness(Number.POSITIVE_INFINITY);

    expect(game.bloomPass.strength).toBeCloseTo(1.6 * 0.6);
    expect(game.renderer.toneMappingExposure).toBeCloseTo(1.1 * 0.88);
  });
});
