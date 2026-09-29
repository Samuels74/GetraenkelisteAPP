/** Short haptic feedback where supported (Android Chrome); no-op elsewhere. */
export function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // ignore – vibration is best effort
  }
}

export const VIBRATE_SUCCESS = 35;
export const VIBRATE_ERROR = [80, 60, 80];
