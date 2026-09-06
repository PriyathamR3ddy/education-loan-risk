import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRng } from "../src/engine/rng.ts";
import { percentileSorted, sampleCurve, summarize } from "../src/engine/dist.ts";
import { amortizingPayment } from "../src/engine/path.ts";
import { simulate } from "../src/engine/simulate.ts";
import { buildReceipt, hashInput, verifyReceipt } from "../src/receipt/receipt.ts";
import { referenceStudent, collectSources } from "../src/data/corridors/in-us-cs.ts";
import type { PercentileCurve, SimulationConfig } from "../src/engine/types.ts";

const fast: SimulationConfig = { paths: 2000, horizonMonths: 180, seed: "test-seed" };

const curve: PercentileCurve = {
  points: [
    { p: 0.1, v: 100 },
    { p: 0.5, v: 200 },
    { p: 0.9, v: 400 },
  ],
  source: { id: "t", label: "test", kind: "placeholder", placeholder: true },
};

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng("abc");
    const b = createRng("abc");
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });

  it("produces different streams for different seeds", () => {
    const a = createRng("abc");
    const b = createRng("abd");
    const sameCount = Array.from({ length: 50 }, () => (a.next() === b.next() ? 1 : 0)).reduce(
      (x: number, y: number) => x + y,
      0,
    );
    assert.equal(sameCount, 0);
  });

  it("draws uniforms in [0,1) and roughly standard normals", () => {
    const rng = createRng("stats");
    let sum = 0;
    let sumSq = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      assert.ok(u >= 0 && u < 1);
      const z = rng.normal();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    assert.ok(Math.abs(mean) < 0.02, `mean ${mean}`);
    assert.ok(Math.abs(variance - 1) < 0.05, `variance ${variance}`);
  });
});

describe("percentile curves", () => {
  it("interpolates linearly between published points", () => {
    // A sampler whose uniform draw is pinned to exactly the median percentile.
    const pinned = { next: () => 0.5, normal: () => 0, bernoulli: () => false };
    assert.equal(sampleCurve(curve, pinned), 200);
  });

  it("stays positive and ordered in the extrapolated tails", () => {
    const low = { next: () => 0.001, normal: () => 0, bernoulli: () => false };
    const high = { next: () => 0.999, normal: () => 0, bernoulli: () => false };
    const lo = sampleCurve(curve, low);
    const hi = sampleCurve(curve, high);
    assert.ok(lo > 0, `lower tail ${lo} must stay positive`);
    assert.ok(lo < 100, "lower tail must sit below the p10 point");
    assert.ok(hi > 400, "upper tail must sit above the p90 point");
  });

  it("reproduces its own percentiles when sampled in bulk", () => {
    const rng = createRng("curve");
    const draws = Array.from({ length: 40_000 }, () => sampleCurve(curve, rng)).sort(
      (a, b) => a - b,
    );
    assert.ok(Math.abs(percentileSorted(draws, 0.5) - 200) < 5);
    assert.ok(Math.abs(percentileSorted(draws, 0.9) - 400) < 15);
  });
});

describe("summarize", () => {
  it("orders percentiles and computes the mean", () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(s.p05 <= s.p10 && s.p10 <= s.p50 && s.p50 <= s.p90);
    assert.equal(s.mean, 5.5);
    assert.equal(s.p50, 5.5);
  });

  it("returns NaN rather than throwing on an empty sample", () => {
    assert.ok(Number.isNaN(summarize([]).p50));
  });
});

describe("amortization", () => {
  it("matches a hand-computed payment", () => {
    // 1,000,000 at 12% nominal over 120 months = 14,347.09 per month.
    const p = amortizingPayment(1_000_000, 0.12 / 12, 120);
    assert.ok(Math.abs(p - 14_347.09) < 0.5, `got ${p}`);
  });

  it("degrades to straight line at a zero rate", () => {
    assert.equal(amortizingPayment(1200, 0, 12), 100);
  });

  it("fully amortizes the balance over the tenure", () => {
    const principal = 500_000;
    const r = 0.1 / 12;
    const n = 60;
    let bal = principal;
    const pmt = amortizingPayment(principal, r, n);
    for (let i = 0; i < n; i++) bal = bal * (1 + r) - pmt;
    assert.ok(Math.abs(bal) < 0.01, `residual ${bal}`);
  });
});

