import * as THREE from 'three';
import { clamp, mulberry32, TAU } from '../core/math';
import type {
  MusicProfile,
  MusicTransition,
  RhythmBeat,
  TrackEvent,
  TrackTheme,
} from '../core/types';

export interface TransportFrames {
  positions: THREE.Vector3[];
  tangents: THREE.Vector3[];
  normals: THREE.Vector3[];
  binormals: THREE.Vector3[];
  segments: number;
}

export interface TrackBeatDistance extends RhythmBeat {
  beatIndex: number;
  distance: number;
}

export interface TrackTransitionDistance extends MusicTransition {
  transitionIndex: number;
  distance: number;
}

export interface TrackPlan {
  curve: THREE.CatmullRomCurve3;
  frames: TransportFrames;
  events: TrackEvent[];
  beatDistances: TrackBeatDistance[];
  transitionDistances: TrackTransitionDistance[];
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

interface IndexedBeat extends RhythmBeat {
  beatIndex: number;
}

interface IndexedTransition extends MusicTransition {
  transitionIndex: number;
}

interface EventTuning {
  gapWidth?: number;
  rotationRate?: number;
  armCount?: number;
  strength?: number;
  warningDistance?: number;
}

const NOMINAL_SPEED = 170;

function sampleProfile(values: number[], progress: number): number {
  if (values.length === 0) return 0.5;
  const scaled = clamp(progress, 0, 0.9999) * (values.length - 1);
  const left = Math.floor(scaled);
  const mix = scaled - left;
  return THREE.MathUtils.lerp(values[left], values[Math.min(left + 1, values.length - 1)], mix);
}

function wrapPositive(angle: number): number {
  return ((angle % TAU) + TAU) % TAU;
}

function profileValueAtTime(values: number[], time: number, runDuration: number): number {
  return sampleProfile(values, time / Math.max(0.001, runDuration));
}

function createBeatGrid(profile: MusicProfile, runDuration: number): IndexedBeat[] {
  const bpm = clamp(profile.bpm || 140, 72, 200);
  const interval = 60 / bpm;
  const offset = ((profile.beatOffset % interval) + interval) % interval;
  const beats: IndexedBeat[] = [];
  let beatIndex = 0;
  for (let time = offset; time <= runDuration + 0.0001; time += interval) {
    const progress = time / runDuration;
    const bass = sampleProfile(profile.bass, progress);
    const highs = sampleProfile(profile.highs, progress);
    const energy = sampleProfile(profile.energy, progress);
    const barBeat = (beatIndex % 4) as RhythmBeat['barBeat'];
    beats.push({
      beatIndex,
      time,
      bass,
      highs,
      barBeat,
      strength: clamp(energy * 0.46 + bass * 0.34 + highs * 0.08 + (barBeat === 0 ? 0.2 : 0.05), 0, 1),
    });
    beatIndex += 1;
  }
  return beats;
}

function buildBeatTimeline(profile: MusicProfile, runDuration: number): IndexedBeat[] {
  const explicit = [...(profile.beats || [])]
    .filter((beat) => Number.isFinite(beat.time) && beat.time >= 0 && beat.time <= runDuration + 0.0001)
    .sort((a, b) => a.time - b.time);

  const distinct: RhythmBeat[] = [];
  for (const beat of explicit) {
    const previous = distinct[distinct.length - 1];
    if (previous && Math.abs(previous.time - beat.time) < 0.025) {
      if (beat.strength > previous.strength) distinct[distinct.length - 1] = beat;
      continue;
    }
    distinct.push(beat);
  }

  const expectedBeatCount = runDuration * (clamp(profile.bpm || 140, 72, 200) / 60);
  const hasCourseCoverage = distinct.length >= Math.max(8, Math.floor(expectedBeatCount * 0.4))
    && distinct[0].time <= Math.max(2, runDuration * 0.12)
    && distinct[distinct.length - 1].time >= runDuration * 0.62;
  if (!hasCourseCoverage) return createBeatGrid(profile, runDuration);

  const beats: IndexedBeat[] = distinct.map((beat, beatIndex) => ({
    beatIndex,
    time: beat.time,
    strength: clamp(beat.strength, 0, 1),
    bass: clamp(beat.bass, 0, 1),
    highs: clamp(beat.highs, 0, 1),
    barBeat: beat.barBeat,
  }));

  // Some decoders can stop reporting peaks shortly before the trimmed playback
  // boundary. Keep the musical grid alive without discarding the real beats.
  const interval = 60 / clamp(profile.bpm || 140, 72, 200);
  const last = beats[beats.length - 1];
  let time = last.time + interval;
  let barBeat = ((last.barBeat + 1) % 4) as RhythmBeat['barBeat'];
  while (time <= runDuration + 0.0001) {
    const energy = profileValueAtTime(profile.energy, time, runDuration);
    const bass = profileValueAtTime(profile.bass, time, runDuration);
    const highs = profileValueAtTime(profile.highs, time, runDuration);
    beats.push({
      beatIndex: beats.length,
      time,
      bass,
      highs,
      barBeat,
      strength: clamp(energy * 0.48 + bass * 0.34 + (barBeat === 0 ? 0.18 : 0.04), 0, 1),
    });
    time += interval;
    barBeat = ((barBeat + 1) % 4) as RhythmBeat['barBeat'];
  }
  return beats;
}

function buildTransitionTimeline(profile: MusicProfile, runDuration: number): IndexedTransition[] {
  return [...(profile.transitions || [])]
    .filter((transition) => Number.isFinite(transition.time) && transition.time > 0 && transition.time < runDuration)
    .sort((a, b) => a.time - b.time)
    .map((transition, transitionIndex) => ({
      transitionIndex,
      time: transition.time,
      strength: clamp(transition.strength, 0, 1),
      kind: transition.kind,
    }));
}

export function createDefaultMusicProfile(): MusicProfile {
  const count = 192;
  const duration = 82;
  const bpm = 148;
  const beatOffset = 0;
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

  const beats: RhythmBeat[] = [];
  const interval = 60 / bpm;
  let beatIndex = 0;
  for (let time = beatOffset; time <= duration + 0.0001; time += interval) {
    const progress = time / duration;
    const beatBass = sampleProfile(bass, progress);
    const beatHighs = sampleProfile(highs, progress);
    const beatEnergy = sampleProfile(energy, progress);
    const barBeat = (beatIndex % 4) as RhythmBeat['barBeat'];
    beats.push({
      time,
      bass: beatBass,
      highs: beatHighs,
      barBeat,
      strength: clamp(beatEnergy * 0.48 + beatBass * 0.34 + beatHighs * 0.06 + (barBeat === 0 ? 0.2 : 0.04), 0, 1),
    });
    beatIndex += 1;
  }

  const transitions: MusicTransition[] = [
    { time: 13.6, strength: 0.68, kind: 'build' },
    { time: 29.4, strength: 0.64, kind: 'fill' },
    { time: 47.2, strength: 0.92, kind: 'build' },
    { time: 50.1, strength: 1, kind: 'drop' },
    { time: 65.8, strength: 0.76, kind: 'break' },
    { time: 70.3, strength: 0.94, kind: 'drop' },
  ];

  return {
    id: 'edge-signal',
    title: 'EDGE SIGNAL',
    duration,
    runDuration: duration,
    bpm,
    beatOffset,
    energy,
    bass,
    mids,
    highs,
    beats,
    transitions,
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
  const runDuration = clamp(profile.runDuration || profile.duration, 58, 108);
  const beats = buildBeatTimeline(profile, runDuration);
  const transitions = buildTransitionTimeline(profile, runDuration);
  const targetLength = runDuration * NOMINAL_SPEED;
  const beatInterval = 60 / clamp(profile.bpm || 140, 72, 200);
  const controlDuration = clamp(beatInterval * 2.5, 0.85, 1.35);
  const pointCount = Math.max(44, Math.ceil(runDuration / controlDuration));
  const controlStep = targetLength / pointCount;
  const points: THREE.Vector3[] = [new THREE.Vector3()];
  const curveRandom = mulberry32(seed ^ 0x63d83595);
  const phaseA = curveRandom() * TAU;
  const phaseB = curveRandom() * TAU;
  const phaseC = curveRandom() * TAU;
  const transitionMotion = transitions.map((transition) => {
    const random = mulberry32((seed ^ Math.imul(transition.transitionIndex + 1, 0x45d9f3b)) >>> 0);
    return {
      ...transition,
      yawSign: random() > 0.5 ? 1 : -1,
      pitchSign: random() > 0.5 ? 1 : -1,
    };
  });

  let yaw = 0;
  let pitch = 0;
  const position = new THREE.Vector3();
  for (let index = 1; index <= pointCount; index += 1) {
    const time = (index / pointCount) * runDuration;
    const progress = time / runDuration;
    const energy = sampleProfile(profile.energy, progress);
    const bass = sampleProfile(profile.bass, progress);
    const mids = sampleProfile(profile.mids, progress);
    const highs = sampleProfile(profile.highs, progress);
    const safeRampRaw = clamp((time - beatInterval * 5) / Math.max(2.2, beatInterval * 5), 0, 1);
    const safeRamp = safeRampRaw * safeRampRaw * (3 - 2 * safeRampRaw);
    let transitionCurve = 0;
    let transitionYaw = 0;
    let transitionPitch = 0;
    let breakCalm = 0;

    for (const transition of transitionMotion) {
      const beforeWindow = transition.kind === 'build' ? 5.5 : 2.2;
      const afterWindow = transition.kind === 'break' ? 4.2 : 2.8;
      const delta = time - transition.time;
      if (delta < -beforeWindow || delta > afterWindow) continue;
      const envelope = delta < 0
        ? 1 - Math.abs(delta) / beforeWindow
        : 1 - delta / afterWindow;
      const influence = clamp(envelope, 0, 1) * transition.strength;
      if (transition.kind === 'break') {
        breakCalm = Math.max(breakCalm, influence * 0.72);
      } else {
        const kindScale = transition.kind === 'drop' ? 1 : transition.kind === 'fill' ? 0.78 : 0.58;
        transitionCurve += influence * kindScale;
        transitionYaw += influence * kindScale * transition.yawSign;
        transitionPitch += influence * kindScale * transition.pitchSign;
      }
    }

    const themeCurve = clamp(0.96 + (theme.hazardRate - 1) * 0.18, 0.86, 1.12);
    const curveAmount = safeRamp * themeCurve * (0.13 + energy * 0.19 + mids * 0.12 + transitionCurve * 0.2) * (1 - breakCalm);
    const yawWave = Math.sin(time * (0.26 + highs * 0.12) + phaseA)
      + Math.sin(time * 0.105 + phaseC) * 0.46;
    const pitchWave = Math.cos(time * (0.2 + mids * 0.08) + phaseB)
      + Math.sin(time * 0.087 + phaseA) * 0.36;
    const targetYaw = clamp(yawWave * curveAmount + transitionYaw * safeRamp * 0.28, -0.68, 0.68);
    const targetPitch = clamp(
      pitchWave * curveAmount * (0.48 + highs * 0.32) + transitionPitch * safeRamp * 0.17 + (bass - 0.5) * 0.035,
      -0.42,
      0.42,
    );
    const response = 0.2 + highs * 0.08 + transitionCurve * 0.06;
    yaw = THREE.MathUtils.lerp(yaw, targetYaw, response);
    pitch = THREE.MathUtils.lerp(pitch, targetPitch, response * 0.86);
    const direction = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ).normalize();
    position.addScaledVector(direction, controlStep);
    points.push(position.clone());
  }

  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.52);
  const length = curve.getLength();
  const frames = buildTransportFrames(curve, Math.max(720, Math.ceil(length / 15)));
  const beatDistances: TrackBeatDistance[] = beats.map((beat) => ({
    ...beat,
    distance: (beat.time / runDuration) * length,
  }));
  const transitionDistances: TrackTransitionDistance[] = transitions.map((transition) => ({
    ...transition,
    distance: (transition.time / runDuration) * length,
  }));
  const events: TrackEvent[] = [];
  let nextPatternId = 0;
  const safeStartTime = Math.max(beatInterval * 8, 3.4);
  const lastEventTime = runDuration - Math.max(beatInterval * 4, 1.8);

