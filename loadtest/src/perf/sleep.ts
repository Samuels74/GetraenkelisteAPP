/**
 * The one `sleep` of the performance checks: setTimeout as a promise that
 * resolves early when the signal aborts – and then frees both the timer and
 * its abort listener, so an aborted run leaves nothing behind that keeps the
 * event loop alive.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}
