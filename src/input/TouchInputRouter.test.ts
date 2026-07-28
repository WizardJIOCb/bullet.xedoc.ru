import { describe, expect, it, vi } from 'vitest';
import {
  TouchInputRouter,
  type TouchInputAction,
  type TouchInputChangeHandler,
} from './TouchInputRouter';

type Change = [TouchInputAction, boolean];

function createRouter(): {
  router: TouchInputRouter;
  changes: Change[];
  onChange: ReturnType<typeof vi.fn<TouchInputChangeHandler>>;
} {
  const changes: Change[] = [];
  const onChange = vi.fn<TouchInputChangeHandler>((action, active) => {
    changes.push([action, active]);
  });
  return { router: new TouchInputRouter(onChange), changes, onChange };
}

describe('TouchInputRouter', () => {
  it('emits changes only when an action crosses its active boundary', () => {
    const { router, changes } = createRouter();

    router.press(11, 'boost');
    router.press(11, 'boost');
    expect(router.isActive('boost')).toBe(true);
    expect(router.pointerCount('boost')).toBe(1);
    expect(changes).toEqual([['boost', true]]);

    expect(router.release(11)).toBe(true);
    expect(router.isActive('boost')).toBe(false);
    expect(changes).toEqual([['boost', true], ['boost', false]]);
  });

  it('keeps an action active until its final pointer is released', () => {
    const { router, changes } = createRouter();

    router.press(1, 'left');
    router.press(2, 'left');
    expect(router.pointerCount('left')).toBe(2);
    expect(changes).toEqual([['left', true]]);

    expect(router.release(1)).toBe(true);
    expect(router.isActive('left')).toBe(true);
    expect(router.pointerCount('left')).toBe(1);
    expect(changes).toEqual([['left', true]]);

    expect(router.release(2)).toBe(true);
    expect(router.isActive('left')).toBe(false);
    expect(changes).toEqual([['left', true], ['left', false]]);
  });

  it('tracks simultaneous actions independently', () => {
    const { router, changes } = createRouter();

    router.press(21, 'left');
    router.press(22, 'boost');
    router.press(23, 'fire');
    router.release(22);

    expect(router.isActive('left')).toBe(true);
    expect(router.isActive('boost')).toBe(false);
    expect(router.isActive('fire')).toBe(true);
    expect(changes).toEqual([
      ['left', true],
      ['boost', true],
      ['fire', true],
      ['boost', false],
    ]);
  });

  it('moves an existing pointer to a new action without leaving stale state', () => {
    const { router, changes } = createRouter();

    router.press(7, 'cool');
    router.press(7, 'right');

    expect(router.isActive('cool')).toBe(false);
    expect(router.isActive('right')).toBe(true);
    expect(changes).toEqual([
      ['cool', true],
      ['cool', false],
      ['right', true],
    ]);
  });

  it('does not deactivate an old action when another pointer still holds it during reassignment', () => {
    const { router, changes } = createRouter();

    router.press(1, 'fire');
    router.press(2, 'fire');
    router.press(1, 'boost');

    expect(router.isActive('fire')).toBe(true);
    expect(router.pointerCount('fire')).toBe(1);
    expect(router.isActive('boost')).toBe(true);
    expect(changes).toEqual([
      ['fire', true],
      ['boost', true],
    ]);
  });

  it('ignores unknown releases', () => {
    const { router, onChange } = createRouter();

    expect(router.release(999)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('releases all active actions exactly once and can be reused', () => {
    const { router, changes } = createRouter();

    router.press(1, 'right');
    router.press(2, 'right');
    router.press(3, 'cool');
    router.press(4, 'fire');
    router.releaseAll();

    expect(router.isActive('right')).toBe(false);
    expect(router.isActive('cool')).toBe(false);
    expect(router.isActive('fire')).toBe(false);
    expect(changes).toEqual([
      ['right', true],
      ['cool', true],
      ['fire', true],
      ['right', false],
      ['cool', false],
      ['fire', false],
    ]);

    router.releaseAll();
    expect(changes).toHaveLength(6);

    router.press(5, 'left');
    expect(router.isActive('left')).toBe(true);
    expect(changes.at(-1)).toEqual(['left', true]);
  });
});