describe("simulation", () => {
  it("is reproducible for a given seed", () => {
    const a = simulate(referenceStudent, fast);
    const b = simulate(referenceStudent, fast);
    assert.deepEqual(a, b);
  });

  it("produces finite headline numbers with no NaN leakage", () => {
    const r = simulate(referenceStudent, fast);
    for (const v of [
      r.pDestJob,
      r.pVisaSelected,
      r.pReturnHome,
      r.pRepayFromHomeIncome,
      r.pStillRepayingAt35,
      r.pNeverBreakEven,
      r.tailCostYear7,
      r.netWorthYear7.p50,
      r.netWorthYear15.p50,
    ]) {
      assert.ok(Number.isFinite(v), `expected finite, got ${v}`);
    }
  });

  it("keeps every probability inside [0,1]", () => {
    const r = simulate(referenceStudent, fast);
    for (const v of [r.pDestJob, r.pVisaSelected, r.pReturnHome, r.pRepayFromHomeIncome]) {
      assert.ok(v >= 0 && v <= 1, `probability out of range: ${v}`);
    }
  });

  it("recovers the employment probability it was given", () => {
    const r = simulate(referenceStudent, fast);
    assert.ok(
      Math.abs(r.pDestJob - referenceStudent.program.pDestOffer) < 0.03,
      `pDestJob ${r.pDestJob} should track pDestOffer ${referenceStudent.program.pDestOffer}`,
    );
  });

  it("recovers the compound lottery probability", () => {
    const r = simulate(referenceStudent, fast);
    const { lotterySelectionProbability: p, employerSponsorshipRate: s } =
      referenceStudent.corridor.immigration;
    // Three annual registrations, conditional on employment and sponsorship.
    const expected = referenceStudent.program.pDestOffer * s * (1 - Math.pow(1 - p, 3));
    assert.ok(
      Math.abs(r.pVisaSelected - expected) < 0.03,
      `pVisaSelected ${r.pVisaSelected} vs expected ${expected}`,
    );
  });

  it("everyone who does not clear the lottery ends up home", () => {
    const r = simulate(referenceStudent, fast);
    assert.ok(Math.abs(r.pReturnHome - (1 - r.pVisaSelected)) < 1e-9);
  });

  it("gets worse as the interest rate rises", () => {
    const dearer = structuredClone(referenceStudent);
    dearer.loan.nominalRate += 0.05;
    const base = simulate(referenceStudent, fast);
    const worse = simulate(dearer, fast);
    assert.ok(
      worse.tailCostYear7 < base.tailCostYear7,
      `tail should worsen: ${worse.tailCostYear7} vs ${base.tailCostYear7}`,
    );
  });

  it("gets better as employment odds rise", () => {
    const better = structuredClone(referenceStudent);
    better.program.pDestOffer = 0.95;
    const base = simulate(referenceStudent, fast);
    const good = simulate(better, fast);
    assert.ok(good.netWorthYear7.p50 > base.netWorthYear7.p50);
    assert.ok(good.pRepayFromHomeIncome < base.pRepayFromHomeIncome);
  });

  it("charges the family contribution against the degree path", () => {
    // Family cash is spent capital. Adding it must not make the student richer
    // than the counterfactual for free; it should only reduce borrowing.
    const rich = structuredClone(referenceStudent);
    rich.familyContribution += 5_000_000;
    const base = simulate(referenceStudent, fast);
    const withCash = simulate(rich, fast);
    assert.ok(
      withCash.netWorthYear7.p50 < base.netWorthYear7.p50 + 5_000_000,
      "family cash must not appear as free net worth",
    );
  });

  it("removes repayment risk entirely when nothing is borrowed", () => {
    const funded = structuredClone(referenceStudent);
    funded.loan.sanctioned = 0;
    funded.familyContribution = 100_000_000;
    const r = simulate(funded, fast);
    assert.equal(r.pRepayFromHomeIncome, 0);
    assert.equal(r.pStillRepayingAt35, 0);
  });
});

describe("decision receipt", () => {
  const result = simulate(referenceStudent, fast);
  const sources = collectSources(referenceStudent);
  const receipt = buildReceipt(referenceStudent, fast, result, [], sources);

  it("hashes inputs stably regardless of key order", () => {
    const reordered = { ...structuredClone(referenceStudent) };
    assert.equal(hashInput(reordered, fast), hashInput(referenceStudent, fast));
  });

  it("changes its hash when an assumption moves", () => {
    const moved = structuredClone(referenceStudent);
    moved.loan.nominalRate += 0.0001;
    assert.notEqual(hashInput(moved, fast), receipt.inputHash);
  });

  it("verifies against the inputs it was built from", () => {
    assert.deepEqual(verifyReceipt(receipt, referenceStudent, fast), { ok: true });
  });

  it("refuses to verify against altered inputs", () => {
    const moved = structuredClone(referenceStudent);
    moved.familyContribution += 1;
    const v = verifyReceipt(receipt, moved, fast);
    assert.equal(v.ok, false);
  });

  it("marks the reference scenario uncalibrated while priors stand in for data", () => {
    assert.equal(receipt.calibrated, false);
    assert.ok(receipt.provenance.every((p) => p.placeholder));
  });
});
