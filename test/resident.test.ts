import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UNEMPLOYMENT_GRACE_DAYS,
  runwayMonths,
  simulateResident,
  type ResidentInput,
} from "../src/engine/resident.ts";
import {
  monthlySurplusToday,
  prepaymentFrontier,
  residentAdvice,
  solveSafeDiscretionary,
} from "../src/engine/solve.ts";
import { referenceResident } from "../src/data/corridors/in-us-cs.ts";
import { amortizingPayment } from "../src/engine/path.ts";

const cfg = { paths: 1500, horizonMonths: 120, seed: "resident-test" };
const clone = (patch: Partial<ResidentInput> = {}): ResidentInput => ({
  ...structuredClone(referenceResident),
  ...structuredClone(patch),
});

describe("runway", () => {
  it("converts a home-currency instalment before adding it to dollar outgoings", () => {
    // Regression. Adding a rupee EMI straight onto a dollar burn understated
    // runway by roughly the exchange rate: 3.2 months read as 0.1.
    const input = clone();
    const fx = input.corridor.macro.fxSpot;
    const emiInr = amortizingPayment(
      input.loan.outstanding,
      input.loan.nominalRate / 12,
      input.loan.remainingTenureMonths,
    );
    const essentials =
      input.spend.rent + input.spend.groceries + input.spend.transport + input.spend.health;
    const expected =
      input.savings / (essentials + input.spend.discretionary * 0.3 + emiInr / fx);

    const actual = runwayMonths(input);
    assert.ok(Math.abs(actual - expected) < 0.01, `runway ${actual} vs expected ${expected}`);
    assert.ok(actual > 1, `runway should be months, not a rounding error: ${actual}`);
  });

  it("scales linearly with savings", () => {
    const a = runwayMonths(clone({ savings: 10_000 }));
    const b = runwayMonths(clone({ savings: 20_000 }));
    assert.ok(Math.abs(b - 2 * a) < 1e-9);
  });

  it("shortens when rent rises", () => {
    const cheap = clone();
    cheap.spend.rent = 1_200;
    const dear = clone();
    dear.spend.rent = 3_000;
    assert.ok(runwayMonths(dear) < runwayMonths(cheap));
  });
});

describe("visa clock", () => {
  it("is tightest on H-1B despite feeling like the most secure status", () => {
    assert.ok(UNEMPLOYMENT_GRACE_DAYS.h1b < UNEMPLOYMENT_GRACE_DAYS.opt);
    assert.ok(UNEMPLOYMENT_GRACE_DAYS.opt < UNEMPLOYMENT_GRACE_DAYS["stem-opt"]);
  });

  it("reports the clock the status actually gives", () => {
    const r = simulateResident(clone({ status: "h1b" }), cfg);
    assert.equal(r.visaClockMonths, 2);
  });

  it("produces no forced departure when the job never ends", () => {
    const safe = clone({ monthlyLayoffHazard: 0, status: "h1b", lotteryAttemptsRemaining: 0 });
    const r = simulateResident(safe, cfg);
    assert.equal(r.pForcedReturn, 0);
    assert.equal(r.pForcedReturnWhileOwing, 0);
  });

  it("forces departures when layoffs are certain and rehiring impossible", () => {
    const doomed = clone({ monthlyLayoffHazard: 1, monthlyRehireHazard: 0 });
    const r = simulateResident(doomed, cfg);
    assert.ok(r.pForcedReturn > 0.99, `expected near-certain departure, got ${r.pForcedReturn}`);
  });

  it("makes a longer grace period safer, all else equal", () => {
    const tight = simulateResident(clone({ status: "h1b" }), cfg);
    const loose = simulateResident(clone({ status: "stem-opt", lotteryAttemptsRemaining: 0 }), cfg);
    assert.ok(
      loose.pForcedReturn < tight.pForcedReturn,
      `stem-opt ${loose.pForcedReturn} should beat h1b ${tight.pForcedReturn}`,
    );
  });
});

