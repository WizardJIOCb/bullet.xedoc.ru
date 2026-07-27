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
import { generateTrack, radialAt, sampleTrackFrame, type TrackFrame, type TrackPlan } from './track';

type GameState = 'menu' | 'countdown' | 'playing' | 'finished';

interface GameHooks {
  onHud: (stats: RunStats) => void;
  onToast: (message: string, detail?: string, tone?: 'cyan' | 'gold' | 'red' | 'violet') => void;
  onUpgradeState: (pending: UpgradeDefinition[], installed: UpgradeDefinition[]) => void;
  onFinish: (result: RunResult) => void;
  onCountdown: (value: string | null) => void;
  onSection: (name: string, index: number) => void;
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
  private readonly rivals: Rival[] = [];
  private readonly vehicle: THREE.Group;
  private readonly engineGlow: THREE.Group;
  private streakGeometry: THREE.BufferGeometry | null = null;
  private streakLines: THREE.LineSegments | null = null;
  private streaks: StreakSpec[] = [];
  private tunnelMaterial: THREE.ShaderMaterial | null = null;
  private plan: TrackPlan;
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
  private previousDistance = 0;
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
  private runUpgrades = new Set<UpgradeId>();
  private lastBands: AudioBands = { bass: 0, mids: 0, highs: 0, overall: 0, pulse: 0, onBeat: false };
  private cameraRadial = 0;
  private damageKick = 0;
  private reducedEffects = false;
  private disposed = false;
  private visibilityPaused = false;

  constructor(canvas: HTMLCanvasElement, audio: AudioEngine, hooks: GameHooks) {
    this.canvas = canvas;
    this.audio = audio;
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.18, 0.66, 0.12);
    this.composer.addPass(this.bloomPass);
    this.rgbPass = new ShaderPass(RGBShiftShader);
    this.rgbPass.uniforms.amount.value = 0.00025;
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

  setReducedEffects(enabled: boolean): void {
    this.reducedEffects = enabled;
    this.bloomPass.strength = enabled ? 0.72 : 1.18;
    this.rgbPass.enabled = !enabled;
  }

  async startRun(config: RunConfig): Promise<void> {
    this.config = config;
    this.trackId = config.track;
    this.buildWorld(config.track, config.seed);
    this.resetRun();
    await this.audio.start();
    this.audio.pause();
    this.state = 'countdown';
    this.countdown = 2.8;
    this.hooks.onCountdown('3');
  }

