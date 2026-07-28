import { describe, expect, it, vi, type Mock } from 'vitest';
import * as THREE from 'three';
import { cloneSettings, type GraphicsSettings } from '../settings/SettingsStore';
import { BallisticGame } from './Game';

interface GraphicsHarness {
  setGraphicsSettings: (settings: GraphicsSettings) => void;
  setBloomIntensity: (intensity: number) => void;
  setBrightness: (brightness: number) => void;
  setRivalVisibility: (visibility: number) => void;
  graphicsSettings: GraphicsSettings;
  bloomStrengthSignal: number;
  exposureSignal: number;
  bloomPass: { enabled: boolean; strength: number };
  rgbPass: { enabled: boolean };
  renderer: { toneMappingExposure: number };
  rivals: [];
  remoteRacers: Map<string, never>;
  resize: Mock;
}

interface OpponentVisualProbe {
  graphicsSettings: GraphicsSettings;
  prepareOpponentVisual: (
    craft: THREE.Group,
    kind: 'ai' | 'remote',
    color: number,
    beacon: THREE.Sprite,
    nameplate: THREE.Sprite | null,
  ) => {
    materials: Array<{ material: THREE.MeshBasicMaterial; surface: boolean }>;
  };
  applyOpponentVisibility: (visual: unknown) => void;
}

function harness(): GraphicsHarness {
  return Object.assign(Object.create(BallisticGame.prototype) as object, {
    graphicsSettings: cloneSettings().graphics,
    bloomStrengthSignal: 1.6,
    exposureSignal: 1.1,
    bloomPass: { enabled: true, strength: 1.6 },
    rgbPass: { enabled: true },
    renderer: { toneMappingExposure: 1.1 },
    rivals: [],
    remoteRacers: new Map(),
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

  it('sanitizes the live rival visibility control without rebuilding the renderer', () => {
    const game = harness();

    game.setRivalVisibility(-2);
    expect(game.graphicsSettings.rivalVisibility).toBe(0);

    game.setRivalVisibility(Number.POSITIVE_INFINITY);
    expect(game.graphicsSettings.rivalVisibility).toBe(0.85);
    expect(game.resize).not.toHaveBeenCalled();
  });

  it('keeps solid rival hulls depth-writing while reserving transparency for glow layers', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      graphicsSettings: cloneSettings().graphics,
    }) as unknown as OpponentVisualProbe;
    const solid = new THREE.MeshBasicMaterial({ color: 0x05070a });
    const glow = new THREE.MeshBasicMaterial({
      color: 0x22eeff,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const craft = new THREE.Group();
    craft.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), solid),
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glow),
    );
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0.7 }));

    const visual = game.prepareOpponentVisual(craft, 'ai', 0xff5c82, beacon, null);

    expect(visual.materials.map((entry) => entry.surface)).toEqual([true, false]);
    expect(solid.transparent).toBe(false);
    expect(solid.depthWrite).toBe(true);
    expect(solid.opacity).toBe(1);
    expect(glow.transparent).toBe(true);
    expect(glow.depthWrite).toBe(false);
    expect(glow.opacity).toBeGreaterThan(0.25);
  });
});