  const pushEvent = (
    kind: TrackEvent['kind'],
    beat: IndexedBeat | undefined,
    angle: number,
    patternId: number,
    tuning: EventTuning = {},
  ): void => {
    if (!beat || beat.time < 0.7 || beat.time > lastEventTime) return;
    const energy = profileValueAtTime(profile.energy, beat.time, runDuration);
    const bass = clamp((beat.bass + profileValueAtTime(profile.bass, beat.time, runDuration)) * 0.5, 0, 1);
    const eventStrength = clamp(tuning.strength ?? beat.strength * 0.58 + energy * 0.25 + bass * 0.17, 0, 1);
    const hazard = kind === 'gate' || kind === 'halfwall' || kind === 'blade' || kind === 'cross' || kind === 'drone';
    const finalAngle = wrapPositive(angle);
    events.push({
      id: -1,
      kind,
      distance: (beat.time / runDuration) * length,
      angle: finalAngle,
      gapWidth: tuning.gapWidth ?? (kind === 'gate' ? 0.82 : kind === 'halfwall' ? 1.36 : kind === 'blade' || kind === 'cross' ? 0.2 : 0.32),
      health: kind === 'drone' ? 2 + Math.floor(eventStrength * 3) : 1,
      resolved: false,
      destroyed: false,
      beatIndex: beat.beatIndex,
      musicTime: beat.time,
      strength: eventStrength,
      rotationRate: tuning.rotationRate ?? 0,
      rotationPhase: finalAngle,
      armCount: tuning.armCount ?? (kind === 'cross' ? 4 : kind === 'blade' ? 2 : 1),
      patternId,
      warningDistance: tuning.warningDistance ?? (hazard ? 330 + eventStrength * 190 : 170 + eventStrength * 80),
    });
  };

