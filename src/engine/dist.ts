/**
 * Sampling from empirical percentile curves, plus summary statistics.
 *
 * Wage data arrives as percentiles because that is the shape the public sources
 * publish it in: DOL disclosure files and College Scorecard both give
 * percentile points, never parametric fits. Fitting a lognormal to them would
 * throw away the bimodality that matters most in this problem, so the engine
 * samples the empirical curve directly and only goes parametric in the tails,
 * where it has no data and has to say so.
 */

import type { PercentileCurve, Summary } from "./types.ts";
import type { Rng } from "./rng.ts";

/**
 * Inverse-CDF sample from a percentile curve.
 *
 * Inside the observed range this is linear interpolation between percentile
 * points. Outside it (below the lowest published percentile or above the
 * highest) it extends log-linearly using the slope of the nearest observed
 * segment, which keeps the tail positive and monotone without inventing a
 * fatter tail than the data implies.
 */
export function sampleCurve(curve: PercentileCurve, rng: Rng): number {
  const pts = curve.points;
  if (pts.length === 0) throw new Error("empty percentile curve");
  const first = pts[0]!;
  if (pts.length === 1) return first.v;
  const last = pts[pts.length - 1]!;

  const u = rng.next();

  if (u <= first.p) return extrapolate(first, pts[1]!, u);
  if (u >= last.p) return extrapolate(pts[pts.length - 2]!, last, u);

  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!;
    if (u <= hi.p) {
      const lo = pts[i - 1]!;
      const t = (u - lo.p) / (hi.p - lo.p);
      return lo.v + t * (hi.v - lo.v);
    }
  }
  return last.v;
}

/** Log-linear extension beyond the observed percentile range. */
function extrapolate(
  a: { p: number; v: number },
  b: { p: number; v: number },
  u: number,
): number {
  if (a.v <= 0 || b.v <= 0) {
    const slope = (b.v - a.v) / (b.p - a.p);
    return Math.max(0, a.v + slope * (u - a.p));
  }
  const slope = (Math.log(b.v) - Math.log(a.v)) / (b.p - a.p);
  return Math.exp(Math.log(a.v) + slope * (u - a.p));
}

/** Median of a curve, without sampling. Used for deterministic previews. */
export function curveMedian(curve: PercentileCurve): number {
  const pts = curve.points;
  const first = pts[0]!;
  if (pts.length === 1) return first.v;
  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i]!;
    if (0.5 <= hi.p) {
      const lo = pts[i - 1]!;
      if (hi.p === lo.p) return hi.v;
      const t = (0.5 - lo.p) / (hi.p - lo.p);
      return lo.v + t * (hi.v - lo.v);
    }
  }
  return pts[pts.length - 1]!.v;
}

/** Percentile of an already-sorted ascending array, linear interpolation. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    return { p05: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, mean: NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    p05: percentileSorted(sorted, 0.05),
    p10: percentileSorted(sorted, 0.1),
    p25: percentileSorted(sorted, 0.25),
    p50: percentileSorted(sorted, 0.5),
    p75: percentileSorted(sorted, 0.75),
    p90: percentileSorted(sorted, 0.9),
    mean: sum / sorted.length,
  };
}

/** Fraction of the array satisfying the predicate. */
export function fractionWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  let n = 0;
  for (const item of items) if (pred(item)) n++;
  return n / items.length;
}