  chooseUpgrade(id: UpgradeId): boolean {
    if (this.state !== 'playing' || !this.pendingUpgradeOptions.some((upgrade) => upgrade.id === id)) return false;
    this.runUpgrades.add(id);
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
    const cooldownFactor = this.runUpgrades.has('phase-battery') ? 0.75 : 1;
    this.abilityCooldown = ability.cooldown * cooldownFactor;
    if (ability.id === 'phase') {
      this.phaseTimer = this.runUpgrades.has('afterburner') ? 2.6 : 1.4;
      this.hooks.onToast('PHASE SHIFT', 'Столкновения отключены', 'cyan');
    } else if (ability.id === 'emp') {
      let destroyed = 0;
      for (const event of this.plan.events) {
        if (!event.destroyed && !event.resolved && event.distance > this.distance && event.distance < this.distance + 190 && (event.kind === 'mine' || event.kind === 'drone')) {
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.chaseCamera.aspect = width / height;
    this.chaseCamera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
  };

  private bindInput(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    const isEditing = target instanceof HTMLElement && Boolean(target.closest('input, select, textarea, [contenteditable="true"]'));
    const upgradeDigit = event.code.match(/^(?:Digit|Numpad)([1-3])$/)?.[1]
      ?? (['1', '2', '3'].includes(event.key) ? event.key : null);
    const upgradeIndex = upgradeDigit ? Number(upgradeDigit) - 1 : -1;
    if (!isEditing && !event.repeat && upgradeIndex >= 0 && this.pendingUpgradeOptions[upgradeIndex]) {
      event.preventDefault();
      this.chooseUpgrade(this.pendingUpgradeOptions[upgradeIndex].id);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Space'].includes(event.code)) event.preventDefault();
    this.keys.add(event.code);
    if (!event.repeat && ['KeyF', 'Enter'].includes(event.code)) this.fire();
    if (!event.repeat && ['KeyQ', 'KeyE'].includes(event.code)) this.activateAbility();
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
    this.disposeGroup(this.world);
    this.eventVisuals.clear();
    this.scene.background = new THREE.Color(theme.colors.background);
    this.scene.fog = new THREE.FogExp2(theme.colors.fog, 0.0021);

    const tubeSegments = clamp(Math.ceil(this.plan.length / 18), 620, 1050);
    const tubeGeometry = new THREE.TubeGeometry(this.plan.curve, tubeSegments, this.plan.radius, 20, false);
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
          vec3 base = vec3(0.003, 0.006, 0.013) + uPrimary * 0.014;
          vec3 railColor = mix(uPrimary, uSecondary, smoothstep(0.1, 0.9, vUv.y));
          float edge = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.0);
          vec3 color = base + railColor * (ribs * (0.34 + uEnergy * 0.9) + lanes * 0.4 + micro + pulseWave);
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
    if (!['gate', 'halfwall', 'blade', 'cross', 'mine', 'drone'].includes(event.kind)) return null;
    const distance = event.distance - clamp(event.warningDistance * 0.62, 150, 280);
    if (distance < 35) return null;
    const frame = sampleTrackFrame(this.plan, distance / this.plan.length);
    const group = new THREE.Group();
    group.userData.warningFor = event.id;
    group.position.copy(frame.position);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(frame.normal, frame.binormal, frame.tangent));
    const warningColor = event.kind === 'mine' || event.kind === 'drone' ? 0xff9b42 : 0xffd35a;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.plan.radius - 0.62, 0.085, 4, 36),
      new THREE.MeshBasicMaterial({ color: warningColor, transparent: true, opacity: 0.48, toneMapped: false }),
    );
    group.add(ring);
    const safeAngle = event.kind === 'gate'
      ? event.angle
      : event.kind === 'halfwall'
        ? event.angle + Math.PI
        : event.kind === 'blade' || event.kind === 'cross'
          ? event.rotationPhase + Math.PI / Math.max(2, event.armCount)
          : event.angle + Math.PI;
    const markerGeometry = new THREE.BoxGeometry(1.25, 0.18, 0.7);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0a3, toneMapped: false });
    for (const offset of [-0.16, 0, 0.16]) {
      const angle = safeAngle + offset;
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(Math.cos(angle) * (this.plan.radius - 1.02), Math.sin(angle) * (this.plan.radius - 1.02), 0);
      marker.rotation.z = angle + Math.PI / 2;
      group.add(marker);
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
      const geometry = new THREE.BoxGeometry(4.25, 1.35, 2.65);
      const material = new THREE.MeshStandardMaterial({
        color: 0x240308,
        emissive: theme.colors.danger,
        emissiveIntensity: 0.24,
        roughness: 0.62,
        metalness: 0.36,
      });
      const warningMaterial = new THREE.MeshBasicMaterial({ color: 0xffd45b, toneMapped: false });
      for (let lane = 0; lane < 16; lane += 1) {
        const angle = (lane / 16) * TAU;
        if (angularDistance(angle, event.angle) < event.gapWidth) continue;
        const radial = radialAt(frame, angle);
        const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(angle))).normalize();
        const position = frame.position.clone().add(radial.clone().multiplyScalar(this.plan.radius - 0.75));
        matrix.makeBasis(circumferential, radial, frame.tangent);
        const panel = new THREE.Mesh(geometry, material);
        panel.position.copy(position);
        panel.quaternion.setFromRotationMatrix(matrix);
        visual.add(panel);
        if (lane % 3 === 0) {
          const marker = new THREE.Mesh(new THREE.BoxGeometry(4.36, 0.12, 2.74), warningMaterial);
          marker.position.copy(position);
          marker.quaternion.copy(panel.quaternion);
          visual.add(marker);
        }
      }
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(this.plan.radius - 0.48, 0.14, 5, 48, Math.max(0.35, event.gapWidth * 2)),
        new THREE.MeshBasicMaterial({ color: 0xffe57a, transparent: true, opacity: 0.84, blending: THREE.AdditiveBlending }),
      );
      halo.position.copy(frame.position);
      halo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), frame.tangent);
      halo.rotateZ(event.angle - event.gapWidth);
      visual.add(halo);
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
      const armLength = this.plan.radius - 0.74;
      const armThickness = Math.max(1.2, 2 * armLength * Math.tan(event.gapWidth));
      const armGeometry = new THREE.BoxGeometry(armLength, armThickness, 2.15);
      const armMaterial = new THREE.MeshStandardMaterial({
        color: event.kind === 'cross' ? 0x16030d : 0x1c0306,
        emissive: theme.colors.danger,
        emissiveIntensity: 0.22,
        roughness: 0.58,
        metalness: 0.48,
      });
      const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf61, side: THREE.BackSide, toneMapped: false });
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
        new THREE.MeshBasicMaterial({ color: 0xffefc1, toneMapped: false }),
      );
      hub.rotation.x = Math.PI / 2;
      rotor.add(hub);
      rotor.rotation.z = event.rotationPhase - event.rotationRate * event.musicTime;
      visual.userData.rotor = rotor;
      visual.add(rotor);
      return visual;
    }

    const radialDistance = event.kind === 'drone' ? this.plan.radius - 4.1 : this.plan.radius - 1.8;
    const radial = radialAt(frame, event.angle);
    const position = frame.position.clone().add(radial.multiplyScalar(radialDistance));
    const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(event.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(event.angle))).normalize();
    matrix.makeBasis(circumferential, radialAt(frame, event.angle), frame.tangent);
    visual.position.copy(position);
    visual.quaternion.setFromRotationMatrix(matrix);

    if (event.kind === 'mine') {
      const mine = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.42, 1),
        new THREE.MeshStandardMaterial({ color: 0x300408, emissive: theme.colors.danger, emissiveIntensity: 0.34, metalness: 0.48, roughness: 0.5 }),
      );
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.05, 0.14, 6, 28),
        new THREE.MeshBasicMaterial({ color: 0xffd45b, transparent: true, opacity: 0.92, toneMapped: false }),
      );
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.54, 1),
        new THREE.MeshBasicMaterial({ color: 0xffc45b, wireframe: true, transparent: true, opacity: 0.84, toneMapped: false }),
      );
      visual.add(mine, core, ring);
    } else if (event.kind === 'shard') {
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
    } else {
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(1.25, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0x27040b, emissive: theme.colors.danger, emissiveIntensity: 0.3, metalness: 0.58, roughness: 0.46 }),
      );
      const wingGeometry = new THREE.BoxGeometry(4.4, 0.28, 0.84);
      const wingMaterial = new THREE.MeshBasicMaterial({ color: 0xffc857, toneMapped: false });
      const warningRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.25, 0.12, 6, 28),
        new THREE.MeshBasicMaterial({ color: 0xffe79a, transparent: true, opacity: 0.88, toneMapped: false }),
      );
      visual.add(body, new THREE.Mesh(wingGeometry, wingMaterial), warningRing);
    }
    return visual;
  }

  private addExteriorParticles(color: number, seed: number): void {
    const random = mulberry32(seed ^ 0xfade);
    const count = 900;
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
    this.streaks = Array.from({ length: 72 }, () => ({
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

  private createCraft(primary: number, secondary: number, scale: number): { group: THREE.Group; engineGlow: THREE.Group } {
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
      group.add(trail);
    }
    const reactorMaterial = glowMaterial.clone();
    reactorMaterial.color.setHex(secondary);
    reactorMaterial.opacity = 0.28;
    const reactor = new THREE.Mesh(new THREE.CircleGeometry(0.14, 14), reactorMaterial);
    engineGlow.add(reactor);

    group.add(bodyOutline, wingOutline, body, rearHull, canopy, wings, sternPlate, leftFacet, rightFacet, wingEdge, engineGlow);
    return { group, engineGlow };
  }

  private resetRun(): void {
    if (!this.config) return;
    for (const event of this.plan.events) {
      event.resolved = false;
      event.destroyed = false;
      event.health = event.kind === 'drone' ? Math.max(2, event.health) : 1;
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
    const baseSpeed = this.plan.length / this.plan.runDuration;
    this.distance = 0;
    this.previousDistance = 0;
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
    this.overheatTimer = 0;
    this.invulnerableTimer = 0;
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
    } else if (this.state === 'menu' || this.state === 'finished') {
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
    if (this.vehicle.visible) {
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
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft') || this.mobileInput.get('left');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight') || this.mobileInput.get('right');
    const cooling = this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.mobileInput.get('cool');
    const boostHeld = this.keys.has('Space') || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.mobileInput.get('boost');
    const steering = (left ? 1 : 0) - (right ? 1 : 0);
    const steeringForce = 6.8 * theme.handling * (1 + this.config.garage.engine * 0.025);
    this.angularVelocity += steering * steeringForce * dt;
    this.angularVelocity *= Math.exp(-dt * 4.5);
    this.angularVelocity = clamp(this.angularVelocity, -2.65, 2.65);
    this.angle = wrapAngle(this.angle + this.angularVelocity * dt);

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

    this.previousDistance = this.distance;
    this.distance = Math.min(this.plan.length, this.distance + this.speed * dt);
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
    while (this.lastCollisionCursor < this.plan.events.length && this.plan.events[this.lastCollisionCursor].distance < this.previousDistance - 8) {
      this.lastCollisionCursor += 1;
    }
    for (let index = this.lastCollisionCursor; index < this.plan.events.length; index += 1) {
      const event = this.plan.events[index];
      if (event.distance > this.distance + 7) break;
      if (event.resolved || event.destroyed || event.distance < this.previousDistance - 7) continue;
      const delta = angularDistance(this.angle, event.angle);
      if (event.kind === 'gate') {
        if (delta > event.gapWidth) this.hitObstacle(event);
        else {
          event.resolved = true;
          if (delta > event.gapWidth * 0.69) this.registerNearMiss();
          else if (this.audio.isInsideBeatWindow()) this.registerPerfect('GATE SYNC');
        }
      } else if (event.kind === 'halfwall') {
        if (delta < event.gapWidth) this.hitObstacle(event);
        else {
          event.resolved = true;
          if (delta < event.gapWidth + 0.16) this.registerNearMiss();
          else if (this.audio.isInsideBeatWindow()) this.registerPerfect('WALL SYNC');
        }
      } else if (event.kind === 'blade' || event.kind === 'cross') {
        const bladeDelta = this.rotorAngularDistance(event, this.audio.getTransportTime());
        if (bladeDelta < event.gapWidth) this.hitObstacle(event);
        else {
          event.resolved = true;
          if (bladeDelta < event.gapWidth + 0.14) this.registerNearMiss();
          else if (this.audio.isInsideBeatWindow()) this.registerPerfect(event.kind === 'cross' ? 'CROSS SYNC' : 'BLADE SYNC');
        }
      } else if (event.kind === 'mine' || event.kind === 'drone') {
        const threshold = event.kind === 'mine' ? 0.4 : 0.45;
        if (delta < threshold) this.hitObstacle(event);
        else {
          event.resolved = true;
          if (delta < threshold + 0.18) this.registerNearMiss();
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
          if (this.audio.isInsideBeatWindow()) this.registerPerfect('BOOST SYNC');
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
    const armCount = Math.max(1, event.armCount);
    let closest = Math.PI;
    for (let arm = 0; arm < armCount; arm += 1) {
      closest = Math.min(closest, angularDistance(this.angle, phase + (arm / armCount) * TAU));
    }
    return closest;
  }

  private hitObstacle(event: TrackEvent): void {
    event.resolved = true;
    if (this.phaseTimer > 0 || this.invulnerableTimer > 0) {
      this.score += 160;
      this.hooks.onToast('PHASED', 'Материя пропущена', 'cyan');
      return;
    }
    this.shield -= 1;
    this.speed *= 0.58;
    this.heat = clamp(this.heat + 21, 0, 100);
    this.sync = 0;
    this.invulnerableTimer = 0.9;
    this.damageKick = 1;
    const visual = this.eventVisuals.get(event.id);
    if (visual) this.spawnBurst(visual.getWorldPosition(new THREE.Vector3()), TRACKS[this.trackId].colors.danger, 22);
    this.hooks.onToast('IMPACT', this.shield > 0 ? `SHIELD ${this.shield}/${this.maxShield}` : 'HULL FAILURE', 'red');
    if (this.shield <= 0) this.finishRun(false);
  }

  private collectEvent(event: TrackEvent, label: string): void {
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
        if (event.destroyed || event.resolved || (event.kind !== 'mine' && event.kind !== 'drone')) continue;
        if (event.distance < bullet.distance - 12) continue;
        if (event.distance > bullet.distance + 12) break;
        if (angularDistance(event.angle, bullet.angle) < (event.kind === 'drone' ? 0.46 : 0.4)) {
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
    this.score += event.kind === 'drone' ? 620 : 280;
    this.flux = Math.min(100, this.flux + (event.kind === 'drone' ? 13 : 7));
    const visual = this.eventVisuals.get(event.id);
    if (visual) {
      const position = visual.getWorldPosition(new THREE.Vector3());
      this.spawnBurst(position, event.kind === 'drone' ? 0xff547f : 0xffa33b, fromAbility ? 26 : 18);
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
    this.hooks.onToast('MODULE DROP', 'Выбери 1 / 2 / 3 — движение продолжается', 'violet');
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
    const activeDistance = this.state === 'menu' || this.state === 'finished' ? this.demoDistance : this.distance;
    const progress = clamp(activeDistance / this.plan.length, 0, 0.9998);
    const frame = sampleTrackFrame(this.plan, progress);
    const lookFrame = sampleTrackFrame(this.plan, clamp((activeDistance + 52) / this.plan.length, 0, 0.9999));
    const radial = radialAt(frame, this.angle);
    const circumferential = frame.normal.clone().multiplyScalar(-Math.sin(this.angle)).add(frame.binormal.clone().multiplyScalar(Math.cos(this.angle))).normalize();
    const phaseTarget = this.phaseTimer > 0 ? this.plan.radius * 0.22 : this.plan.radius - 1.15;
    this.cameraRadial = damp(this.cameraRadial || phaseTarget, phaseTarget, this.phaseTimer > 0 ? 7 : 4, dt);
    const craftLean = clamp(this.angularVelocity * 0.045, -0.24, 0.24);
    this.vehicle.position.x = damp(this.vehicle.position.x, -craftLean * 1.35, 7, dt);
    this.vehicle.position.y = damp(this.vehicle.position.y, -2.7, 7, dt);
    this.vehicle.position.z = damp(this.vehicle.position.z || -8.6, -8.6, 9, dt);
    this.vehicle.rotation.set(-0.06, Math.PI, craftLean);
    this.vehicle.visible = this.state !== 'menu' && this.state !== 'finished';
    this.engineGlow.scale.setScalar(0.75 + this.lastBands.bass * 0.8 + (this.overdriveTimer > 0 ? 1.1 : 0));

    const speedRatio = this.config ? clamp(this.speed / (this.plan.length / this.plan.runDuration * 1.55), 0, 1.25) : 0.34;
    const cameraRadialDistance = Math.max(0.6, this.cameraRadial - 3.35);
    const cameraTarget = frame.position.clone().add(radial.clone().multiplyScalar(cameraRadialDistance)).add(frame.tangent.clone().multiplyScalar(-6.8));
    const inward = radial.clone().multiplyScalar(-1);
    const shake = this.reducedEffects ? 0 : (speedRatio * 0.025 + this.damageKick * 0.16) * (0.3 + this.lastBands.bass);
    cameraTarget.add(circumferential.clone().multiplyScalar(Math.sin(performance.now() * 0.037) * shake));
    cameraTarget.add(inward.clone().multiplyScalar(Math.cos(performance.now() * 0.031) * shake));
    if (this.camera.position.lengthSq() === 0) this.camera.position.copy(cameraTarget);
    this.camera.position.lerp(cameraTarget, 1 - Math.exp(-dt * 10));
    this.camera.up.lerp(inward, 1 - Math.exp(-dt * 7)).normalize();
    const lookRadial = radialAt(lookFrame, this.angle).multiplyScalar(Math.max(0.5, this.cameraRadial - 1));
    const lookTarget = lookFrame.position.clone().add(lookRadial);
    this.camera.lookAt(lookTarget);
    const targetFov = clamp(72 + speedRatio * 19 + (this.overdriveTimer > 0 ? 3 : 0), 74, 98);
    this.camera.fov = damp(this.camera.fov, targetFov, 4.5, dt);
    this.camera.updateProjectionMatrix();
    this.damageKick *= Math.exp(-dt * 8);

    if (this.tunnelMaterial) {
      this.tunnelMaterial.uniforms.uTime.value = this.audio.getTime() + performance.now() / 8000;
      this.tunnelMaterial.uniforms.uEnergy.value = this.lastBands.overall;
      this.tunnelMaterial.uniforms.uPulse.value = this.lastBands.pulse;
      this.tunnelMaterial.uniforms.uSpeed.value = speedRatio;
    }
    this.bloomPass.strength = this.reducedEffects ? 0.62 : 0.92 + this.lastBands.pulse * 0.58 + speedRatio * 0.25;
    this.bloomPass.radius = 0.48 + this.lastBands.highs * 0.22;
    this.rgbPass.uniforms.amount.value = this.reducedEffects ? 0 : 0.00015 + speedRatio * 0.00055 + (this.overdriveTimer > 0 ? 0.0012 : 0) + this.damageKick * 0.0018;
    this.renderer.toneMappingExposure = 0.98 + this.lastBands.pulse * 0.15;

    this.updateEventVisuals(dt, activeDistance);
    this.updateBulletVisuals();
    this.updateRivalVisuals();
    this.updateStreaks(activeDistance, speedRatio);
    this.updateBursts(dt);
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
      if (!['gate', 'halfwall', 'blade', 'cross'].includes(event.kind)) visual.scale.setScalar(damp(visual.scale.x, pulse, 8, dt));
      const rotor = visual.userData.rotor as THREE.Group | undefined;
      if (rotor) rotor.rotation.z = event.rotationPhase + event.rotationRate * (transportTime - event.musicTime);
      if (event.kind === 'mine' || event.kind === 'shard' || event.kind === 'coolant') visual.rotateZ(dt * (event.kind === 'mine' ? 1.2 : 2.4));
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

  private updateStreaks(activeDistance: number, speedRatio: number): void {
    if (!this.streakGeometry) return;
    const attribute = this.streakGeometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attribute.array as Float32Array;
    const travel = (this.audio.getTime() * (80 + speedRatio * 220)) % 220;
    for (let index = 0; index < this.streaks.length; index += 1) {
      const spec = this.streaks[index];
      const offset = 12 + ((spec.offset - travel + 440) % 220);
      const startDistance = clamp(activeDistance + offset, 0, this.plan.length - 2);
      const endDistance = clamp(startDistance + spec.length * (1 + speedRatio * 2.8), 0, this.plan.length - 1);
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
  }

  private spawnBurst(position: THREE.Vector3, color: number, count: number): void {
    const random = mulberry32((this.plan.seed + this.bursts.length * 101 + Math.floor(this.distance)) >>> 0);
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = position.x;
      positions[index * 3 + 1] = position.y;
      positions[index * 3 + 2] = position.z;
      velocities.push(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(5 + random() * 16));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color, size: 0.34, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.dynamicLayer.add(points);
    this.bursts.push({ points, velocities, life: 0.8, maxLife: 0.8 });
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
        burst.velocities[index].multiplyScalar(Math.exp(-dt * 2));
      }
      attribute.needsUpdate = true;
      (burst.points.material as THREE.PointsMaterial).opacity = clamp(burst.life / burst.maxLife, 0, 1);
      if (burst.life <= 0) {
        this.removeAndDispose(burst.points);
        this.bursts.splice(burstIndex, 1);
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
    this.canvas.removeEventListener('pointerdown', this.handleCanvasPointerDown);
    this.disposeGroup(this.world);
    this.disposeGroup(this.dynamicLayer);
    this.removeAndDispose(this.vehicle);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
