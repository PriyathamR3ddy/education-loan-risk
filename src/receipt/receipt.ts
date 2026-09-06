/**
 * The Decision Receipt.
 *
 * This is the artifact, not the simulation. A student who runs a calculator has
 * a screenshot; a student who runs this has a hashed, seeded, reproducible
 * record of exactly which assumptions they committed to and what those
 * assumptions implied. That record does three jobs at once:
 *
 *  - it is the thing you hand a parent or co-signer, replacing an argument about
 *    vibes with a document;
 *  - it carries provenance on every input, so a claim sourced from a placement
 *    brochure cannot masquerade as one sourced from a government filing;
 *  - it is what the close-the-loop flow reopens 18 and 36 months later to ask
 *    what actually happened, which is how the model gets calibrated at all.
 *
 * The hash covers inputs, engine version and seed, so re-running later either
 * reproduces the receipt exactly or proves the assumptions changed.
 */

import { createHash } from "node:crypto";
import type {
  Lever,
  SimulationConfig,
  SimulationResult,
  SourceRef,
  StudentInput,
} from "../engine/types.ts";
import { inr, months, pct } from "../format.ts";

export const ENGINE_VERSION = "downside-engine/0.1.0";

export interface Receipt {
  version: 1;
  engine: string;
  generatedAt: string;
  seed: string;
  paths: number;
  horizonMonths: number;
  /** SHA-256 over canonical inputs plus engine version. Identifies the decision. */
  inputHash: string;
  /** SHA-256 over the headline results. Detects a silently changed engine. */
  resultHash: string;
  headline: {
    pRepayFromHomeIncome: number;
    pStillRepayingAt35: number;
    pNeverBreakEven: number;
    medianBreakEvenMonth: number;
    tailCostYear7: number;
    medianNetWorthYear7: number;
  };
  topLevers: Array<{ id: string; label: string; tailPointsRemoved: number }>;
  provenance: Array<Pick<SourceRef, "id" | "label" | "kind" | "placeholder">>;
  /** True when any input was a placeholder prior. Blocks student-facing use. */
  calibrated: boolean;
}

/** Deterministic JSON: keys sorted at every level, so the hash is stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function hashInput(input: StudentInput, config: SimulationConfig): string {
  return sha256(canonical({ engine: ENGINE_VERSION, input, config }));
}

export function buildReceipt(
  input: StudentInput,
  config: SimulationConfig,
  result: SimulationResult,
  levers: readonly Lever[],
  sources: readonly SourceRef[],
  now: Date = new Date(),
): Receipt {
  const headline = {
    pRepayFromHomeIncome: result.pRepayFromHomeIncome,
    pStillRepayingAt35: result.pStillRepayingAt35,
    pNeverBreakEven: result.pNeverBreakEven,
    medianBreakEvenMonth: result.breakEvenMonth.p50,
    tailCostYear7: result.tailCostYear7,
    medianNetWorthYear7: result.netWorthYear7.p50,
  };

  return {
    version: 1,
    engine: ENGINE_VERSION,
    generatedAt: now.toISOString(),
    seed: config.seed,
    paths: config.paths,
    horizonMonths: config.horizonMonths,
    inputHash: hashInput(input, config),
    resultHash: sha256(canonical(headline)),
    headline,
    topLevers: levers.slice(0, 3).map((l) => ({
      id: l.id,
      label: l.label,
      tailPointsRemoved: -l.deltaPRepayFromHomeIncome * 100,
    })),
    provenance: sources.map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      placeholder: s.placeholder,
    })),
    calibrated: sources.every((s) => !s.placeholder),
  };
}

/**
 * Re-run verification. Given a receipt and the inputs it claims to describe,
 * confirms the inputs hash to the same value. A mismatch means the assumptions
 * moved, which is exactly the question a co-signer should be able to settle.
 */
export function verifyReceipt(
  receipt: Receipt,
  input: StudentInput,
  config: SimulationConfig,
): { ok: boolean; reason?: string } {
  if (receipt.engine !== ENGINE_VERSION) {
    return { ok: false, reason: `engine version differs: ${receipt.engine} vs ${ENGINE_VERSION}` };
  }
  const h = hashInput(input, config);
  if (h !== receipt.inputHash) {
    return { ok: false, reason: "inputs do not match the receipt" };
  }
  return { ok: true };
}

export function renderReceipt(r: Receipt): string {
  const lines: string[] = [];
  lines.push("  DECISION RECEIPT");
  lines.push("  " + "-".repeat(76));
  lines.push(`  Issued      ${r.generatedAt}`);
  lines.push(`  Engine      ${r.engine}`);
  lines.push(`  Seed        ${r.seed}  (${r.paths.toLocaleString("en-US")} paths, ${months(r.horizonMonths)} horizon)`);
  lines.push(`  Input hash  ${r.inputHash}`);
  lines.push(`  Result hash ${r.resultHash}`);
  lines.push("");
  lines.push(`  Repay a foreign-priced degree on a home income   ${pct(r.headline.pRepayFromHomeIncome)}`);
  lines.push(`  Still repaying at 35                            ${pct(r.headline.pStillRepayingAt35)}`);
  lines.push(`  Never beats staying home                        ${pct(r.headline.pNeverBreakEven)}`);
  lines.push(`  Median break-even                               ${months(r.headline.medianBreakEvenMonth)}`);
  lines.push(`  Worst-decile position at year 7                 ${inr(r.headline.tailCostYear7)}`);
  lines.push("");
  lines.push("  Provenance");
  for (const p of r.provenance) {
    const mark = p.placeholder ? "[PRIOR]" : "[DATA] ";
    lines.push(`   ${mark} ${p.kind.padEnd(14)} ${p.label}`);
  }
  lines.push("");
  lines.push(
    r.calibrated
      ? "  Status: calibrated. Every input traces to an ingested source."
      : "  Status: UNCALIBRATED. Contains placeholder priors. Not for student use.",
  );
  lines.push("");
  lines.push("  Re-run with the same seed and inputs to reproduce this receipt exactly.");
  return lines.join("\n");
}
