import * as THREE from 'three';
import { clamp, mulberry32, TAU } from '../core/math';
import type { MusicProfile, TrackEvent, TrackTheme } from '../core/types';

export interface TransportFrames {
  positions: THREE.Vector3[];
  tangents: THREE.Vector3[];
  normals: THREE.Vector3[];
  binormals: THREE.Vector3[];
  segments: number;
}

export interface TrackPlan {
  curve: THREE.CatmullRomCurve3;
  frames: TransportFrames;
  events: TrackEvent[];
  length: number;
  runDuration: number;
  radius: number;
  seed: number;
}

export interface TrackFrame {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
}

function sampleProfile(values: number[], progress: number): number {
  if (values.length === 0) return 0.5;
  const scaled = clamp(progress, 0, 0.9999) * (values.length - 1);
  const left = Math.floor(scaled);
  const mix = scaled - left;
  return THREE.MathUtils.lerp(values[left], values[Math.min(left + 1, values.length - 1)], mix);
}

export function createDefaultMusicProfile(): MusicProfile {
  const count = 192;
  const energy: number[] = [];
  const bass: number[] = [];
  const mids: number[] = [];
  const highs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const build = 0.42 + t * 0.34 + Math.sin(t * Math.PI * 6) * 0.08;
    const drop = t > 0.58 && t < 0.88 ? 0.22 : 0;
    energy.push(clamp(build + drop + Math.sin(index * 0.67) * 0.07, 0, 1));
    bass.push(clamp(0.5 + Math.sin(index * 0.42) * 0.28 + drop, 0, 1));
    mids.push(clamp(0.46 + Math.sin(index * 0.21 + 1.4) * 0.25, 0, 1));
    highs.push(clamp(0.43 + Math.sin(index * 0.91 + 0.7) * 0.32, 0, 1));
  }
  return {
    id: 'edge-signal',
    title: 'EDGE SIGNAL',
    duration: 82,
    runDuration: 82,
    bpm: 148,
    beatOffset: 0,
    energy,
    bass,
    mids,
    highs,
    seed: 0xed6e,
  };
}

export function buildTransportFrames(curve: THREE.CatmullRomCurve3, segments = 900): TransportFrames {
  const positions: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  const worldUp = new THREE.Vector3(0, 1, 0);
  const fallback = new THREE.Vector3(1, 0, 0);

  for (let index = 0; index <= segments; index += 1) {
    const u = index / segments;
    positions.push(curve.getPointAt(u));
    tangents.push(curve.getTangentAt(u).normalize());
  }

  const firstTangent = tangents[0];
  const initialNormal = worldUp.clone().sub(firstTangent.clone().multiplyScalar(worldUp.dot(firstTangent)));
  if (initialNormal.lengthSq() < 0.0001) initialNormal.copy(fallback);
  initialNormal.normalize();
  normals.push(initialNormal);
  binormals.push(new THREE.Vector3().crossVectors(firstTangent, initialNormal).normalize());

  const axis = new THREE.Vector3();
  for (let index = 1; index <= segments; index += 1) {
    const previousTangent = tangents[index - 1];
    const tangent = tangents[index];
    const normal = normals[index - 1].clone();
    axis.crossVectors(previousTangent, tangent);
    if (axis.lengthSq() > 0.0000001) {
      axis.normalize();
      const angle = Math.acos(clamp(previousTangent.dot(tangent), -1, 1));
      normal.applyAxisAngle(axis, angle);
    }
    normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    normals.push(normal);
    binormals.push(binormal);
  }

  return { positions, tangents, normals, binormals, segments };
}

export function sampleTrackFrame(plan: TrackPlan, progress: number): TrackFrame {
  const scaled = clamp(progress, 0, 1) * plan.frames.segments;
  const left = Math.min(Math.floor(scaled), plan.frames.segments - 1);
  const right = Math.min(left + 1, plan.frames.segments);
  const mix = scaled - left;
  return {
    position: plan.frames.positions[left].clone().lerp(plan.frames.positions[right], mix),
    tangent: plan.frames.tangents[left].clone().lerp(plan.frames.tangents[right], mix).normalize(),
    normal: plan.frames.normals[left].clone().lerp(plan.frames.normals[right], mix).normalize(),
    binormal: plan.frames.binormals[left].clone().lerp(plan.frames.binormals[right], mix).normalize(),
  };
}

