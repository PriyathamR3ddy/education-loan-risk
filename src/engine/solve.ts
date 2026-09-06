/**
 * Inverting the resident model.
 *
 * Simulating a budget answers "is this safe?". Nobody asks that. They ask "what
 * can I afford?", which is the same model run backwards: find the largest
 * discretionary spend that still holds the probability of a bad outcome under a
 * threshold the person chooses.
 *
 * Every evaluation runs on the same seed. With common random numbers the risk
 * curve is monotone in spending and a bisection converges cleanly; with fresh
 * randomness per evaluation it is a noisy staircase and the search wanders.
 */

import type { ResidentInput, ResidentResult } from "./resident.ts";
import { simulateResident } from "./resident.ts";
import { amortizingPayment } from "./path.ts";

export interface SolveConfig {
  paths: number;
  horizonMonths: number;
  seed: string;
}

export interface SafeSpendResult {
  /** Largest monthly discretionary spend meeting the risk target. */
  safeDiscretionary: number;
  /** Risk actually achieved there. */
  achievedRisk: number;
  /** Risk at the spend the person proposed. */
  riskAtRequested: number;
  requestedDiscretionary: number;
  target: number;
  /** True when even zero discretionary spending misses the target. */
  infeasible: boolean;
  at: ResidentResult;
}

/**
 * Largest discretionary spend whose bad-outcome probability stays at or below
 * `target`. Bisection over a monotone curve; 16 steps resolves a $4000 range to
 * within a few cents, far finer than the model's own precision.
 */
export function solveSafeDiscretionary(
  input: ResidentInput,
  config: SolveConfig,
  target = 0.1,
): SafeSpendResult {
  const evaluate = (discretionary: number): ResidentResult =>
    simulateResident({ ...input, spend: { ...input.spend, discretionary } }, config);

  const requested = input.spend.discretionary;
  const riskAtRequested = evaluate(requested).pBadOutcome;

  const floor = evaluate(0);
  if (floor.pBadOutcome > target) {
    return {
      safeDiscretionary: 0,
      achievedRisk: floor.pBadOutcome,
      riskAtRequested,
      requestedDiscretionary: requested,
      target,
      infeasible: true,
      at: floor,
    };
  }

  // Upper bracket: expand until the target is breached, so the search covers
  // the whole feasible range rather than assuming a ceiling.
  let hi = Math.max(requested, 500);
  for (let i = 0; i < 8 && evaluate(hi).pBadOutcome <= target; i++) hi *= 2;

  let lo = 0;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (evaluate(mid).pBadOutcome <= target) lo = mid;
    else hi = mid;
  }

  const at = evaluate(lo);
  return {
    safeDiscretionary: lo,
    achievedRisk: at.pBadOutcome,
    riskAtRequested,
    requestedDiscretionary: requested,
    target,
    infeasible: false,
    at,
  };
}

export interface PrepaymentPoint {
  aggressiveness: number;
  pBadOutcome: number;
  pForcedReturnWhileOwing: number;
  medianMonthsToPayoff: number;
  finalNetWorthP50: number;
  finalNetWorthP10: number;
}

/**
 * The prepay-versus-runway frontier.
 *
 * Standard advice, and every EMI calculator, pushes the borrower to kill the
 * principal as fast as possible. For someone on a work visa that advice may be
 * actively dangerous: every rupee of prepayment converts liquid runway into
 * reduced principal, and runway is what stands between a layoff and a forced
 * departure that carries the loan onto a home-currency salary.
 *
 * This does not assert an answer. It sweeps the split and reports the curve, so
 * the tradeoff is visible rather than assumed in either direction.
 */
