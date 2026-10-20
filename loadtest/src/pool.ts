/**
 * Runs async work over a list with a fixed number of operations in flight
 * (closed-loop workers: a worker only starts its next item after the previous
 * one finished). Used for the seeder's create requests and reusable for load
 * scenarios.
 *
 * - A worker that throws stops the pool: no new items are started, in-flight
 *   items finish, then the first error is rethrown.
 * - An aborted `signal` stops starting new items the same way and rejects
 *   with the signal's reason.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer (got ${concurrency})`);
  }
  const { signal } = options;
  let next = 0;
  let failure: { error: unknown } | null = null;

  const loop = async (): Promise<void> => {
    while (failure === null && !signal?.aborted && next < items.length) {
      const index = next++;
      try {
        await worker(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  if (failure !== null) throw (failure as { error: unknown }).error;
  signal?.throwIfAborted();
}
