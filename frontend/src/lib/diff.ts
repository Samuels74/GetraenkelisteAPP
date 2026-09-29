/**
 * Returns only the fields of `next` whose values differ from `original`
 * (shallow, `Object.is`). Used so that updates never re-send stale values of
 * fields the user did not touch (another admin may have changed them).
 */
export function changedFields<T extends object>(original: T, next: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!Object.is(original[key], next[key])) patch[key] = next[key];
  }
  return patch;
}

export function isEmptyPatch(patch: object): boolean {
  return Object.keys(patch).length === 0;
}
