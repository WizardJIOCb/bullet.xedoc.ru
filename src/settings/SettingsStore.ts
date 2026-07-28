import { isLanguage, type Language } from '../i18n';

export interface AudioSettings {
  masterVolume: number;
  musicVolume: number;
  effectsVolume: number;
  muted: boolean;
}

export type GraphicsQuality = 'performance' | 'balanced' | 'quality';

export interface GraphicsSettings {
  quality: GraphicsQuality;
  reducedFlashes: boolean;
  bloom: boolean;
  /** User-controlled multiplier for the dynamic bloom signal, from 0 to 1. */
  bloomIntensity: number;
  /** User-controlled multiplier for tone-mapping exposure, from 0 to 1. */
  brightness: number;
  /** User-controlled readability of rival craft, from 0 to 1. */
  rivalVisibility: number;
  chromaticAberration: boolean;
  cameraShake: boolean;
}

export const INPUT_ACTIONS = [
  'left',
  'right',
  'cool',
  'boost',
  'fire',
  'ability',
  'upgrade1',
  'upgrade2',
  'upgrade3',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];
export type ControlBindings = Record<InputAction, [string, string | null]>;

export interface GameSettings {
  version: 1;
  language: Language;
  audio: AudioSettings;
  graphics: GraphicsSettings;
  controls: ControlBindings;
}

export type Settings = GameSettings;
export type SettingsState = GameSettings;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type ReadonlyControlBindings = {
  readonly [Action in InputAction]: readonly [string, string | null];
};

export interface ReadonlyGameSettings {
  readonly version: 1;
  readonly language: Language;
  readonly audio: Readonly<AudioSettings>;
  readonly graphics: Readonly<GraphicsSettings>;
  readonly controls: ReadonlyControlBindings;
}

export const SETTINGS_KEY = 'ballistic-edge-settings-v1';
const LEGACY_REDUCED_EFFECTS_KEY = 'ballistic-edge-reduced-fx';

const GRAPHICS_QUALITIES = new Set<GraphicsQuality>(['performance', 'balanced', 'quality']);
const UPGRADE_CODE_OWNER: Readonly<Record<string, InputAction>> = {
  Digit1: 'upgrade1',
  Numpad1: 'upgrade1',
  Digit2: 'upgrade2',
  Numpad2: 'upgrade2',
  Digit3: 'upgrade3',
  Numpad3: 'upgrade3',
};

const BINDABLE_CODE_PATTERN = /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Comma|Equal|Enter)|Arrow(?:Left|Right|Up|Down)|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Bracket(?:Left|Right)|Semicolon|Quote|Backquote|Comma|Period|Slash|Backslash|Minus|Equal|Intl(?:Backslash|Ro|Yen))$/;

const mutableDefaults: GameSettings = {
  version: 1,
  language: 'en',
  audio: {
    masterVolume: 0.9,
    musicVolume: 0.82,
    effectsVolume: 0.72,
    muted: false,
  },
  graphics: {
    quality: 'quality',
    reducedFlashes: false,
    bloom: true,
    bloomIntensity: 0.6,
    brightness: 0.88,
    rivalVisibility: 0.85,
    chromaticAberration: true,
    cameraShake: true,
  },
  controls: {
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    cool: ['KeyS', 'ArrowDown'],
    boost: ['Space', 'ShiftLeft'],
    fire: ['KeyF', 'Enter'],
    ability: ['KeyQ', 'KeyE'],
    upgrade1: ['Digit1', 'Numpad1'],
    upgrade2: ['Digit2', 'Numpad2'],
    upgrade3: ['Digit3', 'Numpad3'],
  },
};

function freezeDefaults(settings: GameSettings): ReadonlyGameSettings {
  Object.freeze(settings.audio);
  Object.freeze(settings.graphics);
  for (const action of INPUT_ACTIONS) Object.freeze(settings.controls[action]);
  Object.freeze(settings.controls);
  return Object.freeze(settings) as ReadonlyGameSettings;
}

export const DEFAULT_SETTINGS: ReadonlyGameSettings = freezeDefaults(mutableDefaults);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function volumeOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isCodeAllowedForAction(code: string, action: InputAction): boolean {
  const owner = UPGRADE_CODE_OWNER[code];
  return owner === undefined || owner === action;
}

function defaultCode(action: InputAction, slot: 0 | 1): string | null {
  return DEFAULT_SETTINGS.controls[action][slot];
}

function nextAvailablePrimary(action: InputAction, used: ReadonlySet<string>): string {
  const preferred = DEFAULT_SETTINGS.controls[action];
  for (const code of preferred) {
    if (code !== null && !used.has(code)) return code;
  }
  for (const fallbackAction of INPUT_ACTIONS) {
    for (const code of DEFAULT_SETTINGS.controls[fallbackAction]) {
      if (code !== null && !used.has(code) && isCodeAllowedForAction(code, action)) return code;
    }
  }
  // The defaults contain eighteen distinct codes, so this branch is unreachable
  // for the fixed nine-action schema. It keeps the return type total if it grows.
  return DEFAULT_SETTINGS.controls[action][0];
}

