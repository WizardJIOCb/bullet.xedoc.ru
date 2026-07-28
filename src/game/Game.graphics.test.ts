import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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
  createRacerNameplate: (name: string, color: number) => THREE.Sprite | null;
  createRivalBeacon: (color: number) => THREE.Sprite;
  createRivalLocator: (color: number) => THREE.Sprite;
  prepareOpponentVisual: (
    craft: THREE.Group,
    kind: 'ai' | 'remote',
    color: number,
    beacon: THREE.Sprite,
    locator: THREE.Sprite,
    nameplate: THREE.Sprite | null,
  ) => {
    materials: Array<{ material: THREE.MeshBasicMaterial; surface: boolean }>;
    craft: THREE.Group;
    craftBaseScale: THREE.Vector3;
    beacon: THREE.Sprite;
    locator: THREE.Sprite;
    nameplate: THREE.Sprite | null;
  };
  applyOpponentVisibility: (visual: unknown) => void;
  pulseOpponentBeacon: (visual: unknown, pulse: number, ahead?: number) => void;
}

function stubCanvasDocument(): void {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
  };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
    })),
  });
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const locator = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
    }));

    const visual = game.prepareOpponentVisual(craft, 'ai', 0xff5c82, beacon, locator, null);

    expect(visual.materials.map((entry) => entry.surface)).toEqual([true, false]);
    expect(solid.transparent).toBe(false);
    expect(solid.depthWrite).toBe(true);
    expect(solid.opacity).toBe(1);
    expect(glow.transparent).toBe(true);
    expect(glow.depthWrite).toBe(false);
    expect(glow.opacity).toBeGreaterThan(0.25);
  });

  it('creates a screen-readable locator and nameplate without hiding the depth-tested hull reticle', () => {
    stubCanvasDocument();
    const game = Object.create(BallisticGame.prototype) as OpponentVisualProbe;

    const beacon = game.createRivalBeacon(0xff5c82);
    const locator = game.createRivalLocator(0xff5c82);
    const nameplate = game.createRacerNameplate('Oracle', 0xff5c82);

    expect(beacon.material.depthTest).toBe(true);
    expect(beacon.material.depthWrite).toBe(false);
    expect(locator.material.depthTest).toBe(false);
    expect(locator.material.depthWrite).toBe(false);
    expect(locator.renderOrder).toBeGreaterThan(beacon.renderOrder);
    expect(locator.userData.opponentVisibilityRole).toBe('locator');
    expect(nameplate).not.toBeNull();
    expect(nameplate?.material.depthTest).toBe(false);
    expect(nameplate?.material.depthWrite).toBe(false);
  });

  it('uses strong accent contrast and large overlay markers at maximum rival visibility', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      graphicsSettings: { ...cloneSettings().graphics, rivalVisibility: 1 },
    }) as unknown as OpponentVisualProbe;
    const accent = new THREE.Color(0xff5c82);
    const solid = new THREE.MeshBasicMaterial({ color: 0x05070a });
    const originalColor = solid.color.clone();
    const glow = new THREE.MeshBasicMaterial({
      color: 0x22eeff,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const craft = new THREE.Group();
    craft.scale.setScalar(0.72);
    craft.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), solid),
      new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glow),
    );
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0.7 }));
    const locator = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
    }));

    const visual = game.prepareOpponentVisual(craft, 'ai', accent.getHex(), beacon, locator, null);

    expect(colorDistance(solid.color, accent)).toBeLessThan(colorDistance(originalColor, accent) * 0.35);
    expect(solid.transparent).toBe(false);
    expect(solid.depthWrite).toBe(true);
    expect(glow.opacity).toBeGreaterThan(0.5);
    expect(beacon.scale.x).toBeGreaterThanOrEqual(10);
    expect(beacon.material.opacity).toBeGreaterThanOrEqual(0.95);
    expect(locator.scale.x).toBeGreaterThanOrEqual(11);
    expect(locator.material.opacity).toBe(1);
  });

  it('adds bounded distance readability while shrinking markers safely at contact', () => {
    const game = Object.assign(Object.create(BallisticGame.prototype) as object, {
      graphicsSettings: { ...cloneSettings().graphics, rivalVisibility: 1 },
    }) as unknown as OpponentVisualProbe;
    const craft = new THREE.Group();
    craft.scale.setScalar(0.72);
    craft.add(new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x05070a }),
    ));
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }));
    const locator = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    const visual = game.prepareOpponentVisual(craft, 'ai', 0xff5c82, beacon, locator, null);
    const baseCraftScale = visual.craftBaseScale.x;
    const baseLocatorScale = locator.scale.x;

    game.pulseOpponentBeacon(visual, 0, 250);

    expect(craft.scale.x).toBeGreaterThan(baseCraftScale);
    expect(craft.scale.x).toBeLessThanOrEqual(baseCraftScale * 1.36 + 0.0001);
    expect(locator.scale.x).toBeGreaterThan(baseLocatorScale * 1.8);
    expect(beacon.scale.x).toBeGreaterThan(18);

    game.pulseOpponentBeacon(visual, 0, 0);

    expect(craft.scale.x).toBeCloseTo(baseCraftScale);
    expect(craft.scale.y).toBeCloseTo(baseCraftScale);
    expect(locator.scale.x).toBeCloseTo(baseLocatorScale * 0.24);
    expect(beacon.scale.x).toBeCloseTo(10 * 0.24);
    expect(locator.scale.x).toBeLessThan(baseLocatorScale * 0.3);
  });
});
