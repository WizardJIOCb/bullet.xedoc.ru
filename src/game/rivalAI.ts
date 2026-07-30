import type { MusicTransition, RivalRaceMode, TrackEventKind } from '../core/types';
import { angularDistance, clamp, damp, wrapAngle } from '../core/math';
import { steeringInputTowardAngle, stepWallRideSteering, type SteeringInput } from './steering';

export type RivalArchetype = 'apex-reader' | 'pulse-striker' | 'slipstream-hunter' | 'edge-gambler';

export interface RivalAIHazardCue {
  id: number;
  kind: TrackEventKind;
  distance: number;
  safeAngle: number;
  safeHalfWidth: number;
  safeAngularVelocity: number;
  warningDistance: number;
  strength: number;
}

export interface RivalAIBeatCue {
  id: number;
  time: number;
  strength: number;
  barBeat: 0 | 1 | 2 | 3;
}

export interface RivalAITransitionCue {
  id: number;
  time: number;
  kind: MusicTransition['kind'];
  strength: number;
}

export interface RivalAIRaceModel {
  length: number;
  baseSpeed: number;
  handling: number;
  hazards: readonly RivalAIHazardCue[];
  beats: readonly RivalAIBeatCue[];
  transitions: readonly RivalAITransitionCue[];
}

export interface RivalAIProfile {
  id: string;
  callSign: string;
  archetype: RivalArchetype;
  baseSpeedFactor: number;
  skill: number;
  aggression: number;
  rhythmAffinity: number;
  blocking: number;
  risk: number;
  handling: number;
  weave: number;
  passSide: -1 | 1;
  phase: number;
}

export interface RivalAIState {
  distance: number;
  speed: number;
  angle: number;
  angularVelocity: number;
  laneCenter: number;
  mode: RivalRaceMode;
  modeTime: number;
  tacticCooldown: number;
  draftCharge: number;
  flux: number;
  heat: number;
  overheatTimer: number;
  beatImpulse: number;
  dropBoostTimer: number;
  breakTimer: number;
  impactTimer: number;
  boost: number;
  hazardCursor: number;
  beatCursor: number;
  transitionCursor: number;
  finishTick: number | null;
}

export interface RivalAISnapshot {
  id: string;
  distance: number;
  speed: number;
  angle: number;
  angularVelocity?: number;
}

export interface RivalAIInput {
  dt: number;
  tick: number;
  transportTime: number;
  paceReference: number;
  player: RivalAISnapshot;
  traffic: readonly RivalAISnapshot[];
  allowPlayerTactics: boolean;
}

export interface RivalAIOutput {
  state: RivalAIState;
  targetAngle: number;
  targetSpeed: number;
  steering: SteeringInput;
  activeHazardId: number | null;
  crossedHazardIds: readonly number[];
  modeChanged: boolean;
  hitHazard: boolean;
}

interface RivalBlueprint {
  callSign: string;
  archetype: RivalArchetype;
  aggression: number;
  rhythmAffinity: number;
  blocking: number;
  risk: number;
  handling: number;
  weave: number;
}

const BLUEPRINTS: readonly RivalBlueprint[] = [
  { callSign: 'ORACLE', archetype: 'apex-reader', aggression: 0.42, rhythmAffinity: 0.48, blocking: 0.22, risk: 0.18, handling: 1.08, weave: 0.18 },
  { callSign: 'VOLT', archetype: 'pulse-striker', aggression: 0.72, rhythmAffinity: 1, blocking: 0.18, risk: 0.58, handling: 1.02, weave: 0.28 },
  { callSign: 'RIFT', archetype: 'slipstream-hunter', aggression: 0.92, rhythmAffinity: 0.68, blocking: 0.9, risk: 0.62, handling: 1.07, weave: 0.23 },
  { callSign: 'RAZOR', archetype: 'edge-gambler', aggression: 0.76, rhythmAffinity: 0.74, blocking: 0.3, risk: 1, handling: 1.12, weave: 0.42 },
  { callSign: 'WARDEN', archetype: 'apex-reader', aggression: 0.58, rhythmAffinity: 0.4, blocking: 0.82, risk: 0.25, handling: 1.04, weave: 0.16 },
  { callSign: 'NOVA', archetype: 'pulse-striker', aggression: 0.66, rhythmAffinity: 0.94, blocking: 0.26, risk: 0.7, handling: 1.1, weave: 0.34 },
  { callSign: 'SHADE', archetype: 'slipstream-hunter', aggression: 0.84, rhythmAffinity: 0.8, blocking: 0.68, risk: 0.78, handling: 1.14, weave: 0.38 },
];

