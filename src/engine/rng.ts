/**
 * Deterministic RNG.
 *
 * Reproducibility is a product feature, not a testing convenience: a Decision
 * Receipt states its seed, so anyone the student hands it to can re-run the
 * exact simulation years later and get the same numbers back. That is the whole
 * basis for the receipt being evidence rather than a screenshot.
 */

export interface Rng {
  /** Uniform on [0, 1). */
  next(): number;
  /** Standard normal via Box-Muller, with the spare value cached. */
  normal(): number;
  /** Bernoulli draw. */
  bernoulli(p: number): boolean;
}

/** FNV-1a over the seed string, so seeds can be human-readable. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32. Small, fast, and good enough for Monte Carlo of this size. */
export function createRng(seed: string): Rng {
  let state = hashSeed(seed);
  let spare: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    // Guard against log(0).
    let u = next();
    while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };

  return {
    next,
    normal,
    bernoulli: (p: number) => next() < p,
  };
}
