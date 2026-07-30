import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RGBShiftShader } from 'three/examples/jsm/shaders/RGBShiftShader.js';
import type { AudioBands } from '../audio/AudioEngine';
import { AudioEngine } from '../audio/AudioEngine';
import { angularDistance, clamp, damp, mulberry32, pickDistinct, TAU, wrapAngle } from '../core/math';
import { t } from '../i18n';
import {
  ABILITIES,
  TRACKS,
  UPGRADES,
  WEAPONS,
  type RunConfig,
  type LocalRaceSnapshot,
  type RaceStanding,
  type RemoteRacerState,
  type RunResult,
  type RunStats,
  type TrackEvent,
  type TrackId,
  type UpgradeDefinition,
  type UpgradeId,
} from '../core/types';
import {
  sanitizeGraphicsSettings,
  type ControlBindings,
  type GraphicsSettings,
  type InputAction,
  type SettingsState,
} from '../settings/SettingsStore';
import type { TouchInputAction } from '../input/TouchInputRouter';
import { resolveBoostVisualTarget, stepBoostVisualIntensity } from './boost';
import { getApertureBulkheadLayout } from './aperture';
import { computeObstacleKnockback, isObstacleCollision } from './collision';
import { ChaseDeathFx } from './deathFx';
import { classifyMusicEventTiming, isInsideMusicEventWindow, synchronizeDistanceToMusic } from './rhythm';
import { stepWallRideSteering, type SteeringInput } from './steering';
import {
  DEATH_MUSIC_FADE_DURATION,
  createDeathSequenceState,
  stepDeathSequence,
  type DeathSequenceState,
} from './deathSequence';
import {
  RIVAL_ARCHETYPE_LABELS,
  applyRivalHazardImpact,
  createRivalAIProfile,
  createRivalAIState,
  stepRivalAI,
  type RivalAIOutput,
  type RivalAIProfile,
  type RivalAIRaceModel,
  type RivalAISnapshot,
  type RivalAIState,
} from './rivalAI';
import { resolveOpponentVisualQuaternion } from './opponentVisual';
import {
  calculateCourseQuality,
  createObstaclePerformance,
  isMajorObstacle,
  orderRaceStandings,
} from './runReport';
import {
  generateTrack,
  getTrackEventSafeCorridors,
  radialAt,
  sampleTrackFrame,
  type TrackFrame,
  type TrackPlan,
} from './track';
import { createTrackTimeline, type TrackTimeline } from './timeline';

type GameState = 'menu' | 'countdown' | 'playing' | 'dying' | 'finished';

interface GameHooks {
  onHud: (stats: RunStats) => void;
  onTimeline: (timeline: TrackTimeline) => void;
  onToast: (message: string, detail?: string, tone?: 'cyan' | 'gold' | 'red' | 'violet') => void;
  onUpgradeState: (pending: UpgradeDefinition[], installed: UpgradeDefinition[]) => void;
  onTerminal: () => void;
  onFinish: (result: RunResult) => void;
  onCountdown: (value: string | null) => void;
  onSection: (name: string, index: number) => void;
  onImpact: (direction: -1 | 1) => void;
}

interface Bullet {
  mesh: THREE.Mesh;
  distance: number;
  angle: number;
  speed: number;
  damage: number;
  ttl: number;
  piercing: number;
}

interface Rival {
  mesh: THREE.Group;
  engineGlow: THREE.Group;
  thrustTrails: THREE.Mesh[];
  visual: OpponentVisual;
  profile: RivalAIProfile;
  ai: RivalAIState;
  lastOutput: RivalAIOutput | null;
  color: number;
  maxSpeed: number;
  obstaclesEncountered: number;
  obstacleCollisions: number;
}

type OpponentKind = 'ai' | 'remote';

interface OpponentVisualMaterial {
  material: THREE.MeshBasicMaterial;
  baseColor: THREE.Color;
  baseOpacity: number;
  surface: boolean;
  outline: boolean;
}

interface OpponentVisual {
  kind: OpponentKind;
  accent: THREE.Color;
  highlight: THREE.Color;
  materials: OpponentVisualMaterial[];
  craft: THREE.Group;
  craftBaseScale: THREE.Vector3;
  beacon: THREE.Sprite;
  locator: THREE.Sprite;
  nameplate: THREE.Sprite | null;
  nameplateBaseScale: THREE.Vector3 | null;
}

export interface RunStartOptions {
  online?: boolean;
  aiRivals?: readonly RivalStartDescriptor[];
  serverTime?: () => number;
  raceStartsAt?: number;
  /** Stable size of the starting grid, including the local player. */
  competitorCount?: number;
}

export interface RivalStartDescriptor {
  id?: string;
  name?: string;
  difficulty?: number;
}

interface RemoteRacer {
  id: string;
  name: string;
  colorIndex: number;
  mesh: THREE.Group;
  visual: OpponentVisual;
  progress: number;
  targetProgress: number;
  angle: number;
  targetAngle: number;
  speed: number;
  shield: number;
  active: boolean;
  destroyed: boolean;
  finished: boolean;
  dnf: boolean;
  terminalAt: number | null;
  score: number | null;
}

interface Burst {
  points: THREE.Points;
  velocities: THREE.Vector3[];
  life: number;
  maxLife: number;
  drag: number;
}

interface BurstOptions {
  direction?: THREE.Vector3;
  speed?: number;
  spread?: number;
  size?: number;
  life?: number;
  drag?: number;
}

interface ChaseImpactEffect {
  sparks: THREE.LineSegments;
  wave: THREE.Mesh;
  velocities: THREE.Vector3[];
  life: number;
  maxLife: number;
  sparkPeakOpacity: number;
}

interface BoostStreakSpec {
  angle: number;
  radius: number;
  offset: number;
  speed: number;
  length: number;
}

interface ChaseBoostEffect {
  group: THREE.Group;
  shell: THREE.Mesh;
  shellMaterial: THREE.ShaderMaterial;
  streaks: THREE.LineSegments;
  streakMaterial: THREE.LineBasicMaterial;
  streakSpecs: BoostStreakSpec[];
  rings: THREE.Mesh[];
  ringMaterials: THREE.MeshBasicMaterial[];
  kickRing: THREE.Mesh;
  kickMaterial: THREE.MeshBasicMaterial;
}

interface StreakSpec {
  angle: number;
  radial: number;
  offset: number;
  length: number;
}

interface SkylineTrafficVehicle {
  group: THREE.Group;
  baseDistance: number;
  speed: number;
  sideOffset: number;
  orbitAngle: number;
  bobPhase: number;
  bank: number;
}

type UnderwaterCreatureKind = 'whale' | 'shark' | 'dolphin' | 'manta' | 'turtle' | 'jellyfish' | 'fish';

interface UnderwaterCreature {
  group: THREE.Group;
  kind: UnderwaterCreatureKind;
  baseDistance: number;
  speed: number;
  orbitAngle: number;
  radiusOffset: number;
  phase: number;
  scale: number;
}

const FIXED_STEP = 1 / 120;
const RUN_COUNTDOWN_SECONDS = 2.8;
const ONLINE_AI_CATCHUP_STEPS_PER_FRAME = 120;
const RESULT_AI_CATCHUP_STEPS_PER_FRAME = 240;
const RESULT_AI_MAX_DURATION_MULTIPLIER = 1.6;
const ONLINE_TERMINAL_ACK_TIMEOUT = 1.5;
const UPGRADES_AT = [0.31, 0.64];
const TEMPORAL_FOCUS_DURATION = 1.2;
const TEMPORAL_HANDLING_MULTIPLIER = 1.28;
const TEMPORAL_SCORE_MULTIPLIER = 1.35;
const MAX_AI_RIVALS = 7;
const AI_HAZARD_KINDS = new Set<TrackEvent['kind']>(['gate', 'aperture', 'halfwall', 'blade', 'cross', 'bastion']);
const AI_RIVAL_OFFSETS = [32, -24, 65, -52, 88, 12, -78] as const;
const AI_RIVAL_SPEEDS = [0.987, 1.016, 1.004, 0.998, 1.009, 0.992, 1.021] as const;
const AI_RIVAL_COLORS: ReadonlyArray<readonly [number, number]> = [
  [0xff4d9a, 0x7030ff],
  [0xffd65c, 0xff4c35],
  [0x79ffbb, 0x27a9ff],
  [0x56f2ff, 0x4266ff],
  [0xff8c42, 0xffe066],
  [0xc77dff, 0x58d7ff],
  [0x86ff6a, 0x00b89c],
];
const REMOTE_RACER_COLORS: ReadonlyArray<readonly [number, number]> = [
  [0x49f6ff, 0x7a5cff],
  [0xff5dc8, 0x8a4dff],
  [0xffdc5e, 0xff6b42],
  [0x68ffb5, 0x22a7ff],
  [0xff6d7a, 0xffb24b],
  [0xa97cff, 0x39ddff],
  [0xcaff5d, 0x00bfa6],
  [0xff81ea, 0x5f8bff],
];

