/**
 * One simulated life, month by month.
 *
 * The whole point of the engine lives here: this decision is not an expected
 * value, it is a branch. Either the graduate ends up earning in the destination
 * currency, or they end up earning at home at a fraction of that income while
 * still owing for a degree that was priced in the destination currency.
 * Averaging those two futures produces a number that describes neither. So the
 * engine simulates the branch explicitly and reports the shape.
 *
 * Two conventions, both of which are the usual places this class of model goes
 * quietly wrong:
 *
 *  1. Everything is NOMINAL in units of its own currency, converted at the
 *     path's nominal FX rate, and deflated to real home-currency units of today
 *     only at the moment a figure is recorded.
 *  2. The loan balance is carried in the LOAN's currency, not the home currency.
 *     A USD-denominated loan and an INR-denominated loan of identical size are
 *     different instruments: one hedges the destination-employment branch and
 *     wrecks the return-home branch, the other does the reverse.
 */

import type { Currency, PathOutcome, StudentInput } from "./types.ts";
import type { Rng } from "./rng.ts";
import { sampleCurve } from "./dist.ts";

/**
 * Month offsets, relative to graduation, of each work-visa registration.
 * A program ending in May meets its first registration the following March, so
 * the first realistic attempt is about 10 months out, then annually.
 */
const LOTTERY_MONTHS_AFTER_GRADUATION = [10, 22, 34] as const;

/**
 * Compound-growth factors, precomputed once per run.
 *
 * Every one of these is a function of a month offset alone, not of anything the
 * path draws, so computing them inside the monthly loop meant several million
 * redundant `Math.pow` calls per simulation — enough to block a browser frame
 * for tens of seconds. Hoisting them is exact rather than approximate: the same
 * `Math.pow` inputs produce the same bits, so results are unchanged.
 */
export interface GrowthTables {
  destPrice: Float64Array;
  homePrice: Float64Array;
  escalation: Float64Array;
  destWage: Float64Array;
  homeWage: Float64Array;
  counterfactual: Float64Array;
}

function table(rate: number, months: number): Float64Array {
  const t = new Float64Array(months);
  for (let m = 0; m < months; m++) t[m] = Math.pow(1 + rate, m / 12);
  return t;
}

export function buildGrowthTables(input: StudentInput, horizonMonths: number): GrowthTables {
  const n = horizonMonths + 1;
  return {
    destPrice: table(input.corridor.macro.destInflation, n),
    homePrice: table(input.corridor.macro.homeInflation, n),
    escalation: table(input.cost.realEscalation, n),
    destWage: table(input.program.realWageGrowthDest, n),
    homeWage: table(input.corridor.homeReturn.realGrowth, n),
    counterfactual: table(input.counterfactual.realGrowth, n),
  };
}