const HAZARD_MODES = new Set<RivalRaceMode>(['read', 'edge']);
const ATTACK_MODES = new Set<RivalRaceMode>(['block', 'overtake']);
const MODE_HOLD: Readonly<Partial<Record<RivalRaceMode, number>>> = {
  pulse: 0.34,
  draft: 0.42,
  block: 0.58,
  overtake: 0.82,
  read: 0.2,
  edge: 0.2,
  vent: 0.5,
};

function hashUnit(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 0x1_0000_0000;
}

function blendAngle(from: number, to: number, amount: number): number {
  return wrapAngle(from + wrapAngle(to - from) * clamp(amount, 0, 1));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createRivalAIProfile(
  seed: number,
  index: number,
  baseSpeedFactor: number,
  difficulty?: number,
): RivalAIProfile {
  const blueprint = BLUEPRINTS[Math.abs(Math.trunc(index)) % BLUEPRINTS.length];
  const personality = hashUnit(seed ^ Math.imul(index + 1, 0x9e3779b9));
  const skill = clamp(difficulty ?? 0.56 + index * 0.055, 0.35, 0.96);
  const speedVariance = (personality - 0.5) * 0.012;
  return {
    id: `${blueprint.callSign.toLowerCase()}-${index + 1}`,
    callSign: blueprint.callSign,
    archetype: blueprint.archetype,
    baseSpeedFactor: clamp(baseSpeedFactor + speedVariance + (skill - 0.6) * 0.012, 0.955, 1.035),
    skill,
    aggression: clamp(blueprint.aggression + (skill - 0.55) * 0.16, 0.1, 1),
    rhythmAffinity: clamp(blueprint.rhythmAffinity + (skill - 0.55) * 0.1, 0.1, 1),
    blocking: clamp(blueprint.blocking + (skill - 0.55) * 0.08, 0, 1),
    risk: clamp(blueprint.risk + (personality - 0.5) * 0.14, 0, 1),
    handling: blueprint.handling * (0.92 + skill * 0.14),
    weave: blueprint.weave * (0.82 + personality * 0.36),
    passSide: hashUnit(seed ^ Math.imul(index + 17, 0x85ebca6b)) < 0.5 ? -1 : 1,
    phase: personality * Math.PI * 2,
  };
}

export function createRivalAIState(
  profile: RivalAIProfile,
  initial: Readonly<Pick<RivalAIState, 'distance' | 'angle'>>,
  baseSpeed: number,
): RivalAIState {
  const angle = wrapAngle(finiteOr(initial.angle, 0));
  return {
    distance: finiteOr(initial.distance, 0),
    speed: Math.max(0, finiteOr(baseSpeed, 0) * profile.baseSpeedFactor * 0.78),
    angle,
    angularVelocity: 0,
    laneCenter: angle,
    mode: 'cruise',
    modeTime: 0,
    tacticCooldown: 0,
    draftCharge: 0,
    flux: 100,
    heat: 0,
    overheatTimer: 0,
    beatImpulse: 0,
    dropBoostTimer: 0,
    breakTimer: 0,
    impactTimer: 0,
    boost: 0,
    hazardCursor: 0,
    beatCursor: 0,
    transitionCursor: 0,
    finishTick: null,
  };
}

function nearestTrafficAvoidance(
  state: RivalAIState,
  traffic: readonly RivalAISnapshot[],
  passSide: -1 | 1,
): number {
  let avoidance = 0;
  const ordered = [...traffic].sort((left, right) => left.id.localeCompare(right.id));
  for (const other of ordered) {
    const longitudinal = Math.abs(other.distance - state.distance);
    const angular = angularDistance(other.angle, state.angle);
    if (longitudinal > 52 || angular > 0.5) continue;
    const signed = wrapAngle(state.angle - other.angle);
    const direction = Math.abs(signed) < 0.025 ? passSide : signed < 0 ? -1 : 1;
    avoidance += direction * (1 - longitudinal / 52) * (1 - angular / 0.5) * 0.56;
  }
  return clamp(avoidance, -0.62, 0.62);
}

function chooseMode(
  profile: RivalAIProfile,
  state: RivalAIState,
  hazardUrgency: number,
  playerGap: number,
  sameLane: boolean,
  strongMusicCue: boolean,
  allowPlayerTactics: boolean,
): RivalRaceMode {
  if (state.impactTimer > 0 || state.overheatTimer > 0 || state.heat > 84 || (state.breakTimer > 0 && state.heat > 58)) return 'vent';
  if (hazardUrgency > 0.04) return profile.archetype === 'edge-gambler' ? 'edge' : 'read';

  if (allowPlayerTactics && state.tacticCooldown <= 0) {
    if (playerGap > 9 && playerGap < 62 && profile.blocking > 0.62) return 'block';
    if (playerGap < -4 && playerGap > -145) {
      if (state.draftCharge > 0.55 || (strongMusicCue && profile.aggression > 0.6)) return 'overtake';
      if (sameLane || profile.archetype === 'slipstream-hunter') return 'draft';
    }
  }

  if (profile.archetype === 'pulse-striker' && strongMusicCue && state.flux > 12) return 'pulse';
  return 'cruise';
}

function holdMode(previous: RivalRaceMode, desired: RivalRaceMode, modeTime: number): RivalRaceMode {
  if (desired === 'vent' || HAZARD_MODES.has(desired)) return desired;
  const minimum = MODE_HOLD[previous] ?? 0;
  return previous !== desired && modeTime < minimum ? previous : desired;
}

export function stepRivalAI(
  model: RivalAIRaceModel,
  profile: RivalAIProfile,
  previous: Readonly<RivalAIState>,
  input: Readonly<RivalAIInput>,
): RivalAIOutput {
  const dt = clamp(finiteOr(input.dt, 0), 0, 1 / 30);
  if (dt <= 0 || previous.finishTick !== null) {
    return {
      state: { ...previous },
      targetAngle: previous.angle,
      targetSpeed: previous.finishTick === null ? previous.speed : 0,
      steering: 0,
      activeHazardId: null,
      crossedHazardIds: [],
      modeChanged: false,
      hitHazard: false,
    };
  }

  const transportTime = Math.max(0, finiteOr(input.transportTime, 0));
  let beatCursor = clamp(Math.trunc(previous.beatCursor), 0, model.beats.length);
  let transitionCursor = clamp(Math.trunc(previous.transitionCursor), 0, model.transitions.length);
  let hazardCursor = clamp(Math.trunc(previous.hazardCursor), 0, model.hazards.length);
  let beatImpulse = previous.beatImpulse * Math.exp(-dt * 4.8);
  let dropBoostTimer = Math.max(0, previous.dropBoostTimer - dt);
  let breakTimer = Math.max(0, previous.breakTimer - dt);
  let impactTimer = Math.max(0, previous.impactTimer - dt);
  let strongMusicCue = false;

  while (beatCursor < model.beats.length && model.beats[beatCursor].time <= transportTime + 1e-6) {
    const cue = model.beats[beatCursor];
    const accent = clamp(cue.strength * (cue.barBeat === 0 ? 1.18 : 0.78), 0, 1.2);
    beatImpulse = clamp(beatImpulse + accent * profile.rhythmAffinity * 0.018, 0, 0.032);
    strongMusicCue ||= cue.barBeat === 0 && cue.strength > 0.52;
    beatCursor += 1;
  }

  while (transitionCursor < model.transitions.length && model.transitions[transitionCursor].time <= transportTime + 1e-6) {
    const cue = model.transitions[transitionCursor];
    if (cue.kind === 'drop' && cue.strength > 0.42) {
      const commits = hashUnit((profile.phase * 1_000_000) ^ Math.imul(cue.id + 1, 0x27d4eb2d));
      if (commits < 0.42 + profile.rhythmAffinity * 0.5) {
        dropBoostTimer = Math.max(dropBoostTimer, 0.42 + cue.strength * 0.36);
        strongMusicCue = true;
      }
    } else if (cue.kind === 'break') {
      breakTimer = Math.max(breakTimer, 0.6 + cue.strength * 0.7);
    }
    transitionCursor += 1;
  }

  while (hazardCursor < model.hazards.length && model.hazards[hazardCursor].distance < previous.distance - 16) {
    hazardCursor += 1;
  }
  const hazard = model.hazards[hazardCursor];
  const hazardAhead = hazard ? hazard.distance - previous.distance : Number.POSITIVE_INFINITY;
  const archetypeLookahead = profile.archetype === 'apex-reader' ? 1.14 : profile.archetype === 'edge-gambler' ? 0.92 : 1;
  const lookahead = hazard
    ? clamp(hazard.warningDistance * (0.68 + profile.skill * 0.26) * archetypeLookahead, 145, 430)
    : 0;
  const hazardUrgency = hazard && hazardAhead > -12 && hazardAhead < lookahead
    ? clamp(1 - (hazardAhead - 20) / Math.max(1, lookahead - 20), 0, 1)
    : 0;

  const playerGap = previous.distance - finiteOr(input.player.distance, 0);
  const playerAngle = wrapAngle(finiteOr(input.player.angle, 0));
  const sameLane = angularDistance(previous.angle, playerAngle) < 0.62;
  let draftCharge = input.allowPlayerTactics && sameLane && playerGap < -7 && playerGap > -150
    ? clamp(previous.draftCharge + dt * (0.48 + profile.aggression * 0.72), 0, 1.2)
    : Math.max(0, previous.draftCharge - dt * 0.7);
  let tacticCooldown = Math.max(0, previous.tacticCooldown - dt);

  let desiredMode = chooseMode(
    profile,
    { ...previous, beatImpulse, dropBoostTimer, breakTimer, impactTimer, draftCharge, tacticCooldown },
    hazardUrgency,
    playerGap,
    sameLane,
    strongMusicCue || dropBoostTimer > 0,
    input.allowPlayerTactics,
  );
  desiredMode = holdMode(previous.mode, desiredMode, previous.modeTime);
  const modeChanged = desiredMode !== previous.mode;
  if (modeChanged && ATTACK_MODES.has(previous.mode)) tacticCooldown = Math.max(tacticCooldown, 1.35);
  if (desiredMode === 'overtake') draftCharge = Math.max(0, draftCharge - dt * 0.5);
  const modeTime = modeChanged ? 0 : previous.modeTime + dt;

  const laneWave = Math.sin(transportTime * (0.22 + profile.aggression * 0.08) + profile.phase) * profile.weave;
  let targetAngle = wrapAngle(previous.laneCenter + laneWave);
  if (desiredMode === 'draft') {
    targetAngle = blendAngle(targetAngle, playerAngle + profile.passSide * 0.06, 0.88);
  } else if (desiredMode === 'block') {
    const prediction = clamp(finiteOr(input.player.angularVelocity ?? 0, 0) * 0.22, -0.32, 0.32);
    targetAngle = blendAngle(targetAngle, playerAngle + prediction, 0.92);
  } else if (desiredMode === 'overtake') {
    targetAngle = blendAngle(targetAngle, playerAngle + profile.passSide * (0.58 + profile.aggression * 0.18), 0.94);
  } else if (desiredMode === 'pulse') {
    targetAngle = wrapAngle(targetAngle + profile.passSide * beatImpulse * 7);
  }

  if (hazard && hazardUrgency > 0) {
    const edgeOffset = desiredMode === 'edge'
      ? profile.passSide * clamp(hazard.safeHalfWidth * (0.38 + profile.risk * 0.24), 0.08, 0.58)
      : 0;
    const approachTime = clamp(hazardAhead / Math.max(model.baseSpeed * 0.72, previous.speed), 0, 0.45);
    const velocityLead = hazard.safeAngularVelocity * approachTime * (0.38 + profile.skill * 0.32);
    const safeTarget = wrapAngle(hazard.safeAngle + edgeOffset + velocityLead);
    targetAngle = blendAngle(targetAngle, safeTarget, clamp(0.32 + hazardUrgency * 0.82, 0, 1));
  }

  if (!HAZARD_MODES.has(desiredMode)) {
    targetAngle = wrapAngle(targetAngle + nearestTrafficAvoidance(previous, input.traffic, profile.passSide));
  }

  const steering = steeringInputTowardAngle(
    { angle: previous.angle, angularVelocity: previous.angularVelocity },
    targetAngle,
    {
      maxTargetSpeed: 0.7 + profile.skill * 0.42 + hazardUrgency * 0.3,
      positionGain: 1.25 + profile.skill * 0.42,
      velocityDeadband: 0.025,
    },
  );
  const steeringState = stepWallRideSteering(
    { angle: previous.angle, angularVelocity: previous.angularVelocity },
    steering,
    model.handling * profile.handling * (HAZARD_MODES.has(desiredMode) ? 1.08 : 1),
    0,
    dt,
  );

  let flux = clamp(previous.flux, 0, 100);
  let heat = clamp(previous.heat, 0, 100);
  let overheatTimer = Math.max(0, previous.overheatTimer - dt);
  const wantsBoost = desiredMode !== 'vent'
    && impactTimer <= 0
    && (desiredMode === 'pulse' || desiredMode === 'overtake' || dropBoostTimer > 0)
    && flux > 4
    && heat < 98
    && overheatTimer <= 0;
  const boost = damp(previous.boost, wantsBoost ? 1 : 0, wantsBoost ? 8 : 4.5, dt);
  if (wantsBoost) {
    flux = Math.max(0, flux - 17 * dt);
    heat = Math.min(100, heat + 15 * dt);
  } else {
    flux = Math.min(100, flux + (desiredMode === 'vent' ? 4.8 : 2.7) * dt);
    heat = Math.max(0, heat - (desiredMode === 'vent' ? 27 : 8.2) * dt);
  }
  if (heat >= 99 && overheatTimer <= 0) {
    overheatTimer = 1.8;
    heat = 76;
  }

  const paceError = clamp((finiteOr(input.paceReference, previous.distance) - previous.distance) / 560, -1, 1);
  const paceAssist = paceError >= 0 ? paceError * 0.05 : paceError * 0.038;
  const draftAssist = desiredMode === 'draft' ? 0.016 : 0;
  const boostAssist = boost * 0.105;
  const ventPenalty = desiredMode === 'vent' ? -0.17 : 0;
  const hazardPenalty = HAZARD_MODES.has(desiredMode) ? -0.01 * (1 - profile.skill) : 0;
  const speedFactor = clamp(
    profile.baseSpeedFactor + paceAssist + beatImpulse + draftAssist + boostAssist + ventPenalty + hazardPenalty,
    0.78,
    1.16,
  );
  const targetSpeed = Math.max(0, model.baseSpeed * speedFactor);
  const speed = damp(previous.speed, targetSpeed, targetSpeed > previous.speed ? 1.55 + profile.skill * 0.4 : 3.2, dt);
  const distance = Math.min(model.length, previous.distance + Math.max(0, speed) * dt);
  const crossedHazards: RivalAIHazardCue[] = [];
  let nextHazardCursor = hazardCursor;
  while (nextHazardCursor < model.hazards.length && model.hazards[nextHazardCursor].distance <= distance) {
    const crossed = model.hazards[nextHazardCursor];
    if (crossed.distance >= previous.distance - 1e-6) crossedHazards.push(crossed);
    nextHazardCursor += 1;
  }
  let laneCenter = previous.laneCenter;
  if (crossedHazards.length > 0) {
    laneCenter = wrapAngle(crossedHazards[crossedHazards.length - 1].safeAngle);
  }
  const finishTick = previous.finishTick ?? (distance >= model.length ? Math.max(0, Math.trunc(input.tick)) : null);

  return {
    state: {
      distance,
      speed: finishTick === null ? speed : 0,
      angle: steeringState.angle,
      angularVelocity: steeringState.angularVelocity,
      laneCenter,
      mode: desiredMode,
      modeTime,
      tacticCooldown,
      draftCharge,
      flux,
      heat,
      overheatTimer,
      beatImpulse,
      dropBoostTimer,
      breakTimer,
      impactTimer,
      boost,
      hazardCursor: nextHazardCursor,
      beatCursor,
      transitionCursor,
      finishTick,
    },
    targetAngle,
    targetSpeed,
    steering,
    activeHazardId: hazardUrgency > 0 ? hazard.id : null,
    crossedHazardIds: crossedHazards.map((crossed) => crossed.id),
    modeChanged,
    hitHazard: false,
  };
}

export function applyRivalHazardImpact(
  previous: Readonly<RivalAIState>,
  profile: Readonly<RivalAIProfile>,
): RivalAIState {
  return {
    ...previous,
    speed: previous.speed * (0.62 + profile.skill * 0.08),
    laneCenter: previous.angle,
    mode: 'vent',
    modeTime: 0,
    tacticCooldown: Math.max(previous.tacticCooldown, 0.9),
    flux: Math.max(0, previous.flux - 7),
    heat: Math.min(100, previous.heat + 17),
    impactTimer: Math.max(previous.impactTimer, 0.5),
    boost: previous.boost * 0.35,
  };
}

export const RIVAL_ARCHETYPE_LABELS: Readonly<Record<RivalArchetype, string>> = {
  'apex-reader': 'APEX',
  'pulse-striker': 'PULSE',
  'slipstream-hunter': 'HUNTER',
  'edge-gambler': 'EDGE',
};
