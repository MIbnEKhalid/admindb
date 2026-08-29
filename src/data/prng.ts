/**
 * PRNG (Pseudo-Random Number Generator)
 * 
 * Provides deterministic pseudo-randomness via Mulberry32 algorithm.
 * When a numeric seed is provided, identical sequence of numbers is generated.
 * When no seed is provided, falls back to Math.random.
 */

export interface RandomSource {
  next(): number;
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  pick<T>(arr: readonly T[]): T;
  pickMany<T>(arr: readonly T[], count: number, unique?: boolean): T[];
  shuffle<T>(arr: T[]): T[];
  weightedPick<T>(items: readonly T[], weights: readonly number[]): T;
  chance(pct: number): boolean;
}

export function createPrng(seed?: number | null): RandomSource {
  let s = seed != null && Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : null;

  function next(): number {
    if (s === null) return Math.random();
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const int = (min: number, max: number): number => {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(next() * (hi - lo + 1)) + lo;
  };

  const float = (min: number, max: number): number => {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return next() * (hi - lo) + lo;
  };

  const pick = <T>(arr: readonly T[]): T => (!arr || arr.length === 0 ? (undefined as unknown as T) : arr[int(0, arr.length - 1)]);

  const shuffle = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(0, i);
      const temp = arr[i];
      arr[i] = arr[j];
      arr[j] = temp;
    }
    return arr;
  };

  const pickMany = <T>(arr: readonly T[], count: number, unique = false): T[] => {
    if (!arr || !arr.length || count <= 0) return [];
    if (!unique) {
      return Array.from({ length: count }, () => pick(arr));
    }
    const pool = [...arr];
    shuffle(pool);
    return pool.slice(0, Math.min(count, pool.length));
  };

  const weightedPick = <T>(items: readonly T[], weights: readonly number[]): T => {
    if (!items.length) return undefined as unknown as T;
    if (items.length !== weights.length) return pick(items);
    const total = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
    if (total <= 0) return pick(items);

    const r = float(0, total);
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      acc += Math.max(0, weights[i]);
      if (r <= acc) return items[i];
    }
    return items[items.length - 1];
  };

  const chance = (pct: number): boolean => float(0, 100) < pct;

  return {
    next,
    int,
    float,
    pick,
    pickMany,
    shuffle,
    weightedPick,
    chance,
  };
}