function sanitizeControls(value: unknown): ControlBindings {
  const source = isRecord(value) ? value : {};
  const controls = {} as ControlBindings;
  const used = new Set<string>();

  for (const action of INPUT_ACTIONS) {
    const rawBinding = source[action];
    const tuple = Array.isArray(rawBinding) ? rawBinding : null;
    const firstCandidate = tuple?.[0];
    const secondCandidate = tuple?.[1];

    let first = typeof firstCandidate === 'string'
      && isBindableCode(firstCandidate)
      && isCodeAllowedForAction(firstCandidate, action)
      ? firstCandidate
      : defaultCode(action, 0)!;
    if (used.has(first)) {
      const ownFallback = defaultCode(action, 0);
      first = ownFallback !== null && !used.has(ownFallback)
        ? ownFallback
        : nextAvailablePrimary(action, used);
    }
    used.add(first);

    let second: string | null;
    if (secondCandidate === null) {
      second = null;
    } else if (typeof secondCandidate === 'string'
      && isBindableCode(secondCandidate)
      && isCodeAllowedForAction(secondCandidate, action)) {
      second = secondCandidate;
    } else {
      second = defaultCode(action, 1);
    }

    if (second !== null && used.has(second)) {
      const ownFallback = defaultCode(action, 1);
      second = ownFallback !== null && !used.has(ownFallback) ? ownFallback : null;
    }
    if (second !== null) used.add(second);
    controls[action] = [first, second];
  }

  return controls;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function cloneSettings(settings: ReadonlyGameSettings = DEFAULT_SETTINGS): GameSettings {
  const controls = {} as ControlBindings;
  for (const action of INPUT_ACTIONS) {
    const [primary, secondary] = settings.controls[action];
    controls[action] = [primary, secondary];
  }
  return {
    version: 1,
    language: settings.language,
    audio: { ...settings.audio },
    graphics: { ...settings.graphics },
    controls,
  };
}

export function isBindableCode(code: unknown): code is string {
  return typeof code === 'string' && BINDABLE_CODE_PATTERN.test(code);
}

/**
 * Canonicalizes graphics settings independently so live render updates use the
 * same bounds as persisted settings. Missing intensity fields are treated as a
 * v1 payload and migrated to the current defaults.
 */
export function sanitizeGraphicsSettings(value: unknown): GraphicsSettings {
  const defaults = DEFAULT_SETTINGS.graphics;
  const graphics = isRecord(value) ? value : {};
  const quality = typeof graphics.quality === 'string' && GRAPHICS_QUALITIES.has(graphics.quality as GraphicsQuality)
    ? graphics.quality as GraphicsQuality
    : defaults.quality;

  return {
    quality,
    reducedFlashes: booleanOrDefault(graphics.reducedFlashes, defaults.reducedFlashes),
    bloom: booleanOrDefault(graphics.bloom, defaults.bloom),
    bloomIntensity: volumeOrDefault(graphics.bloomIntensity, defaults.bloomIntensity),
    brightness: volumeOrDefault(graphics.brightness, defaults.brightness),
    rivalVisibility: volumeOrDefault(graphics.rivalVisibility, defaults.rivalVisibility),
    chromaticAberration: booleanOrDefault(graphics.chromaticAberration, defaults.chromaticAberration),
    cameraShake: booleanOrDefault(graphics.cameraShake, defaults.cameraShake),
  };
}

export function sanitizeSettings(value: unknown): GameSettings {
  if (!isRecord(value) || value.version !== 1) return cloneSettings();

  const defaults = DEFAULT_SETTINGS;
  const audio = isRecord(value.audio) ? value.audio : {};

  return {
    version: 1,
    language: isLanguage(value.language) ? value.language : defaults.language,
    audio: {
      masterVolume: volumeOrDefault(audio.masterVolume, defaults.audio.masterVolume),
      musicVolume: volumeOrDefault(audio.musicVolume, defaults.audio.musicVolume),
      effectsVolume: volumeOrDefault(audio.effectsVolume, defaults.audio.effectsVolume),
      muted: booleanOrDefault(audio.muted, defaults.audio.muted),
    },
    graphics: sanitizeGraphicsSettings(value.graphics),
    controls: sanitizeControls(value.controls),
  };
}

export function saveSettings(settings: unknown, storage?: StorageLike): GameSettings {
  const sanitized = sanitizeSettings(settings);
  const target = storage ?? defaultStorage();
  if (!target) return sanitized;
  try {
    target.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
  } catch {
    // Storage can be unavailable in private/locked-down browsing contexts.
  }
  return sanitized;
}

export function loadSettings(storage?: StorageLike, legacyStorage?: StorageLike): GameSettings {
  const target = storage ?? defaultStorage();
  let serialized: string | null = null;

  if (target) {
    try {
      serialized = target.getItem(SETTINGS_KEY);
    } catch {
      return cloneSettings();
    }
  }

  if (serialized !== null) {
    try {
      return sanitizeSettings(JSON.parse(serialized) as unknown);
    } catch {
      return cloneSettings();
    }
  }

  const settings = cloneSettings();
  const legacy = legacyStorage ?? target;
  if (!legacy) return settings;

  try {
    if (legacy.getItem(LEGACY_REDUCED_EFFECTS_KEY) !== '1') return settings;
  } catch {
    return settings;
  }

  settings.graphics.reducedFlashes = true;
  settings.graphics.chromaticAberration = false;
  settings.graphics.cameraShake = false;
  return saveSettings(settings, target ?? undefined);
}
