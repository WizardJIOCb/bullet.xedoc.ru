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
import {
  ABILITIES,
  TRACKS,
  UPGRADES,
  WEAPONS,
  type RunConfig,
  type RunResult,
  type RunStats,
  type TrackEvent,
  type TrackId,
  type UpgradeDefinition,
  type UpgradeId,
} from '../core/types';
import type { ControlBindings, GraphicsSettings, InputAction, SettingsState } from '../settings/SettingsStore';
import { resolveBoostVisualTarget, stepBoostVisualIntensity } from './boost';
import { computeObstacleKnockback, isObstacleCollision } from './collision';
import { classifyMusicEventTiming, isInsideMusicEventWindow, synchronizeDistanceToMusic } from './rhythm';
import { stepWallRideSteering, type SteeringInput } from './steering';
import {
  generateTrack,
  getTrackEventSafeCorridors,
  radialAt,
  sampleTrackFrame,
  type TrackFrame,
  type TrackPlan,
} from './track';
import { createTrackTimeline, type TrackTimeline } from './timeline';

type GameState = 'menu' | 'countdown' | 'playing' | 'finished';

interface GameHooks {
  onHud: (stats: RunStats) => void;
  onTimeline: (timeline: TrackTimeline) => void;
  onToast: (message: string, detail?: string, tone?: 'cyan' | 'gold' | 'red' | 'violet') => void;
  onUpgradeState: (pending: UpgradeDefinition[], installed: UpgradeDefinition[]) => void;
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
  distance: number;
  angle: number;
  speedFactor: number;
  phase: number;
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

const FIXED_STEP = 1 / 120;
const UPGRADES_AT = [0.31, 0.64];

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
  private readonly keys = new Set<string>();
  private readonly mobileInput = new Map<string, boolean>();
  private readonly bullets: Bullet[] = [];
  private readonly bursts: Burst[] = [];
  private readonly chaseImpactEffects: ChaseImpactEffect[] = [];
  private readonly rivals: Rival[] = [];
  private readonly vehicle: THREE.Group;
  private readonly engineGlow: THREE.Group;
  private readonly vehicleThrustTrails: THREE.Mesh[];
  private readonly vehicleImpactGlow: THREE.Group;
  private readonly vehicleImpactMaterial: THREE.MeshBasicMaterial;
  private readonly chaseBoostEffect: ChaseBoostEffect;
  private streakGeometry: THREE.BufferGeometry | null = null;
  private streakLines: THREE.LineSegments | null = null;
  private streaks: StreakSpec[] = [];
  private tunnelMaterial: THREE.ShaderMaterial | null = null;
  private plan: TrackPlan;
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
  private graphicsSettings: GraphicsSettings;
  private controlBindings: ControlBindings;
  private inputCapture = false;
  private disposed = false;
  private visibilityPaused = false;