export class BallisticGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly audio: AudioEngine;
  private readonly hooks: GameHooks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly rgbPass: ShaderPass;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(76, 1, 0.08, 1500);
  private readonly chaseScene = new THREE.Scene();
  private readonly chaseCamera = new THREE.PerspectiveCamera(76, 1, 0.08, 100);
  private readonly world = new THREE.Group();
  private readonly dynamicLayer = new THREE.Group();
  private readonly eventVisuals = new Map<number, THREE.Object3D>();
  private readonly trackEventsById = new Map<number, TrackEvent>();
  private readonly keys = new Set<string>();
  private readonly mobileInput = new Map<TouchInputAction, boolean>();
  private readonly bullets: Bullet[] = [];
  private readonly bursts: Burst[] = [];
  private readonly chaseImpactEffects: ChaseImpactEffect[] = [];
  private readonly rivals: Rival[] = [];
  private readonly remoteRacers = new Map<string, RemoteRacer>();
  private readonly vehicle: THREE.Group;
  private readonly engineGlow: THREE.Group;
  private readonly vehicleThrustTrails: THREE.Mesh[];
  private readonly vehicleImpactGlow: THREE.Group;
  private readonly vehicleImpactMaterial: THREE.MeshBasicMaterial;
  private readonly chaseBoostEffect: ChaseBoostEffect;
  private readonly deathFx: ChaseDeathFx;
  private streakGeometry: THREE.BufferGeometry | null = null;
  private streakLines: THREE.LineSegments | null = null;
  private streaks: StreakSpec[] = [];
  private tunnelMaterial: THREE.ShaderMaterial | null = null;
  private skylineSky: THREE.Mesh | null = null;
  private skylineSkyMaterial: THREE.ShaderMaterial | null = null;
  private skylineTraffic: SkylineTrafficVehicle[] = [];
  private skylineTrafficTime = 0;
  private underwaterSky: THREE.Mesh | null = null;
  private underwaterSkyMaterial: THREE.ShaderMaterial | null = null;
  private underwaterCreatures: UnderwaterCreature[] = [];
  private underwaterTime = 0;
  private plan: TrackPlan;
  private rivalAiModel: RivalAIRaceModel | null = null;
  private timelinePreview!: TrackTimeline;
  private trackId: TrackId = 'aurora';
  private config: RunConfig | null = null;
  private state: GameState = 'menu';
  private animationFrame = 0;
  private lastFrameTime = performance.now();
  private fixedAccumulator = 0;
  private uiAccumulator = 0;
  private countdown = 0;
  private demoDistance = 0;
  private distance = 0;
  private speed = 0;
  private maxRunSpeed = 0;
  private angle = 0;
  private angularVelocity = 0;
  private shield = 3;
  private maxShield = 3;
  private heat = 0;
  private flux = 100;
  private sync = 0;
  private score = 0;
  private abilityCooldown = 0;
  private weaponCooldown = 0;
  private phaseTimer = 0;
  private overdriveTimer = 0;
  private temporalFocusTimer = 0;
  private boostVisualTarget = 0;
  private boostVisualIntensity = 0;
  private boostVisualKick = 0;
  private boostVisualClock = 0;
  private overheatTimer = 0;
  private invulnerableTimer = 0;
  private perfects = 0;
  private nearMisses = 0;
  private kills = 0;
  private shots = 0;
  private hits = 0;
  private obstaclePerfects = 0;
  private obstaclesEncountered = 0;
  private obstacleCollisions = 0;
  private section = 1;
  private upgradeIndex = 0;
  private upgradeRoll = 0;
  private pendingUpgradeOptions: UpgradeDefinition[] = [];
  private queuedUpgradePicks = 0;
  private lastCollisionCursor = 0;
  private lastCollisionAudioTime = 0;
  private runUpgrades = new Set<UpgradeId>();
  private lastBands: AudioBands = { bass: 0, mids: 0, highs: 0, overall: 0, pulse: 0, onBeat: false };
  private cameraRadial = 0;
  private damageKick = 0;
  private impactFlashTimer = 0;
  private impactSlide = 0;
  private bloomStrengthSignal = 1.18;
  private exposureSignal = 1.08;
  private graphicsSettings: GraphicsSettings;
  private controlBindings: ControlBindings;
  private inputCapture = false;
  private disposed = false;
  private visibilityPaused = false;
  private deathSequence: DeathSequenceState | null = null;
  private pendingResult: RunResult | null = null;
  private resultDelay = 0;
  private simulationTick = 0;
  private rivalAiTick = 0;
  private rivalAiCatchupBudget = ONLINE_AI_CATCHUP_STEPS_PER_FRAME;
  private onlineRun = false;
  private aiRivals: RivalStartDescriptor[] = [];
  private onlineTimeProvider: (() => number) | null = null;
  private onlineRaceOriginTime: number | null = null;
  private localFinishTime: number | null = null;
  private localFinishAiTick: number | null = null;
  private raceCompetitorCount = 1;
  private awaitingTerminalAck = false;
  private terminalAckTimeout = 0;
  private rivalDraftCharge = 0;
  private rivalDraftCooldown = 0;
  private rivalCalloutCooldown = 0;
  private rivalContactCooldown = 0;

  constructor(canvas: HTMLCanvasElement, audio: AudioEngine, hooks: GameHooks, settings: Pick<SettingsState, 'graphics' | 'controls'>) {
    this.canvas = canvas;
    this.audio = audio;
    this.hooks = hooks;
    this.graphicsSettings = sanitizeGraphicsSettings(settings.graphics);
    this.controlBindings = Object.fromEntries(
      Object.entries(settings.controls).map(([action, bindings]) => [action, [...bindings]]),
    ) as ControlBindings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioLimit()));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.exposureSignal * this.graphicsSettings.brightness;
    this.renderer.shadowMap.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      this.bloomStrengthSignal * this.graphicsSettings.bloomIntensity,
      0.66,
      0.12,
    );
    this.bloomPass.enabled = this.graphicsSettings.bloom && this.graphicsSettings.bloomIntensity > 0;
    this.composer.addPass(this.bloomPass);
    this.rgbPass = new ShaderPass(RGBShiftShader);
    this.rgbPass.uniforms.amount.value = 0.00025;
    this.rgbPass.enabled = this.graphicsSettings.chromaticAberration && !this.graphicsSettings.reducedFlashes;
    this.composer.addPass(this.rgbPass);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.world, this.dynamicLayer);
    this.scene.add(new THREE.HemisphereLight(0x8fdcff, 0x080310, 0.48));
    const cameraLight = new THREE.PointLight(0xffffff, 28, 50, 1.8);
    this.camera.add(cameraLight);
    this.scene.add(this.camera);

    const craft = this.createCraft(0x37f6ff, 0xa55cff, 1.16);
    this.vehicle = craft.group;
    this.engineGlow = craft.engineGlow;
    this.vehicleThrustTrails = craft.thrustTrails;
    this.vehicleImpactGlow = craft.impactGlow;
    this.vehicleImpactMaterial = craft.impactMaterial;
    this.vehicle.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.depthTest = false;
        material.depthWrite = false;
      }
      object.renderOrder = typeof object.userData.chaseLayer === 'number'
        ? object.userData.chaseLayer
        : materials.some((material) => material.transparent) ? 34 : 32;
    });
    this.chaseBoostEffect = this.createChaseBoostEffect();
    this.vehicle.add(this.chaseBoostEffect.group);
    this.deathFx = new ChaseDeathFx(this.vehicle);
    this.chaseScene.add(this.vehicle, this.deathFx.group);

    this.plan = generateTrack(TRACKS.aurora, this.audio.getProfile(), 1);
    this.buildWorld('aurora', 1);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  previewTrack(trackId: TrackId, seed: number): void {
    if (this.state !== 'menu' && this.state !== 'finished') return;
    this.trackId = trackId;
    this.buildWorld(trackId, seed);
    this.demoDistance = Math.min(this.plan.length * 0.08, 800);
  }

  getTimelinePreview(): TrackTimeline {
    return this.timelinePreview;
  }

  /** Returns a JSON-safe frame for the online transport without exposing internals. */
  getLocalRaceSnapshot(): LocalRaceSnapshot {
    const stats = this.getStats();
    const active = this.state === 'countdown' || this.state === 'playing' || this.state === 'dying';
    const destroyed = this.state === 'dying' || (this.state === 'finished' && this.shield <= 0);
    return {
      progress: clamp(stats.progress, 0, 1),
      angle: wrapAngle(this.angle),
      speed: Math.max(0, stats.speed),
      shield: Math.max(0, this.shield),
      heat: clamp(stats.heat, 0, 100),
      flux: clamp(stats.flux, 0, 100),
      score: Math.max(0, this.pendingResult?.score ?? stats.score),
      rank: stats.rank,
      section: stats.section,
      active,
      running: this.state === 'playing',
      destroyed,
      finished: this.state === 'finished',
    };
  }

  /**
   * Reconciles the complete set of remote humans. They are interpolated and
   * rendered in the tunnel, but are deliberately absent from collision logic.
   */
  setRemoteRacers(states: readonly RemoteRacerState[]): void {
    const seen = new Set<string>();
    for (const state of states) {
      const id = state.id.trim().slice(0, 80);
      if (!id || seen.has(id)) continue;
      if (![state.progress, state.angle, state.speed, state.shield].every(Number.isFinite)) continue;
      seen.add(id);

      const name = state.name.replace(/\s+/g, ' ').trim().slice(0, 24) || 'RACER';
      const targetProgress = clamp(state.progress, 0, 1);
      const targetAngle = wrapAngle(state.angle);
      const terminal = Boolean(state.finished || state.destroyed);
      const terminalStamp = state.terminalAt ?? state.finishedAt;
      let racer = this.remoteRacers.get(id);
      if (!racer) {
        const colorIndex = this.pickRemoteRacerColorIndex(id);
        const craft = this.createRemoteRacerMesh(id, name, colorIndex);
        this.dynamicLayer.add(craft.mesh);
        racer = {
          id,
          name,
          colorIndex,
          mesh: craft.mesh,
          visual: craft.visual,
          progress: targetProgress,
          targetProgress,
          angle: targetAngle,
          targetAngle,
          speed: Math.max(0, state.speed),
          shield: Math.max(0, state.shield),
          active: state.active ?? true,
          destroyed: state.destroyed ?? false,
          finished: state.finished ?? false,
          dnf: state.dnf ?? false,
          terminalAt: terminal && Number.isFinite(terminalStamp) ? terminalStamp as number : null,
          score: Number.isFinite(state.score) ? Math.max(0, state.score as number) : null,
        };
        this.remoteRacers.set(id, racer);
      } else {
        racer.name = name;
        racer.targetProgress = targetProgress;
        racer.targetAngle = targetAngle;
        racer.speed = Math.max(0, state.speed);
        racer.shield = Math.max(0, state.shield);
        racer.active = state.active ?? true;
        racer.destroyed = state.destroyed ?? false;
        racer.finished = state.finished ?? false;
        racer.dnf = state.dnf ?? false;
        racer.terminalAt = terminal && Number.isFinite(terminalStamp)
          ? terminalStamp as number
          : terminal ? racer.terminalAt : null;
        racer.score = Number.isFinite(state.score) ? Math.max(0, state.score as number) : racer.score;
      }
      racer.mesh.userData.remoteRacer = {
        id: racer.id,
        name: racer.name,
        colorIndex: racer.colorIndex,
        speed: racer.speed,
        shield: racer.shield,
        progress: racer.targetProgress,
        active: racer.active,
        destroyed: racer.destroyed,
        finished: racer.finished,
        dnf: racer.dnf,
        terminalAt: racer.terminalAt,
        score: racer.score,
      };
    }

    for (const [id, racer] of this.remoteRacers) {
      if (seen.has(id)) continue;
      this.removeAndDispose(racer.mesh);
      this.remoteRacers.delete(id);
    }
  }

  /** Replaces the client's estimated finish clock with the server-accepted terminal stamp. */
  confirmAuthoritativeTerminal(serverTime: number): void {
    if (!this.onlineRun || !Number.isFinite(serverTime)) return;
    this.localFinishTime = serverTime;
    this.localFinishAiTick = this.onlineAiTickAt(serverTime);
    this.awaitingTerminalAck = false;
    this.terminalAckTimeout = 0;
  }

  setGraphicsSettings(settings: GraphicsSettings): void {
    this.graphicsSettings = sanitizeGraphicsSettings(settings);
    this.applyPostProcessingSettings();
    this.applyRivalVisibilitySettings();
    this.resize();
  }

  /** Rebuilds volatile opponent rows without changing the locally awarded result. */
  refreshRunReport(result: Readonly<RunResult>): RunResult {
    return {
      ...result,
      standings: this.createRaceStandings(result.survived, result.score, result.rank),
    };
  }

  /** Applies a live bloom slider value without reallocating render targets. */
  setBloomIntensity(intensity: number): void {
    this.graphicsSettings = sanitizeGraphicsSettings({
      ...this.graphicsSettings,
      bloomIntensity: intensity,
    });
    this.applyPostProcessingSettings();
  }

  /** Applies a live brightness slider value without rebuilding the renderer. */
  setBrightness(brightness: number): void {
    this.graphicsSettings = sanitizeGraphicsSettings({
      ...this.graphicsSettings,
      brightness,
    });
    this.applyPostProcessingSettings();
  }

  /** Updates opponent contrast, markers and engines without rebuilding their meshes. */
  setRivalVisibility(visibility: number): void {
    this.graphicsSettings = sanitizeGraphicsSettings({
      ...this.graphicsSettings,
      rivalVisibility: visibility,
    });
    this.applyRivalVisibilitySettings();
  }

  private applyPostProcessingSettings(): void {
    this.bloomPass.enabled = this.graphicsSettings.bloom && this.graphicsSettings.bloomIntensity > 0;
    this.bloomPass.strength = this.bloomStrengthSignal * this.graphicsSettings.bloomIntensity;
    this.rgbPass.enabled = this.graphicsSettings.chromaticAberration && !this.graphicsSettings.reducedFlashes;
    this.renderer.toneMappingExposure = this.exposureSignal * this.graphicsSettings.brightness;
  }

  private applyRivalVisibilitySettings(): void {
    for (const rival of this.rivals ?? []) this.applyOpponentVisibility(rival.visual);
    for (const racer of this.remoteRacers?.values() ?? []) this.applyOpponentVisibility(racer.visual);
  }

  setControlBindings(bindings: ControlBindings): void {
    this.controlBindings = Object.fromEntries(
      Object.entries(bindings).map(([action, values]) => [action, [...values]]),
    ) as ControlBindings;
    this.releaseInputs();
  }

  setInputCapture(enabled: boolean): void {
    this.inputCapture = enabled;
    if (enabled) this.releaseInputs();
  }

  releaseInputs = (): void => {
    this.keys.clear();
    this.mobileInput.clear();
  };

  private pixelRatioLimit(): number {
    if (this.graphicsSettings.quality === 'performance') return 0.8;
    if (this.graphicsSettings.quality === 'balanced') return 1.15;
    return 1.6;
  }

  private isBound(action: InputAction, code: string): boolean {
    return this.controlBindings[action].includes(code);
  }

  private isActionPressed(action: InputAction): boolean {
    return this.controlBindings[action].some((code) => code && this.keys.has(code));
  }

  async startRun(config: RunConfig, options: RunStartOptions = {}): Promise<void> {
    this.releaseInputs();
    this.visibilityPaused = false;
    this.config = config;
    this.onlineRun = options.online ?? false;
    this.aiRivals = [...(options.aiRivals ?? [])]
      .slice(0, MAX_AI_RIVALS)
      .map((rival) => ({
        id: rival.id?.trim().slice(0, 80),
        name: rival.name?.replace(/\s+/g, ' ').trim().slice(0, 24),
        difficulty: clamp(Number.isFinite(rival.difficulty) ? rival.difficulty as number : 0.6, 0.35, 0.96),
      }));
    this.onlineTimeProvider = this.onlineRun && options.serverTime ? options.serverTime : null;
    this.onlineRaceOriginTime = this.onlineRun && Number.isFinite(options.raceStartsAt)
      ? options.raceStartsAt as number + RUN_COUNTDOWN_SECONDS * 1_000
      : null;
    this.trackId = config.track;
    this.buildWorld(config.track, config.seed);
    const configuredCompetitors = Number.isFinite(options.competitorCount)
      ? Math.trunc(options.competitorCount as number)
      : 1 + this.rivals.length;
    this.raceCompetitorCount = Math.max(1 + this.rivals.length, configuredCompetitors);
    this.resetRun();
    await this.audio.start(true);
    this.state = 'countdown';
    this.countdown = RUN_COUNTDOWN_SECONDS;
    this.hooks.onCountdown('3');
  }

  chooseUpgrade(id: UpgradeId): boolean {
    if (this.state !== 'playing' || !this.pendingUpgradeOptions.some((upgrade) => upgrade.id === id)) return false;
    this.runUpgrades.add(id);
    this.audio.playEffect('upgrade');
    if (id === 'glass-cannon') {
      this.maxShield = Math.max(1, this.maxShield - 1);
      this.shield = Math.min(this.shield, this.maxShield);
    }
    this.hooks.onToast(UPGRADES.find((upgrade) => upgrade.id === id)?.name || 'MODULE INSTALLED', t('game.upgradeInstalled'), 'violet');
    this.pendingUpgradeOptions = [];
    if (this.queuedUpgradePicks > 0) {
      this.queuedUpgradePicks -= 1;
      this.openUpgrade();
    } else {
      this.emitUpgradeState();
    }
    return true;
  }

  setMobileControl(control: TouchInputAction, active: boolean): void {
    this.mobileInput.set(control, active);
  }

  fire(): void {
    if (this.state !== 'playing' || !this.config || this.weaponCooldown > 0 || this.overheatTimer > 0) return;
    const weapon = WEAPONS[this.config.weapon];
    this.audio.playEffect('fire', weapon.id === 'rail' ? 1.25 : weapon.id === 'scatter' ? 0.9 : 0.72);
    const perfect = this.audio.isInsideBeatWindow();
    const levelDamage = 1 + this.config.garage.weapon * 0.1;
    const upgradeDamage = this.runUpgrades.has('glass-cannon') ? 1.65 : 1;
    const beatDamage = perfect && weapon.id === 'pulse' ? 2 : 1;
    const resonant = this.runUpgrades.has('resonant-chamber') && perfect && (this.perfects + 1) % 4 === 0;
    const projectileCount = weapon.projectiles + (resonant ? 2 : 0);
    const spreadCenter = (projectileCount - 1) / 2;
    for (let index = 0; index < projectileCount; index += 1) {
      const shotAngle = wrapAngle(this.angle + (index - spreadCenter) * Math.max(weapon.spread, resonant ? 0.1 : 0));
      this.spawnBullet(shotAngle, weapon.damage * levelDamage * upgradeDamage * beatDamage, weapon.id === 'rail' ? 3 : 1);
    }
    this.weaponCooldown = 1 / weapon.fireRate;
    this.heat = clamp(this.heat + weapon.heat, 0, 100);
    this.shots += projectileCount;
    if (perfect) this.registerPerfect('SHOT SYNC');
  }

  activateAbility(): void {
    if (this.state !== 'playing' || !this.config || this.abilityCooldown > 0) return;
    const ability = ABILITIES[this.config.ability];
    this.audio.playEffect('ability');
    const cooldownFactor = this.runUpgrades.has('phase-battery') ? 0.75 : 1;
    this.abilityCooldown = ability.cooldown * cooldownFactor;
    if (ability.id === 'phase') {
      this.phaseTimer = this.runUpgrades.has('afterburner') ? 2.6 : 1.4;
      this.hooks.onToast('PHASE SHIFT', t('game.phase'), 'cyan');
    } else if (ability.id === 'emp') {
      let destroyed = 0;
      for (const event of this.plan.events) {
        if (!event.destroyed && !event.resolved && event.distance > this.distance && event.distance < this.distance + 190 && event.kind === 'bastion') {
          this.destroyEvent(event, true);
          destroyed += 1;
        }
      }
      this.hooks.onToast('EMP HALO', `${destroyed || 'NO'} TARGETS ERASED`, 'violet');
    } else {
      this.overdriveTimer = this.runUpgrades.has('afterburner') ? 5.2 : 4;
      this.hooks.onToast('REDLINE', 'HEAT BYPASS / MAXIMUM THRUST', 'gold');
    }
    if (this.audio.isInsideBeatWindow()) this.registerPerfect('ABILITY SYNC');
  }

  backToMenu(): void {
    this.releaseInputs();
    this.audio.stop();
    this.state = 'menu';
    this.visibilityPaused = false;
    this.deathFx.reset();
    this.deathSequence = null;
    this.pendingResult = null;
    this.resultDelay = 0;
    this.resetBoostVisuals();
    this.config = null;
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.runUpgrades.clear();
    this.setRemoteRacers([]);
    this.onlineRun = false;
    this.aiRivals = [];
    this.onlineTimeProvider = null;
    this.onlineRaceOriginTime = null;
    this.localFinishTime = null;
    this.localFinishAiTick = null;
    this.raceCompetitorCount = 1;
    this.awaitingTerminalAck = false;
    this.terminalAckTimeout = 0;
    this.rivalDraftCharge = 0;
    this.rivalDraftCooldown = 0;
    this.rivalCalloutCooldown = 0;
    this.rivalContactCooldown = 0;
    this.emitUpgradeState();
    this.hooks.onCountdown(null);
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio, this.pixelRatioLimit());
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.chaseCamera.aspect = width / height;
    this.chaseCamera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.composer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
  };

  private bindInput(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.releaseInputs);
    this.canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    const isEditing = target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, [contenteditable="true"]'));
    if (this.inputCapture || isEditing) return;
    const upgradeActions: InputAction[] = ['upgrade1', 'upgrade2', 'upgrade3'];
    const upgradeIndex = upgradeActions.findIndex((action) => this.isBound(action, event.code));
    if (!event.repeat && upgradeIndex >= 0 && this.pendingUpgradeOptions[upgradeIndex]) {
      event.preventDefault();
      this.chooseUpgrade(this.pendingUpgradeOptions[upgradeIndex].id);
      return;
    }
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    const gameplayActions: InputAction[] = ['left', 'right', 'cool', 'boost', 'fire', 'ability'];
    if (gameplayActions.some((action) => this.isBound(action, event.code))) event.preventDefault();
    this.keys.add(event.code);
    if (!event.repeat && this.isBound('fire', event.code)) this.fire();
    if (!event.repeat && this.isBound('ability', event.code)) this.activateAbility();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly handleCanvasPointerDown = (event: PointerEvent): void => {
    if (event.button === 0 && this.state === 'playing') this.fire();
  };

  private buildWorld(trackId: TrackId, seed: number): void {
    const profile = this.audio.getProfile();
    const theme = TRACKS[trackId];
    this.plan = generateTrack(theme, profile, seed);
    if (trackId === 'abyss') this.addUnderwaterForkEvents(seed);
    this.trackEventsById.clear();
    for (const event of this.plan.events) this.trackEventsById.set(event.id, event);
    this.rivalAiModel = this.createRivalAiModel(theme.handling);
    this.timelinePreview = createTrackTimeline(this.plan, profile);
    this.hooks.onTimeline(this.timelinePreview);
    this.disposeGroup(this.world);
    this.eventVisuals.clear();
    this.skylineSky = null;
    this.skylineSkyMaterial = null;
    this.skylineTraffic = [];
    this.skylineTrafficTime = 0;
    this.underwaterSky = null;
    this.underwaterSkyMaterial = null;
    this.underwaterCreatures = [];
    this.underwaterTime = 0;
    this.scene.background = new THREE.Color(theme.colors.background);
    this.scene.fog = new THREE.FogExp2(
      theme.colors.fog,
      trackId === 'skyline' ? 0.00072 : trackId === 'abyss' ? 0.00125 : 0.0021,
    );
    this.bloomPass.threshold = trackId === 'skyline' ? 0.88 : trackId === 'abyss' ? 0.54 : 0.12;

    const quality = this.graphicsSettings.quality;
    const tubeDivisor = quality === 'performance' ? 29 : quality === 'balanced' ? 23 : 18;
    const tubeSegments = clamp(
      Math.ceil(this.plan.length / tubeDivisor),
      quality === 'performance' ? 360 : quality === 'balanced' ? 480 : 620,
      quality === 'performance' ? 620 : quality === 'balanced' ? 820 : 1050,
    );
    const radialSegments = quality === 'performance' ? 12 : quality === 'balanced' ? 16 : 20;
    const tubeGeometry = new THREE.TubeGeometry(this.plan.curve, tubeSegments, this.plan.radius, radialSegments, false);
    this.tunnelMaterial = this.createTunnelMaterial(
      theme.colors.primary,
      theme.colors.secondary,
      trackId === 'skyline' || trackId === 'abyss',
      trackId === 'abyss',
    );
    const tunnel = new THREE.Mesh(tubeGeometry, this.tunnelMaterial);
    tunnel.frustumCulled = false;
    this.world.add(tunnel);

    this.addStructuralRings(
      theme.colors.primary,
      theme.colors.secondary,
      trackId === 'abyss' ? 0.24 : 0.46,
    );
    this.addTrackEvents();
    if (trackId === 'skyline') this.addSkylineEnvironment(seed);
    else if (trackId === 'abyss') this.addUnderwaterEnvironment(seed);
    else this.addExteriorParticles(theme.colors.primary, seed);
    this.createStreakField(theme.colors.primary, seed);
    this.createRivals();
    this.demoDistance = Math.min(this.plan.length * 0.045, 520);
  }

  private createRivalAiModel(handling: number): RivalAIRaceModel {
    const hazards = this.plan.events
      .filter((event) => AI_HAZARD_KINDS.has(event.kind))
      .map((event) => {
        const corridors = getTrackEventSafeCorridors(event);
        const referenceAngle = wrapAngle(event.safeAngle ?? corridors[0]?.center ?? event.angle);
        const corridor = corridors.reduce<(typeof corridors)[number] | undefined>((nearest, candidate) => {
          if (!nearest) return candidate;
          return angularDistance(candidate.center, referenceAngle) < angularDistance(nearest.center, referenceAngle)
            ? candidate
            : nearest;
        }, undefined);
        return {
          id: event.id,
          kind: event.kind,
          distance: event.distance,
          safeAngle: referenceAngle,
          safeHalfWidth: corridor?.halfWidth ?? Math.max(0.2, event.gapWidth),
          safeAngularVelocity: event.safeAngularVelocity ?? 0,
          warningDistance: event.warningDistance,
          strength: event.strength,
        };
      });
    return {
      length: this.plan.length,
      baseSpeed: this.plan.length / this.plan.runDuration,
      handling,
      hazards,
      beats: this.plan.beatDistances.map((beat) => ({
        id: beat.beatIndex,
        time: beat.time,
        strength: beat.strength,
        barBeat: beat.barBeat,
      })),
      transitions: this.plan.transitionDistances.map((transition) => ({
        id: transition.transitionIndex,
        time: transition.time,
        kind: transition.kind,
        strength: transition.strength,
      })),
    };
  }

  private createTunnelMaterial(primary: number, secondary: number, glass = false, underwater = false): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: glass,
      depthWrite: !glass,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0.25 },
        uPulse: { value: 0 },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uPrimary: { value: new THREE.Color(primary) },
        uSecondary: { value: new THREE.Color(secondary) },
        uGlass: { value: glass ? 1 : 0 },
        uUnderwater: { value: underwater ? 1 : 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        void main() {
          vUv = uv;
          vNormal = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        uniform float uTime;
        uniform float uEnergy;
        uniform float uPulse;
        uniform float uSpeed;
        uniform float uBoost;
        uniform vec3 uPrimary;
        uniform vec3 uSecondary;
        uniform float uGlass;
        uniform float uUnderwater;

        float line(float value, float width) {
          float d = abs(fract(value) - 0.5);
          return 1.0 - smoothstep(width, width + 0.025, d);
        }

        void main() {
          float ribs = line(vUv.x * 180.0, 0.045 + uPulse * 0.025);
          float lanes = line(vUv.y * 12.0, 0.022);
          float micro = line(vUv.x * 720.0 - uTime * (0.2 + uSpeed * 0.8), 0.012) * 0.18;
          float pulseWave = pow(max(0.0, sin(vUv.x * 82.0 - uTime * 6.0)), 14.0) * (0.12 + uPulse * 0.5);
          float warpBands = pow(max(0.0, sin(vUv.x * (105.0 + uBoost * 48.0) - uTime * (8.0 + uBoost * 15.0))), 24.0);
          float warpLanes = line(vUv.y * 24.0 + uTime * uBoost * 0.35, 0.014) * uBoost;
          vec3 base = vec3(0.003, 0.006, 0.013) + uPrimary * 0.014;
          vec3 railColor = mix(uPrimary, uSecondary, smoothstep(0.1, 0.9, vUv.y));
          float edge = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.0);
          vec3 color = base + railColor * (ribs * (0.34 + uEnergy * 0.9) + lanes * 0.4 + micro + pulseWave);
          color += mix(railColor, vec3(0.72, 0.94, 1.0), 0.66)
            * uBoost * (warpBands * 0.18 + warpLanes * 0.065 + micro * 0.24);
          color += uSecondary * edge * 0.018;
          vec3 glassColor = mix(vec3(0.012, 0.085, 0.15), railColor, 0.22)
            + railColor * (ribs * 0.66 + lanes * 0.4 + micro * 0.36 + pulseWave * 0.26)
            + vec3(0.72, 0.94, 1.0) * edge * 0.16;
          vec3 waterGlass = vec3(0.004, 0.035, 0.065)
            + railColor * (ribs * 0.34 + lanes * 0.18 + micro * 0.22 + pulseWave * 0.18)
            + vec3(0.32, 0.78, 0.88) * edge * 0.045;
          glassColor = mix(glassColor, waterGlass, uUnderwater);
          float glassAlpha = clamp(
            0.085 + ribs * (0.25 + uEnergy * 0.13) + lanes * 0.16 + micro * 0.1
              + pulseWave * 0.08 + edge * 0.13 + uBoost * warpBands * 0.08,
            0.075,
            0.55
          );
          glassAlpha *= mix(1.0, 0.32, uUnderwater);
          gl_FragColor = vec4(mix(color, glassColor, uGlass), mix(1.0, glassAlpha, uGlass));
        }
      `,
    });
  }

  private addStructuralRings(primary: number, secondary: number, opacity = 0.46): void {
    const geometry = new THREE.TorusGeometry(this.plan.radius - 0.16, 0.075, 4, 28);
    const material = new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity, blending: THREE.AdditiveBlending });
    const beats = this.plan.beatDistances;
    const count = beats.length;
    const rings = new THREE.InstancedMesh(geometry, material, count);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const forward = new THREE.Vector3(0, 0, 1);
    for (let index = 0; index < count; index += 1) {
      const beat = beats[index];
      const progress = beat.distance / this.plan.length;
      const frame = sampleTrackFrame(this.plan, progress);
      quaternion.setFromUnitVectors(forward, frame.tangent);
      scale.setScalar(1 + beat.strength * 0.006 + (beat.barBeat === 0 ? 0.009 : 0));
      matrix.compose(frame.position, quaternion, scale);
      rings.setMatrixAt(index, matrix);
      rings.setColorAt(index, new THREE.Color(beat.barBeat === 0 ? secondary : primary));
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    rings.frustumCulled = false;
    this.world.add(rings);

    if (this.plan.transitionDistances.length > 0) {
      const transitionGeometry = new THREE.TorusGeometry(this.plan.radius - 0.34, 0.21, 5, 36);
      const transitionMaterial = new THREE.MeshBasicMaterial({ color: secondary, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending });
      const transitionRings = new THREE.InstancedMesh(transitionGeometry, transitionMaterial, this.plan.transitionDistances.length);
      for (let index = 0; index < this.plan.transitionDistances.length; index += 1) {
        const transition = this.plan.transitionDistances[index];
        const frame = sampleTrackFrame(this.plan, transition.distance / this.plan.length);
        quaternion.setFromUnitVectors(forward, frame.tangent);
        const punch = transition.kind === 'drop' ? 1.035 : 1.012;
        scale.setScalar(punch + transition.strength * 0.012);
        matrix.compose(frame.position, quaternion, scale);
        transitionRings.setMatrixAt(index, matrix);
        transitionRings.setColorAt(index, new THREE.Color(transition.kind === 'drop' ? 0xffd35a : secondary));
      }
      transitionRings.instanceMatrix.needsUpdate = true;
      if (transitionRings.instanceColor) transitionRings.instanceColor.needsUpdate = true;
      transitionRings.frustumCulled = false;
      this.world.add(transitionRings);
    }
  }

  private addTrackEvents(): void {
    for (const event of this.plan.events) {
      const warning = this.createEventWarning(event);
      if (warning) this.world.add(warning);
      const visual = this.createEventVisual(event);
      this.eventVisuals.set(event.id, visual);
      this.world.add(visual);
    }
  }

  private createEventWarning(event: TrackEvent): THREE.Object3D | null {
    if (!['gate', 'aperture', 'halfwall', 'blade', 'cross', 'bastion'].includes(event.kind)) return null;
    const warningLead = event.kind === 'aperture'
      ? clamp(event.warningDistance * 0.68, 360, 470)
      : clamp(event.warningDistance * 0.62, 150, 280);
    const distance = event.distance - warningLead;
    if (distance < 35) return null;
    const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
    const group = new THREE.Group();
    group.userData.warningFor = event.id;
    group.position.copy(frame.position);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.normal, frame.binormal, frame.tangent));
    const warningColor = event.kind === 'aperture'
      ? 0xffd35a
      : event.kind === 'gate'
      ? 0xff315f
      : event.kind === 'bastion'
        ? 0xff9b42
        : event.kind === 'cross' && event.trigger === 'drop'
          ? 0xff4f86
          : 0xffd35a;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.plan.radius - 0.62, 0.085, 4, 36),
      new THREE.MeshBasicMaterial({ color: warningColor, transparent: true, opacity: 0.48, toneMapped: false }),
    );
    group.add(ring);
    const safeAngle = event.safeAngle ?? (event.kind === 'gate' || event.kind === 'aperture'
      ? event.angle
      : event.kind === 'halfwall'
        ? event.angle + Math.PI
        : event.kind === 'blade' || event.kind === 'cross'
          ? event.rotationPhase + Math.PI / Math.max(2, event.armCount)
          : event.angle + Math.PI);
    const markerAngles = [safeAngle];
    const safeMaterial = new THREE.MeshBasicMaterial({
      color: 0x4ffff2,
      transparent: true,
      opacity: 0.92,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    for (const angle of markerAngles) {
      const safeCorridor = getTrackEventSafeCorridors(event).reduce(
        (nearest, corridor) => (
          !nearest || angularDistance(angle, corridor.center) < angularDistance(angle, nearest.center)
            ? corridor
            : nearest
        ),
        undefined as ReturnType<typeof getTrackEventSafeCorridors>[number] | undefined,
      );
      const halfArc = clamp((safeCorridor?.halfWidth ?? 0.4) * 0.82, 0.32, 0.72);
      const safeArc = new THREE.Mesh(
        new THREE.TorusGeometry(this.plan.radius - 1.08, 0.22, 5, 28, halfArc * 2),
        safeMaterial,
      );
      safeArc.rotation.z = angle - halfArc;
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.52, 1.8, 3),
        safeMaterial,
      );
      arrow.position.set(
        Math.cos(angle) * (this.plan.radius - 1.08),
        Math.sin(angle) * (this.plan.radius - 1.08),
        0,
      );
      arrow.rotation.z = angle + Math.PI / 2;
      group.add(safeArc, arrow);
    }
    return group;
  }

  private createEventVisual(event: TrackEvent): THREE.Object3D {
    const theme = TRACKS[this.trackId];
    const frame = sampleTrackFrame(this.plan, event.distance / this.plan.length);
    const matrix = new THREE.Matrix4();
    const visual = new THREE.Group();
    visual.userData.eventId = event.id;
    visual.userData.baseScale = 1;
    visual.userData.kind = event.kind;

    if (event.kind === 'aperture') {
      matrix.makeBasis(frame.normal, frame.binormal, frame.tangent);
      visual.position.copy(frame.position);
      visual.quaternion.setFromRotationMatrix(matrix);

      const layout = getApertureBulkheadLayout(this.plan.radius, event.angle, event.gapWidth);
      const blockedEnd = layout.blockedStart + layout.blockedArc;
      const longitudinalBefore = 7.4;
      const longitudinalAfter = 2.8;
      const bulkheadDepth = longitudinalBefore + longitudinalAfter;
      const bulkheadShape = new THREE.Shape();
      bulkheadShape.absarc(0, 0, layout.outerRadius, layout.blockedStart, blockedEnd, false);
      bulkheadShape.lineTo(
        Math.cos(blockedEnd) * layout.innerRadius,
        Math.sin(blockedEnd) * layout.innerRadius,
      );
      bulkheadShape.absarc(0, 0, layout.innerRadius, blockedEnd, layout.blockedStart, true);
      bulkheadShape.closePath();
      const bulkheadGeometry = new THREE.ExtrudeGeometry(bulkheadShape, {
        depth: bulkheadDepth,
        bevelEnabled: false,
        curveSegments: 64,
      });
      bulkheadGeometry.translate(0, 0, -longitudinalBefore);
      const bulkhead = new THREE.Mesh(
        bulkheadGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x160309,
          emissive: 0xff173f,
          emissiveIntensity: 0.34,
          roughness: 0.62,
          metalness: 0.72,
          side: THREE.DoubleSide,
        }),
      );
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(bulkheadGeometry, 14),
        new THREE.LineBasicMaterial({ color: 0xff5577, transparent: true, opacity: 0.88, toneMapped: false }),
      );
      outline.scale.setScalar(1.0015);

      const centerCapGeometry = new THREE.CylinderGeometry(
        layout.centerCapRadius,
        layout.centerCapRadius,
        bulkheadDepth,
        40,
      );
      const centerCap = new THREE.Mesh(
        centerCapGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x09040a,
          emissive: 0x5d071e,
          emissiveIntensity: 0.3,
          roughness: 0.7,
          metalness: 0.76,
        }),
      );
      centerCap.rotation.x = Math.PI / 2;
      centerCap.position.z = (longitudinalAfter - longitudinalBefore) * 0.5;

      const portalMaterial = new THREE.MeshBasicMaterial({
        color: 0x55fff1,
        transparent: true,
        opacity: 0.98,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      });
      const safeRail = new THREE.Mesh(
        new THREE.TorusGeometry(layout.routeRadius, 0.22, 6, 48, layout.safeArc),
        portalMaterial,
      );
      safeRail.rotation.z = layout.safeStart;
      safeRail.position.z = -longitudinalBefore - 0.1;

      const outerWarningRing = new THREE.Mesh(
        new THREE.TorusGeometry(layout.outerRadius - 0.42, 0.18, 5, 64),
        new THREE.MeshBasicMaterial({
          color: 0xffd35a,
          transparent: true,
          opacity: 0.86,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      outerWarningRing.position.z = -longitudinalBefore - 0.04;

      const slotDepth = layout.outerRadius - layout.centerCapRadius;
      const slotRadius = (layout.outerRadius + layout.centerCapRadius) * 0.5;
      const boundaryPostGeometry = new THREE.BoxGeometry(0.38, slotDepth, bulkheadDepth + 0.45);
      const chevronGeometry = new THREE.ConeGeometry(0.5, 1.65, 3);
      for (const side of [-1, 1]) {
        const boundaryAngle = event.angle + side * event.gapWidth;
        const boundaryPost = new THREE.Mesh(boundaryPostGeometry, portalMaterial);
        boundaryPost.position.set(
          Math.cos(boundaryAngle) * slotRadius,
          Math.sin(boundaryAngle) * slotRadius,
          (longitudinalAfter - longitudinalBefore) * 0.5,
        );
        boundaryPost.rotation.z = boundaryAngle - Math.PI / 2;
        const chevron = new THREE.Mesh(chevronGeometry, portalMaterial);
        chevron.position.set(
          Math.cos(boundaryAngle) * layout.routeRadius,
          Math.sin(boundaryAngle) * layout.routeRadius,
          -longitudinalBefore - 0.22,
        );
        chevron.rotation.z = event.angle + (side > 0 ? Math.PI : 0);
        visual.add(boundaryPost, chevron);
      }

      visual.add(bulkhead, outline, centerCap, outerWarningRing, safeRail);
      return visual;
    }

    if (event.kind === 'gate') {
      matrix.makeBasis(frame.normal, frame.binormal, frame.tangent);
      visual.position.copy(frame.position);
      visual.quaternion.setFromRotationMatrix(matrix);

      const outerRadius = this.plan.radius - 0.18;
      const barrierDepth = clamp(this.plan.radius * 0.48, 5.8, 6.6);
      const innerRadius = outerRadius - barrierDepth;
      const barrierRadius = (outerRadius + innerRadius) * 0.5;
      const blockedStart = event.angle + event.gapWidth;
      const blockedArc = TAU - event.gapWidth * 2;
      const blockedEnd = blockedStart + blockedArc;
      // Music-locked collision timing may lead or trail the spatial plane slightly.
      // Keep the rendered barrier around the full synchronization envelope.
      const longitudinalBefore = 6.2;
      const longitudinalAfter = 2.4;
      const longitudinalDepth = longitudinalBefore + longitudinalAfter;
      const barrierShape = new THREE.Shape();
      barrierShape.absarc(0, 0, outerRadius, blockedStart, blockedEnd, false);
      barrierShape.lineTo(Math.cos(blockedEnd) * innerRadius, Math.sin(blockedEnd) * innerRadius);
      barrierShape.absarc(0, 0, innerRadius, blockedEnd, blockedStart, true);
      barrierShape.closePath();
      const barrierGeometry = new THREE.ExtrudeGeometry(barrierShape, {
        depth: longitudinalDepth,
        bevelEnabled: false,
        curveSegments: 64,
      });
      barrierGeometry.translate(0, 0, -longitudinalBefore);
      const barrier = new THREE.Mesh(
        barrierGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x650618,
          emissive: 0xff174d,
          emissiveIntensity: 0.7,
          roughness: 0.44,
          metalness: 0.5,
          side: THREE.DoubleSide,
        }),
      );
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(barrierGeometry, 18),
        new THREE.LineBasicMaterial({ color: 0xffadc1, transparent: true, opacity: 0.94, toneMapped: false }),
      );
      outline.scale.setScalar(1.002);
      const blockedRim = new THREE.Mesh(
        new THREE.TorusGeometry(innerRadius, 0.28, 6, 64, blockedArc),
        new THREE.MeshBasicMaterial({
          color: 0xff315f,
          transparent: true,
          opacity: 0.96,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      blockedRim.rotation.z = blockedStart;
      blockedRim.position.z = -longitudinalBefore - 0.02;

      const portalMaterial = new THREE.MeshBasicMaterial({
        color: 0x4ffff2,
        transparent: true,
        opacity: 0.96,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      });
      const portalPostWidth = 0.42;
      const portalPostGeometry = new THREE.BoxGeometry(portalPostWidth, barrierDepth + 0.24, longitudinalDepth + 0.4);
      const portalPostHalfAngle = (portalPostWidth * 0.5) / barrierRadius;
      for (const side of [-1, 1]) {
        const boundaryAngle = event.angle + side * (event.gapWidth + portalPostHalfAngle);
        const post = new THREE.Mesh(portalPostGeometry, portalMaterial);
        post.position.set(
          Math.cos(boundaryAngle) * barrierRadius,
          Math.sin(boundaryAngle) * barrierRadius,
          (longitudinalAfter - longitudinalBefore) * 0.5,
        );
        post.rotation.z = boundaryAngle - Math.PI / 2;
        visual.add(post);
      }
      const safeRail = new THREE.Mesh(
        new THREE.TorusGeometry(this.plan.radius - 1.15, 0.2, 5, 48, event.gapWidth * 2),
        portalMaterial,
      );
      safeRail.rotation.z = event.angle - event.gapWidth;
      visual.add(barrier, outline, blockedRim, safeRail);
      return visual;
    }

    if (event.kind === 'halfwall') {
      matrix.makeBasis(frame.normal, frame.binormal, frame.tangent);
      visual.position.copy(frame.position);
      visual.quaternion.setFromRotationMatrix(matrix);
      const startAngle = event.angle - event.gapWidth;
      const arcLength = event.gapWidth * 2;
      const panelGeometry = new THREE.CircleGeometry(this.plan.radius - 0.72, 48, startAngle, arcLength);
      const panel = new THREE.Mesh(
        panelGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x180308,
          emissive: theme.colors.danger,
          emissiveIntensity: 0.18,
          roughness: 0.68,
          metalness: 0.28,
          side: THREE.DoubleSide,
        }),
      );
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(this.plan.radius - 1.32, this.plan.radius - 0.54, 48, 1, startAngle, arcLength),
        new THREE.MeshBasicMaterial({ color: 0xffc857, side: THREE.DoubleSide, transparent: true, opacity: 0.92, toneMapped: false }),
      );
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(panelGeometry, 10),
        new THREE.LineBasicMaterial({ color: 0xffefb0, transparent: true, opacity: 0.9, toneMapped: false }),
      );
      panel.position.z = 0.15;
      rim.position.z = -0.04;
      edge.position.z = 0.28;
      visual.add(panel, rim, edge);
      return visual;
    }

    if (event.kind === 'blade' || event.kind === 'cross') {
      matrix.makeBasis(frame.normal, frame.binormal, frame.tangent);
      visual.position.copy(frame.position);
      visual.quaternion.setFromRotationMatrix(matrix);
      const rotor = new THREE.Group();
      const isCathedralCross = event.kind === 'cross' && event.trigger === 'drop';
      const armLength = this.plan.radius - 0.74;
      const armThickness = Math.max(1.2, 2 * armLength * Math.tan(event.gapWidth));
      const armGeometry = new THREE.BoxGeometry(armLength, armThickness, 2.15);
      const armMaterial = new THREE.MeshStandardMaterial({
        color: isCathedralCross ? 0x280018 : event.kind === 'cross' ? 0x16030d : 0x1c0306,
        emissive: isCathedralCross ? 0xff285f : theme.colors.danger,
        emissiveIntensity: isCathedralCross ? 0.42 : 0.22,
        roughness: 0.58,
        metalness: 0.48,
      });
      const outlineMaterial = new THREE.MeshBasicMaterial({
        color: isCathedralCross ? 0xffffff : 0xffcf61,
        side: THREE.BackSide,
        toneMapped: false,
      });
      const armCount = Math.max(2, event.armCount);
      for (let arm = 0; arm < armCount; arm += 1) {
        const angle = (arm / armCount) * TAU;
        const armMesh = new THREE.Mesh(armGeometry, armMaterial);
        armMesh.position.set(Math.cos(angle) * armLength * 0.5, Math.sin(angle) * armLength * 0.5, 0);
        armMesh.rotation.z = angle;
        const outline = new THREE.Mesh(armGeometry, outlineMaterial);
        outline.position.copy(armMesh.position);
        outline.rotation.copy(armMesh.rotation);
        outline.scale.set(1.012, 1.32, 1.16);
        rotor.add(outline, armMesh);
      }
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(1.24, 1.24, 2.8, 12),
        new THREE.MeshBasicMaterial({ color: isCathedralCross ? 0xff4f86 : 0xffefc1, toneMapped: false }),
      );
      hub.rotation.x = Math.PI / 2;
      rotor.add(hub);
      rotor.rotation.z = event.rotationPhase - event.rotationRate * event.musicTime;
      visual.userData.rotor = rotor;
      visual.add(rotor);
      return visual;
    }

    if (event.kind === 'bastion') {
      const radial = radialAt(frame, event.angle);
      const position = frame.position.clone().add(radial.multiplyScalar(this.plan.radius - 3.75));
      const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(event.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(event.angle))).normalize();
      matrix.makeBasis(circumferential, radialAt(frame, event.angle), frame.tangent);
      visual.position.copy(position);
      visual.quaternion.setFromRotationMatrix(matrix);

      const bodyGeometry = new THREE.BoxGeometry(8.6, 7.5, 3.5);
      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0x220309,
        emissive: theme.colors.danger,
        emissiveIntensity: 0.34,
        metalness: 0.68,
        roughness: 0.4,
      });
      const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
      const outline = new THREE.Mesh(
        bodyGeometry,
        new THREE.MeshBasicMaterial({ color: 0xffc857, side: THREE.BackSide, toneMapped: false }),
      );
      outline.scale.set(1.035, 1.035, 1.07);

      const pylonGeometry = new THREE.BoxGeometry(1.2, 8.7, 4.15);
      const pylonMaterial = new THREE.MeshBasicMaterial({ color: 0xffd45b, toneMapped: false });
      const leftPylon = new THREE.Mesh(pylonGeometry, pylonMaterial);
      const rightPylon = new THREE.Mesh(pylonGeometry, pylonMaterial);
      leftPylon.position.x = -4.15;
      rightPylon.position.x = 4.15;

      const core = new THREE.Mesh(
        new THREE.CylinderGeometry(1.55, 1.55, 4.15, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff1b8, toneMapped: false }),
      );
      core.rotation.x = Math.PI / 2;
      core.position.z = -0.42;

      const stripeMaterial = new THREE.MeshBasicMaterial({ color: 0xff6a3d, toneMapped: false });
      for (const y of [-2.1, 0, 2.1]) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(7.25, 0.24, 0.12), stripeMaterial);
        stripe.position.set(0, y, -1.82);
        visual.add(stripe);
      }
      const shield = new THREE.Mesh(
        new THREE.TorusGeometry(4.95, 0.16, 6, 32),
        new THREE.MeshBasicMaterial({ color: 0xffe89a, transparent: true, opacity: 0.8, toneMapped: false }),
      );
      shield.position.z = -2;
      visual.add(outline, body, leftPylon, rightPylon, core, shield);
      return visual;
    }

    const radialDistance = this.plan.radius - 1.8;
    const radial = radialAt(frame, event.angle);
    const position = frame.position.clone().add(radial.multiplyScalar(radialDistance));
    const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(event.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(event.angle))).normalize();
    matrix.makeBasis(circumferential, radialAt(frame, event.angle), frame.tangent);
    visual.position.copy(position);
    visual.quaternion.setFromRotationMatrix(matrix);

    if (event.kind === 'shard') {
      const shard = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.72, 0),
        new THREE.MeshStandardMaterial({ color: 0xcfffff, emissive: theme.colors.primary, emissiveIntensity: 5.5, metalness: 0.18, roughness: 0.12 }),
      );
      shard.scale.set(0.65, 1.4, 0.65);
      visual.add(shard);
    } else if (event.kind === 'boost') {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.34, 0.18, 6, 24),
        new THREE.MeshBasicMaterial({ color: 0xffd45b, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending }),
      );
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(0.88, 20),
        new THREE.MeshBasicMaterial({ color: 0xff9b21, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
      );
      visual.add(ring, core);
    } else if (event.kind === 'coolant') {
      const core = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.9, 0),
        new THREE.MeshStandardMaterial({ color: 0xeaffff, emissive: 0x42ddff, emissiveIntensity: 4.4, metalness: 0.26, roughness: 0.12 }),
      );
      visual.add(core);
    }
    return visual;
  }

  private addExteriorParticles(color: number, seed: number): void {
    const random = mulberry32(seed ^ 0xfade);
    const count = this.graphicsSettings.quality === 'performance' ? 360 : this.graphicsSettings.quality === 'balanced' ? 620 : 900;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const distance = random() * this.plan.length;
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const angle = random() * TAU;
      const radial = radialAt(frame, angle).multiplyScalar(this.plan.radius + 18 + random() * 85);
      const position = frame.position.clone().add(radial);
      positions[index * 3] = position.x;
      positions[index * 3 + 1] = position.y;
      positions[index * 3 + 2] = position.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color, size: 0.9, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false });
    const points = new THREE.Points(geometry, material);
    this.world.add(points);
  }

  private addSkylineEnvironment(seed: number): void {
    const random = mulberry32(seed ^ 0x5a17c17e);
    this.skylineSkyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDirection;
        uniform float uTime;

        void main() {
          vec3 direction = normalize(vDirection);
          float height = smoothstep(-0.34, 0.88, direction.y);
          vec3 horizon = vec3(0.4, 0.68, 0.82);
          vec3 zenith = vec3(0.035, 0.25, 0.52);
          vec3 color = mix(horizon, zenith, height);
          color += vec3(0.09, 0.075, 0.045) * exp(-abs(direction.y + 0.04) * 8.0);

          vec3 sunDirection = normalize(vec3(0.48, 0.64, -0.6));
          float sunDot = max(dot(direction, sunDirection), 0.0);
          float sunDisc = smoothstep(0.9982, 0.99935, sunDot);
          float halo = pow(sunDot, 34.0) * 0.54 + pow(sunDot, 150.0) * 0.82;
          vec3 sunX = normalize(cross(vec3(0.0, 1.0, 0.0), sunDirection));
          vec3 sunY = normalize(cross(sunDirection, sunX));
          float rayX = dot(direction, sunX);
          float rayY = dot(direction, sunY);
          float rayRadius = length(vec2(rayX, rayY));
          float rayAngle = atan(rayY, rayX);
          float rayShape = pow(max(0.0, cos(rayAngle * 8.0 + sin(uTime * 0.08) * 0.06)), 20.0);
          float rays = rayShape * smoothstep(0.02, 0.075, rayRadius)
            * (1.0 - smoothstep(0.08, 0.5, rayRadius)) * smoothstep(0.72, 0.98, sunDot);
          vec3 sunlight = vec3(1.0, 0.72, 0.32);
          color += sunlight * (halo + rays * 0.3) + vec3(1.0, 0.94, 0.72) * sunDisc * 1.3;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.skylineSky = new THREE.Mesh(
      new THREE.SphereGeometry(820, 32, 18),
      this.skylineSkyMaterial,
    );
    this.skylineSky.frustumCulled = false;
    this.skylineSky.renderOrder = -1000;
    this.world.add(this.skylineSky);

    const daylight = new THREE.HemisphereLight(0xe6f8ff, 0x31547a, 1.35);
    const sunLight = new THREE.DirectionalLight(0xffe2a8, 1.75);
    sunLight.position.set(320, 520, -410);
    this.world.add(daylight, sunLight);
    this.addSkylineGround(seed);

    const buildingCount = this.graphicsSettings.quality === 'performance'
      ? 120
      : this.graphicsSettings.quality === 'balanced'
        ? 180
        : 250;
    const buildingPalette = [
      new THREE.Color(0x7a9fb7),
      new THREE.Color(0xc3d7df),
      new THREE.Color(0x406c91),
      new THREE.Color(0x9a86a8),
      new THREE.Color(0xd1b581),
      new THREE.Color(0x5a8c88),
    ];
    const up = new THREE.Vector3(0, 1, 0);
    const basis = new THREE.Matrix4();
    const facadeQuaternion = new THREE.Quaternion();
    const buildingSpecs: Array<{
      type: number;
      matrix: THREE.Matrix4;
      facadeMatrices: THREE.Matrix4[];
      podiumMatrix: THREE.Matrix4;
      roofMatrix: THREE.Matrix4;
      crownMatrix: THREE.Matrix4 | null;
      color: THREE.Color;
    }> = [];

    for (let index = 0; index < buildingCount; index += 1) {
      const distance = ((index + random() * 0.78) / buildingCount) * this.plan.length;
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().setY(0);
      if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
      else forward.normalize();
      const sideAxis = new THREE.Vector3(-forward.z, 0, forward.x);
      const side = random() > 0.5 ? 1 : -1;
      const sideDistance = this.plan.radius + 18 + random() * 72;
      const width = 9 + random() * 17;
      const depth = 9 + random() * 21;
      const skylineAccent = random() > 0.83 ? 1.35 : 1;
      const height = (34 + random() * 112 + Math.pow(random(), 7) * 92) * skylineAccent;
      const baseY = this.skylineGroundHeight(frame) + 0.65;
      const towardTube = sideAxis.clone().multiplyScalar(-side);
      const bodyX = new THREE.Vector3().crossVectors(up, towardTube).normalize();
      basis.makeBasis(bodyX, up, towardTube);
      facadeQuaternion.setFromRotationMatrix(basis);
      const position = frame.position.clone()
        .addScaledVector(sideAxis, side * sideDistance)
        .setY(baseY + height * 0.5);
      const bodyMatrix = new THREE.Matrix4().compose(
        position,
        facadeQuaternion,
        new THREE.Vector3(width, height, depth),
      );
      const facadeMatrices: THREE.Matrix4[] = [];
      const facadeHeight = height * 0.84;
      const addFacade = (
        normal: THREE.Vector3,
        halfDepth: number,
        facadeWidth: number,
      ): void => {
        const facadeX = new THREE.Vector3().crossVectors(up, normal).normalize();
        const facadeBasis = new THREE.Matrix4().makeBasis(facadeX, up, normal);
        const facadeRotation = new THREE.Quaternion().setFromRotationMatrix(facadeBasis);
        facadeMatrices.push(new THREE.Matrix4().compose(
          position.clone().addScaledVector(normal, halfDepth + 0.09),
          facadeRotation,
          new THREE.Vector3(facadeWidth, facadeHeight, 1),
        ));
      };
      addFacade(towardTube, depth * 0.505, width * 0.8);
      addFacade(forward, width * 0.505, depth * 0.74);
      addFacade(forward.clone().multiplyScalar(-1), width * 0.505, depth * 0.74);
      const podiumHeight = 5 + random() * 6;
      const podiumMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, baseY + podiumHeight * 0.5, position.z),
        facadeQuaternion,
        new THREE.Vector3(width * 1.22, podiumHeight, depth * 1.22),
      );
      const roofMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, baseY + height + 0.85, position.z),
        facadeQuaternion,
        new THREE.Vector3(width * 0.94, 1.7, depth * 0.94),
      );
      const crownHeight = 8 + random() * 22;
      const crownMatrix = random() > 0.67
        ? new THREE.Matrix4().compose(
          new THREE.Vector3(position.x, baseY + height + crownHeight * 0.5, position.z),
          facadeQuaternion,
          new THREE.Vector3(width * 0.44, crownHeight, depth * 0.44),
        )
        : null;
      const color = buildingPalette[Math.floor(random() * buildingPalette.length)].clone()
        .offsetHSL((random() - 0.5) * 0.035, (random() - 0.5) * 0.08, (random() - 0.5) * 0.09);
      buildingSpecs.push({
        type: Math.min(2, Math.floor(random() * 3)),
        matrix: bodyMatrix,
        facadeMatrices,
        podiumMatrix,
        roofMatrix,
        crownMatrix,
        color,
      });
    }

    const buildingGeometries: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.CylinderGeometry(0.42, 0.58, 1, 7, 1),
      new THREE.CylinderGeometry(0.16, 0.58, 1, 5, 1),
    ];
    const buildingMaterials = [0, 1, 2].map((type) => new THREE.MeshStandardMaterial({
      color: type === 1 ? 0xd7edf4 : 0xc0d6e1,
      emissive: type === 2 ? 0x132c48 : 0x0b2234,
      emissiveIntensity: 0.34,
      metalness: type === 0 ? 0.72 : 0.52,
      roughness: type === 2 ? 0.27 : 0.39,
      vertexColors: true,
      flatShading: type !== 0,
    }));
    for (let type = 0; type < 3; type += 1) {
      const specs = buildingSpecs.filter((spec) => spec.type === type);
      const buildings = new THREE.InstancedMesh(buildingGeometries[type], buildingMaterials[type], specs.length);
      specs.forEach((spec, index) => {
        buildings.setMatrixAt(index, spec.matrix);
        buildings.setColorAt(index, spec.color);
      });
      buildings.instanceMatrix.needsUpdate = true;
      if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
      buildings.frustumCulled = false;
      this.world.add(buildings);
    }

    const podiums = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x91a3a9,
        roughness: 0.7,
        metalness: 0.24,
        vertexColors: true,
      }),
      buildingSpecs.length,
    );
    const roofs = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xc7dde2,
        emissive: 0x173c4c,
        emissiveIntensity: 0.28,
        roughness: 0.3,
        metalness: 0.72,
        vertexColors: true,
      }),
      buildingSpecs.length,
    );
    buildingSpecs.forEach((spec, index) => {
      podiums.setMatrixAt(index, spec.podiumMatrix);
      podiums.setColorAt(index, spec.color.clone().multiplyScalar(0.64));
      roofs.setMatrixAt(index, spec.roofMatrix);
      roofs.setColorAt(index, spec.color.clone().offsetHSL(0, -0.08, 0.13));
    });
    podiums.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    if (podiums.instanceColor) podiums.instanceColor.needsUpdate = true;
    if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
    podiums.frustumCulled = false;
    roofs.frustumCulled = false;
    this.world.add(podiums, roofs);

    const facadeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      vertexShader: `
        varying vec2 vUv;
        varying float vViewDepth;
        void main() {
          vUv = uv;
          vec4 localPosition = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            localPosition = instanceMatrix * localPosition;
          #endif
          vec4 viewPosition = modelViewMatrix * localPosition;
          vViewDepth = max(0.0, -viewPosition.z);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vViewDepth;
        float hash(vec2 value) {
          return fract(sin(dot(value, vec2(41.13, 289.7))) * 43758.5453);
        }
        void main() {
          vec2 cells = vec2(5.0, 22.0);
          vec2 cell = fract(vUv * cells);
          vec2 cellId = floor(vUv * cells);
          float pane = step(0.16, cell.x) * step(cell.x, 0.82)
            * step(0.16, cell.y) * step(cell.y, 0.76);
          float lit = step(0.24, hash(cellId));
          float warm = step(0.58, hash(cellId + 17.0));
          vec3 glass = mix(vec3(0.07, 0.28, 0.38), vec3(0.13, 0.42, 0.54), vUv.y);
          vec3 lightColor = mix(vec3(0.18, 0.8, 1.0), vec3(1.0, 0.72, 0.32), warm);
          vec3 color = mix(vec3(0.018, 0.045, 0.06), glass, pane);
          color += lightColor * pane * lit * 0.72;
          float distanceFade = exp(-vViewDepth * 0.00145);
          float alpha = (0.58 + pane * 0.16 + pane * lit * 0.18) * distanceFade;
          if (alpha < 0.025) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    const facades = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      facadeMaterial,
      buildingSpecs.length * 3,
    );
    let facadeIndex = 0;
    for (const spec of buildingSpecs) {
      for (const facadeMatrix of spec.facadeMatrices) {
        facades.setMatrixAt(facadeIndex, facadeMatrix);
        facadeIndex += 1;
      }
    }
    facades.instanceMatrix.needsUpdate = true;
    facades.frustumCulled = false;
    facades.renderOrder = 2;
    this.world.add(facades);

    const crownSpecs = buildingSpecs.filter((spec) => spec.crownMatrix);
    const crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.5, 1, 5),
      new THREE.MeshStandardMaterial({
        color: 0xc8e8f2,
        emissive: 0x235b74,
        emissiveIntensity: 0.48,
        metalness: 0.76,
        roughness: 0.26,
        vertexColors: true,
        flatShading: true,
      }),
      crownSpecs.length,
    );
    crownSpecs.forEach((spec, index) => {
      crowns.setMatrixAt(index, spec.crownMatrix as THREE.Matrix4);
      crowns.setColorAt(index, spec.color);
    });
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    crowns.frustumCulled = false;
    this.world.add(crowns);

    const trafficCount = this.graphicsSettings.quality === 'performance'
      ? 26
      : this.graphicsSettings.quality === 'balanced'
        ? 42
        : 56;
    const trafficPalette = [0xff5d4d, 0x2ac8ff, 0xffc34d, 0x8c72ff, 0x55e5a5, 0xf0f4ff];
    for (let index = 0; index < trafficCount; index += 1) {
      const vehicle = this.createSkylineVehicle(
        index % 3,
        trafficPalette[Math.floor(random() * trafficPalette.length)],
        2.6 + random() * 1.5,
      );
      this.world.add(vehicle);
      this.skylineTraffic.push({
        group: vehicle,
        baseDistance: ((index + random() * 0.72) / trafficCount) * 3200,
        speed: index % 4 === 0
          ? 148 + random() * 38
          : (random() > 0.22 ? 1 : -1) * (34 + random() * 66),
        sideOffset: this.plan.radius + 12 + random() * 22,
        orbitAngle: random() * TAU,
        bobPhase: random() * TAU,
        bank: (random() - 0.5) * 0.24,
      });
    }
  }

  private skylineGroundHeight(frame: TrackFrame): number {
    return frame.position.y - this.plan.radius - 24;
  }

  private addSkylineGround(seed: number): void {
    const random = mulberry32(seed ^ 0x6a4d3e21);
    const quality = this.graphicsSettings.quality;
    const patchSpacing = quality === 'performance' ? 185 : quality === 'balanced' ? 145 : 112;
    const patchCount = Math.max(2, Math.ceil(this.plan.length / patchSpacing) + 1);
    const patchLength = (this.plan.length / (patchCount - 1)) * 1.18;
    const up = new THREE.Vector3(0, 1, 0);
    const identity = new THREE.Quaternion();
    const turfMatrices: THREE.Matrix4[] = [];
    const soilMatrices: THREE.Matrix4[] = [];
    const pathMatrices: THREE.Matrix4[] = [];
    const turfColors: THREE.Color[] = [];
    const soilColors: THREE.Color[] = [];

    for (let index = 0; index < patchCount; index += 1) {
      const distance = Math.min(this.plan.length - 1, (index / (patchCount - 1)) * this.plan.length);
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().normalize();
      const terrainX = new THREE.Vector3().crossVectors(up, forward);
      if (terrainX.lengthSq() < 0.0001) terrainX.set(1, 0, 0);
      else terrainX.normalize();
      const terrainUp = new THREE.Vector3().crossVectors(forward, terrainX).normalize();
      const terrainBasis = new THREE.Matrix4().makeBasis(terrainX, terrainUp, forward);
      const terrainQuaternion = new THREE.Quaternion().setFromRotationMatrix(terrainBasis);
      const groundTop = this.skylineGroundHeight(frame);
      for (const side of [-1, 1]) {
        const center = frame.position.clone().addScaledVector(terrainX, side * 57);
        soilMatrices.push(new THREE.Matrix4().compose(
          new THREE.Vector3(center.x, groundTop - 3.5, center.z),
          terrainQuaternion,
          new THREE.Vector3(114, 7, patchLength),
        ));
        turfMatrices.push(new THREE.Matrix4().compose(
          new THREE.Vector3(center.x, groundTop + 0.35, center.z),
          terrainQuaternion,
          new THREE.Vector3(113.4, 0.7, patchLength * 0.985),
        ));
        const pathCenter = frame.position.clone().addScaledVector(terrainX, side * 29.5);
        pathMatrices.push(new THREE.Matrix4().compose(
          new THREE.Vector3(pathCenter.x, groundTop + 0.76, pathCenter.z),
          terrainQuaternion,
          new THREE.Vector3(5.2, 0.18, patchLength),
        ));
        turfColors.push(new THREE.Color(0xe9ffda).offsetHSL(
          (random() - 0.5) * 0.035,
          (random() - 0.5) * 0.035,
          (random() - 0.5) * 0.035,
        ));
        soilColors.push(new THREE.Color(0x59412c).offsetHSL(
          (random() - 0.5) * 0.025,
          0,
          (random() - 0.5) * 0.055,
        ));
      }
    }

    const soil = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x79583a,
        roughness: 1,
        metalness: 0,
        vertexColors: true,
      }),
      soilMatrices.length,
    );
    const grassCanvas = document.createElement('canvas');
    grassCanvas.width = 128;
    grassCanvas.height = 128;
    const grassContext = grassCanvas.getContext('2d');
    let grassTexture: THREE.CanvasTexture | null = null;
    if (grassContext) {
      const textureRandom = mulberry32(seed ^ 0x47a551c);
      grassContext.fillStyle = '#6ea948';
      grassContext.fillRect(0, 0, grassCanvas.width, grassCanvas.height);
      const grassTones = ['#7db957', '#5d973d', '#8fc361', '#4f8435', '#74ad49'];
      for (let index = 0; index < 720; index += 1) {
        const size = 0.7 + textureRandom() * 2.4;
        grassContext.globalAlpha = 0.25 + textureRandom() * 0.42;
        grassContext.fillStyle = grassTones[Math.floor(textureRandom() * grassTones.length)];
        grassContext.fillRect(textureRandom() * 128, textureRandom() * 128, size, size * 0.72);
      }
      for (let index = 0; index < 130; index += 1) {
        const x = textureRandom() * 128;
        const y = textureRandom() * 128;
        grassContext.globalAlpha = 0.35 + textureRandom() * 0.35;
        grassContext.strokeStyle = textureRandom() > 0.5 ? '#9bca62' : '#3f7430';
        grassContext.lineWidth = 0.55;
        grassContext.beginPath();
        grassContext.moveTo(x, y + 2.4);
        grassContext.lineTo(x + (textureRandom() - 0.5) * 1.5, y);
        grassContext.stroke();
      }
      for (let index = 0; index < 38; index += 1) {
        grassContext.globalAlpha = 0.75;
        grassContext.fillStyle = textureRandom() > 0.45 ? '#f6e8a4' : '#d8f1ff';
        grassContext.fillRect(textureRandom() * 128, textureRandom() * 128, 1.1, 1.1);
      }
      grassContext.globalAlpha = 1;
      grassTexture = new THREE.CanvasTexture(grassCanvas);
      grassTexture.colorSpace = THREE.SRGBColorSpace;
      grassTexture.wrapS = THREE.RepeatWrapping;
      grassTexture.wrapT = THREE.RepeatWrapping;
      grassTexture.repeat.set(9, 9);
      grassTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    }
    const turfMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x315d19,
      emissiveIntensity: 0.54,
      roughness: 0.97,
      metalness: 0,
      vertexColors: true,
      map: grassTexture,
    });
    const turf = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      turfMaterial,
      turfMatrices.length,
    );
    soilMatrices.forEach((item, index) => {
      soil.setMatrixAt(index, item);
      soil.setColorAt(index, soilColors[index]);
      turf.setMatrixAt(index, turfMatrices[index]);
      turf.setColorAt(index, turfColors[index]);
    });
    soil.instanceMatrix.needsUpdate = true;
    turf.instanceMatrix.needsUpdate = true;
    if (soil.instanceColor) soil.instanceColor.needsUpdate = true;
    if (turf.instanceColor) turf.instanceColor.needsUpdate = true;
    soil.frustumCulled = false;
    turf.frustumCulled = false;

    const paths = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0xb6b7aa,
        roughness: 0.84,
        metalness: 0.08,
      }),
      pathMatrices.length,
    );
    pathMatrices.forEach((item, index) => paths.setMatrixAt(index, item));
    paths.instanceMatrix.needsUpdate = true;
    paths.frustumCulled = false;
    this.world.add(soil, turf, paths);

    const treeCount = quality === 'performance' ? 90 : quality === 'balanced' ? 150 : 220;
    const trunkMatrices: THREE.Matrix4[] = [];
    const canopyMatrices: THREE.Matrix4[] = [];
    const canopyTopMatrices: THREE.Matrix4[] = [];
    const canopyColors: THREE.Color[] = [];
    for (let index = 0; index < treeCount; index += 1) {
      const distance = random() * (this.plan.length - 2);
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().setY(0);
      if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
      else forward.normalize();
      const sideAxis = new THREE.Vector3(-forward.z, 0, forward.x);
      const side = random() > 0.5 ? 1 : -1;
      const sideOffset = 39 + random() * 60;
      const ground = this.skylineGroundHeight(frame) + 0.72;
      const height = 7 + random() * 9;
      const position = frame.position.clone().addScaledVector(sideAxis, side * sideOffset);
      trunkMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, ground + height * 0.31, position.z),
        identity,
        new THREE.Vector3(0.48 + height * 0.035, height * 0.62, 0.48 + height * 0.035),
      ));
      canopyMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, ground + height * 0.73, position.z),
        identity,
        new THREE.Vector3(height * 0.38, height * 0.34, height * 0.38),
      ));
      canopyTopMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, ground + height * 0.98, position.z),
        identity,
        new THREE.Vector3(height * 0.27, height * 0.25, height * 0.27),
      ));
      canopyColors.push(new THREE.Color(random() > 0.3 ? 0x3f873d : 0x6a9d3e).offsetHSL(
        (random() - 0.5) * 0.06,
        (random() - 0.5) * 0.09,
        (random() - 0.5) * 0.08,
      ));
    }
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.68, 1, 7),
      new THREE.MeshStandardMaterial({ color: 0x66462c, roughness: 1 }),
      trunkMatrices.length,
    );
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: 0x57944a,
      emissive: 0x173712,
      emissiveIntensity: 0.38,
      roughness: 0.93,
      vertexColors: true,
      flatShading: true,
    });
    const canopies = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.5, 1),
      canopyMaterial,
      canopyMatrices.length,
    );
    const canopyTops = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.5, 1),
      canopyMaterial.clone(),
      canopyTopMatrices.length,
    );
    trunkMatrices.forEach((item, index) => {
      trunks.setMatrixAt(index, item);
      canopies.setMatrixAt(index, canopyMatrices[index]);
      canopies.setColorAt(index, canopyColors[index]);
      canopyTops.setMatrixAt(index, canopyTopMatrices[index]);
      canopyTops.setColorAt(index, canopyColors[index].clone().offsetHSL(0.015, 0.02, 0.05));
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    canopyTops.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    if (canopyTops.instanceColor) canopyTops.instanceColor.needsUpdate = true;
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;
    canopyTops.frustumCulled = false;
    this.world.add(trunks, canopies, canopyTops);

    const lightMatrices: THREE.Matrix4[] = [];
    const bulbMatrices: THREE.Matrix4[] = [];
    for (let index = 0; index < patchCount; index += 1) {
      const distance = Math.min(this.plan.length - 1, ((index + 0.5) / patchCount) * this.plan.length);
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().setY(0);
      if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
      else forward.normalize();
      const sideAxis = new THREE.Vector3(-forward.z, 0, forward.x);
      const ground = this.skylineGroundHeight(frame) + 0.76;
      for (const side of [-1, 1]) {
        const position = frame.position.clone().addScaledVector(sideAxis, side * 26.2);
        lightMatrices.push(new THREE.Matrix4().compose(
          new THREE.Vector3(position.x, ground + 3.15, position.z),
          identity,
          new THREE.Vector3(0.18, 6.3, 0.18),
        ));
        bulbMatrices.push(new THREE.Matrix4().compose(
          new THREE.Vector3(position.x, ground + 6.4, position.z),
          identity,
          new THREE.Vector3(0.7, 0.38, 0.7),
        ));
      }
    }
    const lampPoles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.62, 1, 7),
      new THREE.MeshStandardMaterial({ color: 0x30424a, metalness: 0.72, roughness: 0.28 }),
      lightMatrices.length,
    );
    const lampBulbs = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 8, 5),
      new THREE.MeshBasicMaterial({ color: 0xffe2a1, toneMapped: false }),
      bulbMatrices.length,
    );
    lightMatrices.forEach((item, index) => {
      lampPoles.setMatrixAt(index, item);
      lampBulbs.setMatrixAt(index, bulbMatrices[index]);
    });
    lampPoles.instanceMatrix.needsUpdate = true;
    lampBulbs.instanceMatrix.needsUpdate = true;
    lampPoles.frustumCulled = false;
    lampBulbs.frustumCulled = false;
    this.world.add(lampPoles, lampBulbs);

    const objectCount = quality === 'performance' ? 34 : quality === 'balanced' ? 54 : 76;
    const benchSeatMatrices: THREE.Matrix4[] = [];
    const benchBackMatrices: THREE.Matrix4[] = [];
    const rockMatrices: THREE.Matrix4[] = [];
    for (let index = 0; index < objectCount; index += 1) {
      const distance = random() * (this.plan.length - 2);
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().setY(0);
      if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
      else forward.normalize();
      const sideAxis = new THREE.Vector3(-forward.z, 0, forward.x);
      const side = random() > 0.5 ? 1 : -1;
      const normal = sideAxis.clone().multiplyScalar(-side);
      const objectX = new THREE.Vector3().crossVectors(up, normal).normalize();
      const objectBasis = new THREE.Matrix4().makeBasis(objectX, up, normal);
      const objectQuaternion = new THREE.Quaternion().setFromRotationMatrix(objectBasis);
      const ground = this.skylineGroundHeight(frame) + 0.73;
      const position = frame.position.clone().addScaledVector(sideAxis, side * (43 + random() * 48));
      benchSeatMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(position.x, ground + 1.15, position.z),
        objectQuaternion,
        new THREE.Vector3(3.1, 0.32, 0.86),
      ));
      benchBackMatrices.push(new THREE.Matrix4().compose(
        position.clone().addScaledVector(normal, 0.4).setY(ground + 1.85),
        objectQuaternion,
        new THREE.Vector3(3.1, 1.35, 0.24),
      ));

      const rockDistance = random() * (this.plan.length - 2);
      const rockFrame = sampleTrackFrame(this.plan, rockDistance / this.plan.length);
      const rockForward = rockFrame.tangent.clone().setY(0);
      if (rockForward.lengthSq() < 0.0001) rockForward.set(0, 0, -1);
      else rockForward.normalize();
      const rockSideAxis = new THREE.Vector3(-rockForward.z, 0, rockForward.x);
      const rockSide = random() > 0.5 ? 1 : -1;
      const rockScale = 0.8 + random() * 2.3;
      const rockPosition = rockFrame.position.clone().addScaledVector(
        rockSideAxis,
        rockSide * (40 + random() * 60),
      );
      rockMatrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(
          rockPosition.x,
          this.skylineGroundHeight(rockFrame) + 0.72 + rockScale * 0.26,
          rockPosition.z,
        ),
        new THREE.Quaternion().setFromAxisAngle(up, random() * TAU),
        new THREE.Vector3(rockScale, rockScale * (0.55 + random() * 0.35), rockScale * 0.82),
      ));
    }
    const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x9b6038, roughness: 0.78, metalness: 0.08 });
    const benchSeats = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), benchMaterial, benchSeatMatrices.length);
    const benchBacks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), benchMaterial.clone(), benchBackMatrices.length);
    const rocks = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x7c8178, roughness: 0.96, flatShading: true }),
      rockMatrices.length,
    );
    benchSeatMatrices.forEach((item, index) => {
      benchSeats.setMatrixAt(index, item);
      benchBacks.setMatrixAt(index, benchBackMatrices[index]);
      rocks.setMatrixAt(index, rockMatrices[index]);
    });
    benchSeats.instanceMatrix.needsUpdate = true;
    benchBacks.instanceMatrix.needsUpdate = true;
    rocks.instanceMatrix.needsUpdate = true;
    benchSeats.frustumCulled = false;
    benchBacks.frustumCulled = false;
    rocks.frustumCulled = false;
    this.world.add(benchSeats, benchBacks, rocks);
  }

  private createSkylineVehicle(type: number, color: number, scale: number): THREE.Group {
    const group = new THREE.Group();
    const hullMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.12),
      emissiveIntensity: 0.44,
      metalness: 0.82,
      roughness: 0.2,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x152d3d,
      emissive: 0x09253a,
      emissiveIntensity: 0.7,
      metalness: 0.72,
      roughness: 0.16,
    });
    const lightMaterial = new THREE.MeshBasicMaterial({
      color: type === 1 ? 0xffc457 : 0x4de7ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 7), hullMaterial);
    hull.scale.set(type === 1 ? 1.55 : 1.22, type === 2 ? 0.48 : 0.36, type === 0 ? 2.25 : 1.82);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.68, 10, 6), darkMaterial);
    canopy.position.set(0, 0.3, type === 0 ? -0.12 : 0.18);
    canopy.scale.set(type === 2 ? 1.08 : 0.82, 0.48, type === 0 ? 1.05 : 0.78);
    group.add(hull, canopy);

    if (type === 0) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.1, 0.75), hullMaterial);
      wing.position.z = 0.32;
      group.add(wing);
    } else if (type === 1) {
      for (const side of [-1, 1]) {
        const pod = new THREE.Mesh(new THREE.SphereGeometry(0.45, 9, 5), darkMaterial);
        pod.position.set(side * 1.38, -0.08, 0.24);
        pod.scale.set(0.7, 0.62, 1.55);
        const strut = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.08, 0.22), hullMaterial);
        strut.position.set(side * 0.88, 0, 0.16);
        group.add(pod, strut);
      }
    } else {
      const lowerDeck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 1.55), darkMaterial);
      lowerDeck.position.y = -0.38;
      group.add(lowerDeck);
    }

    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 7, 4), lightMaterial);
      lamp.position.set(side * 0.52, -0.02, -1.78);
      lamp.scale.z = 1.9;
      const trail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.55, 7), lightMaterial);
      trail.position.set(side * 0.48, -0.08, 2.15);
      trail.rotation.x = Math.PI * 0.5;
      group.add(lamp, trail);
    }
    group.scale.setScalar(scale);
    return group;
  }

  private updateSkylineEnvironment(dt: number, activeDistance: number): void {
    if (!this.skylineSky) return;
    this.skylineSky.position.copy(this.camera.position);
    if (this.skylineSkyMaterial) {
      this.skylineSkyMaterial.uniforms.uTime.value = performance.now() / 1000;
    }
    this.skylineTrafficTime += Math.max(0, dt);
    const localForward = new THREE.Vector3(0, 0, -1);
    const localRollAxis = new THREE.Vector3(0, 0, -1);
    const rollQuaternion = new THREE.Quaternion();
    for (const vehicle of this.skylineTraffic) {
      const trafficSpan = 3200;
      const unwrapped = vehicle.baseDistance + this.skylineTrafficTime * vehicle.speed;
      const localDistance = ((unwrapped % trafficSpan) + trafficSpan) % trafficSpan;
      const distance = Math.min(this.plan.length - 1, activeDistance + 80 + localDistance);
      const ahead = distance - activeDistance;
      vehicle.group.visible = ahead > -380 && ahead < 1400;
      if (!vehicle.group.visible) continue;
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const bob = Math.sin(this.skylineTrafficTime * 1.2 + vehicle.bobPhase) * 0.65;
      const orbitRadial = radialAt(
        frame,
        vehicle.orbitAngle + Math.sin(this.skylineTrafficTime * 0.16 + vehicle.bobPhase) * 0.045,
      );
      vehicle.group.position.copy(frame.position)
        .addScaledVector(orbitRadial, vehicle.sideOffset + bob);
      const direction = frame.tangent.clone().multiplyScalar(vehicle.speed >= 0 ? 1 : -1).normalize();
      vehicle.group.quaternion.setFromUnitVectors(localForward, direction);
      rollQuaternion.setFromAxisAngle(
        localRollAxis,
        vehicle.bank + Math.sin(this.skylineTrafficTime * 0.7 + vehicle.bobPhase) * 0.035,
      );
      vehicle.group.quaternion.multiply(rollQuaternion);
    }
  }

  private addUnderwaterEnvironment(seed: number): void {
    const random = mulberry32(seed ^ 0x0cea75);
    const quality = this.graphicsSettings.quality;

    this.underwaterSkyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDirection;
        uniform float uTime;
        void main() {
          vec3 direction = normalize(vDirection);
          float height = direction.y * 0.5 + 0.5;
          vec3 abyss = vec3(0.001, 0.011, 0.034);
          vec3 middle = vec3(0.004, 0.085, 0.14);
          vec3 surface = vec3(0.055, 0.34, 0.46);
          vec3 color = mix(abyss, middle, smoothstep(0.12, 0.62, height));
          color = mix(color, surface, smoothstep(0.66, 0.98, height));
          float sun = pow(max(0.0, dot(direction, normalize(vec3(0.2, 0.94, -0.18)))), 46.0);
          float rayWave = sin(direction.x * 22.0 + direction.z * 17.0 + uTime * 0.08) * 0.5 + 0.5;
          float rays = pow(max(0.0, direction.y), 4.0) * pow(rayWave, 7.0);
          float haze = sin(direction.x * 38.0 - direction.z * 31.0 + uTime * 0.12) * 0.012;
          color += vec3(0.28, 0.74, 0.82) * rays * 0.11;
          color += vec3(0.68, 0.93, 0.86) * sun * 0.72;
          color += haze * vec3(0.02, 0.16, 0.2);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.underwaterSky = new THREE.Mesh(
      new THREE.SphereGeometry(720, 40, 24),
      this.underwaterSkyMaterial,
    );
    this.underwaterSky.frustumCulled = false;
    this.underwaterSky.renderOrder = -1000;
    this.world.add(this.underwaterSky);

    const hemisphere = new THREE.HemisphereLight(0x7cecff, 0x021326, 2.2);
    const surfaceLight = new THREE.DirectionalLight(0xc5fff2, 3.4);
    surfaceLight.position.set(110, 260, 40);
    const reefLight = new THREE.DirectionalLight(0x477dff, 1.15);
    reefLight.position.set(-140, -40, -80);
    this.world.add(hemisphere, surfaceLight, reefLight);

    this.addUnderwaterBranches(seed);

    const up = new THREE.Vector3(0, 1, 0);
    const identity = new THREE.Quaternion();
    const patchSpacing = quality === 'performance' ? 190 : quality === 'balanced' ? 145 : 112;
    const patchCount = Math.max(1, Math.ceil(this.plan.length / patchSpacing));
    const sandMatrices: THREE.Matrix4[] = [];
    const rockMatrices: THREE.Matrix4[] = [];
    const coralMatrices: THREE.Matrix4[] = [];
    const coralColors: THREE.Color[] = [];
    const kelpMatrices: THREE.Matrix4[] = [];
    const kelpColors: THREE.Color[] = [];
    for (let index = 0; index < patchCount; index += 1) {
      const distance = Math.min(this.plan.length - 1, ((index + 0.5) / patchCount) * this.plan.length);
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const forward = frame.tangent.clone().normalize();
      const terrainX = new THREE.Vector3().crossVectors(up, forward);
      if (terrainX.lengthSq() < 0.0001) terrainX.copy(frame.normal);
      terrainX.normalize();
      const terrainUp = new THREE.Vector3().crossVectors(forward, terrainX).normalize();
      const terrainBasis = new THREE.Matrix4().makeBasis(terrainX, terrainUp, forward);
      const terrainQuaternion = new THREE.Quaternion().setFromRotationMatrix(terrainBasis);
      const groundCenter = frame.position.clone().addScaledVector(terrainUp, -(this.plan.radius + 62));
      sandMatrices.push(new THREE.Matrix4().compose(
        groundCenter.clone().addScaledVector(terrainUp, -2.2),
        terrainQuaternion,
        new THREE.Vector3(310, 5.4, patchSpacing + 26),
      ));

      const decorations = quality === 'performance' ? 3 : quality === 'balanced' ? 5 : 7;
      for (let item = 0; item < decorations; item += 1) {
        const side = (random() - 0.5) * 150;
        const along = (random() - 0.5) * patchSpacing;
        const position = groundCenter.clone()
          .addScaledVector(terrainX, side)
          .addScaledVector(forward, along);
        const rockScale = 1.8 + random() * 7.2;
        rockMatrices.push(new THREE.Matrix4().compose(
          position.clone().addScaledVector(terrainUp, rockScale * 0.28),
          new THREE.Quaternion().setFromAxisAngle(terrainUp, random() * TAU),
          new THREE.Vector3(rockScale * (0.7 + random() * 0.7), rockScale * 0.7, rockScale),
        ));
        const coralHeight = 2.5 + random() * 8.5;
        const coralPosition = position.clone().addScaledVector(terrainX, (random() - 0.5) * 9);
        coralMatrices.push(new THREE.Matrix4().compose(
          coralPosition.clone().addScaledVector(terrainUp, coralHeight * 0.5),
          new THREE.Quaternion().setFromUnitVectors(up, terrainUp),
          new THREE.Vector3(0.65 + random() * 1.45, coralHeight, 0.65 + random() * 1.45),
        ));
        const coralPalette = [0xff6ea9, 0xffa55b, 0x9f73ff, 0x45f1d0, 0xffdf76];
        coralColors.push(new THREE.Color(coralPalette[Math.floor(random() * coralPalette.length)]));

        const kelpHeight = 5 + random() * 13;
        const kelpPosition = position.clone().addScaledVector(terrainX, (random() - 0.5) * 16);
        kelpMatrices.push(new THREE.Matrix4().compose(
          kelpPosition.clone().addScaledVector(terrainUp, kelpHeight * 0.5),
          new THREE.Quaternion().setFromUnitVectors(up, terrainUp),
          new THREE.Vector3(0.35 + random() * 0.45, kelpHeight, 0.18 + random() * 0.35),
        ));
        kelpColors.push(new THREE.Color(random() > 0.38 ? 0x2e9f78 : 0x6ab46c));
      }
    }

    const sand = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x52777a,
        emissive: 0x062e35,
        emissiveIntensity: 0.28,
        roughness: 1,
        metalness: 0,
      }),
      sandMatrices.length,
    );
    sandMatrices.forEach((matrix, index) => sand.setMatrixAt(index, matrix));
    sand.instanceMatrix.needsUpdate = true;
    sand.frustumCulled = false;

    const rocks = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.5, 1),
      new THREE.MeshStandardMaterial({ color: 0x183d46, roughness: 0.95, flatShading: true }),
      rockMatrices.length,
    );
    rockMatrices.forEach((matrix, index) => rocks.setMatrixAt(index, matrix));
    rocks.instanceMatrix.needsUpdate = true;
    rocks.frustumCulled = false;

    const corals = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.76, 1, 7),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x2b1238,
        emissiveIntensity: 0.7,
        roughness: 0.72,
        vertexColors: true,
      }),
      coralMatrices.length,
    );
    coralMatrices.forEach((matrix, index) => {
      corals.setMatrixAt(index, matrix);
      corals.setColorAt(index, coralColors[index]);
    });
    corals.instanceMatrix.needsUpdate = true;
    if (corals.instanceColor) corals.instanceColor.needsUpdate = true;
    corals.frustumCulled = false;

    const kelp = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.42, 0.62, 1, 5),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true }),
      kelpMatrices.length,
    );
    kelpMatrices.forEach((matrix, index) => {
      kelp.setMatrixAt(index, matrix);
      kelp.setColorAt(index, kelpColors[index]);
    });
    kelp.instanceMatrix.needsUpdate = true;
    if (kelp.instanceColor) kelp.instanceColor.needsUpdate = true;
    kelp.frustumCulled = false;
    this.world.add(sand, rocks, corals, kelp);

    const bubbleCount = quality === 'performance' ? 420 : quality === 'balanced' ? 760 : 1120;
    const bubblePositions = new Float32Array(bubbleCount * 3);
    for (let index = 0; index < bubbleCount; index += 1) {
      const frame = sampleTrackFrame(this.plan, random());
      const angle = random() * TAU;
      const radius = this.plan.radius + 8 + random() * 125;
      const position = frame.position.addScaledVector(radialAt(frame, angle), radius);
      bubblePositions[index * 3] = position.x;
      bubblePositions[index * 3 + 1] = position.y;
      bubblePositions[index * 3 + 2] = position.z;
    }
    const bubbleGeometry = new THREE.BufferGeometry();
    bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(bubblePositions, 3));
    const bubbles = new THREE.Points(
      bubbleGeometry,
      new THREE.PointsMaterial({
        color: 0xbafaff,
        size: quality === 'performance' ? 0.42 : 0.58,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    bubbles.frustumCulled = false;
    bubbles.userData.underwaterBubbles = true;
    this.world.add(bubbles);

    const creatureCount = quality === 'performance' ? 30 : quality === 'balanced' ? 44 : 60;
    for (let index = 0; index < creatureCount; index += 1) {
      const kind: UnderwaterCreatureKind = index < 2
        ? 'whale'
        : index < 8
          ? 'shark'
          : index < 12
            ? 'dolphin'
            : index < 17
              ? 'manta'
              : index < 21
                ? 'turtle'
                : index < 34
                  ? 'jellyfish'
                  : 'fish';
      const scale = kind === 'whale'
        ? 1.7 + random() * 0.75
        : kind === 'shark'
          ? 1.15 + random() * 0.75
          : kind === 'jellyfish'
            ? 0.8 + random() * 1.35
            : 0.72 + random() * 0.78;
      const group = this.createUnderwaterCreature(kind, random);
      group.scale.setScalar(scale);
      this.world.add(group);
      this.underwaterCreatures.push({
        group,
        kind,
        baseDistance: random() * 2800,
        speed: (kind === 'jellyfish' ? 0.35 : kind === 'whale' ? 1.15 : 1.8 + random() * 3.5)
          * (random() > 0.18 ? 1 : -1),
        orbitAngle: random() * TAU,
        radiusOffset: this.plan.radius + (kind === 'whale' ? 34 : 17) + random() * (kind === 'whale' ? 58 : 66),
        phase: random() * TAU,
        scale,
      });
    }
  }

  private addUnderwaterForkEvents(seed: number): void {
    const random = mulberry32(seed ^ 0xf04c5);
    const branchFractions = [0.24, 0.5, 0.76];
    const forkEvents: TrackEvent[] = [];
    const firstPatternId = this.plan.events.reduce((highest, event) => Math.max(highest, event.patternId), -1) + 1;
    for (let index = 0; index < branchFractions.length; index += 1) {
      const centerDistance = this.plan.length * branchFractions[index];
      const halfSpan = clamp(this.plan.length * 0.035, 330, 470);
      const forkDistance = Math.max(40, centerDistance - halfSpan + 115);
      const branchAngle = random() * TAU;
      const musicTime = (forkDistance / this.plan.length) * this.plan.runDuration;
      const nearestBeat = this.plan.beatDistances.reduce((nearest, beat) => (
        !nearest || Math.abs(beat.distance - forkDistance) < Math.abs(nearest.distance - forkDistance)
          ? beat
          : nearest
      ), undefined as (typeof this.plan.beatDistances)[number] | undefined);
      forkEvents.push({
        id: -1,
        kind: 'blade',
        distance: forkDistance,
        angle: branchAngle - Math.PI * 0.5,
        gapWidth: 0.22,
        health: 1,
        resolved: false,
        destroyed: false,
        beatIndex: nearestBeat?.beatIndex ?? -1,
        musicTime,
        trigger: nearestBeat?.cue ?? 'beat',
        strength: 0.82,
        rotationRate: 0,
        rotationPhase: branchAngle - Math.PI * 0.5,
        armCount: 2,
        patternId: firstPatternId + index,
        warningDistance: 520,
        safeAngle: branchAngle,
        safeAngularVelocity: 0,
      });
    }
    const cleanEvents = this.plan.events.filter((event) => (
      forkEvents.every((fork) => Math.abs(fork.distance - event.distance) > 190)
    ));
    cleanEvents.push(...forkEvents);
    cleanEvents.sort((left, right) => left.distance - right.distance || left.patternId - right.patternId);
    cleanEvents.forEach((event, index) => { event.id = index; });
    this.plan.events.splice(0, this.plan.events.length, ...cleanEvents);
  }

  private addUnderwaterBranches(seed: number): void {
    const random = mulberry32(seed ^ 0xf04c5);
    const theme = TRACKS.abyss;
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c7690,
      emissive: 0x0a5068,
      emissiveIntensity: 0.72,
      transparent: true,
      opacity: 0.22,
      roughness: 0.14,
      metalness: 0.08,
      transmission: 0.2,
      thickness: 0.65,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const railMaterialA = new THREE.MeshBasicMaterial({
      color: theme.colors.primary,
      transparent: true,
      opacity: 0.88,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const railMaterialB = railMaterialA.clone();
    railMaterialB.color.setHex(theme.colors.secondary);
    const branchFractions = [0.24, 0.5, 0.76];
    const forwardAxis = new THREE.Vector3(0, 0, 1);
    for (let branchIndex = 0; branchIndex < branchFractions.length; branchIndex += 1) {
      const centerDistance = this.plan.length * branchFractions[branchIndex];
      const halfSpan = clamp(this.plan.length * 0.035, 330, 470);
      const startDistance = Math.max(20, centerDistance - halfSpan);
      const endDistance = Math.min(this.plan.length - 20, centerDistance + halfSpan);
      const branchAngle = random() * TAU;
      for (const side of [-1, 1]) {
        const points: THREE.Vector3[] = [];
        const pointCount = 12;
        for (let pointIndex = 0; pointIndex <= pointCount; pointIndex += 1) {
          const mix = pointIndex / pointCount;
          const distance = THREE.MathUtils.lerp(startDistance, endDistance, mix);
          const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
          const arch = Math.sin(mix * Math.PI);
          const radial = radialAt(frame, branchAngle + (side > 0 ? 0 : Math.PI));
          points.push(frame.position.clone().addScaledVector(radial, arch * (this.plan.radius * 2.65 + 13)));
        }
        const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.48);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 92, this.plan.radius * 0.67, 12, false),
          glassMaterial.clone(),
        );
        tube.frustumCulled = false;
        tube.renderOrder = 1;
        this.world.add(tube);

        const railPoints = curve.getPoints(96);
        const railGeometry = new THREE.BufferGeometry().setFromPoints(railPoints);
        const rail = new THREE.Line(
          railGeometry,
          (side > 0 ? railMaterialA : railMaterialB).clone(),
        );
        rail.frustumCulled = false;
        this.world.add(rail);

        const ringCount = 11;
        for (let ringIndex = 1; ringIndex < ringCount; ringIndex += 1) {
          const mix = ringIndex / ringCount;
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(this.plan.radius * 0.67, 0.13, 4, 24),
            (side > 0 ? railMaterialA : railMaterialB).clone(),
          );
          ring.position.copy(curve.getPointAt(mix));
          ring.quaternion.setFromUnitVectors(forwardAxis, curve.getTangentAt(mix).normalize());
          ring.frustumCulled = false;
          this.world.add(ring);
        }
      }

      const splitFrame = sampleTrackFrame(this.plan, startDistance / this.plan.length);
      const portal = new THREE.Group();
      portal.position.copy(splitFrame.position);
      portal.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(splitFrame.normal, splitFrame.binormal, splitFrame.tangent),
      );
      const portalRadius = this.plan.radius - 1.25;
      for (const side of [-1, 1]) {
        const colorMaterial = (side > 0 ? railMaterialA : railMaterialB).clone();
        const arc = new THREE.Mesh(
          new THREE.TorusGeometry(portalRadius, 0.34, 6, 42, Math.PI * 0.82),
          colorMaterial,
        );
        arc.rotation.z = (side > 0 ? branchAngle : branchAngle + Math.PI) - Math.PI * 0.41;
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.75, 2.25, 3), colorMaterial.clone());
        const arrowAngle = branchAngle + (side > 0 ? 0 : Math.PI);
        arrow.position.set(Math.cos(arrowAngle) * (portalRadius - 0.7), Math.sin(arrowAngle) * (portalRadius - 0.7), -1.4);
        arrow.rotation.z = arrowAngle - Math.PI * 0.5;
        portal.add(arc, arrow);
      }
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(this.plan.radius - 0.48, 0.12, 4, 42),
        new THREE.MeshBasicMaterial({
          color: 0xbffcff,
          transparent: true,
          opacity: 0.54,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      portal.add(halo);
      portal.userData.underwaterFork = true;
      this.world.add(portal);
    }
    glassMaterial.dispose();
    railMaterialA.dispose();
    railMaterialB.dispose();
  }

  private createUnderwaterCreature(kind: UnderwaterCreatureKind, random: () => number): THREE.Group {
    const group = new THREE.Group();
    const coolPalette = [0x79a9b8, 0x5f91a5, 0x87b4be, 0x4e8194];
    const skinColor = coolPalette[Math.floor(random() * coolPalette.length)];
    const skin = new THREE.MeshStandardMaterial({
      color: skinColor,
      emissive: new THREE.Color(skinColor),
      emissiveIntensity: 0.78,
      roughness: 0.7,
      metalness: 0,
      flatShading: kind === 'fish',
    });
    const pale = new THREE.MeshStandardMaterial({
      color: 0xa7d4d8,
      emissive: 0x315f68,
      emissiveIntensity: 0.62,
      roughness: 0.78,
    });
    const eye = new THREE.MeshBasicMaterial({ color: 0x07151b });
    const tail = new THREE.Group();
    tail.name = 'swimming-tail';

    if (kind === 'jellyfish') {
      const jellyPalette = [0xa96fff, 0x6feaff, 0xff72cc, 0x8d9dff];
      const jellyColor = jellyPalette[Math.floor(random() * jellyPalette.length)];
      const jellyMaterial = new THREE.MeshBasicMaterial({
        color: jellyColor,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
      });
      const bell = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 16, 9, 0, TAU, 0, Math.PI * 0.56),
        jellyMaterial,
      );
      bell.scale.y = 0.72;
      group.add(bell);
      for (let tentacleIndex = 0; tentacleIndex < 7; tentacleIndex += 1) {
        const angle = (tentacleIndex / 7) * TAU;
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(Math.cos(angle) * 1.35, -0.2, Math.sin(angle) * 1.35),
          new THREE.Vector3(Math.cos(angle + 0.25) * 1.1, -2.4, Math.sin(angle + 0.25) * 1.1),
          new THREE.Vector3(Math.cos(angle - 0.18) * 0.8, -4.5 - random() * 2.4, Math.sin(angle - 0.18) * 0.8),
        ]);
        const tentacleMaterial = jellyMaterial.clone();
        tentacleMaterial.opacity = 0.78;
        group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 8, 0.09, 4, false), tentacleMaterial));
      }
      group.userData.tail = null;
      return group;
    }

    if (kind === 'whale') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), skin);
      body.scale.set(4.1, 2.65, 9.6);
      const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 9), pale);
      belly.position.set(0, -1.65, -0.7);
      belly.scale.set(3.45, 0.9, 7.1);
      const finGeometry = new THREE.ConeGeometry(1.15, 5.8, 3);
      for (const side of [-1, 1]) {
        const fin = new THREE.Mesh(finGeometry, skin);
        fin.position.set(side * 3.3, -0.75, 0.2);
        fin.rotation.z = side * 1.18;
        fin.rotation.x = 0.25;
        group.add(fin);
      }
      tail.position.z = 9.2;
      for (const side of [-1, 1]) {
        const fluke = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), skin);
        fluke.position.x = side * 2.2;
        fluke.scale.set(2.8, 0.34, 1.35);
        fluke.rotation.y = side * 0.22;
        tail.add(fluke);
      }
      group.add(body, belly, tail);
    } else if (kind === 'manta') {
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 9), skin);
      body.scale.set(4.8, 0.68, 3.4);
      const wingGeometry = new THREE.ConeGeometry(2.6, 5.4, 3);
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(wingGeometry, skin);
        wing.position.x = side * 3.7;
        wing.rotation.z = side * Math.PI * 0.5;
        wing.rotation.y = side * 0.18;
        group.add(wing);
      }
      const rayTail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.18, 7, 6), skin);
      rayTail.rotation.x = Math.PI * 0.5;
      rayTail.position.z = 5.5;
      group.add(body, rayTail);
    } else if (kind === 'turtle') {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), skin);
      shell.scale.set(2.7, 0.95, 3.4);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.66, 10, 7), pale);
      head.position.z = -3.45;
      for (const side of [-1, 1]) {
        for (const z of [-1.5, 1.45]) {
          const flipper = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 5), pale);
          flipper.position.set(side * 2.45, -0.12, z);
          flipper.scale.set(2.1, 0.24, 0.72);
          flipper.rotation.y = side * (z < 0 ? 0.2 : -0.35);
          group.add(flipper);
        }
      }
      group.add(shell, head);
    } else {
      const isShark = kind === 'shark';
      const isDolphin = kind === 'dolphin';
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, isShark ? 14 : 11, 8), skin);
      body.scale.set(isShark ? 1.45 : isDolphin ? 1.2 : 0.66, isShark ? 0.82 : isDolphin ? 0.68 : 0.45, isShark ? 4.3 : isDolphin ? 3.6 : 1.55);
      const snout = new THREE.Mesh(new THREE.ConeGeometry(isShark ? 0.72 : 0.36, isShark ? 2.1 : 1.85, isShark ? 10 : 8), skin);
      snout.rotation.x = -Math.PI * 0.5;
      snout.position.z = isShark ? -4.55 : isDolphin ? -4 : -1.65;
      const dorsal = new THREE.Mesh(new THREE.ConeGeometry(isShark ? 0.72 : 0.32, isShark ? 2.35 : 0.9, 3), skin);
      dorsal.position.set(0, isShark ? 1.1 : 0.65, 0.3);
      dorsal.rotation.x = 0.08;
      tail.position.z = isShark ? 4.2 : isDolphin ? 3.5 : 1.5;
      for (const side of [-1, 1]) {
        const fluke = new THREE.Mesh(new THREE.ConeGeometry(isShark ? 0.72 : 0.38, isShark ? 2.5 : isDolphin ? 1.8 : 0.85, 3), skin);
        fluke.position.y = side * (isShark ? 0.72 : isDolphin ? 0.5 : 0.27);
        fluke.rotation.z = side * Math.PI * 0.5;
        tail.add(fluke);
      }
      if (isShark || isDolphin) {
        for (const side of [-1, 1]) {
          const fin = new THREE.Mesh(new THREE.ConeGeometry(0.36, isShark ? 2.7 : 1.75, 3), skin);
          fin.position.set(side * 1.05, -0.25, -0.25);
          fin.rotation.z = side * 1.22;
          group.add(fin);
        }
      }
      for (const side of [-1, 1]) {
        const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), eye);
        eyeball.position.set(side * (isShark ? 0.82 : isDolphin ? 0.66 : 0.35), 0.24, isShark ? -3.35 : isDolphin ? -2.7 : -1.1);
        group.add(eyeball);
      }
      group.add(body, snout, dorsal, tail);
    }
    group.userData.tail = tail;
    return group;
  }

  private updateUnderwaterEnvironment(dt: number, activeDistance: number): void {
    if (!this.underwaterSky) return;
    this.underwaterTime += Math.max(0, dt);
    this.underwaterSky.position.copy(this.camera.position);
    if (this.underwaterSkyMaterial) this.underwaterSkyMaterial.uniforms.uTime.value = this.underwaterTime;
    const bubbles = this.world.children.find((child) => child.userData.underwaterBubbles);
    if (bubbles) {
      bubbles.rotation.y = Math.sin(this.underwaterTime * 0.045) * 0.018;
      bubbles.position.y = Math.sin(this.underwaterTime * 0.16) * 1.8;
    }
    const localForward = new THREE.Vector3(0, 0, -1);
    const swimRoll = new THREE.Quaternion();
    for (const creature of this.underwaterCreatures) {
      const span = 2800;
      const unwrapped = creature.baseDistance + this.underwaterTime * creature.speed;
      const localDistance = ((unwrapped % span) + span) % span;
      const distance = Math.min(this.plan.length - 1, activeDistance + 70 + localDistance);
      const ahead = distance - activeDistance;
      creature.group.visible = ahead > -300 && ahead < 1650;
      if (!creature.group.visible) continue;
      const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
      const orbitAngle = creature.orbitAngle + Math.sin(this.underwaterTime * 0.1 + creature.phase) * 0.08;
      const radial = radialAt(frame, orbitAngle);
      const bob = Math.sin(this.underwaterTime * (creature.kind === 'jellyfish' ? 0.72 : 0.42) + creature.phase)
        * (creature.kind === 'whale' ? 2.2 : 1.25);
      creature.group.position.copy(frame.position)
        .addScaledVector(radial, creature.radiusOffset + bob);

      const pulse = Math.sin(this.underwaterTime * 2.1 + creature.phase);
      if (creature.kind === 'jellyfish') {
        creature.group.quaternion.identity();
        creature.group.rotation.y = this.underwaterTime * 0.08 + creature.phase;
        creature.group.scale.set(
          creature.scale * (1 - pulse * 0.045),
          creature.scale * (1 + pulse * 0.11),
          creature.scale * (1 - pulse * 0.045),
        );
      } else {
        const direction = frame.tangent.clone().multiplyScalar(creature.speed >= 0 ? 1 : -1).normalize();
        creature.group.quaternion.setFromUnitVectors(localForward, direction);
        swimRoll.setFromAxisAngle(localForward, Math.sin(this.underwaterTime * 0.32 + creature.phase) * 0.09);
        creature.group.quaternion.multiply(swimRoll);
        creature.group.scale.setScalar(creature.scale);
        const tail = creature.group.userData.tail as THREE.Group | null | undefined;
        if (tail) tail.rotation.y = Math.sin(this.underwaterTime * (creature.kind === 'whale' ? 1.15 : 3.2) + creature.phase) * 0.38;
      }
    }
  }

  private createStreakField(color: number, seed: number): void {
    if (this.streakLines) {
      this.removeAndDispose(this.streakLines);
      this.streakLines = null;
    }
    const random = mulberry32(seed ^ 0x51eed);
    const streakCount = this.graphicsSettings.quality === 'performance' ? 30 : this.graphicsSettings.quality === 'balanced' ? 50 : 72;
    this.streaks = Array.from({ length: streakCount }, () => ({
      angle: random() * TAU,
      radial: this.plan.radius - (0.7 + random() * 4.2),
      offset: 18 + random() * 220,
      length: 2 + random() * 9,
    }));
    this.streakGeometry = new THREE.BufferGeometry();
    this.streakGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.streaks.length * 6), 3));
    const lines = new THREE.LineSegments(
      this.streakGeometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.54, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    lines.frustumCulled = false;
    lines.userData.speedStreaks = true;
    this.streakLines = lines;
    this.dynamicLayer.add(lines);
  }

  private createRivals(): void {
    for (const rival of this.rivals) this.removeAndDispose(rival.mesh);
    this.rivals.length = 0;
    const requestedCount = this.config?.aiOpponents;
    const count = Number.isFinite(requestedCount)
      ? clamp(Math.trunc(requestedCount as number), 0, MAX_AI_RIVALS)
      : 3;
    if (!this.rivalAiModel) return;
    for (let index = 0; index < count; index += 1) {
      const colors = AI_RIVAL_COLORS[index];
      const generatedProfile = createRivalAIProfile(
        this.plan.seed,
        index,
        AI_RIVAL_SPEEDS[index],
        this.aiRivals[index]?.difficulty,
      );
      const profile: RivalAIProfile = {
        ...generatedProfile,
        id: this.aiRivals[index]?.id || generatedProfile.id,
        callSign: this.aiRivals[index]?.name || generatedProfile.callSign,
      };
      const craftParts = this.createCraft(colors[0], colors[1], 0.84);
      const craft = craftParts.group;
      const nameplate = this.createRacerNameplate(
        `${profile.callSign} // ${RIVAL_ARCHETYPE_LABELS[profile.archetype]}`,
        colors[0],
      );
      if (nameplate) craft.add(nameplate);
      const beacon = this.createRivalBeacon(colors[0]);
      const locator = this.createRivalLocator(colors[0]);
      craft.add(beacon, locator);
      const visual = this.prepareOpponentVisual(craft, 'ai', colors[0], beacon, locator, nameplate);
      craft.userData.rivalAI = { id: profile.id, callSign: profile.callSign, archetype: profile.archetype };
      this.dynamicLayer.add(craft);
      this.rivals.push({
        mesh: craft,
        engineGlow: craftParts.engineGlow,
        thrustTrails: craftParts.thrustTrails,
        visual,
        profile,
        ai: createRivalAIState(profile, {
          distance: AI_RIVAL_OFFSETS[index],
          angle: (index / Math.max(1, count)) * TAU,
        }, this.rivalAiModel.baseSpeed),
        lastOutput: null,
        color: colors[0],
        maxSpeed: this.rivalAiModel.baseSpeed,
        obstaclesEncountered: 0,
        obstacleCollisions: 0,
      });
    }
  }

  private pickRemoteRacerColorIndex(id: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    const start = (hash >>> 0) % REMOTE_RACER_COLORS.length;
    const used = new Set([...this.remoteRacers.values()].map((racer) => racer.colorIndex));
    for (let offset = 0; offset < REMOTE_RACER_COLORS.length; offset += 1) {
      const candidate = (start + offset) % REMOTE_RACER_COLORS.length;
      if (!used.has(candidate)) return candidate;
    }
    return start;
  }

  private createRemoteRacerMesh(id: string, name: string, colorIndex: number): {
    mesh: THREE.Group;
    visual: OpponentVisual;
  } {
    const colors = REMOTE_RACER_COLORS[colorIndex % REMOTE_RACER_COLORS.length];
    const craft = this.createCraft(colors[0], colors[1], 0.86).group;
    const nameplate = this.createRacerNameplate(name, colors[0]);
    if (nameplate) craft.add(nameplate);
    const beacon = this.createRivalBeacon(colors[0]);
    const locator = this.createRivalLocator(colors[0]);
    craft.add(beacon, locator);
    const visual = this.prepareOpponentVisual(craft, 'remote', colors[0], beacon, locator, nameplate);
    craft.userData.remoteRacer = { id, name, colorIndex };
    return { mesh: craft, visual };
  }

  private createRacerNameplate(name: string, color: number): THREE.Sprite | null {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const cssColor = `#${new THREE.Color(color).getHexString()}`;
    context.fillStyle = 'rgba(1, 7, 14, 0.82)';
    context.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.strokeStyle = cssColor;
    context.lineWidth = 4;
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.fillStyle = '#f3fbff';
    context.font = '700 34px Rajdhani, Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name.toUpperCase(), canvas.width / 2, canvas.height / 2 + 2, canvas.width - 38);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, 3, 0);
    sprite.scale.set(6.2, 1.16, 1);
    sprite.renderOrder = 8;
    sprite.userData.opponentVisibilityRole = 'nameplate';
    return sprite;
  }

  private createRivalBeacon(color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (context) {
      const center = canvas.width / 2;
      const radius = 92;
      const cssColor = `#${new THREE.Color(color).getHexString()}`;
      const backdrop = context.createRadialGradient(center, center, 10, center, center, 122);
      backdrop.addColorStop(0, 'rgba(0, 3, 10, 0.76)');
      backdrop.addColorStop(0.48, 'rgba(0, 3, 10, 0.62)');
      backdrop.addColorStop(0.76, 'rgba(0, 3, 10, 0.24)');
      backdrop.addColorStop(1, 'rgba(0, 3, 10, 0)');
      context.fillStyle = backdrop;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const drawReticle = (strokeStyle: string, lineWidth: number): void => {
        context.save();
        context.strokeStyle = strokeStyle;
        context.lineWidth = lineWidth;
        context.lineCap = 'square';
        for (let corner = 0; corner < 4; corner += 1) {
          const angle = Math.PI * 0.25 + corner * Math.PI * 0.5;
          context.beginPath();
          context.arc(center, center, radius, angle - 0.26, angle + 0.26);
          context.stroke();
        }
        for (let axis = 0; axis < 4; axis += 1) {
          const angle = axis * Math.PI * 0.5;
          const inner = radius - 13;
          const outer = radius + 13;
          context.beginPath();
          context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
          context.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
          context.stroke();
        }
        context.restore();
      };
      drawReticle('rgba(0, 3, 8, 0.94)', 18);
      drawReticle('rgba(244, 252, 255, 0.96)', 11);
      context.shadowColor = cssColor;
      context.shadowBlur = 18;
      drawReticle(cssColor, 6);
      context.shadowBlur = 0;
      context.fillStyle = 'rgba(0, 3, 8, 0.92)';
      context.beginPath();
      context.arc(center, center, 9, 0, TAU);
      context.fill();
      context.fillStyle = cssColor;
      context.beginPath();
      context.arc(center, center, 4, 0, TAU);
      context.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const beacon = new THREE.Sprite(material);
    beacon.position.set(0, 0.1, 0.18);
    beacon.scale.set(7.2, 7.2, 1);
    beacon.renderOrder = 7;
    beacon.userData.opponentVisibilityRole = 'beacon';
    return beacon;
  }

  private createRivalLocator(color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (context) {
      const center = canvas.width / 2;
      const cssColor = `#${new THREE.Color(color).getHexString()}`;
      const drawCorners = (strokeStyle: string, lineWidth: number, inset: number): void => {
        context.save();
        context.strokeStyle = strokeStyle;
        context.lineWidth = lineWidth;
        context.lineCap = 'square';
        const inner = 56 + inset;
        const outer = 103 - inset;
        const arm = 24;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            context.beginPath();
            context.moveTo(center + sx * outer, center + sy * (outer - arm));
            context.lineTo(center + sx * outer, center + sy * outer);
            context.lineTo(center + sx * (outer - arm), center + sy * outer);
            context.stroke();
            context.beginPath();
            context.moveTo(center + sx * inner, center + sy * (inner - 12));
            context.lineTo(center + sx * inner, center + sy * inner);
            context.lineTo(center + sx * (inner - 12), center + sy * inner);
            context.stroke();
          }
        }
        context.restore();
      };
      drawCorners('rgba(0, 2, 8, 0.98)', 18, 0);
      drawCorners('rgba(245, 252, 255, 0.98)', 10, 1);
      context.shadowColor = cssColor;
      context.shadowBlur = 16;
      drawCorners(cssColor, 5, 2);
      context.shadowBlur = 0;

      context.fillStyle = 'rgba(0, 2, 8, 0.98)';
      context.beginPath();
      context.moveTo(center, 8);
      context.lineTo(center - 18, 38);
      context.lineTo(center + 18, 38);
      context.closePath();
      context.fill();
      context.fillStyle = '#f5fcff';
      context.beginPath();
      context.moveTo(center, 15);
      context.lineTo(center - 10, 33);
      context.lineTo(center + 10, 33);
      context.closePath();
      context.fill();
      context.fillStyle = cssColor;
      context.fillRect(center - 3, 19, 6, 10);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const locator = new THREE.Sprite(material);
    locator.position.set(0, 0.1, -0.2);
    locator.scale.set(8.6, 8.6, 1);
    locator.renderOrder = 100;
    locator.userData.opponentVisibilityRole = 'locator';
    return locator;
  }

  private prepareOpponentVisual(
    craft: THREE.Group,
    kind: OpponentKind,
    color: number,
    beacon: THREE.Sprite,
    locator: THREE.Sprite,
    nameplate: THREE.Sprite | null,
  ): OpponentVisual {
    const materials: OpponentVisualMaterial[] = [];
    const seen = new Set<THREE.Material>();
    const outlineMeshes: THREE.Mesh[] = [];
    craft.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const candidate of objectMaterials) {
        if (!(candidate instanceof THREE.MeshBasicMaterial) || seen.has(candidate)) continue;
        seen.add(candidate);
        const baseOpacity = candidate.opacity;
        materials.push({
          material: candidate,
          baseColor: candidate.color.clone(),
          baseOpacity,
          surface: baseOpacity >= 0.95,
          outline: candidate.side === THREE.BackSide,
        });
        // Keep hull and outline meshes in the opaque pass. Sending every craft
        // surface through transparent sorting is expensive on mobile and makes
        // the craft lose its own depth cues; only glow layers need blending.
        candidate.transparent = baseOpacity < 0.95;
        candidate.depthWrite = baseOpacity >= 0.95;
        candidate.toneMapped = false;
        candidate.needsUpdate = true;
      }
      if (objectMaterials.some((candidate) => candidate instanceof THREE.MeshBasicMaterial
        && candidate.side === THREE.BackSide
        && candidate.opacity >= 0.95)) {
        outlineMeshes.push(object);
      }
    });
    // A dark outer keyline keeps the luminous inner outline readable against
    // both white bloom and saturated tunnel sections without making hulls
    // transparent or adding a full-screen post-processing pass.
    const contrastOutlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x00030a,
      side: THREE.BackSide,
      toneMapped: false,
    });
    for (const source of outlineMeshes) {
      const outline = new THREE.Mesh(source.geometry, contrastOutlineMaterial);
      outline.position.copy(source.position);
      outline.quaternion.copy(source.quaternion);
      outline.scale.copy(source.scale).multiplyScalar(1.12);
      outline.renderOrder = Math.max(0, source.renderOrder - 1);
      outline.userData.opponentVisibilityRole = 'contrast-outline';
      source.parent?.add(outline);
    }
    const accent = new THREE.Color(color);
    const visual: OpponentVisual = {
      kind,
      accent,
      highlight: accent.clone().lerp(new THREE.Color(0xffffff), 0.58),
      materials,
      craft,
      craftBaseScale: craft.scale.clone(),
      beacon,
      locator,
      nameplate,
      nameplateBaseScale: nameplate?.scale.clone() ?? null,
    };
    this.applyOpponentVisibility(visual);
    return visual;
  }

  private applyOpponentVisibility(visual: OpponentVisual): void {
    const visibility = clamp(this.graphicsSettings.rivalVisibility, 0, 1);
    for (const entry of visual.materials) {
      if (entry.surface) {
        const tint = entry.outline
          ? 0.72 + visibility * 0.28
          : (visual.kind === 'ai' ? 0.18 + visibility * 0.56 : 0.16 + visibility * 0.52);
        entry.material.color.copy(entry.baseColor).lerp(
          entry.outline ? visual.highlight : visual.accent,
          tint,
        );
        entry.material.opacity = 1;
      } else {
        entry.material.color.copy(entry.baseColor).lerp(visual.highlight, 0.08 + visibility * 0.18);
        entry.material.opacity = Math.min(1, entry.baseOpacity * (1 + visibility * 1.75));
      }
    }

    const beaconSize = 7.4 + visibility * 2.6;
    visual.beacon.scale.set(beaconSize, beaconSize, 1);
    visual.beacon.material.opacity = 0.34 + visibility * 0.62;
    const locatorSize = 8.2 + visibility * 2.8;
    visual.locator.scale.set(locatorSize, locatorSize, 1);
    visual.locator.material.opacity = 0.42 + visibility * 0.58;
    if (visual.nameplate && visual.nameplateBaseScale) {
      const labelScale = 0.94 + visibility * 0.24;
      visual.nameplate.scale.copy(visual.nameplateBaseScale).multiplyScalar(labelScale);
      visual.nameplate.material.opacity = 0.74 + visibility * 0.26;
    }
  }

  private pulseOpponentBeacon(
    visual: OpponentVisual,
    pulse: number,
    ahead = 0,
    cameraDistance = Math.abs(ahead) + 10,
  ): void {
    const visibility = clamp(this.graphicsSettings.rivalVisibility, 0, 1);
    // Sprites are world-sized, so compensate for the chase camera distance to
    // keep their projected size readable instead of filling the screen during
    // contact or collapsing into a few pixels farther down the tunnel.
    const safeCameraDistance = Number.isFinite(cameraDistance) ? Math.max(0, cameraDistance) : Math.abs(ahead) + 10;
    const screenAssist = clamp(safeCameraDistance / 52, 0.24, 2.05);
    const pulseAmount = clamp(pulse, 0, 1);
    const beaconSize = (7.4 + visibility * 2.6) * screenAssist * (1 + pulseAmount * 0.1);
    const locatorSize = (8.2 + visibility * 2.8) * screenAssist * (1 + pulseAmount * 0.14);
    visual.beacon.scale.set(beaconSize, beaconSize, 1);
    visual.locator.scale.set(locatorSize, locatorSize, 1);
    // Visibility is already culled by the scene/camera. A longitudinal cutoff
    // is wrong on curved track sections where a rival behind the player can
    // still be plainly visible around the side of the tunnel.
    visual.beacon.material.opacity = 0.34 + visibility * 0.62;
    visual.locator.material.opacity = 0.42 + visibility * 0.58;
    const craftAssist = 1 + clamp((Math.abs(ahead) - 28) / 180, 0, 1) * (0.12 + visibility * 0.24);
    visual.craft.scale.copy(visual.craftBaseScale).multiplyScalar(craftAssist);
    if (visual.nameplate && visual.nameplateBaseScale) {
      const labelScale = (0.94 + visibility * 0.24) * screenAssist;
      visual.nameplate.scale.copy(visual.nameplateBaseScale).multiplyScalar(labelScale);
      visual.nameplate.material.opacity = 0.74 + visibility * 0.26;
    }
  }

  private createCraft(primary: number, secondary: number, scale: number): {
    group: THREE.Group;
    engineGlow: THREE.Group;
    thrustTrails: THREE.Mesh[];
    impactGlow: THREE.Group;
    impactMaterial: THREE.MeshBasicMaterial;
  } {
    const group = new THREE.Group();
    group.scale.setScalar(scale);
    const shellMaterial = new THREE.MeshBasicMaterial({ color: 0x010309, toneMapped: false });
    const trimMaterial = new THREE.MeshBasicMaterial({ color: 0x17445c, toneMapped: false });
    const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x010208, side: THREE.BackSide });
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: primary,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const bodyGeometry = new THREE.ConeGeometry(0.68, 4.15, 7);
    bodyGeometry.rotateX(Math.PI / 2);
    const body = new THREE.Mesh(bodyGeometry, shellMaterial);
    body.position.z = 0.3;
    const bodyOutline = new THREE.Mesh(bodyGeometry, outlineMaterial);
    bodyOutline.position.copy(body.position);
    bodyOutline.scale.setScalar(1.12);

    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.54, 14, 8), trimMaterial);
    canopy.scale.set(0.78, 0.48, 1.3);
    canopy.position.set(0, -0.07, -0.08);

    const rearHull = new THREE.Mesh(new THREE.SphereGeometry(0.96, 10, 7), shellMaterial);
    rearHull.scale.set(1.24, 0.7, 1.05);
    rearHull.position.set(0, 0, -0.74);

    const wingGeometry = new THREE.BoxGeometry(3.85, 0.28, 0.82);
    const wings = new THREE.Mesh(wingGeometry, shellMaterial);
    wings.position.z = -0.68;
    const wingOutline = new THREE.Mesh(wingGeometry, outlineMaterial);
    wingOutline.position.copy(wings.position);
    wingOutline.scale.set(1.06, 1.24, 1.12);
    const wingEdgeMaterial = glowMaterial.clone();
    wingEdgeMaterial.opacity = 0.16;
    const wingEdge = new THREE.Mesh(new THREE.BoxGeometry(4.12, 0.045, 0.14), wingEdgeMaterial);
    wingEdge.position.set(0, -0.095, -0.96);

    const sternShape = new THREE.Shape();
    sternShape.moveTo(-2.18, -0.06);
    sternShape.lineTo(-1.55, 0.54);
    sternShape.lineTo(-0.72, 0.42);
    sternShape.lineTo(0, 0.88);
    sternShape.lineTo(0.72, 0.42);
    sternShape.lineTo(1.55, 0.54);
    sternShape.lineTo(2.18, -0.06);
    sternShape.lineTo(1.15, -0.58);
    sternShape.lineTo(0.5, -0.42);
    sternShape.lineTo(0, -0.78);
    sternShape.lineTo(-0.5, -0.42);
    sternShape.lineTo(-1.15, -0.58);
    sternShape.closePath();
    const sternPlate = new THREE.Mesh(
      new THREE.ShapeGeometry(sternShape),
      new THREE.MeshBasicMaterial({ color: 0x01030a, side: THREE.DoubleSide, toneMapped: false }),
    );
    sternPlate.position.z = -2.02;
    sternPlate.userData.chaseLayer = 30;

    const makeSternFacet = (points: Array<[number, number]>, color: number): THREE.Mesh => {
      const shape = new THREE.Shape();
      shape.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) shape.lineTo(points[index][0], points[index][1]);
      shape.closePath();
      const facet = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false }),
      );
      facet.position.z = -2.035;
      facet.userData.chaseLayer = 31;
      return facet;
    };
    const leftFacet = makeSternFacet([
      [-2.02, -0.05], [-1.53, 0.44], [-0.76, 0.34], [-0.18, 0.02], [-0.58, -0.31], [-1.28, -0.47],
    ], 0x16102d);
    const rightFacet = makeSternFacet([
      [2.02, -0.05], [1.53, 0.44], [0.76, 0.34], [0.18, 0.02], [0.58, -0.31], [1.28, -0.47],
    ], 0x072431);

    const engineGlow = new THREE.Group();
    engineGlow.position.z = -1.9;
    const thrustTrails: THREE.Mesh[] = [];
    const engineCasingGeometry = new THREE.CylinderGeometry(0.34, 0.42, 0.74, 10);
    engineCasingGeometry.rotateX(Math.PI / 2);
    for (const x of [-0.72, 0.72]) {
      const casing = new THREE.Mesh(engineCasingGeometry, shellMaterial);
      casing.position.set(x, 0, -1.51);
      group.add(casing);

      const engineRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.33, 0.075, 6, 18),
        new THREE.MeshBasicMaterial({
          color: x < 0 ? primary : secondary,
          transparent: true,
          opacity: 0.42,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      engineRing.position.x = x;
      engineGlow.add(engineRing);

      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.24, 18), glowMaterial.clone());
      glow.position.x = x;
      engineGlow.add(glow);

      const trailGeometry = new THREE.CylinderGeometry(0.2, 0.035, 3.25, 8, 1, true);
      trailGeometry.rotateX(Math.PI / 2);
      const trail = new THREE.Mesh(
        trailGeometry,
        new THREE.MeshBasicMaterial({
          color: x < 0 ? primary : secondary,
          transparent: true,
          opacity: 0.14,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      trail.position.set(x, 0, -1.62);
      trail.userData.baseOpacity = 0.14;
      thrustTrails.push(trail);
      group.add(trail);
    }
    const reactorMaterial = glowMaterial.clone();
    reactorMaterial.color.setHex(secondary);
    reactorMaterial.opacity = 0.28;
    const reactor = new THREE.Mesh(new THREE.CircleGeometry(0.14, 14), reactorMaterial);
    engineGlow.add(reactor);

    const impactMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6a38,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const impactGlow = new THREE.Group();
    impactGlow.visible = false;
    const impactBody = new THREE.Mesh(bodyGeometry, impactMaterial);
    impactBody.position.copy(body.position);
    impactBody.scale.setScalar(1.06);
    const impactRear = new THREE.Mesh(rearHull.geometry, impactMaterial);
    impactRear.position.copy(rearHull.position);
    impactRear.scale.copy(rearHull.scale).multiplyScalar(1.055);
    const impactWings = new THREE.Mesh(wingGeometry, impactMaterial);
    impactWings.position.copy(wings.position);
    impactWings.scale.setScalar(1.055);
    const impactStern = new THREE.Mesh(sternPlate.geometry, impactMaterial);
    impactStern.position.z = sternPlate.position.z + 0.01;
    for (const mesh of [impactBody, impactRear, impactWings, impactStern]) mesh.userData.chaseLayer = 39;
    impactGlow.add(impactBody, impactRear, impactWings, impactStern);

    group.add(
      bodyOutline,
      wingOutline,
      body,
      rearHull,
      canopy,
      wings,
      sternPlate,
      leftFacet,
      rightFacet,
      wingEdge,
      engineGlow,
      impactGlow,
    );
    return { group, engineGlow, thrustTrails, impactGlow, impactMaterial };
  }

  private createChaseBoostEffect(): ChaseBoostEffect {
    const group = new THREE.Group();
    group.visible = false;
    group.name = 'player-boost-warp';

    const shellMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uPrimary: { value: new THREE.Color(0x56f7ff) },
        uSecondary: { value: new THREE.Color(0xa66cff) },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vViewNormal;
        void main() {
          vUv = uv;
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vViewNormal;
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uPrimary;
        uniform vec3 uSecondary;

        void main() {
          float bandPhase = (vUv.y * 10.0 - uTime * 5.4) * 6.2831853;
          float bands = pow(max(0.0, sin(bandPhase)), 18.0);
          float rim = pow(1.0 - abs(vViewNormal.z), 1.7);
          float taperFade = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
          float shimmer = 0.72 + 0.28 * sin(uTime * 8.0 + vUv.x * 12.0);
          vec3 color = mix(uPrimary, uSecondary, 0.5 + 0.5 * sin(vUv.x * 9.0 + uTime * 1.8));
          float alpha = uIntensity * taperFade * shimmer * (0.018 + bands * 0.12 + rim * 0.045);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const shellGeometry = new THREE.ConeGeometry(2.65, 9.4, 32, 1, true);
    shellGeometry.rotateX(Math.PI / 2);
    const shell = new THREE.Mesh(shellGeometry, shellMaterial);
    shell.position.z = 3.15;
    shell.renderOrder = 26;
    shell.frustumCulled = false;
    group.add(shell);

    const random = mulberry32(0xb0057eed);
    const streakCount = 64;
    const streakSpecs: BoostStreakSpec[] = [];
    const streakPositions = new Float32Array(streakCount * 6);
    const streakColors = new Float32Array(streakCount * 6);
    const cyan = new THREE.Color(0x77fbff);
    const violet = new THREE.Color(0xb277ff);
    const white = new THREE.Color(0xeaffff);
    for (let index = 0; index < streakCount; index += 1) {
      streakSpecs.push({
        angle: random() * TAU,
        radius: 2.5 + random() * 4.8,
        offset: random(),
        speed: 0.72 + random() * 0.76,
        length: 1.8 + random() * 4.6,
      });
      const base = index % 3 === 0 ? violet : cyan;
      streakColors.set([
        base.r * 0.36,
        base.g * 0.36,
        base.b * 0.36,
        white.r,
        white.g,
        white.b,
      ], index * 6);
    }
    const streakGeometry = new THREE.BufferGeometry();
    streakGeometry.setAttribute('position', new THREE.BufferAttribute(streakPositions, 3));
    streakGeometry.setAttribute('color', new THREE.BufferAttribute(streakColors, 3));
    const streakMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const streaks = new THREE.LineSegments(streakGeometry, streakMaterial);
    streaks.renderOrder = 27;
    streaks.frustumCulled = false;
    group.add(streaks);

    const rings: THREE.Mesh[] = [];
    const ringMaterials: THREE.MeshBasicMaterial[] = [];
    for (let index = 0; index < 5; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: index % 2 === 0 ? 0x75fbff : 0xb77aff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.08, 40), material);
      ring.renderOrder = 28;
      ring.frustumCulled = false;
      rings.push(ring);
      ringMaterials.push(material);
      group.add(ring);
    }

    const kickMaterial = new THREE.MeshBasicMaterial({
      color: 0x9ffcff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const kickRing = new THREE.Mesh(new THREE.RingGeometry(0.84, 0.96, 48), kickMaterial);
    kickRing.position.z = 2.35;
    kickRing.renderOrder = 29;
    kickRing.frustumCulled = false;
    group.add(kickRing);

    return {
      group,
      shell,
      shellMaterial,
      streaks,
      streakMaterial,
      streakSpecs,
      rings,
      ringMaterials,
      kickRing,
      kickMaterial,
    };
  }

  private resetBoostVisuals(): void {
    this.boostVisualTarget = 0;
    this.boostVisualIntensity = 0;
    this.boostVisualKick = 0;
    this.boostVisualClock = 0;
    this.chaseBoostEffect.group.visible = false;
    this.chaseBoostEffect.shellMaterial.uniforms.uIntensity.value = 0;
    this.chaseBoostEffect.streakMaterial.opacity = 0;
    this.chaseBoostEffect.kickMaterial.opacity = 0;
    this.chaseBoostEffect.kickRing.visible = false;
    for (let index = 0; index < this.chaseBoostEffect.rings.length; index += 1) {
      this.chaseBoostEffect.rings[index].visible = false;
      this.chaseBoostEffect.ringMaterials[index].opacity = 0;
    }
    for (const trail of this.vehicleThrustTrails) {
      (trail.material as THREE.MeshBasicMaterial).opacity = Number(trail.userData.baseOpacity) || 0.14;
      trail.scale.set(1, 1, 1);
    }
    this.chaseCamera.fov = 76;
    this.chaseCamera.position.set(0, 0, 0);
    this.chaseCamera.rotation.set(0, 0, 0);
    this.chaseCamera.updateProjectionMatrix();
  }

  private updateChaseBoostVisuals(dt: number): void {
    const target = this.state === 'playing' ? this.boostVisualTarget : 0;
    this.boostVisualIntensity = stepBoostVisualIntensity(this.boostVisualIntensity, target, dt);
    this.boostVisualKick *= Math.exp(-dt * 6.4);
    if (target <= 0 && this.boostVisualIntensity < 0.001) this.boostVisualIntensity = 0;
    if (this.boostVisualKick < 0.001) this.boostVisualKick = 0;

    const normalized = clamp(this.boostVisualIntensity / 1.2, 0, 1);
    const kick = clamp(this.boostVisualKick, 0, 1);
    const visible = normalized > 0.001 || kick > 0.001;
    const effect = this.chaseBoostEffect;
    effect.group.visible = visible;
    if (!visible) {
      for (const trail of this.vehicleThrustTrails) {
        (trail.material as THREE.MeshBasicMaterial).opacity = Number(trail.userData.baseOpacity) || 0.14;
        trail.scale.set(1, 1, 1);
      }
      this.chaseCamera.fov = damp(this.chaseCamera.fov, 76, 10, dt);
      this.chaseCamera.updateProjectionMatrix();
      return;
    }

    this.boostVisualClock += dt * (1.15 + normalized * 2.45);
    const reduced = this.graphicsSettings.reducedFlashes;
    effect.shellMaterial.uniforms.uTime.value = this.boostVisualClock;
    effect.shellMaterial.uniforms.uIntensity.value = normalized * (reduced ? 0.48 : 1);
    effect.shell.scale.setScalar(1 + Math.sin(this.boostVisualClock * 8.5) * 0.012 * normalized);

    const activeStreakCount = this.graphicsSettings.quality === 'performance'
      ? 20
      : this.graphicsSettings.quality === 'balanced'
        ? 42
        : 64;
    effect.streaks.geometry.setDrawRange(0, activeStreakCount * 2);
    const streakAttribute = effect.streaks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const streakPositions = streakAttribute.array as Float32Array;
    for (let index = 0; index < activeStreakCount; index += 1) {
      const spec = effect.streakSpecs[index];
      const progress = (this.boostVisualClock * spec.speed + spec.offset) % 1;
      const spiral = spec.angle + Math.sin(this.boostVisualClock * 0.6 + index) * 0.035;
      const radialScale = 0.72 + progress * 0.34;
      const x = Math.cos(spiral) * spec.radius * radialScale;
      const y = Math.sin(spiral) * spec.radius * radialScale;
      const headZ = 14 - progress * 19;
      const trailLength = spec.length * (0.58 + normalized * 1.92 + kick * 0.45);
      const offset = index * 6;
      streakPositions[offset] = x;
      streakPositions[offset + 1] = y;
      streakPositions[offset + 2] = headZ;
      streakPositions[offset + 3] = x;
      streakPositions[offset + 4] = y;
      streakPositions[offset + 5] = headZ + trailLength;
    }
    streakAttribute.needsUpdate = true;
    effect.streakMaterial.opacity = normalized * (reduced ? 0.27 : 0.58);

    const activeRingCount = this.graphicsSettings.quality === 'performance'
      ? 2
      : this.graphicsSettings.quality === 'balanced'
        ? 4
        : 5;
    for (let index = 0; index < effect.rings.length; index += 1) {
      const ring = effect.rings[index];
      const material = effect.ringMaterials[index];
      ring.visible = index < activeRingCount;
      if (!ring.visible) {
        material.opacity = 0;
        continue;
      }
      const progress = (this.boostVisualClock * 0.72 + index / activeRingCount) % 1;
      const fade = Math.sin(progress * Math.PI) ** 2;
      ring.position.z = 1.65 + progress * 11.4;
      ring.scale.setScalar(0.76 + progress * 2.5 + kick * 0.12);
      material.opacity = normalized * fade * (reduced ? 0.1 : 0.24)
        * (0.86 + this.lastBands.pulse * 0.24);
    }

    const kickProgress = 1 - kick;
    effect.kickRing.visible = kick > 0.001;
    effect.kickRing.scale.setScalar(0.88 + kickProgress * 2.05 + normalized * 0.14);
    effect.kickMaterial.opacity = kick * (reduced ? 0.1 : 0.34);

    for (const trail of this.vehicleThrustTrails) {
      (trail.material as THREE.MeshBasicMaterial).opacity = 0.14
        + normalized * (reduced ? 0.17 : 0.4);
      trail.scale.set(
        1 + normalized * 0.16,
        1 + normalized * 0.16,
        1 + normalized * 1.45 + kick * 0.18,
      );
    }

    const chaseFov = 76 + normalized * 4.8 + kick * (reduced ? 0.6 : 2.1);
    this.chaseCamera.fov = damp(this.chaseCamera.fov, chaseFov, 10, dt);
    this.chaseCamera.updateProjectionMatrix();
  }

  private resetRun(): void {
    if (!this.config) return;
    for (const event of this.plan.events) {
      event.resolved = false;
      event.destroyed = false;
      event.health = event.kind === 'bastion' ? Math.max(3, event.health) : 1;
      const visual = this.eventVisuals.get(event.id);
      if (visual) {
        visual.visible = true;
        visual.scale.setScalar(1);
      }
    }
    for (const bullet of this.bullets) this.removeAndDispose(bullet.mesh);
    this.bullets.length = 0;
    for (const burst of this.bursts) this.removeAndDispose(burst.points);
    this.bursts.length = 0;
    for (const effect of this.chaseImpactEffects) {
      this.removeAndDispose(effect.sparks);
      this.removeAndDispose(effect.wave);
    }
    this.chaseImpactEffects.length = 0;
    this.deathFx.reset();
    this.deathSequence = null;
    this.pendingResult = null;
    this.resultDelay = 0;
    const baseSpeed = this.plan.length / this.plan.runDuration;
    this.distance = 0;
    this.speed = baseSpeed * 0.72;
    this.maxRunSpeed = this.speed;
    this.angle = 0;
    this.angularVelocity = 0;
    this.maxShield = 3 + Math.floor(this.config.garage.shield / 2);
    this.shield = this.maxShield;
    this.heat = 0;
    this.flux = 100;
    this.sync = 0;
    this.score = 0;
    this.abilityCooldown = 0;
    this.weaponCooldown = 0;
    this.phaseTimer = 0;
    this.overdriveTimer = 0;
    this.temporalFocusTimer = 0;
    this.resetBoostVisuals();
    this.overheatTimer = 0;
    this.invulnerableTimer = 0;
    this.impactFlashTimer = 0;
    this.impactSlide = 0;
    this.vehicleImpactGlow.visible = false;
    this.vehicleImpactMaterial.opacity = 0;
    this.perfects = 0;
    this.nearMisses = 0;
    this.kills = 0;
    this.shots = 0;
    this.hits = 0;
    this.obstaclePerfects = 0;
    this.obstaclesEncountered = 0;
    this.obstacleCollisions = 0;
    this.section = 1;
    this.upgradeIndex = 0;
    this.upgradeRoll = 0;
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.lastCollisionCursor = 0;
    this.lastCollisionAudioTime = 0;
    this.fixedAccumulator = 0;
    this.simulationTick = 0;
    this.rivalAiTick = 0;
    this.rivalAiCatchupBudget = ONLINE_AI_CATCHUP_STEPS_PER_FRAME;
    this.localFinishTime = null;
    this.localFinishAiTick = null;
    this.awaitingTerminalAck = false;
    this.terminalAckTimeout = 0;
    this.rivalDraftCharge = 0;
    this.rivalDraftCooldown = 0;
    this.rivalCalloutCooldown = 0;
    this.rivalContactCooldown = 0;
    this.runUpgrades.clear();
    this.emitUpgradeState();
    for (let index = 0; index < this.rivals.length; index += 1) {
      const rival = this.rivals[index];
      rival.ai = createRivalAIState(rival.profile, {
        distance: AI_RIVAL_OFFSETS[index],
        angle: (index / Math.max(1, this.rivals.length)) * TAU,
      }, baseSpeed);
      rival.lastOutput = null;
      rival.maxSpeed = baseSpeed;
      rival.obstaclesEncountered = 0;
      rival.obstacleCollisions = 0;
    }
    for (const racer of this.remoteRacers.values()) {
      racer.progress = 0;
      racer.targetProgress = 0;
      racer.angle = racer.targetAngle;
      racer.speed = 0;
      racer.destroyed = false;
      racer.finished = false;
      racer.dnf = false;
      racer.terminalAt = null;
      racer.score = 0;
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    const frameDt = clamp((now - this.lastFrameTime) / 1000, 0, 0.05);
    this.lastFrameTime = now;
    const dt = this.visibilityPaused ? 0 : frameDt;
    this.lastBands = this.audio.update(dt);

    if (this.state === 'countdown') {
      const previous = Math.ceil(this.countdown);
      this.countdown -= dt;
      const current = Math.ceil(this.countdown);
      if (current !== previous && current > 0) this.hooks.onCountdown(String(current));
      if (this.countdown <= 0) {
        this.state = 'playing';
        void this.audio.resume();
        this.hooks.onCountdown('PULSE!');
        window.setTimeout(() => this.hooks.onCountdown(null), 650);
      }
    }

    if (this.state === 'playing') {
      this.rivalAiCatchupBudget = ONLINE_AI_CATCHUP_STEPS_PER_FRAME;
      this.fixedAccumulator = Math.min(this.fixedAccumulator + dt, FIXED_STEP * 8);
      while (this.fixedAccumulator >= FIXED_STEP && this.state === 'playing') {
        this.fixedAccumulator -= FIXED_STEP;
        this.stepSimulation(FIXED_STEP);
      }
    } else if (
      this.pendingResult
      && (this.state === 'finished' || this.state === 'dying')
      && dt > 0
    ) {
      if (this.onlineRun) {
        this.rivalAiCatchupBudget = ONLINE_AI_CATCHUP_STEPS_PER_FRAME;
        this.updateRivals(
          FIXED_STEP,
          this.distance,
          this.rivalAiTick * FIXED_STEP,
          false,
          this.rivalReportMaxTick(),
        );
      } else {
        this.catchUpSoloRivalsForReport();
      }
    } else if (
      this.state === 'menu'
      || (this.state === 'finished' && this.impactFlashTimer <= 0 && this.chaseImpactEffects.length === 0)
    ) {
      this.demoDistance = (this.demoDistance + dt * 74) % Math.max(1, this.plan.length - 100);
      this.angle = wrapAngle(this.angle + dt * 0.12);
    }

    let resultReady = false;
    if (this.awaitingTerminalAck) {
      this.terminalAckTimeout = Math.max(0, this.terminalAckTimeout - dt);
    }
    if (this.state === 'dying' && this.deathSequence) {
      const deathFrame = stepDeathSequence(this.deathSequence, dt);
      this.deathSequence = deathFrame.state;
      resultReady = deathFrame.resultReady;
    } else if (this.state === 'finished' && this.pendingResult) {
      this.resultDelay = Math.max(0, this.resultDelay - dt);
      resultReady = this.resultDelay <= 0;
    }
    if (resultReady && this.awaitingTerminalAck && this.terminalAckTimeout > 0) resultReady = false;
    if (resultReady && !this.rivalsReadyForResult()) resultReady = false;

    this.updateVisuals(dt);
    this.uiAccumulator += dt;
    if (this.uiAccumulator > 1 / 30) {
      this.uiAccumulator = 0;
      if (this.state === 'playing' || this.state === 'countdown' || this.state === 'dying') this.hooks.onHud(this.getStats());
    }
    this.composer.render(dt);
    if (this.vehicle.visible || this.chaseImpactEffects.length > 0 || this.deathFx.active) {
      const autoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.chaseScene, this.chaseCamera);
      this.renderer.autoClear = autoClear;
    }
    if (resultReady) this.deliverPendingResult();
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden && (this.state === 'countdown' || this.state === 'playing' || this.state === 'dying')) {
      this.releaseInputs();
      this.visibilityPaused = true;
      this.audio.pause();
      return;
    }
    if (!document.hidden && this.visibilityPaused && (this.state === 'countdown' || this.state === 'playing' || this.state === 'dying')) {
      this.visibilityPaused = false;
      this.lastFrameTime = performance.now();
      void this.audio.resume();
    }
  };

  private stepSimulation(dt: number): void {
    if (!this.config) return;
    this.simulationTick += 1;
    const baseSpeed = this.plan.length / this.plan.runDuration;
    const theme = TRACKS[this.config.track];
    const left = this.isActionPressed('left') || this.mobileInput.get('left');
    const right = this.isActionPressed('right') || this.mobileInput.get('right');
    const cooling = this.isActionPressed('cool') || this.mobileInput.get('cool');
    const boostHeld = this.isActionPressed('boost') || this.mobileInput.get('boost');
    const steering = ((left ? 1 : 0) - (right ? 1 : 0)) as SteeringInput;
    const temporalHandling = this.temporalFocusTimer > 0 ? TEMPORAL_HANDLING_MULTIPLIER : 1;
    const steeringState = stepWallRideSteering(
      { angle: this.angle, angularVelocity: this.angularVelocity },
      steering,
      theme.handling * temporalHandling,
      this.config.garage.engine,
      dt,
    );
    this.angle = steeringState.angle;
    this.angularVelocity = steeringState.angularVelocity;

    this.abilityCooldown = Math.max(0, this.abilityCooldown - dt);
    this.weaponCooldown = Math.max(0, this.weaponCooldown - dt);
    if (this.mobileInput.get('fire')) this.fire();
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);
    this.temporalFocusTimer = Math.max(0, this.temporalFocusTimer - dt);
    this.overheatTimer = Math.max(0, this.overheatTimer - dt);
    this.invulnerableTimer = Math.max(0, this.invulnerableTimer - dt);

    const redlineMultiplier = this.runUpgrades.has('redline-engine') ? 1.16 : 1;
    const engineMultiplier = 1 + this.config.garage.engine * 0.065;
    const maxSpeed = baseSpeed * 1.43 * engineMultiplier * redlineMultiplier;
    const cruisingSpeed = baseSpeed * (cooling ? 0.68 : 1);
    const boosting = boostHeld && this.flux > 0 && this.overheatTimer <= 0;
    const overdrive = this.overdriveTimer > 0;
    const transportTime = this.audio.getTransportTime();
    const musicDistance = clamp(transportTime / this.plan.runDuration, 0, 1) * this.plan.length;
    const phaseError = musicDistance - this.distance;
    const phaseAssist = clamp(phaseError * 0.65, -baseSpeed * 0.26, baseSpeed * 0.26);
    const rawTargetSpeed = overdrive ? maxSpeed * 1.08 : boosting ? maxSpeed : cruisingSpeed;
    const targetSpeed = clamp(rawTargetSpeed + phaseAssist, baseSpeed * 0.5, maxSpeed * 1.12);
    const acceleration = targetSpeed > this.speed ? 1.5 + this.config.garage.engine * 0.16 : 3.8;
    this.speed = damp(this.speed, targetSpeed, acceleration, dt);

    const coolingMultiplier = (1 + this.config.garage.cooling * 0.12) * (this.runUpgrades.has('cryo-loop') ? 1.18 : 1);
    if (boosting && !overdrive) {
      this.flux = Math.max(0, this.flux - 18 * dt);
      const redlineHeat = this.runUpgrades.has('redline-engine') ? 1.28 : 1;
      this.heat = clamp(this.heat + 15.5 * redlineHeat * dt, 0, 100);
    } else {
      this.flux = Math.min(100, this.flux + (overdrive ? 1 : 3.2) * dt);
      this.heat = clamp(this.heat - (cooling ? 29 : 8.4) * coolingMultiplier * dt, 0, 100);
    }
    if (overdrive) this.heat = Math.max(0, this.heat - 9 * dt);
    if (this.heat >= 99.8 && this.overheatTimer <= 0) {
      this.overheatTimer = 2.3;
      this.heat = 78;
      this.speed *= 0.62;
      this.sync = 0;
      this.hooks.onToast('FORCED VENT', t('game.overheat'), 'red');
    }

    const nextBoostVisualTarget = resolveBoostVisualTarget(
      Boolean(boosting && this.flux > 0 && this.overheatTimer <= 0),
      overdrive,
    );
    if (nextBoostVisualTarget > this.boostVisualTarget + 0.12) {
      this.boostVisualKick = 1;
      this.boostVisualClock = 0;
    }
    this.boostVisualTarget = nextBoostVisualTarget;

    const proposedDistance = this.distance + this.speed * dt;
    this.distance = Math.min(
      this.plan.length,
      synchronizeDistanceToMusic(this.distance, proposedDistance, musicDistance, baseSpeed),
    );
    this.maxRunSpeed = Math.max(this.maxRunSpeed, this.speed);
    this.score += this.speed * dt * (0.42 + this.sync * 0.012);
    this.processCollisions();
    if (this.state !== 'playing') return;
    this.updateBullets(dt);
    this.updateRivals(dt, musicDistance, transportTime);

    const progress = this.distance / this.plan.length;
    const newSection = progress < 0.33 ? 1 : progress < 0.67 ? 2 : 3;
    if (newSection !== this.section) {
      this.section = newSection;
      this.hooks.onSection(['IGNITION', 'FRACTURE', 'THE DROP'][newSection - 1], newSection);
    }
    if (this.upgradeIndex < UPGRADES_AT.length && progress >= UPGRADES_AT[this.upgradeIndex]) {
      this.upgradeIndex += 1;
      if (this.pendingUpgradeOptions.length > 0) this.queuedUpgradePicks += 1;
      else this.openUpgrade();
    }
    if (this.distance >= this.plan.length) this.finishRun(true);
  }

  private processCollisions(): void {
    const audibleTime = this.audio.getTransportTime();
    const previousAudibleTime = Math.min(this.lastCollisionAudioTime, audibleTime);
    this.lastCollisionAudioTime = audibleTime;
    while (this.lastCollisionCursor < this.plan.events.length) {
      const event = this.plan.events[this.lastCollisionCursor];
      const timing = classifyMusicEventTiming(event.musicTime, audibleTime, previousAudibleTime);
      if (!event.resolved && !event.destroyed && timing !== 'stale') break;
      if (timing === 'stale') event.resolved = true;
      this.lastCollisionCursor += 1;
    }
    for (let index = this.lastCollisionCursor; index < this.plan.events.length; index += 1) {
      const event = this.plan.events[index];
      const timing = classifyMusicEventTiming(event.musicTime, audibleTime, previousAudibleTime);
      if (timing === 'future') break;
      if (event.resolved || event.destroyed) continue;
      if (timing === 'stale') {
        event.resolved = true;
        continue;
      }
      if (isMajorObstacle(event.kind)) this.obstaclesEncountered += 1;
      const onEventCue = isInsideMusicEventWindow(event.musicTime, audibleTime);
      const delta = angularDistance(this.angle, event.angle);
      if (event.kind === 'gate' || event.kind === 'aperture') {
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (delta > event.gapWidth * 0.69) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect(event.kind === 'aperture' ? 'APERTURE SYNC' : 'GATE SYNC', true);
        }
      } else if (event.kind === 'halfwall') {
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (delta < event.gapWidth + 0.16) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect('WALL SYNC', true);
        }
      } else if (event.kind === 'blade' || event.kind === 'cross') {
        const bladeDelta = this.rotorAngularDistance(event, audibleTime);
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (bladeDelta < event.gapWidth + 0.14) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect(event.kind === 'cross' ? 'CROSS SYNC' : 'BLADE SYNC', true);
        }
      } else if (event.kind === 'bastion') {
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (delta < event.gapWidth + 0.18) this.registerNearMiss();
        }
      } else if (event.kind === 'shard') {
        const radius = this.runUpgrades.has('flux-magnet') ? 0.84 : 0.4;
        if (delta < radius) {
          event.resolved = true;
          this.flux = Math.min(100, this.flux + (this.runUpgrades.has('flux-magnet') ? 30 : 16));
          this.score += this.runUpgrades.has('flux-magnet') ? 420 : 210;
          this.collectEvent(event, 'FLUX +');
        } else event.resolved = true;
      } else if (event.kind === 'boost') {
        if (delta < 0.48) {
          event.resolved = true;
          this.speed *= 1.12;
          this.flux = Math.min(100, this.flux + 22);
          this.overdriveTimer = Math.max(this.overdriveTimer, this.runUpgrades.has('afterburner') ? 2.4 : 1.2);
          this.collectEvent(event, 'SLIPSTREAM');
          if (onEventCue) this.registerPerfect('BOOST SYNC');
        } else event.resolved = true;
      } else {
        if (delta < 0.48) {
          event.resolved = true;
          this.heat = Math.max(0, this.heat - 34);
          this.collectEvent(event, 'CRYO -34');
        } else event.resolved = true;
      }
      if (this.state !== 'playing') return;
    }
  }

  private rotorAngularDistance(event: TrackEvent, transportTime: number): number {
    const phase = event.rotationPhase + event.rotationRate * (transportTime - event.musicTime);
    const armCount = Math.max(2, event.armCount);
    let closest = Math.PI;
    for (let arm = 0; arm < armCount; arm += 1) {
      closest = Math.min(closest, angularDistance(this.angle, phase + (arm / armCount) * TAU));
    }
    return closest;
  }

  private hitObstacle(event: TrackEvent, transportTime: number): void {
    event.resolved = true;
    if (this.phaseTimer > 0 || this.invulnerableTimer > 0) {
      this.score += 160;
      this.hooks.onToast('PHASED', t('game.phased'), 'cyan');
      return;
    }
    this.obstacleCollisions += 1;
    const impactAngle = this.angle;
    const knockback = computeObstacleKnockback(
      event,
      impactAngle,
      this.angularVelocity,
      transportTime,
    );
    const impactDirection = knockback?.direction ?? 1;
    if (knockback) {
      this.angle = knockback.angle;
      this.angularVelocity = knockback.angularVelocity;
    }
    this.shield -= 1;
    this.speed *= 0.72;
    this.heat = clamp(this.heat + 21, 0, 100);
    this.sync = 0;
    this.invulnerableTimer = 0.9;
    this.damageKick = 1;
    this.impactFlashTimer = 0.46;
    this.impactSlide = impactDirection;
    const fatal = this.shield <= 0;
    if (!fatal) this.audio.playEffect('impact');
    this.spawnImpactEffects(event, impactAngle, impactDirection);
    this.hooks.onImpact(impactDirection);
    this.hooks.onToast(
      'IMPACT // DEFLECT',
      this.shield > 0 ? `AUTO-SLIDE // SHIELD ${this.shield}/${this.maxShield}` : 'HULL FAILURE',
      'red',
    );
    if (fatal) this.finishRun(false);
  }

  private collectEvent(event: TrackEvent, label: string): void {
    this.audio.playEffect('pickup', label.startsWith('SLIPSTREAM') ? 1.15 : 0.82);
    const visual = this.eventVisuals.get(event.id);
    if (visual) {
      this.spawnBurst(visual.getWorldPosition(new THREE.Vector3()), TRACKS[this.trackId].colors.primary, 12);
      visual.visible = false;
    }
    this.hooks.onToast(label, t('game.resource'), 'cyan');
  }

  private spawnBullet(angle: number, damage: number, piercing: number): void {
    const color = this.audio.isInsideBeatWindow() ? 0xfff2a0 : TRACKS[this.trackId].colors.primary;
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.08, 1.6, 3, 7),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }),
    );
    mesh.geometry.rotateX(Math.PI / 2);
    this.dynamicLayer.add(mesh);
    this.bullets.push({ mesh, distance: this.distance + 5, angle, speed: this.speed + 430, damage, ttl: 0.7, piercing });
  }

  private updateBullets(dt: number): void {
    for (let index = this.bullets.length - 1; index >= 0; index -= 1) {
      const bullet = this.bullets[index];
      bullet.distance += bullet.speed * dt;
      bullet.ttl -= dt;
      let consumed = false;
      for (const event of this.plan.events) {
        if (event.destroyed || event.resolved || event.kind !== 'bastion') continue;
        if (event.distance < bullet.distance - 12) continue;
        if (event.distance > bullet.distance + 12) break;
        if (angularDistance(event.angle, bullet.angle) < event.gapWidth) {
          event.health -= bullet.damage;
          this.hits += 1;
          bullet.piercing -= 1;
          if (event.health <= 0) this.destroyEvent(event, false);
          if (bullet.piercing <= 0) consumed = true;
          break;
        }
      }
      if (bullet.ttl <= 0 || bullet.distance >= this.plan.length || consumed) {
        this.removeAndDispose(bullet.mesh);
        this.bullets.splice(index, 1);
      }
    }
  }

  private destroyEvent(event: TrackEvent, fromAbility: boolean): void {
    if (event.destroyed) return;
    if (!event.resolved && isMajorObstacle(event.kind)) this.obstaclesEncountered += 1;
    event.destroyed = true;
    event.resolved = true;
    this.kills += 1;
    this.score += event.kind === 'bastion' ? 620 : 280;
    this.flux = Math.min(100, this.flux + (event.kind === 'bastion' ? 13 : 7));
    this.audio.playEffect('destroy', event.kind === 'bastion' ? 1.1 : 0.72);
    const visual = this.eventVisuals.get(event.id);
    if (visual) {
      const position = visual.getWorldPosition(new THREE.Vector3());
      this.spawnBurst(position, event.kind === 'bastion' ? 0xff547f : 0xffa33b, fromAbility ? 26 : 18);
      visual.visible = false;
    }
  }

  private onlineAiTickAt(serverTime: number): number {
    if (this.onlineRaceOriginTime === null || !Number.isFinite(serverTime)) return this.rivalAiTick;
    const elapsed = Math.max(0, (serverTime - this.onlineRaceOriginTime) / 1_000);
    return clamp(
      Math.floor(elapsed / FIXED_STEP),
      0,
      Math.ceil(this.plan.runDuration / FIXED_STEP),
    );
  }

  private onlineAiTargetTick(): number {
    if (!this.onlineRun || !this.onlineTimeProvider || this.onlineRaceOriginTime === null) {
      return this.rivalAiTick + 1;
    }
    return Math.max(this.rivalAiTick, this.onlineAiTickAt(this.onlineTimeProvider()));
  }

  private onlineRivalsReadyForResult(): boolean {
    if (!this.onlineRun || this.rivals.every((rival) => rival.ai.finishTick !== null)) return true;
    return this.rivalAiTick >= this.rivalReportMaxTick();
  }

  private rivalReportMaxTick(): number {
    return Math.max(
      this.rivalAiTick,
      Math.ceil(this.plan.runDuration * RESULT_AI_MAX_DURATION_MULTIPLIER / FIXED_STEP),
    );
  }

  private catchUpSoloRivalsForReport(): void {
    if (this.onlineRun || !this.rivalAiModel || this.rivals.every((rival) => rival.ai.finishTick !== null)) return;
    const finalTick = Math.min(
      this.rivalReportMaxTick(),
      this.rivalAiTick + RESULT_AI_CATCHUP_STEPS_PER_FRAME,
    );
    while (
      this.rivalAiTick < finalTick
      && this.rivals.some((rival) => rival.ai.finishTick === null)
    ) {
      const transportTime = (this.rivalAiTick + 1) * FIXED_STEP;
      const paceReference = clamp(transportTime / this.plan.runDuration, 0, 1) * this.plan.length;
      this.updateRivals(FIXED_STEP, paceReference, transportTime, false);
    }
  }

  private catchUpOnlineRivalsToTick(targetTick: number): void {
    if (!this.onlineRun || !Number.isFinite(targetTick) || !this.rivalAiModel || this.rivals.length === 0) return;
    const boundedTarget = clamp(
      Math.trunc(targetTick),
      this.rivalAiTick,
      Math.ceil(this.plan.runDuration / FIXED_STEP),
    );
    while (this.rivalAiTick < boundedTarget) {
      this.rivalAiCatchupBudget = ONLINE_AI_CATCHUP_STEPS_PER_FRAME;
      this.updateRivals(
        FIXED_STEP,
        this.distance,
        this.rivalAiTick * FIXED_STEP,
        false,
        boundedTarget,
      );
    }
  }

  private rivalsReadyForResult(): boolean {
    if (this.onlineRun) return this.onlineRivalsReadyForResult();
    return this.rivals.every((rival) => rival.ai.finishTick !== null)
      || this.rivalAiTick >= this.rivalReportMaxTick();
  }

  private updateRivals(
    dt: number,
    paceReference: number,
    transportTime: number,
    interactive = true,
    targetTickOverride?: number,
  ): void {
    if (!this.rivalAiModel || this.rivals.length === 0) return;
    this.rivalDraftCooldown = Math.max(0, this.rivalDraftCooldown - dt);
    this.rivalCalloutCooldown = Math.max(0, this.rivalCalloutCooldown - dt);
    this.rivalContactCooldown = Math.max(0, this.rivalContactCooldown - dt);

    const player: RivalAISnapshot = {
      id: 'player',
      distance: this.distance,
      speed: this.speed,
      angle: this.angle,
      angularVelocity: this.angularVelocity,
    };
    const targetAiTick = this.onlineRun
      ? Number.isFinite(targetTickOverride)
        ? clamp(
          Math.trunc(targetTickOverride as number),
          this.rivalAiTick,
          interactive ? Math.ceil(this.plan.runDuration / FIXED_STEP) : this.rivalReportMaxTick(),
        )
        : this.onlineAiTargetTick()
      : this.rivalAiTick + 1;
    const availableCatchup = this.onlineRun
      ? Math.max(0, Math.trunc(Number.isFinite(this.rivalAiCatchupBudget)
        ? this.rivalAiCatchupBudget
        : ONLINE_AI_CATCHUP_STEPS_PER_FRAME))
      : 1;
    const finalAiTick = Math.min(targetAiTick, this.rivalAiTick + availableCatchup);
    const catchupStartTick = this.rivalAiTick;
    let outputs: RivalAIOutput[] = [];
    while (this.rivalAiTick < finalAiTick) {
      this.rivalAiTick += 1;
      const aiTransportTime = this.onlineRun ? this.rivalAiTick * FIXED_STEP : transportTime;
      const aiPaceReference = this.onlineRun
        ? clamp(aiTransportTime / this.plan.runDuration, 0, 1) * this.plan.length
        : paceReference;
      const snapshots: RivalAISnapshot[] = this.rivals.map((rival) => ({
        id: rival.profile.id,
        distance: rival.ai.distance,
        speed: rival.ai.speed,
        angle: rival.ai.angle,
        angularVelocity: rival.ai.angularVelocity,
      }));
      outputs = this.rivals.map((rival) => this.resolveRivalHazards(
        rival,
        stepRivalAI(
          this.rivalAiModel as RivalAIRaceModel,
          rival.profile,
          rival.ai,
          {
            dt: this.onlineRun ? FIXED_STEP : dt,
            tick: this.rivalAiTick,
            transportTime: aiTransportTime,
            paceReference: aiPaceReference,
            player,
            traffic: snapshots.filter((snapshot) => snapshot.id !== rival.profile.id),
            allowPlayerTactics: interactive && !this.onlineRun,
          },
        ),
        aiTransportTime,
      ));
      for (let index = 0; index < this.rivals.length; index += 1) {
        this.rivals[index].ai = outputs[index].state;
      }
    }
    if (this.onlineRun) {
      this.rivalAiCatchupBudget = Math.max(
        0,
        availableCatchup - (this.rivalAiTick - catchupStartTick),
      );
    }

    if (outputs.length > 0) {
      for (let index = 0; index < this.rivals.length; index += 1) {
        const rival = this.rivals[index];
        const output = outputs[index];
        rival.lastOutput = output;
        rival.mesh.userData.rivalAI = {
          ...rival.mesh.userData.rivalAI,
          mode: output.state.mode,
          targetAngle: output.targetAngle,
          activeHazardId: output.activeHazardId,
        };
        if (interactive && output.hitHazard) this.showRivalImpact(rival);
        if (interactive && output.modeChanged) this.announceRivalManeuver(rival);
      }
    }

    if (!interactive) return;
    const draftTarget = this.rivals
      .filter((rival) => {
        const ahead = rival.ai.distance - this.distance;
        return ahead > 10 && ahead < 112 && angularDistance(rival.ai.angle, this.angle) < 0.36;
      })
      .sort((left, right) => left.ai.distance - right.ai.distance)[0];
    if (draftTarget && this.rivalDraftCooldown <= 0) {
      this.rivalDraftCharge = clamp(this.rivalDraftCharge + dt * 1.18, 0, 1);
      if (this.rivalDraftCharge >= 1) {
        this.rivalDraftCharge = 0;
        this.rivalDraftCooldown = 2.6;
        this.flux = Math.min(100, this.flux + 10);
        this.speed *= 1.022;
        this.score += 180;
        this.audio.accentMusic(0.72);
        this.hooks.onToast('RIVAL SLIPSTREAM', `${draftTarget.profile.callSign} WAKE // FLUX +10`, 'cyan');
      }
    } else {
      this.rivalDraftCharge = Math.max(0, this.rivalDraftCharge - dt * 1.7);
    }
    this.resolveRivalContact();
  }

  private resolveRivalHazards(rival: Rival, output: RivalAIOutput, transportTime: number): RivalAIOutput {
    const crossedObstacleIds = output.crossedHazardIds.filter((id) => {
      const event = this.trackEventsById.get(id);
      return Boolean(event && isMajorObstacle(event.kind));
    });
    rival.obstaclesEncountered = Math.max(
      0,
      Number.isFinite(rival.obstaclesEncountered) ? rival.obstaclesEncountered : 0,
    ) + crossedObstacleIds.length;
    const hitHazard = crossedObstacleIds.some((id) => {
      const event = this.trackEventsById.get(id);
      if (!event || (!this.onlineRun && event.destroyed)) return false;
      return isObstacleCollision(event, output.state.angle, transportTime);
    });
    if (!hitHazard) {
      rival.maxSpeed = Math.max(Number.isFinite(rival.maxSpeed) ? rival.maxSpeed : 0, output.state.speed);
      return output;
    }
    rival.obstacleCollisions = Math.max(
      0,
      Number.isFinite(rival.obstacleCollisions) ? rival.obstacleCollisions : 0,
    ) + 1;
    const state = applyRivalHazardImpact(output.state, rival.profile);
    rival.maxSpeed = Math.max(Number.isFinite(rival.maxSpeed) ? rival.maxSpeed : 0, state.speed);
    return {
      ...output,
      state,
      modeChanged: state.mode !== rival.ai.mode,
      hitHazard: true,
    };
  }

  private resolveRivalContact(): void {
    if (this.onlineRun || this.rivalContactCooldown > 0 || this.phaseTimer > 0 || this.invulnerableTimer > 0) return;
    const rival = this.rivals
      .filter((candidate) => (
        Math.abs(candidate.ai.distance - this.distance) < 8.5
        && angularDistance(candidate.ai.angle, this.angle) < 0.24
      ))
      .sort((left, right) => (
        Math.abs(left.ai.distance - this.distance) - Math.abs(right.ai.distance - this.distance)
      ))[0];
    if (!rival) return;

    const separation = wrapAngle(this.angle - rival.ai.angle);
    const direction = (Math.abs(separation) < 0.02 ? -rival.profile.passSide : separation > 0 ? 1 : -1) as -1 | 1;
    this.rivalContactCooldown = 0.82;
    this.angle = wrapAngle(this.angle + direction * 0.07);
    this.angularVelocity = clamp(this.angularVelocity + direction * 0.92, -2.4, 2.4);
    this.speed *= 0.965;
    this.heat = Math.min(100, this.heat + 4);
    rival.ai = {
      ...rival.ai,
      angle: wrapAngle(rival.ai.angle - direction * 0.05),
      angularVelocity: clamp(rival.ai.angularVelocity - direction * 0.78, -2.4, 2.4),
      speed: rival.ai.speed * 0.965,
      heat: Math.min(100, rival.ai.heat + 4),
      impactTimer: Math.max(rival.ai.impactTimer, 0.28),
      tacticCooldown: Math.max(rival.ai.tacticCooldown, 0.7),
    };
    this.damageKick = Math.max(this.damageKick, 0.32);
    this.impactFlashTimer = Math.max(this.impactFlashTimer, 0.18);
    this.audio.playEffect('impact', 0.38);
    const frame = sampleTrackFrame(this.plan, clamp(rival.ai.distance / this.plan.length, 0, 0.9999));
    const position = frame.position.clone().add(radialAt(frame, rival.ai.angle).multiplyScalar(this.plan.radius - 1.4));
    this.spawnBurst(position, rival.color, 9);
    this.hooks.onImpact(direction);
    this.hooks.onToast('RIVAL CONTACT', `${rival.profile.callSign} // SOFT DEFLECT`, 'red');
  }

  private showRivalImpact(rival: Rival): void {
    const frame = sampleTrackFrame(this.plan, clamp(rival.ai.distance / this.plan.length, 0, 0.9999));
    const position = frame.position.clone().add(radialAt(frame, rival.ai.angle).multiplyScalar(this.plan.radius - 1.4));
    this.spawnBurst(position, 0xff6a38, 12);
    const ahead = rival.ai.distance - this.distance;
    if (this.rivalCalloutCooldown > 0 || ahead < -80 || ahead > 320) return;
    this.rivalCalloutCooldown = 1.4;
    this.hooks.onToast(`${rival.profile.callSign} // IMPACT`, 'RIVAL LOST SPEED // RECOVERING', 'red');
  }

  private announceRivalManeuver(rival: Rival): void {
    if (this.rivalCalloutCooldown > 0) return;
    const ahead = rival.ai.distance - this.distance;
    if (ahead < -80 || ahead > 260) return;
    const callouts: Partial<Record<RivalAIState['mode'], [string, string, 'cyan' | 'gold' | 'red' | 'violet']>> = {
      block: [`${rival.profile.callSign} // BLOCK`, 'RIVAL IS CLOSING YOUR LINE', 'red'],
      overtake: [`${rival.profile.callSign} // STRIKE`, 'SLIPSTREAM RELEASE // OVERTAKE', 'gold'],
      pulse: [`${rival.profile.callSign} // PULSE`, 'BEAT-SYNC THRUST', 'violet'],
      edge: [`${rival.profile.callSign} // EDGE`, 'HIGH-RISK CORRIDOR CUT', 'gold'],
    };
    const callout = callouts[rival.ai.mode];
    if (!callout) return;
    this.rivalCalloutCooldown = 1.65;
    this.hooks.onToast(...callout);
  }

  private openUpgrade(): void {
    this.upgradeRoll += 1;
    const random = mulberry32(this.plan.seed ^ (this.upgradeRoll * 0x9e3779b9));
    const available = UPGRADES.filter((upgrade) => !this.runUpgrades.has(upgrade.id));
    this.pendingUpgradeOptions = pickDistinct(available, Math.min(3, available.length), random);
    this.emitUpgradeState();
    this.hooks.onToast('MODULE DROP', t('game.moduleDrop'), 'violet');
  }

  private emitUpgradeState(): void {
    const installed = UPGRADES.filter((upgrade) => this.runUpgrades.has(upgrade.id));
    this.hooks.onUpgradeState([...this.pendingUpgradeOptions], installed);
  }

  private registerPerfect(label: string, obstacle = false): void {
    this.perfects += 1;
    if (obstacle) this.obstaclePerfects += 1;
    this.sync = Math.min(32, this.sync + 1);
    const temporalCore = this.runUpgrades.has('temporal-core');
    this.score += 180 * (1 + this.sync * 0.08) * (temporalCore ? TEMPORAL_SCORE_MULTIPLIER : 1);
    if (temporalCore) this.temporalFocusTimer = Math.max(this.temporalFocusTimer, TEMPORAL_FOCUS_DURATION);
    this.flux = Math.min(100, this.flux + 5);
    if (this.runUpgrades.has('cryo-loop')) this.heat = Math.max(0, this.heat - 7);
    if (this.runUpgrades.has('echo-shield') && this.sync % 8 === 0) this.shield = Math.min(this.maxShield, this.shield + 1);
    this.audio.accentMusic(this.sync % 4 === 0 ? 1 : 0.45);
    this.boostVisualKick = Math.max(this.boostVisualKick, this.sync % 4 === 0 ? 0.5 : 0.28);
    if (this.sync % 4 === 0) this.hooks.onToast('PERFECT', `${label} / SYNC ×${this.sync}`, 'gold');
  }

  private registerNearMiss(): void {
    this.nearMisses += 1;
    this.score += 260 * (1 + this.sync * 0.04);
    if (this.runUpgrades.has('kinetic-skin')) {
      this.flux = Math.min(100, this.flux + 18);
      this.speed *= 1.035;
      this.boostVisualKick = Math.max(this.boostVisualKick, 0.42);
    } else {
      this.flux = Math.min(100, this.flux + 8);
      this.boostVisualKick = Math.max(this.boostVisualKick, 0.22);
    }
    this.hooks.onToast('NEAR MISS', '+FLOW', 'gold');
  }

  private finishRun(survived: boolean): void {
    if (this.state !== 'playing') return;
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.emitUpgradeState();
    if (!survived) {
      this.state = 'dying';
      this.localFinishTime = this.onlineTimeProvider?.() ?? null;
      this.localFinishAiTick = this.localFinishTime === null
        ? this.rivalAiTick
        : this.onlineAiTickAt(this.localFinishTime);
      this.catchUpOnlineRivalsToTick(this.localFinishAiTick);
      this.awaitingTerminalAck = this.onlineRun;
      this.terminalAckTimeout = this.onlineRun ? ONLINE_TERMINAL_ACK_TIMEOUT : 0;
      const result = this.createRunResult(false);
      this.beginDeathSequence(result);
      this.hooks.onTerminal();
      return;
    }
    this.releaseInputs();
    this.state = 'finished';
    this.localFinishTime = this.onlineTimeProvider?.() ?? null;
    this.localFinishAiTick = this.localFinishTime === null
      ? this.rivalAiTick
      : this.onlineAiTickAt(this.localFinishTime);
    this.catchUpOnlineRivalsToTick(this.localFinishAiTick);
    this.awaitingTerminalAck = this.onlineRun;
    this.terminalAckTimeout = this.onlineRun ? ONLINE_TERMINAL_ACK_TIMEOUT : 0;
    const result = this.createRunResult(true);
    this.audio.stop();
    this.pendingResult = result;
    this.resultDelay = 0.42;
    this.hooks.onTerminal();
  }

  private getLocalElapsedTime(): number {
    if (Number.isFinite(this.onlineRaceOriginTime) && Number.isFinite(this.localFinishTime)) {
      return Math.max(0, ((this.localFinishTime as number) - (this.onlineRaceOriginTime as number)) / 1_000);
    }
    return Math.max(0, (Number.isFinite(this.simulationTick) ? this.simulationTick : 0) * FIXED_STEP);
  }

  private getPlayerObstaclePerformance() {
    const obstacles = (this.plan?.events ?? []).filter((event) => isMajorObstacle(event.kind));
    const encountered = Number.isFinite(this.obstaclesEncountered)
      ? this.obstaclesEncountered
      : obstacles.filter((event) => event.resolved || event.destroyed).length;
    return createObstaclePerformance(obstacles.length, encountered, this.obstacleCollisions);
  }

  private getRemoteElapsedTime(racer: Readonly<RemoteRacer>): number | null {
    if (!Number.isFinite(racer.terminalAt) || !Number.isFinite(this.onlineRaceOriginTime)) return null;
    return Math.max(0, ((racer.terminalAt as number) - (this.onlineRaceOriginTime as number)) / 1_000);
  }

  private createRaceStandings(
    survived: boolean,
    finalScore: number,
    rank: number,
  ): RaceStanding[] {
    const planLength = Math.max(1, Number.isFinite(this.plan?.length) ? this.plan.length : 1);
    const obstacleTotal = (this.plan?.events ?? []).filter((event) => isMajorObstacle(event.kind)).length;
    const entries: RaceStanding[] = [{
      id: 'player',
      name: 'YOU',
      kind: 'player',
      status: survived ? 'finished' : 'destroyed',
      place: rank,
      progress: clamp((Number.isFinite(this.distance) ? this.distance : 0) / planLength, 0, 1),
      elapsedTime: this.getLocalElapsedTime(),
      score: finalScore,
      obstaclePerformance: this.getPlayerObstaclePerformance(),
    }];

    for (const rival of this.rivals ?? []) {
      const finished = rival.ai.finishTick !== null;
      const reportClosed = this.state !== 'playing'
        && this.rivalAiTick >= this.rivalReportMaxTick();
      entries.push({
        id: rival.profile.id,
        name: rival.profile.callSign,
        kind: 'ai',
        status: finished ? 'finished' : reportClosed ? 'dnf' : 'racing',
        place: 0,
        progress: clamp(rival.ai.distance / planLength, 0, 1),
        elapsedTime: finished ? (rival.ai.finishTick as number) * FIXED_STEP : null,
        score: null,
        obstaclePerformance: createObstaclePerformance(
          obstacleTotal,
          rival.obstaclesEncountered,
          rival.obstacleCollisions,
        ),
      });
    }

    for (const racer of this.remoteRacers?.values() ?? []) {
      const status = racer.finished
        ? 'finished'
        : racer.destroyed
          ? 'destroyed'
          : racer.dnf || !racer.active
            ? 'dnf'
            : 'racing';
      entries.push({
        id: racer.id,
        name: racer.name,
        kind: 'human',
        status,
        place: 0,
        progress: clamp(racer.targetProgress, 0, 1),
        elapsedTime: this.getRemoteElapsedTime(racer),
        score: racer.score,
        obstaclePerformance: null,
      });
    }

    return orderRaceStandings(entries, rank);
  }

  private createRunTelemetry(survived: boolean, finalScore: number, rank: number) {
    const obstaclePerformance = this.getPlayerObstaclePerformance();
    const planLength = Math.max(1, Number.isFinite(this.plan?.length) ? this.plan.length : 1);
    const courseProgress = clamp((Number.isFinite(this.distance) ? this.distance : 0) / planLength, 0, 1);
    return {
      elapsedTime: this.getLocalElapsedTime(),
      competitorCount: Math.max(
        Number.isFinite(this.raceCompetitorCount) ? this.raceCompetitorCount : 1,
        1 + (this.rivals?.length ?? 0) + (this.remoteRacers?.size ?? 0),
      ),
      courseProgress,
      courseQuality: calculateCourseQuality({
        survived,
        progress: courseProgress,
        obstaclePerformance,
        perfects: Number.isFinite(this.obstaclePerfects) ? this.obstaclePerfects : this.perfects,
        nearMisses: this.nearMisses,
      }),
      obstaclePerformance,
      standings: this.createRaceStandings(survived, finalScore, rank),
    };
  }

  private createRunResult(survived: boolean): RunResult {
    const rank = this.getRank();
    const accuracy = this.shots > 0 ? this.hits / this.shots : 0;
    const placementBonus = Math.max(0, this.raceCompetitorCount - rank) * 1200;
    const finalScore = Math.round(this.score + (survived ? 5000 : 0) + placementBonus);
    const credits = Math.max(90, Math.round(finalScore / 42 + this.kills * 8));
    return {
      score: finalScore,
      credits,
      maxSpeed: this.maxRunSpeed * 12.4,
      accuracy,
      perfects: this.perfects,
      nearMisses: this.nearMisses,
      kills: this.kills,
      rank,
      survived,
      trackName: TRACKS[this.trackId].name,
      seed: this.plan.seed,
      ...this.createRunTelemetry(survived, finalScore, rank),
    };
  }

  private refreshRunResultPlacement(result: Readonly<RunResult>): RunResult {
    return {
      ...result,
      ...this.createRunTelemetry(result.survived, result.score, result.rank),
    };
  }

  private beginDeathSequence(result: RunResult): void {
    this.state = 'dying';
    this.pendingResult = result;
    this.resultDelay = 0;
    this.deathSequence = createDeathSequenceState();
    this.fixedAccumulator = 0;
    this.releaseInputs();
    this.boostVisualTarget = 0;
    this.overdriveTimer = 0;
    const explosionSeed = (
      this.plan.seed
      ^ Math.imul(Math.round(this.distance * 16), 0x45d9f3b)
      ^ Math.imul(Math.round(this.score) + this.kills * 131, 0x27d4eb2d)
    ) >>> 0;
    this.audio.fadeOutMusic(DEATH_MUSIC_FADE_DURATION);
    this.audio.playDeathExplosion(explosionSeed, 1.08);
    this.deathFx.start({
      seed: explosionSeed,
      quality: this.graphicsSettings.quality,
      reducedFlashes: this.graphicsSettings.reducedFlashes,
      impactDirection: this.impactSlide < 0 ? -1 : 1,
    });
    this.damageKick = this.graphicsSettings.reducedFlashes ? 0.72 : 1.5;
  }

  private deliverPendingResult(): void {
    if (!this.pendingResult) return;
    const result = this.refreshRunResultPlacement(this.pendingResult);
    const wasDying = this.state === 'dying';
    this.pendingResult = null;
    this.resultDelay = 0;
    this.awaitingTerminalAck = false;
    this.terminalAckTimeout = 0;
    this.deathSequence = null;
    this.state = 'finished';
    this.releaseInputs();
    if (wasDying) {
      this.audio.stop();
      this.deathFx.reset();
    }
    this.hooks.onFinish(result);
  }

  private updateVisuals(dt: number): void {
    const holdingFinalImpact = this.state === 'finished'
      && (this.impactFlashTimer > 0 || this.chaseImpactEffects.length > 0);
    const activeDistance = this.state === 'menu' || (this.state === 'finished' && !holdingFinalImpact)
      ? this.demoDistance
      : this.distance;
    const progress = clamp(activeDistance / this.plan.length, 0, 0.9998);
    const frame = sampleTrackFrame(this.plan, progress);
    const lookFrame = sampleTrackFrame(this.plan, clamp((activeDistance + 56) / this.plan.length, 0, 0.9999));
    const radial = radialAt(frame, this.angle);
    const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(this.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(this.angle))).normalize();
    const phaseTarget = this.phaseTimer > 0 ? this.plan.radius * 0.22 : this.plan.radius - 1.15;
    this.cameraRadial = damp(this.cameraRadial || phaseTarget, phaseTarget, this.phaseTimer > 0 ? 7 : 4, dt);
    this.updateChaseBoostVisuals(dt);
    const deathFxFrame = this.state === 'dying' ? this.deathFx.update(dt) : null;
    if (deathFxFrame?.active) {
      const cameraMotion = this.graphicsSettings.cameraShake && !this.graphicsSettings.reducedFlashes ? 1 : 0;
      this.chaseCamera.position.set(
        deathFxFrame.cameraOffsetX * cameraMotion,
        deathFxFrame.cameraOffsetY * cameraMotion,
        0,
      );
      this.chaseCamera.rotation.set(0, 0, deathFxFrame.cameraRoll * cameraMotion);
      this.chaseCamera.fov = 76 + deathFxFrame.fovKick;
      this.chaseCamera.updateProjectionMatrix();
    } else {
      this.chaseCamera.position.x = damp(this.chaseCamera.position.x, 0, 12, dt);
      this.chaseCamera.position.y = damp(this.chaseCamera.position.y, 0, 12, dt);
      this.chaseCamera.rotation.z = damp(this.chaseCamera.rotation.z, 0, 12, dt);
    }
    const boostStrength = clamp(this.boostVisualIntensity / 1.2, 0, 1);
    const boostKick = clamp(this.boostVisualKick, 0, 1);
    const craftLean = clamp(this.angularVelocity * 0.045, -0.24, 0.24);
    this.impactFlashTimer = Math.max(0, this.impactFlashTimer - dt);
    const impactEnvelope = clamp(this.impactFlashTimer / 0.46, 0, 1);
    const impactRecoil = this.impactSlide * impactEnvelope;
    this.vehicle.position.x = damp(this.vehicle.position.x, -craftLean * 1.35 - impactRecoil * 0.82, 10, dt);
    this.vehicle.position.y = damp(this.vehicle.position.y, -2.7, 7, dt);
    const vehicleDepth = -8.6 + boostStrength * 0.3 + boostKick * 0.12;
    this.vehicle.position.z = damp(this.vehicle.position.z || -8.6, vehicleDepth, 9, dt);
    this.vehicle.rotation.set(
      -0.06 - boostStrength * 0.028 + impactEnvelope * 0.035,
      Math.PI,
      craftLean + impactRecoil * 0.16,
    );
    this.vehicle.visible = this.state !== 'menu'
      && this.state !== 'dying'
      && (this.state !== 'finished' || holdingFinalImpact);
    this.engineGlow.scale.setScalar(
      0.78 + this.lastBands.bass * 0.9 + boostStrength * 0.8 + (this.overdriveTimer > 0 ? 0.28 : 0),
    );
    this.vehicleImpactGlow.visible = impactEnvelope > 0.001;
    this.vehicleImpactGlow.scale.setScalar(1 + (1 - impactEnvelope) * 0.09);
    this.vehicleImpactMaterial.opacity = (
      this.graphicsSettings.reducedFlashes ? 0.18 : 0.52
    ) * impactEnvelope * (0.76 + Math.sin(performance.now() * 0.075) * 0.24);

    const speedRatio = this.config ? clamp(this.speed / (this.plan.length / this.plan.runDuration * 1.55), 0, 1.25) : 0.34;
    const cameraRadialDistance = Math.max(0.6, this.cameraRadial - 3.35);
    const cameraTarget = frame.position.clone().add(radial.clone().multiplyScalar(cameraRadialDistance)).add(frame.tangent.clone().multiplyScalar(-6.8));
    const inward = radial.clone().multiplyScalar(-1);
    const shake = (!this.graphicsSettings.cameraShake || this.graphicsSettings.reducedFlashes)
      ? 0
      : (speedRatio * 0.025 + boostStrength * 0.035 + boostKick * 0.045 + this.damageKick * 0.16)
        * (0.3 + this.lastBands.bass);
    cameraTarget.add(circumferential.clone().multiplyScalar(Math.sin(performance.now() * 0.037) * shake));
    cameraTarget.add(inward.clone().multiplyScalar(Math.cos(performance.now() * 0.031) * shake));
    cameraTarget.add(circumferential.clone().multiplyScalar(-impactRecoil * 0.28));
    if (this.camera.position.lengthSq() === 0) this.camera.position.copy(cameraTarget);
    this.camera.position.lerp(cameraTarget, 1 - Math.exp(-dt * 10.5));
    this.camera.up.lerp(inward, 1 - Math.exp(-dt * 7.5)).normalize();
    const lookRadial = radialAt(lookFrame, this.angle).multiplyScalar(Math.max(0.5, this.cameraRadial - 1));
    const lookTarget = lookFrame.position.clone().add(lookRadial);
    this.camera.lookAt(lookTarget);
    const boostFov = this.graphicsSettings.reducedFlashes
      ? boostStrength * 2.1 + boostKick * 0.65
      : boostStrength * 5.4 + boostKick * 2.2;
    const targetFov = clamp(
      72 + speedRatio * 19 + boostFov + (this.overdriveTimer > 0 ? 2 : 0),
      74,
      103,
    );
    this.camera.fov = damp(this.camera.fov, targetFov, 4.5, dt);
    this.camera.updateProjectionMatrix();
    this.damageKick *= Math.exp(-dt * 8);
    this.updateSkylineEnvironment(dt, activeDistance);
    this.updateUnderwaterEnvironment(dt, activeDistance);

    if (this.tunnelMaterial) {
      this.tunnelMaterial.uniforms.uTime.value = this.audio.getTime() + performance.now() / 7600;
      this.tunnelMaterial.uniforms.uEnergy.value = this.lastBands.overall;
      this.tunnelMaterial.uniforms.uPulse.value = this.lastBands.pulse;
      this.tunnelMaterial.uniforms.uSpeed.value = speedRatio;
      this.tunnelMaterial.uniforms.uBoost.value = boostStrength
        * (this.graphicsSettings.reducedFlashes ? 0.52 : 1);
    }
    this.bloomStrengthSignal = this.graphicsSettings.reducedFlashes
      ? 0.62 + boostStrength * 0.08 + this.damageKick * 0.12
      : 0.92 + this.lastBands.pulse * 0.58 + speedRatio * 0.25 + boostStrength * 0.11
        + boostKick * 0.06 + this.damageKick * 0.38;
    this.bloomPass.radius = 0.48 + this.lastBands.highs * 0.22;
    this.rgbPass.uniforms.amount.value = this.rgbPass.enabled
      ? 0.00015 + speedRatio * 0.00055 + boostStrength * 0.00072 + boostKick * 0.00038
        + (this.overdriveTimer > 0 ? 0.0008 : 0) + this.damageKick * 0.0018
      : 0;
    this.exposureSignal = (this.trackId === 'skyline' ? 0.82 : this.trackId === 'abyss' ? 0.76 : 0.98)
      + this.lastBands.pulse * 0.15
      + boostStrength * (this.graphicsSettings.reducedFlashes ? 0.008 : 0.016)
      + this.damageKick * (this.graphicsSettings.reducedFlashes ? 0.025 : 0.08)
      + (deathFxFrame?.exposureKick ?? 0);
    this.applyPostProcessingSettings();

    this.updateEventVisuals(dt, activeDistance);
    this.updateBulletVisuals();
    this.updateRivalVisuals(dt);
    this.updateStreaks(activeDistance, speedRatio, boostStrength);
    this.updateBursts(dt);
    this.updateChaseImpactEffects(dt);
    this.impactSlide *= Math.exp(-dt * 6.5);
  }

  private updateEventVisuals(dt: number, activeDistance: number): void {
    const time = this.audio.getTime();
    const transportTime = this.audio.getTransportTime();
    for (const event of this.plan.events) {
      const visual = this.eventVisuals.get(event.id);
      if (!visual) continue;
      const ahead = event.distance - activeDistance;
      if (!event.destroyed && !event.resolved) visual.visible = ahead > -45 && ahead < 1100;
      if (!visual.visible) continue;
      const pulse = 1 + this.lastBands.pulse * 0.1 + Math.sin(time * 3.2 + event.id) * 0.035;
      if (!['gate', 'aperture', 'halfwall', 'blade', 'cross', 'bastion'].includes(event.kind)) visual.scale.setScalar(damp(visual.scale.x, pulse, 8, dt));
      const rotor = visual.userData.rotor as THREE.Group | undefined;
      if (rotor) rotor.rotation.z = event.rotationPhase + event.rotationRate * (transportTime - event.musicTime);
      if (event.kind === 'shard' || event.kind === 'coolant') visual.rotateZ(dt * 2.4);
    }
  }

  private updateBulletVisuals(): void {
    for (const bullet of this.bullets) {
      const progress = clamp(bullet.distance / this.plan.length, 0, 0.9999);
      const frame = sampleTrackFrame(this.plan, progress);
      const radial = radialAt(frame, bullet.angle);
      const position = frame.position.clone().add(radial.multiplyScalar(this.plan.radius - 1.35));
      const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(bullet.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(bullet.angle))).normalize();
      bullet.mesh.position.copy(position);
      bullet.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(circumferential, radialAt(frame, bullet.angle), frame.tangent));
    }
  }

  private updateRivalVisuals(dt: number): void {
    for (const rival of this.rivals) {
      const ahead = rival.ai.distance - this.distance;
      rival.mesh.visible = this.state === 'menu' ? false : ahead > -100 && ahead < 800;
      if (!rival.mesh.visible) continue;
      const frame = sampleTrackFrame(this.plan, clamp(rival.ai.distance / this.plan.length, 0, 0.9999));
      const radial = radialAt(frame, rival.ai.angle);
      rival.mesh.position.copy(frame.position).add(radial.clone().multiplyScalar(this.plan.radius - 1.4));
      resolveOpponentVisualQuaternion(
        frame.tangent,
        radial,
        rival.mesh.position,
        this.camera.position,
        rival.mesh.quaternion,
      );
      const boost = rival.ai.boost;
      const beatGlow = rival.ai.beatImpulse * 7;
      const visibilityGain = 0.9 + this.graphicsSettings.rivalVisibility * 1.08;
      rival.engineGlow.scale.setScalar(1.14 + boost * 0.34 + beatGlow * 0.14);
      for (const child of rival.engineGlow.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const material = child.material as THREE.MeshBasicMaterial;
        material.opacity = clamp((0.26 + boost * 0.4 + beatGlow * 0.1) * visibilityGain, 0.24, 0.96);
      }
      for (const trail of rival.thrustTrails) {
        const material = trail.material as THREE.MeshBasicMaterial;
        material.opacity = clamp((0.16 + boost * 0.38) * visibilityGain, 0.16, 0.84);
        trail.scale.set(1 + boost * 0.18, 1 + boost * 0.18, 1 + boost * 1.25);
      }
      this.pulseOpponentBeacon(
        rival.visual,
        Math.max(rival.ai.beatImpulse, boost * 0.65),
        ahead,
        rival.mesh.position.distanceTo(this.camera.position),
      );
    }
    const interpolation = 1 - Math.exp(-Math.max(0, dt) * 14);
    for (const racer of this.remoteRacers.values()) {
      racer.progress += (racer.targetProgress - racer.progress) * interpolation;
      racer.angle = wrapAngle(racer.angle + wrapAngle(racer.targetAngle - racer.angle) * interpolation);
      const racerDistance = clamp(racer.progress, 0, 1) * this.plan.length;
      const ahead = racerDistance - this.distance;
      racer.mesh.visible = this.state !== 'menu'
        && racer.active
        && !racer.destroyed
        && ahead > -100
        && ahead < 800;
      if (!racer.mesh.visible) continue;
      const frame = sampleTrackFrame(this.plan, clamp(racer.progress, 0, 0.9999));
      const radial = radialAt(frame, racer.angle);
      racer.mesh.position.copy(frame.position).add(radial.clone().multiplyScalar(this.plan.radius - 1.32));
      resolveOpponentVisualQuaternion(
        frame.tangent,
        radial,
        racer.mesh.position,
        this.camera.position,
        racer.mesh.quaternion,
      );
      const speedPulse = clamp(racer.speed / Math.max(1, this.maxRunSpeed || racer.speed), 0, 1);
      this.pulseOpponentBeacon(
        racer.visual,
        0.16 + speedPulse * 0.42 + this.lastBands.pulse * 0.32,
        ahead,
        racer.mesh.position.distanceTo(this.camera.position),
      );
    }
  }

  private updateStreaks(activeDistance: number, speedRatio: number, boostStrength: number): void {
    if (!this.streakGeometry) return;
    const attribute = this.streakGeometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attribute.array as Float32Array;
    const travel = (this.audio.getTime() * (80 + speedRatio * 220 + boostStrength * 520)) % 220;
    for (let index = 0; index < this.streaks.length; index += 1) {
      const spec = this.streaks[index];
      const offset = 12 + ((spec.offset - travel + 440) % 220);
      const startDistance = clamp(activeDistance + offset, 0, this.plan.length - 2);
      const endDistance = clamp(
        startDistance + spec.length * (1 + speedRatio * 2.8 + boostStrength * 7.2),
        0,
        this.plan.length - 1,
      );
      const startFrame = sampleTrackFrame(this.plan, startDistance / this.plan.length);
      const endFrame = sampleTrackFrame(this.plan, endDistance / this.plan.length);
      const start = startFrame.position.clone().add(radialAt(startFrame, spec.angle).multiplyScalar(spec.radial));
      const end = endFrame.position.clone().add(radialAt(endFrame, spec.angle).multiplyScalar(spec.radial));
      positions[index * 6] = start.x;
      positions[index * 6 + 1] = start.y;
      positions[index * 6 + 2] = start.z;
      positions[index * 6 + 3] = end.x;
      positions[index * 6 + 4] = end.y;
      positions[index * 6 + 5] = end.z;
    }
    attribute.needsUpdate = true;
    if (this.streakLines) {
      (this.streakLines.material as THREE.LineBasicMaterial).opacity = clamp(
        0.54 + boostStrength * (this.graphicsSettings.reducedFlashes ? 0.1 : 0.34),
        0,
        0.92,
      );
    }
  }

  private spawnImpactEffects(
    event: TrackEvent,
    impactAngle: number,
    direction: -1 | 1,
  ): void {
    const progress = clamp(this.distance / this.plan.length, 0, 0.9999);
    const frame = sampleTrackFrame(this.plan, progress);
    const radial = radialAt(frame, impactAngle);
    const circumferential = frame.normal.clone()
      .multiplyScalar(-Math.sin(impactAngle))
      .add(frame.binormal.clone().multiplyScalar(Math.cos(impactAngle)))
      .normalize();
    const contact = frame.position.clone()
      .add(radial.clone().multiplyScalar(this.plan.radius - 1.15))
      .add(circumferential.clone().multiplyScalar(-direction * 0.72));
    const backwardSpray = frame.tangent.clone().multiplyScalar(-0.86)
      .add(circumferential.clone().multiplyScalar(-direction * 0.66))
      .add(radial.clone().multiplyScalar(-0.18))
      .normalize();
    const qualityScale = this.graphicsSettings.quality === 'performance'
      ? 0.68
      : this.graphicsSettings.quality === 'quality'
        ? 1.18
        : 1;
    const flashScale = this.graphicsSettings.reducedFlashes ? 0.58 : 1;
    const dangerColor = event.kind === 'blade' || event.kind === 'cross' ? 0xffc14d : 0xff315f;

    this.spawnBurst(contact, dangerColor, Math.round(30 * qualityScale * flashScale), {
      direction: backwardSpray,
      speed: 25,
      spread: 11,
      size: this.graphicsSettings.reducedFlashes ? 0.3 : 0.48,
      life: 0.78,
      drag: 2.25,
    });
    this.spawnBurst(contact, 0xfff2c0, Math.round(14 * qualityScale * flashScale), {
      direction: backwardSpray,
      speed: 34,
      spread: 7,
      size: this.graphicsSettings.reducedFlashes ? 0.2 : 0.28,
      life: 0.48,
      drag: 3.1,
    });
    this.spawnChaseImpactEffect(direction);
  }

  private spawnChaseImpactEffect(direction: -1 | 1): void {
    const random = mulberry32((this.plan.seed ^ Math.imul(this.score + this.shield * 97 + 1, 0x9e3779b9)) >>> 0);
    const qualityCount = this.graphicsSettings.quality === 'performance'
      ? 9
      : this.graphicsSettings.quality === 'quality'
        ? 22
        : 15;
    const count = Math.max(7, Math.round(qualityCount * (this.graphicsSettings.reducedFlashes ? 0.62 : 1)));
    const contact = this.vehicle.position.clone().add(new THREE.Vector3(direction * 1.55, 0.08, 0.42));
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const velocities: THREE.Vector3[] = [];
    const hot = new THREE.Color(0xfff4ce);
    const ember = new THREE.Color(0xff542e);

    for (let index = 0; index < count; index += 1) {
      const jitter = new THREE.Vector3((random() - 0.5) * 0.18, (random() - 0.5) * 0.18, (random() - 0.5) * 0.12);
      const start = contact.clone().add(jitter);
      positions.set([start.x, start.y, start.z, start.x, start.y, start.z], index * 6);
      colors.set([hot.r, hot.g, hot.b, ember.r, ember.g, ember.b], index * 6);
      velocities.push(new THREE.Vector3(
        direction * (3.5 + random() * 9) + (random() - 0.5) * 5,
        (random() - 0.5) * 11,
        9 + random() * 19,
      ));
    }

    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    sparkGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sparkMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.graphicsSettings.reducedFlashes ? 0.64 : 1,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sparks = new THREE.LineSegments(sparkGeometry, sparkMaterial);
    sparks.renderOrder = 48;

    const waveMaterial = new THREE.MeshBasicMaterial({
      color: 0xff8a4a,
      transparent: true,
      opacity: this.graphicsSettings.reducedFlashes ? 0.24 : 0.66,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const wave = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.42, 32), waveMaterial);
    wave.position.copy(contact);
    wave.renderOrder = 47;
    this.chaseScene.add(sparks, wave);
    this.chaseImpactEffects.push({
      sparks,
      wave,
      velocities,
      life: 0.58,
      maxLife: 0.58,
      sparkPeakOpacity: sparkMaterial.opacity,
    });
  }

  private spawnBurst(
    position: THREE.Vector3,
    color: number,
    count: number,
    options: Readonly<BurstOptions> = {},
  ): void {
    const random = mulberry32((this.plan.seed + this.bursts.length * 101 + Math.floor(this.distance)) >>> 0);
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    const direction = options.direction?.clone().normalize();
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = position.x;
      positions[index * 3 + 1] = position.y;
      positions[index * 3 + 2] = position.z;
      const scatter = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      velocities.push(direction
        ? direction.clone()
          .multiplyScalar((options.speed ?? 20) * (0.62 + random() * 0.76))
          .addScaledVector(scatter, (options.spread ?? 8) * (0.35 + random() * 0.65))
        : scatter.multiplyScalar(5 + random() * 16));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color,
        size: options.size ?? 0.34,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.dynamicLayer.add(points);
    const life = options.life ?? 0.8;
    this.bursts.push({ points, velocities, life, maxLife: life, drag: options.drag ?? 2 });
  }

  private updateBursts(dt: number): void {
    for (let burstIndex = this.bursts.length - 1; burstIndex >= 0; burstIndex -= 1) {
      const burst = this.bursts[burstIndex];
      burst.life -= dt;
      const attribute = burst.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let index = 0; index < burst.velocities.length; index += 1) {
        attribute.setXYZ(
          index,
          attribute.getX(index) + burst.velocities[index].x * dt,
          attribute.getY(index) + burst.velocities[index].y * dt,
          attribute.getZ(index) + burst.velocities[index].z * dt,
        );
        burst.velocities[index].multiplyScalar(Math.exp(-dt * burst.drag));
      }
      attribute.needsUpdate = true;
      (burst.points.material as THREE.PointsMaterial).opacity = clamp(burst.life / burst.maxLife, 0, 1);
      if (burst.life <= 0) {
        this.removeAndDispose(burst.points);
        this.bursts.splice(burstIndex, 1);
      }
    }
  }

  private updateChaseImpactEffects(dt: number): void {
    for (let effectIndex = this.chaseImpactEffects.length - 1; effectIndex >= 0; effectIndex -= 1) {
      const effect = this.chaseImpactEffects[effectIndex];
      effect.life -= dt;
      const lifeRatio = clamp(effect.life / effect.maxLife, 0, 1);
      const progress = 1 - lifeRatio;
      const attribute = effect.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let index = 0; index < effect.velocities.length; index += 1) {
        const velocity = effect.velocities[index];
        const startOffset = index * 2;
        attribute.setXYZ(
          startOffset,
          attribute.getX(startOffset) + velocity.x * dt * 0.34,
          attribute.getY(startOffset) + velocity.y * dt * 0.34,
          attribute.getZ(startOffset) + velocity.z * dt * 0.34,
        );
        attribute.setXYZ(
          startOffset + 1,
          attribute.getX(startOffset + 1) + velocity.x * dt,
          attribute.getY(startOffset + 1) + velocity.y * dt,
          attribute.getZ(startOffset + 1) + velocity.z * dt,
        );
        velocity.multiplyScalar(Math.exp(-dt * 3.2));
      }
      attribute.needsUpdate = true;
      (effect.sparks.material as THREE.LineBasicMaterial).opacity = (
        effect.sparkPeakOpacity * lifeRatio * lifeRatio
      );
      effect.wave.scale.setScalar(0.72 + progress * 4.8);
      (effect.wave.material as THREE.MeshBasicMaterial).opacity = (
        this.graphicsSettings.reducedFlashes ? 0.2 : 0.58
      ) * lifeRatio * lifeRatio;

      if (effect.life <= 0) {
        this.removeAndDispose(effect.sparks);
        this.removeAndDispose(effect.wave);
        this.chaseImpactEffects.splice(effectIndex, 1);
      }
    }
  }

  private getRank(): number {
    const localFinished = this.distance >= this.plan.length;
    const localFinishTime = localFinished ? this.localFinishTime : null;
    const remoteAhead = [...(this.remoteRacers?.values() ?? [])].filter((racer) => (
      !racer.destroyed
      && (racer.active || racer.finished)
      && (
        localFinished && racer.finished
          ? localFinishTime !== null && racer.terminalAt !== null && racer.terminalAt < localFinishTime
          : racer.targetProgress * this.plan.length > this.distance + 2
      )
    )).length;
    const localAiAhead = localFinished
      ? this.rivals.filter((rival) => (
        rival.ai.finishTick !== null
        && rival.ai.finishTick < (this.localFinishAiTick ?? this.rivalAiTick)
      )).length
      : this.rivals.filter((rival) => rival.ai.distance > this.distance + 2).length;
    return 1 + localAiAhead + remoteAhead;
  }

  private getStats(): RunStats {
    const maxBase = this.plan.length / this.plan.runDuration * 1.75;
    return {
      speed: this.speed * 12.4,
      maxSpeed: maxBase * 12.4,
      progress: this.distance / this.plan.length,
      shield: this.shield,
      maxShield: this.maxShield,
      heat: this.heat,
      flux: this.flux,
      sync: this.sync,
      score: Math.round(this.score),
      rank: this.getRank(),
      abilityCooldown: this.abilityCooldown,
      weaponCooldown: this.weaponCooldown,
      section: this.section,
      rhythmPulse: this.lastBands.pulse,
      phaseActive: this.phaseTimer > 0,
      overheated: this.overheatTimer > 0,
      rivals: this.rivals.map((rival) => ({
        id: rival.profile.id,
        name: rival.profile.callSign,
        progress: clamp(rival.ai.distance / this.plan.length, 0, 1),
        mode: rival.ai.mode,
        color: rival.color,
        boost: rival.ai.boost,
      })),
    };
  }

  private disposeGroup(group: THREE.Group): void {
    const children = [...group.children];
    for (const child of children) {
      group.remove(child);
      child.traverse((object) => {
        if (object instanceof THREE.Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
          return;
        }
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments)) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if ('map' in material) material.map?.dispose();
          material?.dispose();
        }
      });
    }
  }

  private removeAndDispose(object: THREE.Object3D): void {
    object.parent?.remove(object);
    object.traverse((child) => {
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
        return;
      }
      if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) return;
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if ('map' in material) material.map?.dispose();
        material?.dispose();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.audio.stop();
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.releaseInputs);
    this.canvas.removeEventListener('pointerdown', this.handleCanvasPointerDown);
    this.disposeGroup(this.world);
    this.setRemoteRacers([]);
    this.disposeGroup(this.dynamicLayer);
    for (const effect of this.chaseImpactEffects) {
      this.removeAndDispose(effect.sparks);
      this.removeAndDispose(effect.wave);
    }
    this.chaseImpactEffects.length = 0;
    this.deathFx.dispose();
    this.removeAndDispose(this.vehicle);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
