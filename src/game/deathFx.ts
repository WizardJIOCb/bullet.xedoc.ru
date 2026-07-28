import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/math';
import type { GraphicsQuality } from '../settings/SettingsStore';
import { DEATH_BREAKUP_DELAY, DEATH_SEQUENCE_DURATION } from './deathSequence';

export type DeathFxVariant = 'reactor-bloom' | 'lateral-shear' | 'engine-rupture';

export interface DeathFxBudget {
  shards: number;
  sparks: number;
  rings: number;
  flashScale: number;
}

export interface ChaseDeathFxStartOptions {
  seed: number;
  quality: GraphicsQuality;
  reducedFlashes: boolean;
  impactDirection?: -1 | 1;
  variant?: DeathFxVariant;
}

/**
 * The same object is reused by every update. Consumers should read it
 * immediately instead of retaining it as a historical snapshot.
 */
export interface ChaseDeathFxFrame {
  active: boolean;
  justFinished: boolean;
  resultReady: boolean;
  elapsed: number;
  progress: number;
  cameraOffsetX: number;
  cameraOffsetY: number;
  cameraRoll: number;
  fovKick: number;
  exposureKick: number;
}

interface FragmentMaterialState {
  material: THREE.Material;
  baseOpacity: number;
  baseColor: THREE.Color | null;
}

interface FragmentState {
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  baseScale: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  delay: number;
  materials: FragmentMaterialState[];
}

interface ParticleState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  scale: number;
  life: number;
  maxLife: number;
}

const VARIANTS: readonly DeathFxVariant[] = ['reactor-bloom', 'lateral-shear', 'engine-rupture'];
const MAX_SHARDS = 36;
const MAX_SPARKS = 44;
const RESULT_READY_AT = 1.32;
const HOT_FRAGMENT_COLOR = new THREE.Color(0xff7338);
const SHARD_COLORS = [new THREE.Color(0xff6a35), new THREE.Color(0xffd38a), new THREE.Color(0x57efff), new THREE.Color(0xb166ff)];

const DEAD_FRAME: ChaseDeathFxFrame = {
  active: false,
  justFinished: false,
  resultReady: false,
  elapsed: 0,
  progress: 0,
  cameraOffsetX: 0,
  cameraOffsetY: 0,
  cameraRoll: 0,
  fovKick: 0,
  exposureKick: 0,
};

export function resolveDeathFxVariant(seed: number): DeathFxVariant {
  const normalized = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
  return VARIANTS[normalized % VARIANTS.length];
}

export function resolveDeathFxBudget(quality: GraphicsQuality, reducedFlashes: boolean): DeathFxBudget {
  const base = quality === 'performance'
    ? { shards: 12, sparks: 18, rings: 1 }
    : quality === 'quality'
      ? { shards: 36, sparks: 44, rings: 3 }
      : { shards: 22, sparks: 30, rings: 2 };
  return {
    shards: reducedFlashes ? Math.max(8, Math.round(base.shards * 0.72)) : base.shards,
    sparks: reducedFlashes ? Math.max(10, Math.round(base.sparks * 0.62)) : base.sparks,
    rings: reducedFlashes ? Math.min(2, base.rings) : base.rings,
    flashScale: reducedFlashes ? 0.38 : 1,
  };
}

