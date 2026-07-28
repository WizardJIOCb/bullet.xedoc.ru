import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ChaseDeathFx, resolveDeathFxBudget, resolveDeathFxVariant } from './deathFx';

describe('death FX budgets', () => {
  it('scales monotonically with quality and retains geometry in safe-flash mode', () => {
    const performance = resolveDeathFxBudget('performance', false);
    const balanced = resolveDeathFxBudget('balanced', false);
    const quality = resolveDeathFxBudget('quality', false);
    const safe = resolveDeathFxBudget('quality', true);

    expect(performance.shards).toBeLessThan(balanced.shards);
    expect(balanced.shards).toBeLessThan(quality.shards);
    expect(performance.sparks).toBeLessThan(balanced.sparks);
    expect(balanced.sparks).toBeLessThan(quality.sparks);
    expect(safe.shards).toBeGreaterThan(0);
    expect(safe.sparks).toBeGreaterThan(0);
    expect(safe.rings).toBeGreaterThan(0);
    expect(safe.flashScale).toBeLessThan(quality.flashScale);
  });

  it('selects all three deterministic variants', () => {
    expect([0, 1, 2].map(resolveDeathFxVariant)).toEqual([
      'reactor-bloom',
      'lateral-shear',
      'engine-rupture',
    ]);
    expect(resolveDeathFxVariant(Number.NaN)).toBe('reactor-bloom');
  });
});

describe('ChaseDeathFx resource ownership', () => {
  it('clones top-level opaque craft resources and leaves its source untouched on dispose', () => {
    const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
    const sourceMaterial = new THREE.MeshBasicMaterial({ color: 0x123456 });
    const disposeGeometry = vi.spyOn(sourceGeometry, 'dispose');
    const disposeMaterial = vi.spyOn(sourceMaterial, 'dispose');
    const source = new THREE.Group();
    source.add(new THREE.Mesh(sourceGeometry, sourceMaterial));
    source.add(new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
    ));
    source.add(new THREE.Mesh(
      new THREE.SphereGeometry(1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
    ));

    const effect = new ChaseDeathFx(source);
    const fragment = effect.group.getObjectByName('death-fragment-0') as THREE.Mesh;
    expect(fragment).toBeInstanceOf(THREE.Mesh);
    expect(fragment.geometry).not.toBe(sourceGeometry);
    expect(fragment.material).not.toBe(sourceMaterial);
    expect(effect.group.getObjectByName('death-fragment-1')).toBeUndefined();

    effect.dispose();
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
    sourceGeometry.dispose();
    sourceMaterial.dispose();
  });
});