export function simulatePath(
  input: StudentInput,
  horizonMonths: number,
  rng: Rng,
  tables: GrowthTables,
): PathOutcome {
  const { corridor, program, cost, loan, assistantship, counterfactual } = input;
  const { macro, immigration, homeReturn } = corridor;

  const gradMonth = input.programMonths;
  const amortStart = gradMonth + loan.moratoriumMonths;
  const workAuthEnd =
    gradMonth +
    immigration.postStudyWorkMonths +
    (immigration.stemEligible ? immigration.stemExtensionMonths : 0);
  const graceMonths = Math.round(immigration.unemploymentGraceDays / 30);
  const loanIsDest = loan.currency === corridor.destCurrency;

  // --- Draws fixed for the whole life --------------------------------------
  const hasAssistantship = rng.bernoulli(assistantship.probability);
  // pDestOffer is defined as P(secures employment inside the authorized search
  // window), so it already prices in the graduates whose status lapses before an
  // offer lands. monthsToOffer is conditional on that and is clamped to the
  // window rather than tested against it, which would penalize the same failure
  // twice and understate employment by roughly half.
  const gotDestOffer = rng.bernoulli(program.pDestOffer);
  const monthsToOffer = Math.min(
    graceMonths,
    Math.max(0, Math.round(sampleCurve(program.monthsToOffer, rng))),
  );
  const employmentStart = gradMonth + monthsToOffer;
  const baseWageDest = sampleCurve(program.firstYearWage, rng);
  const employerSponsors = rng.bernoulli(immigration.employerSponsorshipRate);
  const homeSalaryBase =
    sampleCurve(homeReturn.baseSalary, rng) * homeReturn.foreignDegreePremium;

  // Resolve the visa branch up front. It depends only on fixed draws, and
  // knowing the return month in advance keeps the monthly loop readable.
  let visaSelected = false;
  if (gotDestOffer && employerSponsors) {
    for (const offset of LOTTERY_MONTHS_AFTER_GRADUATION) {
      const m = gradMonth + offset;
      if (m > workAuthEnd) break;
      if (m < employmentStart) continue; // an employer must already hold you
      if (rng.bernoulli(immigration.lotterySelectionProbability)) {
        visaSelected = true;
        break;
      }
    }
  }

  const everWorkedInDest = gotDestOffer;
  let monthToReturnHome: number | null = null;
  if (!everWorkedInDest) {
    monthToReturnHome = gradMonth + graceMonths;
  } else if (!visaSelected) {
    monthToReturnHome = workAuthEnd;
  }

  // --- Mutable state -------------------------------------------------------
  let fx = macro.fxSpot; // home currency per 1 destination unit, nominal
  let familyPool = input.familyContribution; // home currency
  let sanctionedRemaining = loan.sanctioned; // loan currency
  let outstanding = 0; // loan currency, nominal
  let blendedRate = loan.nominalRate / 12;
  let fxShortfall = 0; // home currency, at the rate prevailing when drawn
  let principalDrawn = 0; // home currency, at the rate prevailing when drawn
  let totalInterestAccrued = 0; // home currency
  let emi = 0; // loan currency
  let monthsToPayoff: number | null = null;
  let repaidFromHomeIncome = false;

  // Family capital spent on the degree is real money that stops compounding, so
  // the degree path starts in the hole by exactly that amount and the
  // counterfactual starts at zero. Anything else flatters the degree.
  let savings = -input.familyContribution;
  let cfSavings = 0;

  const netWorthByYear: number[] = [];
  const counterfactualByYear: number[] = [];
  let lastMonthBehind = -1;
  let debtToIncome = 0;

  for (let m = 0; m < horizonMonths; m++) {
    const destPriceIndex = tables.destPrice[m]!;
    const homePriceIndex = tables.homePrice[m]!;

    // FX: geometric Brownian motion on the nominal rate.
    if (m > 0) {
      const drift = (macro.fxDrift - (macro.fxVol * macro.fxVol) / 2) / 12;
      fx *= Math.exp(drift + (macro.fxVol / Math.sqrt(12)) * rng.normal());
    }

    // Home currency per 1 unit of the loan's currency, this month.
    const loanFx = loanIsDest ? fx : 1;
    const returnedHome = monthToReturnHome !== null && m >= monthToReturnHome;

    // --- Funding needs while studying -------------------------------------
    if (m < gradMonth) {
      const escalation = tables.escalation[m]! * destPriceIndex;
      const tuition =
        (cost.tuitionPerYear / 12) *
        escalation *
        (hasAssistantship ? 1 - assistantship.tuitionWaiverFraction : 1);
      const living = cost.livingPerMonthStudy * escalation;
      const stipend = hasAssistantship ? assistantship.annualStipend / 12 : 0;
      const oneTime = m === 0 ? cost.oneTimeCosts : 0;

      const needDest = Math.max(0, tuition + living + oneTime - stipend);
      const needLoanCcy = loanIsDest ? needDest : needDest * fx;

      // Waterfall: family cash first, then the sanctioned facility, then a
      // top-up at a penalty rate. The top-up branch is where a rupee facility
      // sized at signing quietly fails to cover a dollar bill two years later.
      const familyInLoanCcy = Math.max(0, familyPool) / loanFx;
      const fromFamily = Math.min(needLoanCcy, familyInLoanCcy);
      const afterFamily = needLoanCcy - fromFamily;
      const drawn = Math.min(afterFamily, Math.max(0, sanctionedRemaining));
      const topUp = Math.max(0, afterFamily - drawn);

      familyPool -= fromFamily * loanFx;
      sanctionedRemaining -= drawn;
      if (topUp > 0) {
        const topUpRate = (loan.nominalRate + loan.topUpRatePremium) / 12;
        const total = outstanding + drawn + topUp;
        blendedRate =
          total > 0
            ? ((outstanding + drawn) * blendedRate + topUp * topUpRate) / total
            : blendedRate;
        fxShortfall += topUp * loanFx;
      }
      outstanding += drawn + topUp;
      principalDrawn += (drawn + topUp) * loanFx;
    }

    // --- Interest ---------------------------------------------------------
    if (outstanding > 0) {
      const interest = outstanding * blendedRate;
      const serviceable =
        m < amortStart &&
        loan.moratorium === "interest-serviced" &&
        familyPool >= interest * loanFx;
      if (serviceable) {
        familyPool -= interest * loanFx;
        totalInterestAccrued += interest * loanFx;
      } else {
        outstanding += interest; // capitalized
        if (m >= amortStart) totalInterestAccrued += interest * loanFx;
      }
    }

    // --- Income -----------------------------------------------------------
    let grossHome = 0;
    if (returnedHome) {
      const sinceReturn = m - (monthToReturnHome ?? 0);
      if (sinceReturn >= homeReturn.monthsToOffer) {
        const k = sinceReturn - homeReturn.monthsToOffer;
        grossHome = (homeSalaryBase / 12) * tables.homeWage[k]! * homePriceIndex;
      }
    } else if (m >= employmentStart && everWorkedInDest) {
      const wageDest = (baseWageDest / 12) * tables.destWage[m - employmentStart]! * destPriceIndex;
      grossHome = wageDest * fx;
    }

    const taxRate = returnedHome ? macro.homeEffectiveTaxRate : macro.destEffectiveTaxRate;
    const postTax = grossHome * (1 - taxRate); // home currency
    const livingHome = returnedHome
      ? (counterfactual.livingPerYear / 12) * homePriceIndex
      : m >= employmentStart && everWorkedInDest
        ? cost.livingPerMonthWorking * destPriceIndex * fx
        : 0;

    // --- Amortization -----------------------------------------------------
    if (m === amortStart && outstanding > 0) {
      emi = amortizingPayment(outstanding, blendedRate, loan.tenureMonths);
      const annualPostTax = postTax * 12;
      debtToIncome = annualPostTax > 0 ? (outstanding * loanFx) / annualPostTax : 99;
    }

    let surplus = postTax - livingHome; // home currency
    if (m >= amortStart && outstanding > 0) {
      // Still carrying a destination-priced degree on a home-currency income.
      if (returnedHome) repaidFromHomeIncome = true;

      const due = Math.min(emi, outstanding);
      const affordable = Math.max(0, surplus) / loanFx;
      const paid = Math.min(due, affordable);
      outstanding -= paid;
      surplus -= paid * loanFx;
      // Anything unpaid simply stays outstanding and keeps compounding, which is
      // what actually happens to a distressed borrower.

      if (outstanding > 0 && surplus > 0 && input.prepaymentAggressiveness > 0) {
        const prepay = Math.min(
          outstanding,
          (surplus * input.prepaymentAggressiveness) / loanFx,
        );
        outstanding -= prepay;
        surplus -= prepay * loanFx;
      }
      if (outstanding <= 0.01) {
        outstanding = 0;
        if (monthsToPayoff === null) monthsToPayoff = m;
      }
    }
    savings += surplus;

    // --- Counterfactual ---------------------------------------------------
    const cfGross =
      (counterfactual.startingSalary / 12) * tables.counterfactual[m]! * homePriceIndex;
    cfSavings +=
      cfGross * (1 - macro.homeEffectiveTaxRate) -
      (counterfactual.livingPerYear / 12) * homePriceIndex;

    // --- Record -----------------------------------------------------------
    const realNetWorth = (savings - outstanding * loanFx) / homePriceIndex;
    const realCf = cfSavings / homePriceIndex;
    if (realNetWorth < realCf) lastMonthBehind = m;
    if ((m + 1) % 12 === 0) {
      netWorthByYear.push(realNetWorth);
      counterfactualByYear.push(realCf);
    }
  }

  return {
    gotDestJob: everWorkedInDest,
    visaSelected,
    returnedHome: monthToReturnHome !== null,
    monthToReturnHome,
    firstYearWageDest: everWorkedInDest ? baseWageDest : 0,
    principalDrawn,
    fxShortfall,
    totalInterestAccrued,
    monthsToPayoff,
    repaidFromHomeIncome,
    breakEvenMonth: lastMonthBehind + 1 < horizonMonths ? lastMonthBehind + 1 : null,
    netWorthByYear,
    counterfactualByYear,
    debtToIncome,
  };
}

/** Standard amortizing payment. Falls back to straight-line at a zero rate. */
export function amortizingPayment(
  principal: number,
  monthlyRate: number,
  months: number,
): number {
  if (months <= 0) return principal;
  if (monthlyRate <= 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

/** Kept for callers that need the currency helper without the whole path. */
export function isDestCurrency(loan: Currency, dest: Currency): boolean {
  return loan === dest;
}
