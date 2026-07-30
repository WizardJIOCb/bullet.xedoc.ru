import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { resolveOpponentVisualQuaternion } from './opponentVisual';

const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);

function expectVectorClose(actual: THREE.Vector3, expected: THREE.Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
}

describe('opponent visual orientation', () => {
  it('keeps a straight-ahead craft face-readable without changing its track position', () => {
    const tangent = new THREE.Vector3(0, 0, 1);
    const radial = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3(2, 4, 32);
    const cameraPosition = new THREE.Vector3(2, 4, 0);
    const originalTangent = tangent.clone();
    const originalRadial = radial.clone();
    const originalPosition = position.clone();
    const originalCameraPosition = cameraPosition.clone();

    const orientation = resolveOpponentVisualQuaternion(
      tangent,
      radial,
      position,
      cameraPosition,
    );
    const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();
    const right = LOCAL_RIGHT.clone().applyQuaternion(orientation).normalize();
    const up = LOCAL_UP.clone().applyQuaternion(orientation).normalize();

    expectVectorClose(forward, tangent);
    // A quaternion must describe a proper rotation, never the reflected
    // circumferential/radial/tangent basis that previously collapsed rivals.
    expect(right.clone().cross(up).dot(forward)).toBeGreaterThan(0.999);
    expect(Math.abs(right.dot(forward))).toBeLessThan(0.000001);
    expect(Math.abs(up.dot(forward))).toBeLessThan(0.000001);

    expectVectorClose(tangent, originalTangent);
    expectVectorClose(radial, originalRadial);
    expectVectorClose(position, originalPosition);
    expectVectorClose(cameraPosition, originalCameraPosition);
  });

  it('turns the presentation toward the camera view by a bounded amount on a sharp curve', () => {
    const tangent = new THREE.Vector3(1, 0, 0);
    const radial = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3(0, 0, 40);
    const cameraPosition = new THREE.Vector3(0, 0, 0);
    const maxAssist = Math.PI / 4;
    const readableAngle = Math.PI / 3;
    const viewDirection = position.clone().sub(cameraPosition).normalize();
    const sourceAngle = tangent.angleTo(viewDirection);

    const orientation = resolveOpponentVisualQuaternion(
      tangent,
      radial,
      position,
      cameraPosition,
      new THREE.Quaternion(),
      maxAssist,
      readableAngle,
    );
    const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();
    const right = LOCAL_RIGHT.clone().applyQuaternion(orientation).normalize();
    const up = LOCAL_UP.clone().applyQuaternion(orientation).normalize();

    expect(tangent.angleTo(forward)).toBeCloseTo(sourceAngle - readableAngle, 6);
    expect(forward.angleTo(viewDirection)).toBeCloseTo(readableAngle, 6);
    expect(right.clone().cross(up).dot(forward)).toBeGreaterThan(0.999);
  });

  it('keeps ordinary readable turns aligned with the physical track tangent', () => {
    const tangent = new THREE.Vector3(0, 0, 1);
    const radial = new THREE.Vector3(0, 1, 0);
    const angle = Math.PI / 6;
    const position = new THREE.Vector3(Math.sin(angle) * 40, 0, Math.cos(angle) * 40);
    const cameraPosition = new THREE.Vector3(0, 0, 0);

    const orientation = resolveOpponentVisualQuaternion(
      tangent,
      radial,
      position,
      cameraPosition,
    );
    const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();

    expectVectorClose(forward, tangent);
  });

  it('treats an equally wide rear silhouette as readable without a needless turn', () => {
    const tangent = new THREE.Vector3(0, 0, 1);
    const radial = new THREE.Vector3(0, 1, 0);
    const angle = Math.PI * 2 / 3;
    const position = new THREE.Vector3(Math.sin(angle) * 40, 0, Math.cos(angle) * 40);
    const cameraPosition = new THREE.Vector3(0, 0, 0);

    const orientation = resolveOpponentVisualQuaternion(
      tangent,
      radial,
      position,
      cameraPosition,
    );
    const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();

    expectVectorClose(forward, tangent);
  });

  it('remains face-on and right-handed across a full tunnel-wall angular sweep', () => {
    const tangent = new THREE.Vector3(0, 0, 1);
    const position = new THREE.Vector3(0, 0, 30);
    const cameraPosition = new THREE.Vector3(0, 0, 0);
    const viewDirection = position.clone().sub(cameraPosition).normalize();

    for (let step = 0; step < 32; step += 1) {
      const angle = step / 32 * Math.PI * 2;
      const radial = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
      const originalRadial = radial.clone();
      const orientation = resolveOpponentVisualQuaternion(
        tangent,
        radial,
        position,
        cameraPosition,
      );
      const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();
      const right = LOCAL_RIGHT.clone().applyQuaternion(orientation).normalize();
      const up = LOCAL_UP.clone().applyQuaternion(orientation).normalize();

      // Changing wall lane is physical position data, not permission for a
      // reflected visual basis to turn the broad stern edge-on or inside-out.
      expect(forward.dot(viewDirection)).toBeGreaterThan(0.999);
      expect(right.clone().cross(up).dot(forward)).toBeGreaterThan(0.999);
      expectVectorClose(radial, originalRadial);
    }
  });

  it('never exceeds its facing-assist limit or mutates physical frame inputs', () => {
    const tangent = new THREE.Vector3(0.72, -0.18, 0.67).normalize();
    const radial = new THREE.Vector3(0.12, 0.98, 0.13)
      .addScaledVector(tangent, -new THREE.Vector3(0.12, 0.98, 0.13).dot(tangent))
      .normalize();
    const position = new THREE.Vector3(-8, 5, 24);
    const cameraPosition = new THREE.Vector3(4, -2, -10);
    const maxAssist = 0.31;
    const inputs = [tangent, radial, position, cameraPosition].map((value) => value.clone());
    const target = new THREE.Quaternion();

    const orientation = resolveOpponentVisualQuaternion(
      tangent,
      radial,
      position,
      cameraPosition,
      target,
      maxAssist,
    );
    const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation).normalize();

    expect(tangent.angleTo(forward)).toBeLessThanOrEqual(maxAssist + 0.000001);
    expect(orientation).toBe(target);
    expect(orientation.length()).toBeCloseTo(1, 6);
    expectVectorClose(tangent, inputs[0]);
    expectVectorClose(radial, inputs[1]);
    expectVectorClose(position, inputs[2]);
    expectVectorClose(cameraPosition, inputs[3]);
  });
});
