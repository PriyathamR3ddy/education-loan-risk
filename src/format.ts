/** Presentation helpers. Indian numbering, because the reader thinks in lakhs. */

export function inr(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1e7) return `${sign}Rs ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${sign}Rs ${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `${sign}Rs ${(v / 1e3).toFixed(0)}k`;
  return `${sign}Rs ${v.toFixed(0)}`;
}

export function usd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(digits)}%`;
}

export function months(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const y = Math.floor(value / 12);
  const m = Math.round(value % 12);
  if (y === 0) return `${m}mo`;
  return m === 0 ? `${y}y` : `${y}y ${m}mo`;
}

/**
 * Compact ASCII histogram. The distribution is the product, so it has to be
 * visible even from a terminal.
 */
export function histogram(
  values: readonly number[],
  opts: { bins?: number; width?: number; label: (v: number) => string },
): string[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return ["  (no data)"];
  const bins = opts.bins ?? 12;
  const width = opts.width ?? 40;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const counts = new Array<number>(bins).fill(0);
  for (const v of finite) {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / span) * bins));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const peak = Math.max(...counts);
  return counts.map((c, i) => {
    const lo = min + (span * i) / bins;
    const bar = "#".repeat(Math.round((c / peak) * width));
    const share = ((c / finite.length) * 100).toFixed(1).padStart(4);
    return `  ${opts.label(lo).padStart(12)} | ${bar.padEnd(width)} ${share}%`;
  });
}

export function rule(char = "-", width = 78): string {
  return char.repeat(width);
}
