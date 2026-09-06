/**
 * The second life stage: already arrived, already employed, already borrowing.
 *
 * The pre-departure model asks whether to take the bet. This one asks how to
 * carry the position, and the binding constraint is different in a way that no
 * budgeting tool models.
 *
 * For a resident on a work visa, the limit on an emergency fund is not money,
 * it is TIME BEFORE STATUS LAPSES. Ordinary advice says hold three to six
 * months of expenses. An H-1B holder who is laid off has sixty days to find a
 * new sponsoring employer or leave the country — and leaving carries the
 * foreign-priced loan onto a home-currency salary, which reopens the exact
 * branch the first model exists to price, years after the borrower believed
 * they had escaped it.
 *
 * So "what can I afford in rent" is not a percentage-of-income question here.
 * It is a question about how many months of runway sit between a layoff and a
 * forced departure, and that is what this simulates.
 */

import type { Corridor, Summary } from "./types.ts";
import type { Rng } from "./rng.ts";
import { createRng } from "./rng.ts";
import { fractionWhere, percentileSorted, sampleCurve, summarize } from "./dist.ts";
import { amortizingPayment } from "./path.ts";

export type VisaStatus = "opt" | "stem-opt" | "h1b";

/**
 * Days of unemployment each status tolerates before it lapses.
 *
 * OPT counts 90 cumulative days; the STEM extension raises the total to 150.
 * H-1B is a discretionary 60-day grace period per cessation of employment, and
 * is the tightest of the three despite feeling like the most secure.
 */
export const UNEMPLOYMENT_GRACE_DAYS: Record<VisaStatus, number> = {
  opt: 90,
  "stem-opt": 150,
  h1b: 60,
};

/** Monthly outgoings, destination currency, before the loan. */
export interface SpendPlan {
  rent: number;
  groceries: number;
  transport: number;
  health: number;
  /** Sent home. Home currency, because that is how the family experiences it. */
  remittanceHome: number;
  discretionary: number;
}

export interface ResidentLoan {
  /** Balance outstanding today, in `currency`. */
  outstanding: number;
  currency: "INR" | "USD";
  nominalRate: number;
  remainingTenureMonths: number;
}

export interface ResidentInput {
  corridor: Corridor;
  loan: ResidentLoan;
  /** Gross annual compensation, destination currency. */
  salary: number;
  realWageGrowth: number;
  /** Liquid savings today, destination currency. This is the runway. */
  savings: number;
  spend: SpendPlan;
  status: VisaStatus;
  /**
   * Cap-lottery registrations still ahead of this person. Zero once on H-1B.
   * Running out while still on OPT means a forced departure regardless of how
   * well the job is going.
   */
  lotteryAttemptsRemaining: number;
  /** P(job ends) in any given month. */
  monthlyLayoffHazard: number;
  /** P(finds a new sponsoring employer) in any month while searching. */
  monthlyRehireHazard: number;
  /** Share of post-EMI surplus thrown at the principal rather than savings. */
  prepaymentAggressiveness: number;
  ageNow: number;
}

export interface ResidentOutcome {
  /** Forced out of the country while still carrying the loan. The nightmare. */
  forcedReturnWhileOwing: boolean;
  forcedReturn: boolean;
  /** Ever failed to meet an instalment in full. */
  distressed: boolean;
  everLaidOff: boolean;
  monthsToPayoff: number | null;
  /** Lowest savings balance reached, destination currency. */
  minSavings: number;
  /** Real home-currency net worth at the end of the horizon. */
  finalNetWorth: number;
  ageAtPayoff: number | null;
}

export interface ResidentResult {
  paths: number;
  /** THE metric for this stage. */
  pForcedReturnWhileOwing: number;
  pForcedReturn: number;
  pDistress: number;
  /** Either failure mode. What the safe-spend solver holds down. */
  pBadOutcome: number;
  pLaidOff: number;
  pClearedBeforePayoffHorizon: number;
  monthsToPayoff: Summary;
  finalNetWorth: Summary;
  /** Deterministic, not simulated: savings divided by fixed monthly outgoings. */
  runwayMonths: number;
  /** Months of unemployment this status tolerates. */
  visaClockMonths: number;
}

export const DEFAULT_RESIDENT_HORIZON = 120;

/** Essential outgoings continue through unemployment; these do not. */
const DISCRETIONARY_RETAINED_WHEN_UNEMPLOYED = 0.3;

