export const TOUCH_INPUT_ACTIONS = [
  'left',
  'right',
  'cool',
  'boost',
  'fire',
] as const;

export type TouchInputAction = (typeof TOUCH_INPUT_ACTIONS)[number];

export type TouchInputChangeHandler = (action: TouchInputAction, active: boolean) => void;

/**
 * Converts Pointer Events into action-level pressed state.
 *
 * A single action can be held by multiple pointers. The change handler only
 * runs when the action changes between inactive and active, so releasing one
 * of several pointers does not interrupt the remaining touch.
 */
export class TouchInputRouter {
  private readonly actionPointers = new Map<TouchInputAction, Set<number>>(
    TOUCH_INPUT_ACTIONS.map((action) => [action, new Set<number>()]),
  );

  private readonly pointerActions = new Map<number, TouchInputAction>();

  constructor(private readonly onChange: TouchInputChangeHandler) {}

  /** Associates a pointer with an action, releasing its previous action first. */
  press(pointerId: number, action: TouchInputAction): void {
    const previousAction = this.pointerActions.get(pointerId);
    if (previousAction === action) return;

    if (previousAction !== undefined) this.release(pointerId);

    const pointers = this.actionPointers.get(action)!;
    const wasActive = pointers.size > 0;
    pointers.add(pointerId);
    this.pointerActions.set(pointerId, action);

    if (!wasActive) this.onChange(action, true);
  }

  /** Releases a pointer. Returns false when the pointer was not registered. */
  release(pointerId: number): boolean {
    const action = this.pointerActions.get(pointerId);
    if (action === undefined) return false;

    this.pointerActions.delete(pointerId);
    const pointers = this.actionPointers.get(action)!;
    pointers.delete(pointerId);

    if (pointers.size === 0) this.onChange(action, false);
    return true;
  }

  /** Releases every active pointer and emits one inactive transition per action. */
  releaseAll(): void {
    const activeActions = TOUCH_INPUT_ACTIONS.filter(
      (action) => this.actionPointers.get(action)!.size > 0,
    );

    this.pointerActions.clear();
    for (const pointers of this.actionPointers.values()) pointers.clear();
    for (const action of activeActions) this.onChange(action, false);
  }

  isActive(action: TouchInputAction): boolean {
    return this.actionPointers.get(action)!.size > 0;
  }

  pointerCount(action: TouchInputAction): number {
    return this.actionPointers.get(action)!.size;
  }
}
