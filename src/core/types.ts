export type TrackId = 'aurora' | 'reactor' | 'void' | 'forge';
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
  | 'flux-magnet'
  | 'temporal-core';

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
  onsets?: number[];
  kicks?: number[];
  transients?: number[];
  beats: RhythmBeat[];
  transitions: MusicTransition[];
  seed: number;
}

export type RhythmCue = 'beat' | 'kick' | 'transient' | 'transition';

export interface RhythmBeat {
  time: number;
  strength: number;
  bass: number;
  highs: number;
  barBeat: 0 | 1 | 2 | 3;
  gridBeat?: boolean;
  cue?: RhythmCue;
  onset?: number;
  kick?: number;
  transient?: number;
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
  /** Number of local AI rivals. Omitted keeps the classic three-rival solo race. */
  aiOpponents?: number;
}

/**
 * Compact, serialization-safe state of the local bolide. `speed` uses the same
 * km/h display scale as the HUD and `progress` is normalized to the course.
 */
export interface LocalRaceSnapshot {
  progress: number;
  angle: number;
  speed: number;
  shield: number;
  heat: number;
  flux: number;
  score: number;
  rank: number;
  section: number;
  active: boolean;
  running: boolean;
  destroyed: boolean;
  finished: boolean;
}

/** Network-fed visual state for another human racer. Remote racers are visual only. */
export interface RemoteRacerState {
  id: string;
  name: string;
  progress: number;
  angle: number;
  speed: number;
  shield: number;
  active?: boolean;
  destroyed?: boolean;
  finished?: boolean;
  /** Authoritative server timestamp for a completed online run. */
  finishedAt?: number;
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

export type TrackEventKind = 'gate' | 'aperture' | 'halfwall' | 'blade' | 'cross' | 'bastion' | 'shard' | 'boost' | 'coolant';
export type TrackEventTrigger = RhythmCue | MusicTransition['kind'];

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
  trigger: TrackEventTrigger;
  strength: number;
  rotationRate: number;
  rotationPhase: number;
  armCount: number;
  patternId: number;
  warningDistance: number;
  /** Center of the generator's physically reachable opening at impact time. */
  safeAngle?: number;
  /** Angular velocity of the reference bolide at the reachable opening. */
  safeAngularVelocity?: number;
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
  rivals?: RivalRaceMarker[];
}

export type RivalRaceMode = 'cruise' | 'read' | 'pulse' | 'draft' | 'block' | 'overtake' | 'edge' | 'vent';

export interface RivalRaceMarker {
  id: string;
  name: string;
  progress: number;
  mode: RivalRaceMode;
  color: number;
  boost: number;
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
    description: 'An icy megastructure with wide arcs and long acceleration windows.',
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
    description: 'A reactor shaft with narrow windows, hot sectors, and heavy armored bastions.',
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
    description: 'An open frame above a singularity: sharp corkscrews and rich Flux lines.',
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
  forge: {
    id: 'forge',
    name: 'Pulse Forge',
    kicker: 'INDUSTRIAL / 04',
    description: 'A scorching industrial corridor with dense gates, rotating patterns, and maximum event density.',
    seed: 0xf0a6e,
    radius: 11.8,
    colors: {
      background: 0x05010a,
      fog: 0x120318,
      primary: 0xff5c8a,
      secondary: 0xffc93a,
      danger: 0xff1a4a,
    },
    handling: 0.98,
    hazardRate: 1.35,
  },
};

export const WEAPONS: Record<WeaponId, WeaponDefinition> = {
  pulse: {
    id: 'pulse',
    name: 'Pulse Lance',
    description: 'A precise pulse. Beat hits deal double damage.',
    fireRate: 4.4,
    damage: 1,
    projectiles: 1,
    spread: 0,
    heat: 2.3,
  },
  scatter: {
    id: 'scatter',
    name: 'Arc Scatter',
    description: 'Three plasma arcs clear a wide sector, but heat the reactor quickly.',
    fireRate: 1.8,
    damage: 0.8,
    projectiles: 3,
    spread: 0.19,
    heat: 5.6,
  },
  rail: {
    id: 'rail',
    name: 'Graviton Rail',
    description: 'A slow armor-piercing projectile for bastion cores.',
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
    description: 'Detaches the craft from the wall for 1.4 sec and ignores collisions.',
    cooldown: 7,
  },
  emp: {
    id: 'emp',
    name: 'EMP Halo',
    description: 'Destroys armored bastions ahead within a 190-meter radius.',
    cooldown: 11,
  },
  overdrive: {
    id: 'overdrive',
    name: 'Redline',
    description: 'Four seconds without heat buildup and with maximum thrust.',
    cooldown: 14,
  },
};

export const UPGRADES: UpgradeDefinition[] = [
  { id: 'cryo-loop', name: 'Cryo Loop', description: 'Perfect events remove 7% heat; passive cooling +18%.', tag: 'COOLING', tone: 'cyan' },
  { id: 'resonant-chamber', name: 'Resonant Chamber', description: 'Every fourth rhythm shot fires a free double pulse.', tag: 'WEAPON', tone: 'violet' },
  { id: 'kinetic-skin', name: 'Kinetic Skin', description: 'Near misses restore 18 Flux and grant a short speed pulse.', tag: 'FLOW', tone: 'gold' },
  { id: 'phase-battery', name: 'Phase Battery', description: 'Ability recharge is 25% faster.', tag: 'ABILITY', tone: 'cyan' },
  { id: 'redline-engine', name: 'Redline Engine', description: '+16% top speed, but boost generates more heat.', tag: 'ENGINE', tone: 'red' },
  { id: 'glass-cannon', name: 'Glass Cannon', description: '+65% damage, but maximum shield loses one segment.', tag: 'RISK', tone: 'red' },
  { id: 'echo-shield', name: 'Echo Shield', description: 'Every 8 successful rhythm actions restore one shield segment.', tag: 'SHIELD', tone: 'violet' },
  { id: 'afterburner', name: 'Afterburner', description: 'Overdrive and perfect boost last 1.2 sec longer.', tag: 'BOOST', tone: 'gold' },
  { id: 'flux-magnet', name: 'Flux Magnet', description: 'Doubles crystal pickup radius and value.', tag: 'ECONOMY', tone: 'cyan' },
  { id: 'temporal-core', name: 'Temporal Core', description: 'Perfect sync grants +35% score and stronger handling for 1.2 sec.', tag: 'RHYTHM', tone: 'gold' },
];