/** Monthly cost of living, destination currency, at a given FX rate. */
function monthlySpend(spend: SpendPlan, fx: number, employed: boolean): number {
  const essentials = spend.rent + spend.groceries + spend.transport + spend.health;
  if (employed) {
    return essentials + spend.discretionary + spend.remittanceHome / fx;
  }
  // Remittances stop before an instalment is missed, and discretionary spending
  // collapses but does not vanish.
  return essentials + spend.discretionary * DISCRETIONARY_RETAINED_WHEN_UNEMPLOYED;
}

/**
 * Runway in months: how long savings cover fixed outgoings plus the instalment
 * with no income at all. Deterministic, and the number to compare against the
 * visa clock.
 */
export function runwayMonths(input: ResidentInput): number {
  const fx = input.corridor.macro.fxSpot;
  const emiOwnCurrency = amortizingPayment(
    input.loan.outstanding,
    input.loan.nominalRate / 12,
    input.loan.remainingTenureMonths,
  );
  // Savings and living costs are in the destination currency, so the instalment
  // has to be converted before it can be added to them. A home-currency loan
  // divides by the spot rate; adding the two directly understates runway by
  // roughly the size of the exchange rate.
  const emiDest =
    input.loan.currency === input.corridor.destCurrency ? emiOwnCurrency : emiOwnCurrency / fx;
  const burn = monthlySpend(input.spend, fx, false) + emiDest;
  if (burn <= 0) return Infinity;
  return input.savings / burn;
}

export function simulateResidentPath(
  input: ResidentInput,
  horizonMonths: number,
  rng: Rng,
): ResidentOutcome {
  const { corridor, loan } = input;
  const { macro, homeReturn } = corridor;
  const loanIsDest = loan.currency === corridor.destCurrency;
  const graceMonths = Math.round(UNEMPLOYMENT_GRACE_DAYS[input.status] / 30);

  const monthlyRate = loan.nominalRate / 12;
  const emi = amortizingPayment(loan.outstanding, monthlyRate, loan.remainingTenureMonths);

  let fx = macro.fxSpot;
  let outstanding = loan.outstanding;
  let savings = input.savings; // destination currency
  let employed = true;
  let monthsUnemployed = 0;
  let returnedHomeAt: number | null = null;
  let homeSalary = 0;

  let distressed = false;
  let everLaidOff = false;
  let monthsToPayoff: number | null = null;
  let minSavings = savings;
  let lotteryLeft = input.lotteryAttemptsRemaining;
  let monthsElapsed = 0;

  for (let m = 0; m < horizonMonths; m++) {
    monthsElapsed = m;
    const years = m / 12;
    if (m > 0) {
      const drift = (macro.fxDrift - (macro.fxVol * macro.fxVol) / 2) / 12;
      fx *= Math.exp(drift + (macro.fxVol / Math.sqrt(12)) * rng.normal());
    }
    const loanFx = loanIsDest ? fx : 1; // home currency per loan unit
    const homeIdx = Math.pow(1 + macro.homeInflation, years);
    const returnedHome = returnedHomeAt !== null;

    // --- Status transitions --------------------------------------------
    if (!returnedHome) {
      if (employed) {
        if (rng.bernoulli(input.monthlyLayoffHazard)) {
          employed = false;
          everLaidOff = true;
          monthsUnemployed = 0;
        }
      } else {
        monthsUnemployed++;
        if (rng.bernoulli(input.monthlyRehireHazard)) {
          employed = true;
          monthsUnemployed = 0;
        } else if (monthsUnemployed > graceMonths) {
          // Status lapsed. This is the departure the borrower never priced.
          returnedHomeAt = m;
        }
      }

      // Cap lottery, once a year, only while employed and still needing one.
      if (returnedHomeAt === null && input.status !== "h1b" && m > 0 && m % 12 === 0) {
        if (lotteryLeft > 0) {
          if (employed && rng.bernoulli(corridor.immigration.lotterySelectionProbability)) {
            lotteryLeft = 0; // selected; treat as settled
          } else {
            lotteryLeft--;
            if (lotteryLeft <= 0) returnedHomeAt = m;
          }
        }
      }
    }

    if (returnedHomeAt === m) {
      homeSalary =
        sampleCurve(homeReturn.baseSalary, rng) * homeReturn.foreignDegreePremium;
    }

    // --- Income ---------------------------------------------------------
    let postTaxDest = 0; // destination currency
    let postTaxHome = 0; // home currency
    if (returnedHomeAt !== null) {
      const sinceReturn = m - returnedHomeAt;
      if (sinceReturn >= homeReturn.monthsToOffer) {
        const y = (sinceReturn - homeReturn.monthsToOffer) / 12;
        postTaxHome =
          (homeSalary / 12) *
          Math.pow(1 + homeReturn.realGrowth, y) *
          homeIdx *
          (1 - macro.homeEffectiveTaxRate);
      }
    } else if (employed) {
      postTaxDest =
        (input.salary / 12) *
        Math.pow(1 + input.realWageGrowth, years) *
        Math.pow(1 + macro.destInflation, years) *
        (1 - macro.destEffectiveTaxRate);
    }

    // --- Outgoings ------------------------------------------------------
    const costDest = returnedHomeAt !== null ? 0 : monthlySpend(input.spend, fx, employed);
    const costHome =
      returnedHomeAt !== null
        ? // Living at home, on home prices. Approximated by the remittance-scale
          // household cost rather than destination rent.
          (input.spend.remittanceHome + input.spend.groceries * fx) * homeIdx
        : 0;

    // --- Instalment -----------------------------------------------------
    if (outstanding > 0) {
      outstanding += outstanding * monthlyRate;
      const due = Math.min(emi, outstanding);

      // Everything is settled in the loan's own currency.
      const availableLoanCcy =
        returnedHomeAt !== null
          ? Math.max(0, postTaxHome - costHome) / loanFx
          : (Math.max(0, postTaxDest - costDest) + Math.max(0, savings)) *
            (loanIsDest ? 1 : fx) /
            loanFx;

      const paid = Math.min(due, Math.max(0, availableLoanCcy));
      outstanding -= paid;
      if (paid < due - 1e-6) distressed = true;

      // Draw the shortfall from savings while abroad.
      if (returnedHomeAt === null) {
        const paidDest = paid * (loanIsDest ? 1 : loanFx / fx);
        const net = postTaxDest - costDest - paidDest;
        savings += net;
        if (savings < 0) {
          distressed = true;
          savings = 0;
        }
        if (outstanding > 0 && net > 0 && input.prepaymentAggressiveness > 0) {
          const prepayDest = net * input.prepaymentAggressiveness;
          const prepayLoan = Math.min(outstanding, prepayDest * (loanIsDest ? 1 : fx) / loanFx);
          outstanding -= prepayLoan;
          savings -= prepayLoan * (loanIsDest ? 1 : loanFx / fx);
        }
      }
      if (outstanding <= 0.01) {
        outstanding = 0;
        if (monthsToPayoff === null) monthsToPayoff = m;
      }
    } else if (returnedHomeAt === null) {
      savings += postTaxDest - costDest;
      if (savings < 0) savings = 0;
    }

    if (returnedHomeAt === null) minSavings = Math.min(minSavings, savings);
  }

  const finalFx = fx;
  const finalHomeIdx = Math.pow(1 + macro.homeInflation, monthsElapsed / 12);
  const netWorthHome =
    (savings * finalFx - outstanding * (loanIsDest ? finalFx : 1)) / finalHomeIdx;

  return {
    forcedReturn: returnedHomeAt !== null,
    forcedReturnWhileOwing: returnedHomeAt !== null && outstanding > 0,
    distressed,
    everLaidOff,
    monthsToPayoff,
    minSavings,
    finalNetWorth: netWorthHome,
    ageAtPayoff: monthsToPayoff === null ? null : input.ageNow + monthsToPayoff / 12,
  };
}

