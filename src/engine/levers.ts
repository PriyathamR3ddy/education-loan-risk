/**
 * Counterfactual levers.
 *
 * This is the part students actually act on. The engine is not in the business
 * of telling anyone whether to go: it re-runs the same life with one structural
 * change and reports how much of the left tail that change removes.
 *
 * Every lever is evaluated against the SAME seed as the baseline. Common random
 * numbers means the two runs share their FX paths, wage draws and lottery
 * outcomes, so the difference between them is the lever rather than Monte Carlo
 * noise. Without this, a 20k-path run cannot resolve a 2-point change in tail
 * probability and the ranking is meaningless.
 */

import type { Lever, SimulationConfig, SimulationResult, StudentInput } from "./types.ts";
import { simulate } from "./simulate.ts";

interface LeverDef {
  id: string;
  label: string;
  change: string;
  cost: string;
  /** Returns null when the lever does not apply to this scenario. */
  apply: (input: StudentInput) => StudentInput | null;
}

const clone = (input: StudentInput): StudentInput => structuredClone(input);

export const LEVERS: readonly LeverDef[] = [
  {
    id: "assistantship",
    label: "Chase funding harder than ranking",
    change: "Assistantship odds raised from 1-in-4 to 3-in-4",
    cost: "Target programs by funding density, contact labs before applying, and accept a lower-ranked school that will actually fund you. Note that no student can move this to certainty, which is why the lever stops at 0.75.",
    apply: (i) => {
      if (i.assistantship.probability >= 0.75) return null;
      const n = clone(i);
      n.assistantship.probability = 0.75;
      return n;
    },
  },
  {
    id: "cheaper-metro",
    label: "Study in a lower-cost metro",
    change: "Living costs cut by a quarter, in study and in work",
    cost: "A smaller city, a thinner local employer network, and more relocation risk after graduation.",
    apply: (i) => {
      const n = clone(i);
      n.cost.livingPerMonthStudy *= 0.75;
      n.cost.livingPerMonthWorking *= 0.8;
      return n;
    },
  },
  {
    id: "collateralized",
    label: "Pledge collateral on the loan",
    change: "Interest rate down by 250 basis points",
    cost: "Family property or deposits at risk if the loan is not serviced. This moves risk onto the co-signer, it does not delete it.",
    apply: (i) => {
      const n = clone(i);
      n.loan.nominalRate = Math.max(0.05, n.loan.nominalRate - 0.025);
      return n;
    },
  },
  {
    id: "currency-match",
    label: "Borrow in the destination currency",
    change: "Loan redenominated to the destination currency at a higher headline rate",
    cost: "Rate is typically higher, and the currency exposure inverts: cheaper if you stay, more expensive if you go home.",
    apply: (i) => {
      if (i.loan.currency === i.corridor.destCurrency) return null;
      const n = clone(i);
      n.loan.sanctioned = i.loan.sanctioned / i.corridor.macro.fxSpot;
      n.loan.currency = i.corridor.destCurrency;
      n.loan.nominalRate = i.loan.nominalRate + 0.015;
      return n;
    },
  },
  {
    id: "longer-tenure",
    label: "Stretch the repayment tenure",
    change: "Tenure extended from 10 to 15 years",
    cost: "Materially more total interest. This buys survivability in the bad branch, not a better outcome in the good one.",
    apply: (i) => {
      if (i.loan.tenureMonths >= 180) return null;
      const n = clone(i);
      n.loan.tenureMonths = 180;
      return n;
    },
  },
  {
    id: "service-interest",
    label: "Service interest during study",
    change: "Family pays interest monthly instead of letting it capitalize",
    cost: "Real cash out of the household budget for three years, at a point when there is no income to pay it from.",
    apply: (i) => {
      if (i.loan.moratorium === "interest-serviced") return null;
      const n = clone(i);
      n.loan.moratorium = "interest-serviced";
      return n;
    },
  },
  {
    id: "defer-one-year",
    label: "Work one more year, then go",
    change: "One extra year of home earnings added to the family contribution",
    cost: "A year of foregone destination earnings, and a year older into the visa timeline.",
    apply: (i) => {
      const n = clone(i);
      const saved =
        i.counterfactual.startingSalary * (1 - i.corridor.macro.homeEffectiveTaxRate) -
        i.counterfactual.livingPerYear;
      n.familyContribution += Math.max(0, saved);
      n.ageAtStart += 1;
      return n;
    },
  },
  {
    id: "employability",
    label: "Choose a program with a denser employer graph",
    change: "Probability of any destination offer up by 8 points",
    cost: "Usually a higher sticker price or a harder admit. Verify the claim against filings, not the placement brochure.",
    apply: (i) => {
      if (i.program.pDestOffer >= 0.95) return null;
      const n = clone(i);
      n.program.pDestOffer = Math.min(0.95, n.program.pDestOffer + 0.08);
      return n;
    },
  },
];

export function evaluateLevers(
  input: StudentInput,
  baseline: SimulationResult,
  config: SimulationConfig,
): Lever[] {
  // Reference scale for expressing a tail improvement as a percentage: the size
  // of the borrowing decision itself, in home currency.
  const principalRef =
    input.loan.currency === input.corridor.homeCurrency
      ? input.loan.sanctioned
      : input.loan.sanctioned * input.corridor.macro.fxSpot;

  const levers: Lever[] = [];
  for (const def of LEVERS) {
    const modified = def.apply(input);
    if (modified === null) continue;
    const result = simulate(modified, config);

    const deltaP = result.pRepayFromHomeIncome - baseline.pRepayFromHomeIncome;
    const deltaTail = result.tailCostYear7 - baseline.tailCostYear7;
    const deltaBreakEven = result.breakEvenMonth.p50 - baseline.breakEvenMonth.p50;

    const score =
      -deltaP * 100 + (deltaTail / Math.max(1, principalRef)) * 50;

    levers.push({
      id: def.id,
      label: def.label,
      change: def.change,
      cost: def.cost,
      deltaPRepayFromHomeIncome: deltaP,
      deltaTailYear7: deltaTail,
      deltaBreakEvenMedian: Number.isFinite(deltaBreakEven) ? deltaBreakEven : 0,
      score,
    });
  }
  return levers.sort((a, b) => b.score - a.score);
}
