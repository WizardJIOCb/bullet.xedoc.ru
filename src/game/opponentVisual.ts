import * as THREE from 'three';
import { clamp } from '../core/math';

const BASIS_EPSILON = 1e-8;
const FALLBACK_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_RIGHT = new THREE.Vector3(1, 0, 0);
const DEFAULT_READABLE_FACING_ANGLE = Math.PI / 3;
const SCRATCH_FORWARD = new THREE.Vector3();
const SCRATCH_CAMERA_TO_CRAFT = new THREE.Vector3();
const SCRATCH_UP = new THREE.Vector3();
const SCRATCH_RIGHT = new THREE.Vector3();
const SCRATCH_FULL_TURN = new THREE.Quaternion();
const SCRATCH_PARTIAL_TURN = new THREE.Quaternion();
const SCRATCH_BASIS = new THREE.Matrix4();

/**
 * Builds a visual-only opponent orientation.
 *
 * The craft still follows its authoritative tunnel position and angle. Only
 * a genuinely side-on rendered forward axis receives a bounded camera-facing
 * assist, so ordinary turns still follow the track while the broad stern
 * cannot collapse into an edge-on line. The reconstructed basis is explicitly
 * right-handed; passing a reflected basis to Quaternion.setFromRotationMatrix
 * is undefined and was the source of abrupt-looking flips.
 */
export function resolveOpponentVisualQuaternion(
  tangent: Readonly<THREE.Vector3>,
  radial: Readonly<THREE.Vector3>,
  position: Readonly<THREE.Vector3>,
  cameraPosition: Readonly<THREE.Vector3>,
  target = new THREE.Quaternion(),
  maxFacingAssistRadians = Math.PI / 4,
  readableFacingAngleRadians = DEFAULT_READABLE_FACING_ANGLE,
): THREE.Quaternion {
  const forward = SCRATCH_FORWARD.copy(tangent).normalize();
  const cameraToCraft = SCRATCH_CAMERA_TO_CRAFT.subVectors(position, cameraPosition);

  if (cameraToCraft.lengthSq() > BASIS_EPSILON) {
    cameraToCraft.normalize();
    const viewDot = clamp(forward.dot(cameraToCraft), -1, 1);
    // The craft silhouette is readable from both front and rear. Choose the
    // nearer plane-normal direction instead of rotating a visible rear view
    // through an edge-on angle merely because its signed dot is negative.
    if (viewDot < 0) cameraToCraft.multiplyScalar(-1);
    const separation = Math.acos(Math.abs(viewDot));
    const readableSeparation = clamp(readableFacingAngleRadians, 0, Math.PI);
    const assist = Math.min(
      Math.max(0, maxFacingAssistRadians),
      Math.max(0, separation - readableSeparation),
    );
    if (separation > BASIS_EPSILON && assist > 0) {
      const fullTurn = SCRATCH_FULL_TURN.setFromUnitVectors(forward, cameraToCraft);
      const partialTurn = SCRATCH_PARTIAL_TURN.identity().slerp(fullTurn, assist / separation);
      forward.applyQuaternion(partialTurn).normalize();
    }
  }

  const up = SCRATCH_UP.copy(radial)
    .addScaledVector(forward, -radial.dot(forward));
  if (up.lengthSq() <= BASIS_EPSILON) {
    up.copy(Math.abs(forward.dot(FALLBACK_UP)) < 0.92 ? FALLBACK_UP : FALLBACK_RIGHT)
      .addScaledVector(forward, -up.dot(forward));
  }
  up.normalize();

  // right = up cross forward and up = forward cross right guarantee a proper basis.
  const right = SCRATCH_RIGHT.copy(up).cross(forward).normalize();
  up.copy(forward).cross(right).normalize();

  SCRATCH_BASIS.makeBasis(right, up, forward);
  return target.setFromRotationMatrix(SCRATCH_BASIS).normalize();
}
