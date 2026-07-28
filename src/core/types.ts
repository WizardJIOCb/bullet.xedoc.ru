export type TrackId = 'aurora' | 'reactor' | 'void';
export type WeaponId = 'pulse' | 'scatter' | 'rail';
export type AbilityId = 'phase' | 'emp' | 'overdrive';
export type UpgradeId =
  | 'cryo-loop'
  | 'resonant-chamber'
  | 'kinetic-skin'
  | 'phase-battery'
  | 'redline-engine'
  | 'glass-cannon'
  | 'echo-shield'
  | 'afterburner'
  | 'flux-magnet';

export interface TrackTheme {
  id: TrackId;
  name: string;
  kicker: string;
  description: string;
  seed: number;
  radius: number;
  colors: {
    background: number;
    fog: number;
    primary: number;
    secondary: number;
    danger: number;
  };
  handling: number;
  hazardRate: number;
}

export interface WeaponDefinition {
  id: WeaponId;
  name: string;
  description: string;
  fireRate: number;
  damage: number;
  projectiles: number;
  spread: number;
  heat: number;
}

export interface AbilityDefinition {
  id: AbilityId;
  name: string;
  description: string;
  cooldown: number;
}

export interface MusicProfile {
  id: string;
  title: string;
  duration: number;
  runDuration: number;
  bpm: number;
  beatOffset: number;
  energy: number[];
  bass: number[];
  mids: number[];
  highs: number[];
  beats: RhythmBeat[];
  transitions: MusicTransition[];
  seed: number;
}

export interface RhythmBeat {
  time: number;
  strength: number;
  bass: number;
  highs: number;
  barBeat: 0 | 1 | 2 | 3;
}

export interface MusicTransition {
  time: number;
  strength: number;
  kind: 'build' | 'drop' | 'break' | 'fill';
}

export interface RunConfig {
  track: TrackId;
  weapon: WeaponId;
  ability: AbilityId;
  seed: number;
  garage: GarageState;
}

export interface GarageState {
  credits: number;
  engine: number;
  cooling: number;
  shield: number;
  weapon: number;
  bestScore: number;
  runs: number;
}

export interface UpgradeDefinition {
  id: UpgradeId;
  name: string;
  description: string;
  tag: string;
  tone: 'cyan' | 'gold' | 'red' | 'violet';
}

export type TrackEventKind = 'gate' | 'halfwall' | 'blade' | 'cross' | 'shard' | 'boost' | 'drone' | 'coolant';

export interface TrackEvent {
  id: number;
  kind: TrackEventKind;
  distance: number;
  angle: number;
  gapWidth: number;
  health: number;
  resolved: boolean;
  destroyed: boolean;
  beatIndex: number;
  musicTime: number;
  strength: number;
  rotationRate: number;
  rotationPhase: number;
  armCount: number;
  patternId: number;
  warningDistance: number;
}

export interface RunStats {
  speed: number;
  maxSpeed: number;
  progress: number;
  shield: number;
  maxShield: number;
  heat: number;
  flux: number;
  sync: number;
  score: number;
  rank: number;
  abilityCooldown: number;
  weaponCooldown: number;
  section: number;
  rhythmPulse: number;
  phaseActive: boolean;
  overheated: boolean;
}

export interface RunResult {
  score: number;
  credits: number;
  maxSpeed: number;
  accuracy: number;
  perfects: number;
  nearMisses: number;
  kills: number;
  rank: number;
  survived: boolean;
  trackName: string;
  seed: number;
}

