/**
 * Seeded pseudo-random numbers. The dataset must be reproducible for a given
 * seed, so nothing in the generator may use Math.random().
 *
 * Generator: sfc32 ("Small Fast Counting", 128-bit state) seeded through the
 * cyrb128 string hash – two tiny, well-known public-domain algorithms whose
 * statistical quality is far beyond what a test-data generator needs.
 *
 * Every part of the dataset (names, bookings, timestamps, order) draws from
 * its own stream (`deriveRandom(seed, label)`), so changing one option (e.g.
 * the number of days) does not reshuffle unrelated parts (e.g. the names).
 */

function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(seedWords: [number, number, number, number]): () => number {
  let [a, b, c, d] = seedWords;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface Random {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (both inclusive). */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Index i with a probability proportional to weights[i]. */
  weightedIndex(weights: readonly number[]): number;
  /** Fisher–Yates shuffle in place; returns the same array. */
  shuffle<T>(items: T[]): T[];
}

export function createRandom(seed: string): Random {
  const next = sfc32(cyrb128(seed));
  // the first outputs still correlate with the seed hash – discard them
  for (let i = 0; i < 16; i++) next();

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`invalid integer range [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('cannot pick from an empty list');
      return items[int(0, items.length - 1)] as T;
    },
    weightedIndex(weights) {
      let total = 0;
      for (const weight of weights) {
        if (!(weight >= 0)) throw new RangeError(`invalid weight ${weight}`);
        total += weight;
      }
      if (total <= 0) throw new RangeError('weights must not all be zero');
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i] as number;
        if (r < 0) return i;
      }
      // floating point rest: the last index with a positive weight
      for (let i = weights.length - 1; i >= 0; i--) if ((weights[i] as number) > 0) return i;
      return weights.length - 1;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(0, i);
        [items[i], items[j]] = [items[j] as T, items[i] as T];
      }
      return items;
    },
  };
}

/** An independent stream for one part of the dataset. */
export function deriveRandom(seed: string, label: string): Random {
  return createRandom(`${seed}\u0000${label}`);
}