describe("resident simulation", () => {
  it("is reproducible", () => {
    assert.deepEqual(simulateResident(clone(), cfg), simulateResident(clone(), cfg));
  });

  it("produces finite, in-range headline numbers", () => {
    const r = simulateResident(clone(), cfg);
    for (const p of [r.pForcedReturn, r.pForcedReturnWhileOwing, r.pDistress, r.pBadOutcome]) {
      assert.ok(p >= 0 && p <= 1, `out of range: ${p}`);
    }
    assert.ok(Number.isFinite(r.finalNetWorth.p50));
  });

  it("gets safer with more savings", () => {
    const thin = simulateResident(clone({ savings: 2_000 }), cfg);
    const fat = simulateResident(clone({ savings: 40_000 }), cfg);
    assert.ok(fat.pBadOutcome < thin.pBadOutcome, `${fat.pBadOutcome} vs ${thin.pBadOutcome}`);
  });

  it("gets riskier as fixed costs rise", () => {
    const cheap = clone();
    cheap.spend.rent = 1_200;
    const dear = clone();
    dear.spend.rent = 3_400;
    assert.ok(simulateResident(dear, cfg).pBadOutcome >= simulateResident(cheap, cfg).pBadOutcome);
  });

  it("cannot be forced out owing when nothing is owed", () => {
    const clear = clone();
    clear.loan.outstanding = 0;
    assert.equal(simulateResident(clear, cfg).pForcedReturnWhileOwing, 0);
  });
});

describe("safe spend solver", () => {
  it("finds a spend that meets the risk target", () => {
    const s = solveSafeDiscretionary(clone({ savings: 30_000 }), cfg, 0.15);
    if (!s.infeasible) {
      assert.ok(s.achievedRisk <= 0.15 + 1e-9, `achieved ${s.achievedRisk}`);
      assert.ok(s.safeDiscretionary >= 0);
    }
  });

  it("reports infeasibility rather than returning a fake allowance", () => {
    // Nothing discretionary can rescue a budget whose fixed costs already
    // guarantee trouble.
    const doomed = clone({ savings: 0, monthlyLayoffHazard: 0.5, monthlyRehireHazard: 0.01 });
    const s = solveSafeDiscretionary(doomed, cfg, 0.02);
    assert.equal(s.infeasible, true);
    assert.equal(s.safeDiscretionary, 0);
  });

  it("allows more spending when the risk target is loosened", () => {
    const input = clone({ savings: 30_000 });
    const strict = solveSafeDiscretionary(input, cfg, 0.1);
    const loose = solveSafeDiscretionary(input, cfg, 0.25);
    assert.ok(
      loose.safeDiscretionary >= strict.safeDiscretionary,
      `loose ${loose.safeDiscretionary} should allow at least strict ${strict.safeDiscretionary}`,
    );
  });
});

describe("prepayment frontier", () => {
  it("covers the whole split and stays finite", () => {
    const f = prepaymentFrontier(clone(), cfg);
    assert.equal(f.length, 5);
    assert.equal(f[0]!.aggressiveness, 0);
    assert.equal(f[4]!.aggressiveness, 1);
    for (const p of f) assert.ok(Number.isFinite(p.pBadOutcome));
  });

  it("clears the loan sooner the more surplus is thrown at it", () => {
    const f = prepaymentFrontier(clone(), cfg);
    for (let i = 1; i < f.length; i++) {
      assert.ok(
        f[i]!.medianMonthsToPayoff <= f[i - 1]!.medianMonthsToPayoff,
        "payoff time must fall monotonically with prepayment",
      );
    }
  });

  it("leaves a thin-savings borrower worse off at full aggression than at 75%", () => {
    // The finding the second stage exists to surface: past a point, prepayment
    // is buying principal with the runway that keeps you in the country. It is
    // conditional, not universal — it shows up when the buffer is thin.
    const f = prepaymentFrontier(clone({ savings: 3_000 }), cfg);
    const at75 = f.find((p) => p.aggressiveness === 0.75)!;
    const at100 = f.find((p) => p.aggressiveness === 1)!;
    assert.ok(
      at100.pBadOutcome > at75.pBadOutcome,
      `expected an interior optimum: 100% risk ${at100.pBadOutcome} vs 75% ${at75.pBadOutcome}`,
    );
  });

  it("does not show that reversal for a comfortable borrower", () => {
    // Stated as a test so the claim stays conditional. If this ever fails, the
    // advice in the CLI and UI has to change with it.
    const f = prepaymentFrontier(clone({ savings: 40_000 }), cfg);
    const at75 = f.find((p) => p.aggressiveness === 0.75)!;
    const at100 = f.find((p) => p.aggressiveness === 1)!;
    assert.ok(
      at100.pBadOutcome <= at75.pBadOutcome + 1e-9,
      `comfortable borrower should not show the reversal: ${at100.pBadOutcome} vs ${at75.pBadOutcome}`,
    );
  });
});