export function prepaymentFrontier(
  input: ResidentInput,
  config: SolveConfig,
  steps: readonly number[] = [0, 0.25, 0.5, 0.75, 1],
): PrepaymentPoint[] {
  return steps.map((aggressiveness) => {
    const r = simulateResident({ ...input, prepaymentAggressiveness: aggressiveness }, config);
    return {
      aggressiveness,
      pBadOutcome: r.pBadOutcome,
      pForcedReturnWhileOwing: r.pForcedReturnWhileOwing,
      medianMonthsToPayoff: r.monthsToPayoff.p50,
      finalNetWorthP50: r.finalNetWorth.p50,
      finalNetWorthP10: r.finalNetWorth.p10,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Plain-language advice.
 *
 * A probability is not advice. Someone carrying this loan wants to know what to
 * give up and what it buys them, in the same units they think in: dollars a
 * month, and months of cushion. Everything below is expressed that way, and
 * every recommendation is measured by re-running the model rather than by rule
 * of thumb.
 * ------------------------------------------------------------------------- */

/** What actually lands in your pocket each month today, destination currency. */
export function monthlySurplusToday(input: ResidentInput): {
  takeHome: number;
  spending: number;
  instalment: number;
  surplus: number;
} {
  const fx = input.corridor.macro.fxSpot;
  const takeHome =
    (input.salary / 12) * (1 - input.corridor.macro.destEffectiveTaxRate);
  const s = input.spend;
  const spending =
    s.rent + s.groceries + s.transport + s.health + s.discretionary + s.remittanceHome / fx;
  const emiOwn = amortizingPayment(
    input.loan.outstanding,
    input.loan.nominalRate / 12,
    input.loan.remainingTenureMonths,
  );
  const instalment =
    input.loan.currency === input.corridor.destCurrency ? emiOwn : emiOwn / fx;
  return { takeHome, spending, instalment, surplus: takeHome - spending - instalment };
}

export interface Advice {
  id: string;
  /** What to do, in the imperative, with no jargon. */
  action: string;
  /** What it costs you. Never hidden. */
  giveUp: string;
  riskBefore: number;
  riskAfter: number;
  /** Extra dollars a month in your pocket. Negative means it costs you cash. */
  monthlyGain: number;
  /** Months of cushion before and after. */
  runwayBefore: number;
  runwayAfter: number;
}

const RENT_CUT = 300;
const REMITTANCE_CUT = 0.5;

/**
 * Concrete compromises, ranked by how much trouble each one removes.
 *
 * These are deliberately things a person can actually do this month, not
 * abstractions. Each is re-simulated on the same seed so the comparison is the
 * change rather than simulation noise.
 */
export function residentAdvice(input: ResidentInput, config: SolveConfig): Advice[] {
  const base = simulateResident(input, config);
  const baseCash = monthlySurplusToday(input);

  const options: Array<{
    id: string;
    action: string;
    giveUp: string;
    next: ResidentInput | null;
  }> = [
    {
      id: "rent",
      action: `Find a place $${RENT_CUT} a month cheaper, or take a housemate`,
      giveUp: "A smaller flat, a longer commute, or less privacy.",
      next:
        input.spend.rent > RENT_CUT + 400
          ? { ...input, spend: { ...input.spend, rent: input.spend.rent - RENT_CUT } }
          : null,
    },
    {
      id: "buffer",
      action: "Send less to the loan and more to the bank until you have a real cushion",
      giveUp: "The loan takes longer to clear and costs more in interest overall.",
      next:
        input.prepaymentAggressiveness > 0.25
          ? { ...input, prepaymentAggressiveness: 0.25 }
          : null,
    },
    {
      id: "remittance",
      action: "Halve what you send home for a year",
      giveUp: "The hardest one on this list, and the one most people refuse. Worth knowing the size of it before deciding.",
      next:
        input.spend.remittanceHome > 5000
          ? {
              ...input,
              spend: {
                ...input.spend,
                remittanceHome: input.spend.remittanceHome * REMITTANCE_CUT,
              },
            }
          : null,
    },
    {
      id: "tenure",
      action: "Ask the lender to stretch the loan over five more years",
      giveUp: "A smaller payment each month, but noticeably more interest in total.",
      next: {
        ...input,
        loan: {
          ...input.loan,
          remainingTenureMonths: input.loan.remainingTenureMonths + 60,
        },
      },
    },
    {
      id: "rate",
      action: "Refinance, or pledge collateral, to cut the rate by two points",
      giveUp: "Family property or deposits on the line. This moves the risk onto whoever signs, it does not delete it.",
      next:
        input.loan.nominalRate > 0.07
          ? { ...input, loan: { ...input.loan, nominalRate: input.loan.nominalRate - 0.02 } }
          : null,
    },
    {
      id: "discretionary",
      action: "Cut $200 a month from everything that is not rent, food or travel",
      giveUp: "Eating out, subscriptions, trips. The smallest lever on this list, and the one people reach for first.",
      next:
        input.spend.discretionary > 200
          ? {
              ...input,
              spend: { ...input.spend, discretionary: input.spend.discretionary - 200 },
            }
          : null,
    },
  ];

  const out: Advice[] = [];
  for (const o of options) {
    if (o.next === null) continue;
    const r = simulateResident(o.next, config);
    const cash = monthlySurplusToday(o.next);
    out.push({
      id: o.id,
      action: o.action,
      giveUp: o.giveUp,
      riskBefore: base.pBadOutcome,
      riskAfter: r.pBadOutcome,
      monthlyGain: cash.surplus - baseCash.surplus,
      runwayBefore: base.runwayMonths,
      runwayAfter: r.runwayMonths,
    });
  }
  return out.sort((a, b) => a.riskAfter - b.riskAfter);
}