function hasColor(material: THREE.Material): material is THREE.Material & { color: THREE.Color } {
  return 'color' in material && material.color instanceof THREE.Color;
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function isUsefulTopLevelFragment(object: THREE.Object3D): object is THREE.Mesh {
  if (!(object instanceof THREE.Mesh) || !object.visible) return false;
  const materials = materialsOf(object);
  return materials.some((material) => (
    material.visible
    && material.opacity > 0.01
    && !material.transparent
    && material.blending === THREE.NormalBlending
    && material.side !== THREE.BackSide
  ));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

/**
 * Persistent, allocation-free-per-frame destruction effect for the player's
 * chase-scene craft. Add `group` as a sibling of `source` in the chase scene.
 * Source geometry and materials are cloned once and never disposed by this
 * effect.
 */
export class ChaseDeathFx {
  readonly group = new THREE.Group();
  readonly duration = DEATH_SEQUENCE_DURATION;
  readonly resultReadyAt = RESULT_READY_AT;

  private readonly source: THREE.Group;
  private readonly fragments: FragmentState[] = [];
  private readonly center = new THREE.Vector3();
  private readonly core: THREE.Mesh;
  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly shards: THREE.InstancedMesh;
  private readonly shardStates: ParticleState[] = [];
  private readonly shardDummy = new THREE.Object3D();
  private readonly sparks: THREE.LineSegments;
  private readonly sparkStates: ParticleState[] = [];
  private readonly fragmentTrails: THREE.LineSegments;
  private readonly frameState: ChaseDeathFxFrame = { ...DEAD_FRAME };
  private readonly poseMatrix = new THREE.Matrix4();
  private readonly inverseParentMatrix = new THREE.Matrix4();
  private readonly scratchDirection = new THREE.Vector3();
  private readonly scratchScatter = new THREE.Vector3();
  private readonly scratchTail = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();

  private running = false;
  private disposed = false;
  private elapsed = 0;
  private activeShardCount = 0;
  private activeSparkCount = 0;
  private activeRingCount = 0;
  private reducedFlashes = false;
  private flashScale = 1;
  private variant: DeathFxVariant = 'reactor-bloom';
  private impactDirection: -1 | 1 = 1;
  private seed = 0;

  constructor(source: THREE.Group) {
    this.source = source;
    this.group.name = 'player-death-fx';
    this.group.visible = false;

    const topLevelMeshes = source.children.filter(isUsefulTopLevelFragment);
    for (let index = 0; index < topLevelMeshes.length; index += 1) {
      const sourceMesh = topLevelMeshes[index];
      sourceMesh.updateMatrix();
      const geometry = sourceMesh.geometry.clone();
      const sourceMaterials = materialsOf(sourceMesh);
      const clonedMaterials = sourceMaterials.map((sourceMaterial) => {
        const material = sourceMaterial.clone();
        material.transparent = true;
        material.opacity = sourceMaterial.opacity;
        material.depthTest = true;
        material.depthWrite = true;
        material.toneMapped = false;
        material.blending = THREE.NormalBlending;
        return material;
      });
      const mesh = new THREE.Mesh(geometry, Array.isArray(sourceMesh.material) ? clonedMaterials : clonedMaterials[0]);
      sourceMesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.name = `death-fragment-${index}`;
      mesh.renderOrder = 41;
      mesh.visible = false;
      this.group.add(mesh);
      this.center.add(mesh.position);
      this.fragments.push({
        mesh,
        basePosition: mesh.position.clone(),
        baseQuaternion: mesh.quaternion.clone(),
        baseScale: mesh.scale.clone(),
        velocity: new THREE.Vector3(),
        angularVelocity: new THREE.Vector3(),
        delay: 0,
        materials: clonedMaterials.map((material) => ({
          material,
          baseOpacity: material.opacity,
          baseColor: hasColor(material) ? material.color.clone() : null,
        })),
      });
    }
    if (this.fragments.length > 0) this.center.multiplyScalar(1 / this.fragments.length);

    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb05f,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 12), this.coreMaterial);
    this.core.name = 'death-reactor-core';
    this.core.position.copy(this.center);
    this.core.renderOrder = 45;
    this.core.visible = false;
    this.group.add(this.core);

    const ringColors = [0xff8d45, 0x55eeff, 0xb46aff];
    for (let index = 0; index < 3; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: ringColors[index],
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.39, 40), material);
      ring.name = `death-shockwave-${index}`;
      ring.position.copy(this.center);
      ring.renderOrder = 46 + index;
      ring.visible = false;
      this.rings.push(ring);
      this.ringMaterials.push(material);
      this.group.add(ring);
    }

    const shardGeometry = new THREE.TetrahedronGeometry(0.16, 0);
    const shardMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, MAX_SHARDS);
    this.shards.name = 'death-shards';
    this.shards.count = 0;
    this.shards.renderOrder = 42;
    this.shards.frustumCulled = false;
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.visible = false;
    this.group.add(this.shards);
    for (let index = 0; index < MAX_SHARDS; index += 1) this.shardStates.push(this.createParticleState());

    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 6), 3));
    const sparkColors = new Float32Array(MAX_SPARKS * 6);
    const sparkHot = new THREE.Color(0xfff0c7);
    const sparkEmber = new THREE.Color(0xff5a2f);
    for (let index = 0; index < MAX_SPARKS; index += 1) {
      sparkColors.set([sparkHot.r, sparkHot.g, sparkHot.b, sparkEmber.r, sparkEmber.g, sparkEmber.b], index * 6);
    }
    sparkGeometry.setAttribute('color', new THREE.BufferAttribute(sparkColors, 3));
    sparkGeometry.setDrawRange(0, 0);
    const sparkMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.sparks = new THREE.LineSegments(sparkGeometry, sparkMaterial);
    this.sparks.name = 'death-sparks';
    this.sparks.renderOrder = 50;
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    this.group.add(this.sparks);
    for (let index = 0; index < MAX_SPARKS; index += 1) this.sparkStates.push(this.createParticleState());

    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.fragments.length) * 6), 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.fragments.length) * 6), 3));
    trailGeometry.setDrawRange(0, this.fragments.length * 2);
    const trailMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.fragmentTrails = new THREE.LineSegments(trailGeometry, trailMaterial);
    this.fragmentTrails.name = 'death-fragment-trails';
    this.fragmentTrails.renderOrder = 49;
    this.fragmentTrails.frustumCulled = false;
    this.fragmentTrails.visible = false;
    this.group.add(this.fragmentTrails);
  }

  get active(): boolean {
    return this.running;
  }

  get currentVariant(): DeathFxVariant {
    return this.variant;
  }

  start(options: Readonly<ChaseDeathFxStartOptions>): DeathFxVariant {
    if (this.disposed) throw new Error('Cannot start a disposed ChaseDeathFx');
    this.reset();
    this.seed = Number.isFinite(options.seed) ? Math.trunc(options.seed) >>> 0 : 0;
    this.variant = options.variant ?? resolveDeathFxVariant(this.seed);
    this.impactDirection = options.impactDirection ?? 1;
    this.reducedFlashes = options.reducedFlashes;
    const budget = resolveDeathFxBudget(options.quality, options.reducedFlashes);
    this.activeShardCount = Math.min(MAX_SHARDS, budget.shards);
    this.activeSparkCount = Math.min(MAX_SPARKS, budget.sparks);
    this.activeRingCount = Math.min(this.rings.length, budget.rings);
    this.flashScale = budget.flashScale;
    this.copySourcePose();
    this.seedFragments();
    this.seedShards();
    this.seedSparks();

    this.elapsed = 0;
    this.running = true;
    this.group.visible = true;
    this.core.visible = true;
    this.shards.count = this.activeShardCount;
    this.shards.visible = this.activeShardCount > 0;
    this.sparks.geometry.setDrawRange(0, this.activeSparkCount * 2);
    this.sparks.visible = this.activeSparkCount > 0;
    this.fragmentTrails.visible = this.fragments.length > 0;
    for (let index = 0; index < this.rings.length; index += 1) this.rings[index].visible = index < this.activeRingCount;
    for (const fragment of this.fragments) fragment.mesh.visible = true;
    this.updateFrameState(false);
    return this.variant;
  }

  update(dt: number): ChaseDeathFxFrame {
    this.frameState.justFinished = false;
    if (!this.running || this.disposed) return this.frameState;
    const safeDt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this.elapsed = Math.min(DEATH_SEQUENCE_DURATION, this.elapsed + safeDt);
    this.updateFragments(safeDt);
    this.updateShards(safeDt);
    this.updateSparks(safeDt);
    this.updateCoreAndRings();
    this.updateFrameState(false);
    if (this.elapsed >= DEATH_SEQUENCE_DURATION) {
      this.running = false;
      this.group.visible = false;
      this.frameState.active = false;
      this.frameState.justFinished = true;
      this.frameState.resultReady = true;
      this.zeroCameraFrame();
    }
    return this.frameState;
  }

  reset(): void {
    this.running = false;
    this.elapsed = 0;
    this.group.visible = false;
    this.core.visible = false;
    this.coreMaterial.opacity = 0;
    this.shards.visible = false;
    this.shards.count = 0;
    (this.shards.material as THREE.MeshBasicMaterial).opacity = 0;
    this.sparks.visible = false;
    (this.sparks.material as THREE.LineBasicMaterial).opacity = 0;
    this.sparks.geometry.setDrawRange(0, 0);
    this.fragmentTrails.visible = false;
    (this.fragmentTrails.material as THREE.LineBasicMaterial).opacity = 0;
    for (let index = 0; index < this.rings.length; index += 1) {
      this.rings[index].visible = false;
      this.rings[index].scale.setScalar(1);
      this.ringMaterials[index].opacity = 0;
    }
    for (const fragment of this.fragments) {
      fragment.mesh.visible = false;
      fragment.mesh.position.copy(fragment.basePosition);
      fragment.mesh.quaternion.copy(fragment.baseQuaternion);
      fragment.mesh.scale.copy(fragment.baseScale);
      fragment.velocity.set(0, 0, 0);
      fragment.angularVelocity.set(0, 0, 0);
      for (const state of fragment.materials) {
        state.material.opacity = state.baseOpacity;
        state.material.depthWrite = true;
        if (state.baseColor && hasColor(state.material)) state.material.color.copy(state.baseColor);
      }
    }
    Object.assign(this.frameState, DEAD_FRAME);
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
  }

  private createParticleState(): ParticleState {
    return {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      rotation: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      scale: 1,
      life: 0,
      maxLife: 0,
    };
  }

  private copySourcePose(): void {
    this.source.updateWorldMatrix(true, false);
    this.poseMatrix.copy(this.source.matrixWorld);
    if (this.group.parent) {
      this.group.parent.updateWorldMatrix(true, false);
      this.inverseParentMatrix.copy(this.group.parent.matrixWorld).invert();
      this.poseMatrix.premultiply(this.inverseParentMatrix);
    }
    this.poseMatrix.decompose(this.group.position, this.group.quaternion, this.group.scale);
  }

  private seedFragments(): void {
    const random = mulberry32((this.seed ^ 0x6d2b79f5) >>> 0);
    for (const fragment of this.fragments) {
      fragment.mesh.position.copy(fragment.basePosition);
      fragment.mesh.quaternion.copy(fragment.baseQuaternion);
      fragment.mesh.scale.copy(fragment.baseScale);
      fragment.delay = DEATH_BREAKUP_DELAY
        + random() * (this.variant === 'lateral-shear' ? 0.09 : 0.045);
      this.scratchDirection.copy(fragment.basePosition).sub(this.center);
      if (this.scratchDirection.lengthSq() < 0.025) {
        this.scratchDirection.set(random() - 0.5, random() - 0.5, random() - 0.5);
      }
      this.scratchDirection.normalize();
      this.scratchScatter.set(random() - 0.5, random() - 0.5, random() - 0.5);
      if (this.variant === 'lateral-shear') {
        const side = Math.abs(fragment.basePosition.x - this.center.x) > 0.08
          ? Math.sign(fragment.basePosition.x - this.center.x)
          : this.impactDirection;
        fragment.velocity.set(
          side * (4.1 + random() * 4.4) + this.impactDirection * 0.65,
          (random() - 0.45) * 5.8,
          -0.8 - random() * 2.2,
        );
      } else if (this.variant === 'engine-rupture') {
        const rearFactor = clamp((this.center.z - fragment.basePosition.z + 0.25) / 2.2, 0, 1);
        fragment.velocity.copy(this.scratchDirection).multiplyScalar(2.2 + random() * 3.2);
        fragment.velocity.x += this.impactDirection * (0.8 + random() * 1.7);
        fragment.velocity.y += (random() - 0.48) * 3.8;
        fragment.velocity.z -= 1.4 + rearFactor * (2.8 + random() * 2.2);
      } else {
        fragment.velocity.copy(this.scratchDirection).multiplyScalar(3.3 + random() * 4.7);
        fragment.velocity.addScaledVector(this.scratchScatter, 2.4);
        fragment.velocity.z -= 1.15 + random() * 2.35;
      }
      fragment.angularVelocity.set(
        (random() - 0.5) * 13,
        (random() - 0.5) * 15,
        (random() - 0.5) * 12,
      );
      for (const state of fragment.materials) {
        state.material.opacity = state.baseOpacity;
        state.material.depthWrite = true;
        if (state.baseColor && hasColor(state.material)) state.material.color.copy(state.baseColor);
      }
    }
  }

  private seedShards(): void {
    const random = mulberry32((this.seed ^ 0xa511e9b3) >>> 0);
    for (let index = 0; index < this.activeShardCount; index += 1) {
      const shard = this.shardStates[index];
      shard.position.copy(this.center).add(this.scratchScatter.set(
        (random() - 0.5) * 1.3,
        (random() - 0.5) * 0.65,
        (random() - 0.5) * 1.4,
      ));
      this.scratchDirection.copy(shard.position).sub(this.center);
      if (this.scratchDirection.lengthSq() < 0.02) this.scratchDirection.set(random() - 0.5, random() - 0.5, random() - 0.5);
      this.scratchDirection.normalize();
      const sideBias = this.variant === 'lateral-shear' ? this.impactDirection * (1.2 + random() * 2.5) : 0;
      const rearBias = this.variant === 'engine-rupture' ? 2.4 + random() * 2.8 : 0.9 + random() * 2.2;
      shard.velocity.copy(this.scratchDirection).multiplyScalar(3.8 + random() * 7.5);
      shard.velocity.x += sideBias;
      shard.velocity.z -= rearBias;
      shard.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
      shard.angularVelocity.set((random() - 0.5) * 18, (random() - 0.5) * 18, (random() - 0.5) * 18);
      shard.scale = 0.55 + random() * 1.6;
      shard.life = shard.maxLife = 0.72 + random() * 0.72;
      this.shards.setColorAt(index, SHARD_COLORS[(index + (this.seed & 3)) % SHARD_COLORS.length]);
      this.writeShardMatrix(index, shard, 1);
    }
    this.shards.instanceMatrix.needsUpdate = true;
    if (this.shards.instanceColor) this.shards.instanceColor.needsUpdate = true;
  }

  private seedSparks(): void {
    const random = mulberry32((this.seed ^ 0xf41bbcdc) >>> 0);
    const positions = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < this.activeSparkCount; index += 1) {
      const spark = this.sparkStates[index];
      spark.position.copy(this.center).add(this.scratchScatter.set(
        (random() - 0.5) * 0.55,
        (random() - 0.5) * 0.3,
        (random() - 0.5) * 0.55,
      ));
      this.scratchDirection.set(random() - 0.5, random() - 0.5, -0.15 - random()).normalize();
      if (this.variant === 'lateral-shear') this.scratchDirection.x += this.impactDirection * 0.5;
      spark.velocity.copy(this.scratchDirection).multiplyScalar(8 + random() * 19);
      spark.rotation.set(0, 0, 0);
      spark.angularVelocity.set(0, 0, 0);
      spark.scale = 1;
      spark.life = spark.maxLife = 0.34 + random() * 0.5;
      positions.setXYZ(index * 2, spark.position.x, spark.position.y, spark.position.z);
      positions.setXYZ(index * 2 + 1, spark.position.x, spark.position.y, spark.position.z);
    }
    positions.needsUpdate = true;
  }

  private updateFragments(dt: number): void {
    const fade = 1 - smoothstep(0.64, 1, this.elapsed / DEATH_SEQUENCE_DURATION);
    const hotMix = clamp((0.74 * Math.exp(-this.elapsed * 4.8) + 0.08) * this.flashScale, 0, 0.82);
    const trailPositions = this.fragmentTrails.geometry.getAttribute('position') as THREE.BufferAttribute;
    const trailColors = this.fragmentTrails.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let index = 0; index < this.fragments.length; index += 1) {
      const fragment = this.fragments[index];
      const activeDt = this.elapsed > fragment.delay ? dt : 0;
      if (activeDt > 0) {
        fragment.velocity.y -= 1.55 * activeDt;
        fragment.mesh.position.addScaledVector(fragment.velocity, activeDt);
        fragment.velocity.multiplyScalar(Math.exp(-activeDt * 0.72));
        fragment.mesh.rotateX(fragment.angularVelocity.x * activeDt);
        fragment.mesh.rotateY(fragment.angularVelocity.y * activeDt);
        fragment.mesh.rotateZ(fragment.angularVelocity.z * activeDt);
        fragment.angularVelocity.multiplyScalar(Math.exp(-activeDt * 0.38));
      }
      const scale = 1 - smoothstep(0.86, 1, this.elapsed / DEATH_SEQUENCE_DURATION) * 0.36;
      fragment.mesh.scale.copy(fragment.baseScale).multiplyScalar(scale);
      for (const state of fragment.materials) {
        state.material.opacity = state.baseOpacity * fade;
        state.material.depthWrite = fade > 0.3;
        if (state.baseColor && hasColor(state.material)) {
          state.material.color.copy(state.baseColor).lerp(HOT_FRAGMENT_COLOR, hotMix);
        }
      }
      const offset = index * 2;
      trailPositions.setXYZ(offset, fragment.mesh.position.x, fragment.mesh.position.y, fragment.mesh.position.z);
      this.scratchTail.copy(fragment.mesh.position).addScaledVector(fragment.velocity, -0.095);
      trailPositions.setXYZ(offset + 1, this.scratchTail.x, this.scratchTail.y, this.scratchTail.z);
      this.scratchColor.copy(index % 2 === 0 ? SHARD_COLORS[0] : SHARD_COLORS[2]);
      trailColors.setXYZ(offset, this.scratchColor.r, this.scratchColor.g, this.scratchColor.b);
      trailColors.setXYZ(offset + 1, this.scratchColor.r * 0.18, this.scratchColor.g * 0.18, this.scratchColor.b * 0.18);
    }
    trailPositions.needsUpdate = true;
    trailColors.needsUpdate = true;
    (this.fragmentTrails.material as THREE.LineBasicMaterial).opacity = fade * (this.reducedFlashes ? 0.22 : 0.62);
  }

  private updateShards(dt: number): void {
    let brightestLife = 0;
    for (let index = 0; index < this.activeShardCount; index += 1) {
      const shard = this.shardStates[index];
      shard.life = Math.max(0, shard.life - dt);
      const lifeRatio = shard.maxLife > 0 ? shard.life / shard.maxLife : 0;
      brightestLife = Math.max(brightestLife, lifeRatio);
      if (shard.life > 0) {
        shard.velocity.y -= 1.85 * dt;
        shard.position.addScaledVector(shard.velocity, dt);
        shard.velocity.multiplyScalar(Math.exp(-dt * 0.88));
        shard.rotation.addScaledVector(shard.angularVelocity, dt);
      }
      this.writeShardMatrix(index, shard, lifeRatio);
    }
    this.shards.instanceMatrix.needsUpdate = true;
    (this.shards.material as THREE.MeshBasicMaterial).opacity = brightestLife * (this.reducedFlashes ? 0.58 : 0.92);
  }

  private writeShardMatrix(index: number, shard: ParticleState, lifeRatio: number): void {
    this.shardDummy.position.copy(shard.position);
    this.shardDummy.rotation.set(shard.rotation.x, shard.rotation.y, shard.rotation.z);
    const shrink = shard.scale * smoothstep(0, 0.28, lifeRatio);
    this.shardDummy.scale.setScalar(shrink);
    this.shardDummy.updateMatrix();
    this.shards.setMatrixAt(index, this.shardDummy.matrix);
  }

  private updateSparks(dt: number): void {
    const positions = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let brightestLife = 0;
    for (let index = 0; index < this.activeSparkCount; index += 1) {
      const spark = this.sparkStates[index];
      spark.life = Math.max(0, spark.life - dt);
      const lifeRatio = spark.maxLife > 0 ? spark.life / spark.maxLife : 0;
      brightestLife = Math.max(brightestLife, lifeRatio);
      if (spark.life > 0) {
        spark.velocity.y -= 2.3 * dt;
        spark.position.addScaledVector(spark.velocity, dt);
        spark.velocity.multiplyScalar(Math.exp(-dt * 2.4));
      }
      positions.setXYZ(index * 2, spark.position.x, spark.position.y, spark.position.z);
      this.scratchTail.copy(spark.position).addScaledVector(spark.velocity, -0.052 * lifeRatio);
      positions.setXYZ(index * 2 + 1, this.scratchTail.x, this.scratchTail.y, this.scratchTail.z);
    }
    positions.needsUpdate = true;
    (this.sparks.material as THREE.LineBasicMaterial).opacity = brightestLife * brightestLife * (this.reducedFlashes ? 0.48 : 1);
  }

  private updateCoreAndRings(): void {
    const coreProgress = clamp(this.elapsed / 0.58, 0, 1);
    const coreLife = 1 - coreProgress;
    this.core.scale.setScalar(0.45 + coreProgress * 6.2);
    this.coreMaterial.opacity = coreLife * coreLife * (this.reducedFlashes ? 0.2 : 0.68);
    this.core.visible = coreLife > 0.001;
    const delays = [0, 0.12, 0.25];
    for (let index = 0; index < this.activeRingCount; index += 1) {
      const ringProgress = clamp((this.elapsed - delays[index]) / (0.58 + index * 0.08), 0, 1);
      const ringLife = 1 - ringProgress;
      this.rings[index].visible = this.elapsed >= delays[index] && ringLife > 0.001;
      this.rings[index].scale.setScalar(0.8 + ringProgress * (10.5 + index * 1.8));
      this.ringMaterials[index].opacity = ringLife * ringLife * (this.reducedFlashes ? 0.14 : 0.5 - index * 0.07);
    }
  }

  private updateFrameState(justFinished: boolean): void {
    const progress = clamp(this.elapsed / DEATH_SEQUENCE_DURATION, 0, 1);
    const shakeEnvelope = this.reducedFlashes ? 0 : Math.exp(-this.elapsed * 4.1);
    const phase = this.seed * 0.000013 + VARIANTS.indexOf(this.variant) * 1.73;
    this.frameState.active = this.running;
    this.frameState.justFinished = justFinished;
    this.frameState.resultReady = this.elapsed >= RESULT_READY_AT;
    this.frameState.elapsed = this.elapsed;
    this.frameState.progress = progress;
    this.frameState.cameraOffsetX = Math.sin(this.elapsed * 91 + phase) * 0.12 * shakeEnvelope;
    this.frameState.cameraOffsetY = Math.cos(this.elapsed * 73 + phase * 1.7) * 0.075 * shakeEnvelope;
    this.frameState.cameraRoll = Math.sin(this.elapsed * 57 + phase * 0.8) * 0.012 * shakeEnvelope;
    const kickEnvelope = (1 - Math.exp(-this.elapsed * 34)) * Math.exp(-this.elapsed * 4.9);
    this.frameState.fovKick = kickEnvelope * (this.reducedFlashes ? 2.1 : 8.4);
    this.frameState.exposureKick = Math.exp(-this.elapsed * 6.2) * (this.reducedFlashes ? 0.025 : 0.14);
  }

  private zeroCameraFrame(): void {
    this.frameState.cameraOffsetX = 0;
    this.frameState.cameraOffsetY = 0;
    this.frameState.cameraRoll = 0;
    this.frameState.fovKick = 0;
    this.frameState.exposureKick = 0;
  }
}