describe("plain-language advice", () => {
  it("adds up the month the way a person would", () => {
    const input = clone();
    const c = monthlySurplusToday(input);
    const fx = input.corridor.macro.fxSpot;
    const s = input.spend;
    assert.ok(
      Math.abs(c.takeHome - (input.salary / 12) * (1 - input.corridor.macro.destEffectiveTaxRate)) < 1e-9,
    );
    assert.ok(
      Math.abs(
        c.spending -
          (s.rent + s.groceries + s.transport + s.health + s.discretionary + s.remittanceHome / fx),
      ) < 1e-9,
    );
    // The instalment is quoted in dollars, not rupees. Same class of bug as the
    // runway regression, and just as invisible if it goes wrong.
    assert.ok(c.instalment > 100 && c.instalment < 5000, `instalment ${c.instalment} should be dollars`);
    assert.ok(Math.abs(c.surplus - (c.takeHome - c.spending - c.instalment)) < 1e-9);
  });

  it("reports less left over when rent rises", () => {
    const cheap = clone();
    cheap.spend.rent = 1_200;
    const dear = clone();
    dear.spend.rent = 2_600;
    assert.ok(monthlySurplusToday(dear).surplus < monthlySurplusToday(cheap).surplus);
  });

  it("only suggests things the borrower can actually do", () => {
    // Nothing to cut when there is nothing there: no advice may propose
    // reducing a line that is already at or near zero.
    const bare = clone();
    bare.spend.discretionary = 0;
    bare.spend.remittanceHome = 0;
    bare.spend.rent = 600;
    const ids = residentAdvice(bare, cfg).map((a) => a.id);
    assert.ok(!ids.includes("discretionary"), "cannot cut discretionary that is already zero");
    assert.ok(!ids.includes("remittance"), "cannot halve remittances that are already zero");
    assert.ok(!ids.includes("rent"), "cannot cut $300 from a $600 rent");
  });

  it("ranks by how much trouble each one removes", () => {
    const a = residentAdvice(clone({ savings: 6_000 }), cfg);
    assert.ok(a.length > 0);
    for (let i = 1; i < a.length; i++) {
      assert.ok(a[i]!.riskAfter >= a[i - 1]!.riskAfter, "advice must be sorted best-first");
    }
  });

  it("states the cash effect with the right sign", () => {
    const a = residentAdvice(clone(), cfg);
    const rent = a.find((x) => x.id === "rent");
    assert.ok(rent, "the rent option should be available at this rent level");
    // Cutting rent by 300 leaves exactly 300 more in your pocket each month.
    assert.ok(Math.abs(rent.monthlyGain - 300) < 1e-6, `rent gain ${rent.monthlyGain}`);
    const rate = a.find((x) => x.id === "rate");
    assert.ok(rate && rate.monthlyGain > 0, "a lower rate must free up cash, not consume it");
  });

  it("measures every option against the same starting point", () => {
    const a = residentAdvice(clone(), cfg);
    const before = a[0]!.riskBefore;
    for (const x of a) assert.equal(x.riskBefore, before, "riskBefore must be the shared baseline");
  });
});