  constructor(canvas: HTMLCanvasElement, audio: AudioEngine, hooks: GameHooks, settings: Pick<SettingsState, 'graphics' | 'controls'>) {
    this.canvas = canvas;
    this.audio = audio;
    this.hooks = hooks;
    this.graphicsSettings = { ...settings.graphics };
    this.controlBindings = Object.fromEntries(
      Object.entries(settings.controls).map(([action, bindings]) => [action, [...bindings]]),
    ) as ControlBindings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioLimit()));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.18, 0.66, 0.12);
    this.bloomPass.enabled = this.graphicsSettings.bloom;
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
    this.chaseScene.add(this.vehicle);

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

  setGraphicsSettings(settings: GraphicsSettings): void {
    this.graphicsSettings = { ...settings };
    this.bloomPass.enabled = settings.bloom;
    this.rgbPass.enabled = settings.chromaticAberration && !settings.reducedFlashes;
    this.resize();
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

  async startRun(config: RunConfig): Promise<void> {
    this.config = config;
    this.trackId = config.track;
    this.buildWorld(config.track, config.seed);
    this.resetRun();
    await this.audio.start(true);
    this.state = 'countdown';
    this.countdown = 2.8;
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
    this.hooks.onToast(UPGRADES.find((upgrade) => upgrade.id === id)?.name || 'MODULE INSTALLED', 'Сборка болида обновлена', 'violet');
    this.pendingUpgradeOptions = [];
    if (this.queuedUpgradePicks > 0) {
      this.queuedUpgradePicks -= 1;
      this.openUpgrade();
    } else {
      this.emitUpgradeState();
    }
    return true;
  }

  setMobileControl(control: 'left' | 'right' | 'boost' | 'cool', active: boolean): void {
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
      this.hooks.onToast('PHASE SHIFT', 'Столкновения отключены', 'cyan');
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
    this.audio.stop();
    this.state = 'menu';
    this.resetBoostVisuals();
    this.config = null;
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.runUpgrades.clear();
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
    this.timelinePreview = createTrackTimeline(this.plan, profile);
    this.hooks.onTimeline(this.timelinePreview);
    this.disposeGroup(this.world);
    this.eventVisuals.clear();
    this.scene.background = new THREE.Color(theme.colors.background);
    this.scene.fog = new THREE.FogExp2(theme.colors.fog, 0.0021);

    const quality = this.graphicsSettings.quality;
    const tubeDivisor = quality === 'performance' ? 29 : quality === 'balanced' ? 23 : 18;
    const tubeSegments = clamp(
      Math.ceil(this.plan.length / tubeDivisor),
      quality === 'performance' ? 360 : quality === 'balanced' ? 480 : 620,
      quality === 'performance' ? 620 : quality === 'balanced' ? 820 : 1050,
    );
    const radialSegments = quality === 'performance' ? 12 : quality === 'balanced' ? 16 : 20;
    const tubeGeometry = new THREE.TubeGeometry(this.plan.curve, tubeSegments, this.plan.radius, radialSegments, false);
    this.tunnelMaterial = this.createTunnelMaterial(theme.colors.primary, theme.colors.secondary);
    const tunnel = new THREE.Mesh(tubeGeometry, this.tunnelMaterial);
    tunnel.frustumCulled = false;
    this.world.add(tunnel);

    this.addStructuralRings(theme.colors.primary, theme.colors.secondary);
    this.addTrackEvents();
    this.addExteriorParticles(theme.colors.primary, seed);
    this.createStreakField(theme.colors.primary, seed);
    this.createRivals();
    this.demoDistance = Math.min(this.plan.length * 0.045, 520);
  }

  private createTunnelMaterial(primary: number, secondary: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0.25 },
        uPulse: { value: 0 },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uPrimary: { value: new THREE.Color(primary) },
        uSecondary: { value: new THREE.Color(secondary) },
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
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }

  private addStructuralRings(primary: number, secondary: number): void {
    const geometry = new THREE.TorusGeometry(this.plan.radius - 0.16, 0.075, 4, 28);
    const material = new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity: 0.46, blending: THREE.AdditiveBlending });
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
    if (!['gate', 'halfwall', 'blade', 'cross', 'bastion'].includes(event.kind)) return null;
    const distance = event.distance - clamp(event.warningDistance * 0.62, 150, 280);
    if (distance < 35) return null;
    const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
    const group = new THREE.Group();
    group.userData.warningFor = event.id;
    group.position.copy(frame.position);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.normal, frame.binormal, frame.tangent));
    const warningColor = event.kind === 'gate'
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
    const safeAngle = event.safeAngle ?? (event.kind === 'gate'
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
    const colors: Array<[number, number]> = [[0xff4d9a, 0x7030ff], [0xffd65c, 0xff4c35], [0x79ffbb, 0x27a9ff]];
    const offsets = [32, -24, 65];
    const factors = [0.987, 1.016, 1.004];
    for (let index = 0; index < 3; index += 1) {
      const craft = this.createCraft(colors[index][0], colors[index][1], 0.72).group;
      const fadedMaterials = new Set<THREE.Material>();
      craft.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (fadedMaterials.has(material)) continue;
          fadedMaterials.add(material);
          material.transparent = true;
          material.opacity *= 0.58;
          material.depthWrite = false;
        }
      });
      this.dynamicLayer.add(craft);
      this.rivals.push({ mesh: craft, distance: offsets[index], angle: (index / 3) * TAU, speedFactor: factors[index], phase: index * 2.17 });
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
    this.section = 1;
    this.upgradeIndex = 0;
    this.upgradeRoll = 0;
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.lastCollisionCursor = 0;
    this.lastCollisionAudioTime = 0;
    this.runUpgrades.clear();
    this.emitUpgradeState();
    for (let index = 0; index < this.rivals.length; index += 1) {
      this.rivals[index].distance = [32, -24, 65][index];
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    const dt = clamp((now - this.lastFrameTime) / 1000, 0, 0.05);
    this.lastFrameTime = now;
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
      this.fixedAccumulator = Math.min(this.fixedAccumulator + dt, FIXED_STEP * 8);
      while (this.fixedAccumulator >= FIXED_STEP) {
        this.stepSimulation(FIXED_STEP);
        this.fixedAccumulator -= FIXED_STEP;
      }
    } else if (
      this.state === 'menu'
      || (this.state === 'finished' && this.impactFlashTimer <= 0 && this.chaseImpactEffects.length === 0)
    ) {
      this.demoDistance = (this.demoDistance + dt * 74) % Math.max(1, this.plan.length - 100);
      this.angle = wrapAngle(this.angle + dt * 0.12);
    }

    this.updateVisuals(dt);
    this.uiAccumulator += dt;
    if (this.uiAccumulator > 1 / 30) {
      this.uiAccumulator = 0;
      if (this.state === 'playing' || this.state === 'countdown') this.hooks.onHud(this.getStats());
    }
    this.composer.render(dt);
    if (this.vehicle.visible || this.chaseImpactEffects.length > 0) {
      const autoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.chaseScene, this.chaseCamera);
      this.renderer.autoClear = autoClear;
    }
    this.animationFrame = requestAnimationFrame(this.frame);
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden && this.state === 'playing') {
      this.visibilityPaused = true;
      this.audio.pause();
      return;
    }
    if (!document.hidden && this.visibilityPaused && this.state === 'playing') {
      this.visibilityPaused = false;
      this.lastFrameTime = performance.now();
      void this.audio.resume();
    }
  };

  private stepSimulation(dt: number): void {
    if (!this.config) return;
    const baseSpeed = this.plan.length / this.plan.runDuration;
    const theme = TRACKS[this.config.track];
    const left = this.isActionPressed('left') || this.mobileInput.get('left');
    const right = this.isActionPressed('right') || this.mobileInput.get('right');
    const cooling = this.isActionPressed('cool') || this.mobileInput.get('cool');
    const boostHeld = this.isActionPressed('boost') || this.mobileInput.get('boost');
    const steering = ((left ? 1 : 0) - (right ? 1 : 0)) as SteeringInput;
    const steeringState = stepWallRideSteering(
      { angle: this.angle, angularVelocity: this.angularVelocity },
      steering,
      theme.handling,
      this.config.garage.engine,
      dt,
    );
    this.angle = steeringState.angle;
    this.angularVelocity = steeringState.angularVelocity;

    this.abilityCooldown = Math.max(0, this.abilityCooldown - dt);
    this.weaponCooldown = Math.max(0, this.weaponCooldown - dt);
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);
    this.overheatTimer = Math.max(0, this.overheatTimer - dt);
    this.invulnerableTimer = Math.max(0, this.invulnerableTimer - dt);

    const redlineMultiplier = this.runUpgrades.has('redline-engine') ? 1.16 : 1;
    const engineMultiplier = 1 + this.config.garage.engine * 0.065;
    const maxSpeed = baseSpeed * 1.43 * engineMultiplier * redlineMultiplier;
    const cruisingSpeed = baseSpeed * (cooling ? 0.68 : 1);
    const boosting = boostHeld && this.flux > 0 && this.overheatTimer <= 0;
    const overdrive = this.overdriveTimer > 0;
    const musicDistance = clamp(this.audio.getTransportTime() / this.plan.runDuration, 0, 1) * this.plan.length;
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
      this.hooks.onToast('FORCED VENT', 'Реактор перегрет — тяга отключена', 'red');
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
    this.updateRivals(dt, baseSpeed);

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
      const onEventCue = isInsideMusicEventWindow(event.musicTime, audibleTime);
      const delta = angularDistance(this.angle, event.angle);
      if (event.kind === 'gate') {
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (delta > event.gapWidth * 0.69) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect('GATE SYNC');
        }
      } else if (event.kind === 'halfwall') {
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (delta < event.gapWidth + 0.16) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect('WALL SYNC');
        }
      } else if (event.kind === 'blade' || event.kind === 'cross') {
        const bladeDelta = this.rotorAngularDistance(event, audibleTime);
        if (isObstacleCollision(event, this.angle, audibleTime)) this.hitObstacle(event, audibleTime);
        else {
          event.resolved = true;
          if (bladeDelta < event.gapWidth + 0.14) this.registerNearMiss();
          else if (onEventCue) this.registerPerfect(event.kind === 'cross' ? 'CROSS SYNC' : 'BLADE SYNC');
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
      this.hooks.onToast('PHASED', 'Материя пропущена', 'cyan');
      return;
    }
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
    this.audio.playEffect('impact');
    this.spawnImpactEffects(event, impactAngle, impactDirection);
    this.hooks.onImpact(impactDirection);
    this.hooks.onToast(
      'IMPACT // DEFLECT',
      this.shield > 0 ? `AUTO-SLIDE // SHIELD ${this.shield}/${this.maxShield}` : 'HULL FAILURE',
      'red',
    );
    if (this.shield <= 0) this.finishRun(false);
  }

  private collectEvent(event: TrackEvent, label: string): void {
    this.audio.playEffect('pickup', label.startsWith('SLIPSTREAM') ? 1.15 : 0.82);
    const visual = this.eventVisuals.get(event.id);
    if (visual) {
      this.spawnBurst(visual.getWorldPosition(new THREE.Vector3()), TRACKS[this.trackId].colors.primary, 12);
      visual.visible = false;
    }
    this.hooks.onToast(label, 'Ресурс синхронизирован', 'cyan');
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

  private updateRivals(dt: number, baseSpeed: number): void {
    for (const rival of this.rivals) {
      const modulation = 1 + Math.sin(this.audio.getTime() * 0.7 + rival.phase) * 0.025;
      rival.distance = Math.min(this.plan.length, rival.distance + baseSpeed * rival.speedFactor * modulation * dt);
      rival.angle = wrapAngle(rival.angle + Math.sin(this.audio.getTime() * 0.5 + rival.phase) * dt * 0.12);
    }
  }

  private openUpgrade(): void {
    this.upgradeRoll += 1;
    const random = mulberry32(this.plan.seed ^ (this.upgradeRoll * 0x9e3779b9));
    const available = UPGRADES.filter((upgrade) => !this.runUpgrades.has(upgrade.id));
    this.pendingUpgradeOptions = pickDistinct(available, Math.min(3, available.length), random);
    this.emitUpgradeState();
    this.hooks.onToast('MODULE DROP', 'ВЫБЕРИ МОДУЛЬ СВЕРХУ — ДВИЖЕНИЕ ПРОДОЛЖАЕТСЯ', 'violet');
  }

  private emitUpgradeState(): void {
    const installed = UPGRADES.filter((upgrade) => this.runUpgrades.has(upgrade.id));
    this.hooks.onUpgradeState([...this.pendingUpgradeOptions], installed);
  }

  private registerPerfect(label: string): void {
    this.perfects += 1;
    this.sync = Math.min(32, this.sync + 1);
    this.score += 180 * (1 + this.sync * 0.08);
    this.flux = Math.min(100, this.flux + 5);
    if (this.runUpgrades.has('cryo-loop')) this.heat = Math.max(0, this.heat - 7);
    if (this.runUpgrades.has('echo-shield') && this.sync % 8 === 0) this.shield = Math.min(this.maxShield, this.shield + 1);
    this.audio.accentMusic(this.sync % 4 === 0 ? 1 : 0.45);
    if (this.sync % 4 === 0) this.hooks.onToast('PERFECT', `${label} / SYNC ×${this.sync}`, 'gold');
  }

  private registerNearMiss(): void {
    this.nearMisses += 1;
    this.score += 260 * (1 + this.sync * 0.04);
    if (this.runUpgrades.has('kinetic-skin')) {
      this.flux = Math.min(100, this.flux + 18);
      this.speed *= 1.035;
    } else {
      this.flux = Math.min(100, this.flux + 8);
    }
    this.hooks.onToast('NEAR MISS', '+FLOW', 'gold');
  }

  private finishRun(survived: boolean): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.audio.stop();
    this.pendingUpgradeOptions = [];
    this.queuedUpgradePicks = 0;
    this.emitUpgradeState();
    const rank = this.getRank();
    const accuracy = this.shots > 0 ? this.hits / this.shots : 0;
    const finalScore = Math.round(this.score + (survived ? 5000 : 0) + (4 - rank) * 1200);
    const credits = Math.max(90, Math.round(finalScore / 42 + this.kills * 8));
    const result: RunResult = {
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
    };
    window.setTimeout(() => this.hooks.onFinish(result), 420);
  }

  private updateVisuals(dt: number): void {
    const holdingFinalImpact = this.state === 'finished'
      && (this.impactFlashTimer > 0 || this.chaseImpactEffects.length > 0);
    const activeDistance = this.state === 'menu' || (this.state === 'finished' && !holdingFinalImpact)
      ? this.demoDistance
      : this.distance;
    const progress = clamp(activeDistance / this.plan.length, 0, 0.9998);
    const frame = sampleTrackFrame(this.plan, progress);
    const lookFrame = sampleTrackFrame(this.plan, clamp((activeDistance + 52) / this.plan.length, 0, 0.9999));
    const radial = radialAt(frame, this.angle);
    const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(this.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(this.angle))).normalize();
    const phaseTarget = this.phaseTimer > 0 ? this.plan.radius * 0.22 : this.plan.radius - 1.15;
    this.cameraRadial = damp(this.cameraRadial || phaseTarget, phaseTarget, this.phaseTimer > 0 ? 7 : 4, dt);
    this.updateChaseBoostVisuals(dt);
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
    this.vehicle.visible = this.state !== 'menu' && (this.state !== 'finished' || holdingFinalImpact);
    this.engineGlow.scale.setScalar(
      0.75 + this.lastBands.bass * 0.8 + boostStrength * 0.72 + (this.overdriveTimer > 0 ? 0.16 : 0),
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
    this.camera.position.lerp(cameraTarget, 1 - Math.exp(-dt * 10));
    this.camera.up.lerp(inward, 1 - Math.exp(-dt * 7)).normalize();
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

    if (this.tunnelMaterial) {
      this.tunnelMaterial.uniforms.uTime.value = this.audio.getTime() + performance.now() / 8000;
      this.tunnelMaterial.uniforms.uEnergy.value = this.lastBands.overall;
      this.tunnelMaterial.uniforms.uPulse.value = this.lastBands.pulse;
      this.tunnelMaterial.uniforms.uSpeed.value = speedRatio;
      this.tunnelMaterial.uniforms.uBoost.value = boostStrength
        * (this.graphicsSettings.reducedFlashes ? 0.52 : 1);
    }
    this.bloomPass.enabled = this.graphicsSettings.bloom;
    this.bloomPass.strength = this.graphicsSettings.reducedFlashes
      ? 0.62 + boostStrength * 0.08 + this.damageKick * 0.12
      : 0.92 + this.lastBands.pulse * 0.58 + speedRatio * 0.25 + boostStrength * 0.11
        + boostKick * 0.06 + this.damageKick * 0.38;
    this.bloomPass.radius = 0.48 + this.lastBands.highs * 0.22;
    this.rgbPass.enabled = this.graphicsSettings.chromaticAberration && !this.graphicsSettings.reducedFlashes;
    this.rgbPass.uniforms.amount.value = this.rgbPass.enabled
      ? 0.00015 + speedRatio * 0.00055 + boostStrength * 0.00072 + boostKick * 0.00038
        + (this.overdriveTimer > 0 ? 0.0008 : 0) + this.damageKick * 0.0018
      : 0;
    this.renderer.toneMappingExposure = 0.98
      + this.lastBands.pulse * 0.15
      + boostStrength * (this.graphicsSettings.reducedFlashes ? 0.008 : 0.016)
      + this.damageKick * (this.graphicsSettings.reducedFlashes ? 0.025 : 0.08);

    this.updateEventVisuals(dt, activeDistance);
    this.updateBulletVisuals();
    this.updateRivalVisuals();
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
      if (!['gate', 'halfwall', 'blade', 'cross', 'bastion'].includes(event.kind)) visual.scale.setScalar(damp(visual.scale.x, pulse, 8, dt));
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

  private updateRivalVisuals(): void {
    for (const rival of this.rivals) {
      const ahead = rival.distance - this.distance;
      rival.mesh.visible = this.state === 'menu' ? false : ahead > -100 && ahead < 800;
      if (!rival.mesh.visible) continue;
      const frame = sampleTrackFrame(this.plan, clamp(rival.distance / this.plan.length, 0, 0.9999));
      const radial = radialAt(frame, rival.angle);
      const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(rival.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(rival.angle))).normalize();
      rival.mesh.position.copy(frame.position).add(radial.clone().multiplyScalar(this.plan.radius - 1.4));
      rival.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(circumferential, radial, frame.tangent));
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
    return 1 + this.rivals.filter((rival) => rival.distance > this.distance + 2).length;
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
    };
  }

  private disposeGroup(group: THREE.Group): void {
    const children = [...group.children];
    for (const child of children) {
      group.remove(child);
      child.traverse((object) => {
        if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments)) return;
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose();
      });
    }
  }

  private removeAndDispose(object: THREE.Object3D): void {
    object.parent?.remove(object);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) return;
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material?.dispose();
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
    this.disposeGroup(this.dynamicLayer);
    for (const effect of this.chaseImpactEffects) {
      this.removeAndDispose(effect.sparks);
      this.removeAndDispose(effect.wave);
    }
    this.chaseImpactEffects.length = 0;
    this.removeAndDispose(this.vehicle);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