  const patternRandom = (beatIndex: number, salt: number): (() => number) => mulberry32(
    (seed ^ Math.imul(beatIndex + 1, 0x9e3779b9) ^ salt) >>> 0,
  );

  // The opening bars teach the rhythm with rewards, without blocking the player.
  const openingBeats = beats.filter((beat) => beat.time >= Math.max(1.1, beatInterval * 3) && beat.time < safeStartTime);
  if (openingBeats.length > 0) {
    const patternId = nextPatternId;
    nextPatternId += 1;
    const random = patternRandom(openingBeats[0].beatIndex, 0x0e31);
    const baseAngle = random() * TAU;
    pushEvent('shard', openingBeats[0], baseAngle, patternId);
    pushEvent('shard', openingBeats[Math.min(2, openingBeats.length - 1)], baseAngle + 0.18, patternId);
    pushEvent('boost', openingBeats[Math.min(4, openingBeats.length - 1)], baseAngle + 0.3, patternId);
  }

  const startIndex = Math.max(0, beats.findIndex((beat) => beat.time >= safeStartTime));
  let barOrdinal = 0;
  let baseCycleIndex = 0;
  let reservedThroughIndex = startIndex - 1;
  let lastPatternStartTime = Number.NEGATIVE_INFINITY;
  const hazardCadence = Math.max(1, Math.round(1.35 / theme.hazardRate));
  const minimumPatternGap = clamp(1.05 / theme.hazardRate, 0.78, 1.25);
  const patternCycle = ['gate', 'halfwall', 'blade', 'pickup', 'cross', 'drone'] as const;
  const accentPatternCycle = ['gate', 'blade', 'halfwall', 'cross', 'drone'] as const;
  let accentCycleIndex = Math.floor(
    patternRandom(beats[startIndex]?.beatIndex ?? 0, 0x71ac)() * accentPatternCycle.length,
  );
  const courseStrengths = beats
    .slice(startIndex)
    .filter((beat) => beat.time <= lastEventTime)
    .map((beat) => beat.strength)
    .sort((a, b) => a - b);
  const accentThreshold = Math.max(
    0.64,
    courseStrengths[Math.floor(Math.max(0, courseStrengths.length - 1) * 0.72)] ?? 0.72,
  );
  const transitionByBeat = new Map<number, IndexedTransition>();
  for (const transition of transitions) {
    let nearestIndex = -1;
    let nearestDelta = Number.POSITIVE_INFINITY;
    for (let beatIndex = startIndex; beatIndex < beats.length; beatIndex += 1) {
      const delta = Math.abs(beats[beatIndex].time - transition.time);
      if (delta < nearestDelta) {
        nearestIndex = beatIndex;
        nearestDelta = delta;
      }
      if (beats[beatIndex].time > transition.time + beatInterval) break;
    }
    if (nearestIndex < 0 || nearestDelta > beatInterval * 0.62) continue;
    const existing = transitionByBeat.get(nearestIndex);
    if (!existing || transition.strength > existing.strength) transitionByBeat.set(nearestIndex, transition);
  }
  const localAccentIndexes = new Set<number>();
  for (let beatIndex = startIndex; beatIndex < beats.length; beatIndex += 1) {
    const beat = beats[beatIndex];
    if (beat.time > lastEventTime) break;
    const previousStrength = beats[beatIndex - 1]?.strength ?? -1;
    const nextStrength = beats[beatIndex + 1]?.strength ?? -1;
    if (
      beat.strength >= accentThreshold
      && beat.strength >= previousStrength + 0.035
      && beat.strength >= nextStrength + 0.015
    ) localAccentIndexes.add(beatIndex);
  }
  const protectedAnchorIndexes = [...new Set([...transitionByBeat.keys(), ...localAccentIndexes])].sort((a, b) => a - b);