export function radialAt(frame: TrackFrame, angle: number): THREE.Vector3 {
  return frame.normal.clone().multiplyScalar(Math.cos(angle)).add(frame.binormal.clone().multiplyScalar(Math.sin(angle))).normalize();
}

export function generateTrack(theme: TrackTheme, profile: MusicProfile, runSeed: number): TrackPlan {
  const seed = (theme.seed ^ profile.seed ^ runSeed) >>> 0;
  const random = mulberry32(seed);
  const runDuration = clamp(profile.runDuration || profile.duration, 58, 108);
  const targetLength = runDuration * 170;
  const controlStep = 230;
  const pointCount = Math.max(36, Math.ceil(targetLength / controlStep));
  const points: THREE.Vector3[] = [];
  const phaseA = random() * TAU;
  const phaseB = random() * TAU;
  const phaseC = random() * TAU;

  for (let index = 0; index <= pointCount; index += 1) {
    const t = index / pointCount;
    const energy = sampleProfile(profile.energy, t);
    const mids = sampleProfile(profile.mids, t);
    const highs = sampleProfile(profile.highs, t);
    const amplitude = 34 + energy * 42;
    const x = Math.sin(index * (0.31 + highs * 0.08) + phaseA) * amplitude
      + Math.sin(index * 0.117 + phaseC) * 24 * mids;
    const y = Math.cos(index * (0.27 + mids * 0.07) + phaseB) * amplitude * 0.72
      + Math.sin(index * 0.083 + phaseA) * 18;
    points.push(new THREE.Vector3(x, y, -index * controlStep));
  }

  points[0].set(0, 0, 0);
  points[1].multiplyScalar(0.35);
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.42);
  const length = curve.getLength();
  const frames = buildTransportFrames(curve, Math.max(720, Math.ceil(length / 15)));
  const events: TrackEvent[] = [];
  const beatDistance = length / Math.max(1, runDuration * (profile.bpm / 60));
  let cursor = Math.max(230, beatDistance * 8);
  let eventId = 0;
  let beatIndex = 8;

  while (cursor < length - 260) {
    const progress = cursor / length;
    const energy = sampleProfile(profile.energy, progress);
    const bass = sampleProfile(profile.bass, progress);
    const roll = random();
    let kind: TrackEvent['kind'];
    if (roll < 0.2 * theme.hazardRate) kind = 'gate';
    else if (roll < 0.37 * theme.hazardRate) kind = 'mine';
    else if (roll < 0.49 * theme.hazardRate) kind = 'drone';
    else if (roll < 0.7) kind = 'shard';
    else if (roll < 0.86) kind = 'boost';
    else kind = 'coolant';

    const angle = (random() * TAU + Math.sin(progress * TAU * 3) * bass) % TAU;
    const gapWidth = kind === 'gate' ? 0.7 + (1 - energy) * 0.32 : 0.32;
    events.push({
      id: eventId,
      kind,
      distance: cursor,
      angle,
      gapWidth,
      health: kind === 'drone' ? 2 + Math.floor(energy * 2) : 1,
      resolved: false,
      destroyed: false,
      beatIndex,
    });
    eventId += 1;

    if (kind === 'shard' && random() > 0.35) {
      for (let chain = 1; chain <= 2; chain += 1) {
        events.push({
          id: eventId,
          kind: 'shard',
          distance: cursor + chain * Math.max(18, beatDistance * 0.45),
          angle: angle + chain * 0.16 * (random() > 0.5 ? 1 : -1),
          gapWidth: 0.32,
          health: 1,
          resolved: false,
          destroyed: false,
          beatIndex: beatIndex + chain,
        });
        eventId += 1;
      }
    }

    const beatsToNext = energy > 0.72 ? 2 + Math.floor(random() * 3) : 4 + Math.floor(random() * 4);
    cursor += Math.max(44, beatDistance * beatsToNext);
    beatIndex += beatsToNext;
  }

  events.sort((a, b) => a.distance - b.distance);
  return { curve, frames, events, length, runDuration, radius: theme.radius, seed };
}