export const TRACKS: Record<TrackId, TrackTheme> = {
  aurora: {
    id: 'aurora',
    name: 'Aurora Spine',
    kicker: 'FLOW / 01',
    description: 'Ледяная мегаструктура, широкие дуги и длинные окна для разгона.',
    seed: 0xa01a,
    radius: 13.5,
    colors: {
      background: 0x01050b,
      fog: 0x03101d,
      primary: 0x37f6ff,
      secondary: 0xa55cff,
      danger: 0xff365f,
    },
    handling: 1.05,
    hazardRate: 0.88,
  },
  reactor: {
    id: 'reactor',
    name: 'Solar Rupture',
    kicker: 'HEAT / 02',
    description: 'Реакторная шахта с узкими окнами, горячими секторами и тяжёлыми дронами.',
    seed: 0x501a,
    radius: 12.4,
    colors: {
      background: 0x090201,
      fog: 0x190502,
      primary: 0xffb21c,
      secondary: 0xff3e81,
      danger: 0xff2b2b,
    },
    handling: 0.94,
    hazardRate: 1.18,
  },
  void: {
    id: 'void',
    name: 'Null Cathedral',
    kicker: 'VOID / 03',
    description: 'Открытый каркас над сингулярностью: резкие штопоры и богатые линии Flux.',
    seed: 0xc0de,
    radius: 14.2,
    colors: {
      background: 0x020108,
      fog: 0x09031a,
      primary: 0xb377ff,
      secondary: 0x43ffd1,
      danger: 0xff467a,
    },
    handling: 1.12,
    hazardRate: 1,
  },
};

export const WEAPONS: Record<WeaponId, WeaponDefinition> = {
  pulse: {
    id: 'pulse',
    name: 'Pulse Lance',
    description: 'Точный импульс. Попадание в бит наносит двойной урон.',
    fireRate: 4.4,
    damage: 1,
    projectiles: 1,
    spread: 0,
    heat: 2.3,
  },
  scatter: {
    id: 'scatter',
    name: 'Arc Scatter',
    description: 'Три плазменные дуги очищают широкий сектор, но быстро греют реактор.',
    fireRate: 1.8,
    damage: 0.8,
    projectiles: 3,
    spread: 0.19,
    heat: 5.6,
  },
  rail: {
    id: 'rail',
    name: 'Graviton Rail',
    description: 'Медленный пробивной снаряд для дронов и плотных минных линий.',
    fireRate: 0.82,
    damage: 3,
    projectiles: 1,
    spread: 0,
    heat: 7.8,
  },
};

export const ABILITIES: Record<AbilityId, AbilityDefinition> = {
  phase: {
    id: 'phase',
    name: 'Phase Shift',
    description: 'На 1,4 сек. отрывает болид от стенки и игнорирует столкновения.',
    cooldown: 7,
  },
  emp: {
    id: 'emp',
    name: 'EMP Halo',
    description: 'Сжигает мины и оглушает дронов впереди на 180 метров.',
    cooldown: 11,
  },
  overdrive: {
    id: 'overdrive',
    name: 'Redline',
    description: 'Четыре секунды без нагрева и с максимальной тягой.',
    cooldown: 14,
  },
};

export const UPGRADES: UpgradeDefinition[] = [
  { id: 'cryo-loop', name: 'Cryo Loop', description: 'Perfect-события снимают 7% heat, пассивное охлаждение +18%.', tag: 'COOLING', tone: 'cyan' },
  { id: 'resonant-chamber', name: 'Resonant Chamber', description: 'Каждый четвёртый ритм-выстрел выпускает бесплатный двойной импульс.', tag: 'WEAPON', tone: 'violet' },
  { id: 'kinetic-skin', name: 'Kinetic Skin', description: 'Near-miss восстанавливает 18 Flux и даёт короткий импульс скорости.', tag: 'FLOW', tone: 'gold' },
  { id: 'phase-battery', name: 'Phase Battery', description: 'Способность перезаряжается на 25% быстрее.', tag: 'ABILITY', tone: 'cyan' },
  { id: 'redline-engine', name: 'Redline Engine', description: '+16% к максимальной скорости, но boost греет сильнее.', tag: 'ENGINE', tone: 'red' },
  { id: 'glass-cannon', name: 'Glass Cannon', description: '+65% к урону, но максимальный щит уменьшается на один сегмент.', tag: 'RISK', tone: 'red' },
  { id: 'echo-shield', name: 'Echo Shield', description: 'Каждые 8 успешных ритм-действий восстанавливают сегмент щита.', tag: 'SHIELD', tone: 'violet' },
  { id: 'afterburner', name: 'Afterburner', description: 'Overdrive и идеальный boost длятся на 1,2 сек. дольше.', tag: 'BOOST', tone: 'gold' },
  { id: 'flux-magnet', name: 'Flux Magnet', description: 'Удваивает радиус сбора кристаллов и их ценность.', tag: 'ECONOMY', tone: 'cyan' },
];
