/**
 * Lets an action run only once per key (e.g. "Rückgängig" per booking id –
 * a double tap must not send a second DELETE). `release` re-allows a key,
 * e.g. after a failed attempt that may be retried.
 */
export function createOnceGuard() {
  const used = new Set<string>();
  return {
    tryBegin(key: string): boolean {
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
    release(key: string): void {
      used.delete(key);
    },
  };
}