export function simulateResident(
  input: ResidentInput,
  config: { paths: number; horizonMonths: number; seed: string },
): ResidentResult {
  const rng = createRng(config.seed);
  const outcomes: ResidentOutcome[] = new Array(config.paths);
  for (let i = 0; i < config.paths; i++) {
    outcomes[i] = simulateResidentPath(input, config.horizonMonths, rng);
  }

  const payoff = outcomes
    .map((o) => o.monthsToPayoff)
    .filter((m): m is number => m !== null);

  return {
    paths: outcomes.length,
    pForcedReturnWhileOwing: fractionWhere(outcomes, (o) => o.forcedReturnWhileOwing),
    pForcedReturn: fractionWhere(outcomes, (o) => o.forcedReturn),
    pDistress: fractionWhere(outcomes, (o) => o.distressed),
    pBadOutcome: fractionWhere(outcomes, (o) => o.distressed || o.forcedReturnWhileOwing),
    pLaidOff: fractionWhere(outcomes, (o) => o.everLaidOff),
    pClearedBeforePayoffHorizon: payoff.length / outcomes.length,
    monthsToPayoff: summarize(payoff),
    finalNetWorth: summarize(outcomes.map((o) => o.finalNetWorth)),
    runwayMonths: runwayMonths(input),
    visaClockMonths: UNEMPLOYMENT_GRACE_DAYS[input.status] / 30,
  };
}

export { percentileSorted };