  for (let anchorIndex = startIndex; anchorIndex < beats.length; anchorIndex += 1) {
    const anchor = beats[anchorIndex];
    if (anchor.time > lastEventTime) break;
    const isDownbeat = anchor.barBeat === 0;
    const currentBarOrdinal = barOrdinal;
    if (isDownbeat) barOrdinal += 1;
    const isLocalAccent = localAccentIndexes.has(anchorIndex);
    const nearbyTransition = transitionByBeat.get(anchorIndex);
    if (!isDownbeat && !isLocalAccent && !nearbyTransition) continue;
    const nextProtectedIndex = protectedAnchorIndexes.find((index) => index > anchorIndex);
    const protectedAnchorSoon = !nearbyTransition
      && nextProtectedIndex !== undefined
      && (!isLocalAccent || transitionByBeat.has(nextProtectedIndex))
      && beats[nextProtectedIndex].time - anchor.time < minimumPatternGap;
    if (protectedAnchorSoon) continue;
    if (!nearbyTransition && anchor.time - lastPatternStartTime < minimumPatternGap) continue;
    const keepDownbeat = baseCycleIndex < patternCycle.length
      || Boolean(nearbyTransition)
      || isLocalAccent
      || currentBarOrdinal % hazardCadence === 0;
    if (isDownbeat && !keepDownbeat) continue;
    if (anchorIndex <= reservedThroughIndex) continue;

    const random = patternRandom(anchor.beatIndex, 0xa53c);
    const baseAngle = random() * TAU;
    const direction = random() > 0.5 ? 1 : -1;
    const energy = profileValueAtTime(profile.energy, anchor.time, runDuration);
    const bass = clamp((anchor.bass + profileValueAtTime(profile.bass, anchor.time, runDuration)) * 0.5, 0, 1);
    const highs = clamp((anchor.highs + profileValueAtTime(profile.highs, anchor.time, runDuration)) * 0.5, 0, 1);

    let pattern: typeof patternCycle[number];
    if (nearbyTransition) {
      if (nearbyTransition.kind === 'drop') pattern = 'cross';
      else if (nearbyTransition.kind === 'build') pattern = 'halfwall';
      else if (nearbyTransition.kind === 'fill') pattern = 'blade';
      else pattern = 'pickup';
    } else if (isLocalAccent && !isDownbeat) {
      pattern = accentPatternCycle[accentCycleIndex % accentPatternCycle.length];
      accentCycleIndex += 1;
    } else if (baseCycleIndex < patternCycle.length) {
      pattern = patternCycle[baseCycleIndex];
      baseCycleIndex += 1;
    } else if (highs > 0.72) {
      pattern = 'blade';
    } else if (bass > 0.7 && energy > 0.6) {
      pattern = random() > 0.48 ? 'gate' : 'cross';
    } else if (energy < 0.48) {
      pattern = 'pickup';
    } else {
      pattern = patternCycle[Math.floor(random() * patternCycle.length)];
    }

    const patternId = nextPatternId;
    nextPatternId += 1;
    const at = (offset: number): IndexedBeat | undefined => beats[anchorIndex + offset];
    const maxPatternSpan = nextProtectedIndex === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nextProtectedIndex - anchorIndex - 1);
    let patternSpan = 0;
    if (pattern === 'gate') {
      pushEvent('gate', anchor, baseAngle, patternId, {
        gapWidth: 0.78 + (1 - energy) * 0.24,
        strength: clamp(anchor.strength + 0.08, 0, 1),
      });
    } else if (pattern === 'halfwall') {
      const turn = direction * (0.38 + highs * 0.16);
      pushEvent('halfwall', anchor, baseAngle, patternId, { gapWidth: 1.28 + energy * 0.12 });
      if (maxPatternSpan >= 2) {
        pushEvent('halfwall', at(2), baseAngle + turn, patternId, { gapWidth: 1.26 + energy * 0.12 });
        patternSpan = 2;
      }
    } else if (pattern === 'blade') {
      const preferredCount = nearbyTransition?.kind === 'fill' ? 4 : 3;
      const count = Math.max(1, Math.min(preferredCount, maxPatternSpan + 1));
      const twist = direction * (0.27 + highs * 0.17);
      for (let step = 0; step < count; step += 1) {
        pushEvent('blade', at(step), baseAngle + twist * step, patternId, {
          gapWidth: 0.17 + energy * 0.055,
          rotationRate: direction * (0.08 + highs * 0.15),
          armCount: 2,
        });
      }
      patternSpan = count - 1;
    } else if (pattern === 'cross') {
      const spiral = direction * (0.16 + highs * 0.1);
      const preferredCount = nearbyTransition?.kind === 'drop' ? 3 : 2;
      const count = Math.max(1, Math.min(preferredCount, maxPatternSpan + 1));
      for (let step = 0; step < count; step += 1) {
        pushEvent('cross', at(step), baseAngle + spiral * step, patternId, {
          gapWidth: 0.16 + energy * 0.05,
          rotationRate: direction * (0.06 + anchor.strength * 0.1),
          armCount: 4,
          strength: clamp(anchor.strength + step * 0.035, 0, 1),
        });
      }
      patternSpan = count - 1;
    } else if (pattern === 'drone') {
      pushEvent('drone', anchor, baseAngle, patternId, { warningDistance: 300 + energy * 150 });
      if (maxPatternSpan >= 1) {
        pushEvent('shard', at(1), baseAngle + direction * 0.22, patternId);
        patternSpan = 1;
      }
    } else {
      const rewardKind: TrackEvent['kind'] = nearbyTransition?.kind === 'break' ? 'coolant' : random() > 0.52 ? 'boost' : 'shard';
      pushEvent(rewardKind, anchor, baseAngle, patternId);
      if (maxPatternSpan >= 1) {
        pushEvent('shard', at(1), baseAngle + direction * 0.17, patternId);
        patternSpan = 1;
      }
      if (maxPatternSpan >= 2) {
        pushEvent('shard', at(2), baseAngle + direction * 0.32, patternId);
        patternSpan = 2;
      }
    }
    // Reserve every beat occupied by the pattern plus one readable reaction beat.
    const readablePadding = nextProtectedIndex === anchorIndex + patternSpan + 1 ? 0 : 1;
    reservedThroughIndex = Math.max(reservedThroughIndex, anchorIndex + patternSpan + readablePadding);
    lastPatternStartTime = anchor.time;
  }

  // Profiles with very sparse detected peaks still receive a complete course.
  const occupiedTimes = new Set(events.map((event) => Math.round(event.musicTime * 1000)));
  for (let index = startIndex; events.length < 40 && index < beats.length; index += 1) {
    const beat = beats[index];
    if (beat.time > lastEventTime || occupiedTimes.has(Math.round(beat.time * 1000))) continue;
    const random = patternRandom(beat.beatIndex, 0xf111);
    const patternId = nextPatternId;
    nextPatternId += 1;
    const kind: TrackEvent['kind'] = events.length % 3 === 0 ? 'boost' : events.length % 3 === 1 ? 'shard' : 'coolant';
    pushEvent(kind, beat, random() * TAU, patternId);
    occupiedTimes.add(Math.round(beat.time * 1000));
  }

  events.sort((a, b) => a.distance - b.distance || a.patternId - b.patternId || a.kind.localeCompare(b.kind));
  for (let index = 0; index < events.length; index += 1) events[index].id = index;

  return {
    curve,
    frames,
    events,
    beatDistances,
    transitionDistances,
    length,
    runDuration,
    radius: theme.radius,
    seed,
  };
}
