/**
 * Core domain types for the Downside outcome engine.
 *
 * Design rule everything else follows: no number enters the model without a
 * SourceRef. A student makes a six-figure decision on this output, so every
 * input has to trace back to a filing, a statistic, or an explicitly flagged
 * assumption. See docs/DATA_SOURCES.md.
 */

export type Currency = "INR" | "USD";

export type SourceKind =
  /** Employer or institution filings with a government body. Highest trust. */
  | "public-filing"
  /** Published government statistic or dataset. */
  | "gov-statistic"
  /** Third-party survey or index. */
  | "survey"
  /** Outcome reported back by a verified alumnus via the close-the-loop flow. */
  | "contributed"
  /** A hand-set prior standing in for data not yet ingested. */
  | "placeholder";

export interface SourceRef {
  id: string;
  label: string;
  kind: SourceKind;
  url?: string;
  /** Vintage of the underlying data, e.g. "2024Q4" or "FY2024". */
  vintage?: string;
  /**
   * True when this is an assumption, not an observation. Placeholder values are
   * rendered with a warning everywhere they surface and must never be shown to a
   * student as a measured statistic.
   */
  placeholder: boolean;
}

/** An empirical distribution expressed as percentile points. */
export interface PercentileCurve {
  /** Ascending by p, each p in (0,1). Values in the curve's stated units. */
  points: ReadonlyArray<{ p: number; v: number }>;
  source: SourceRef;
}

/** Realized labour-market outcomes for one program at one institution. */
export interface ProgramOutcomes {
  id: string;
  label: string;
  /** CIP code, used to join to College Scorecard field-of-study data. */
  cip: string;
  /** SOC codes these graduates file under, used to join to LCA data. */
  soc: readonly string[];
  /** Destination-currency annual first-year total compensation. */
  firstYearWage: PercentileCurve;
  /**
   * P(secures destination-country employment inside the authorized search
   * window). This is a joint probability, not just "gets an offer eventually":
   * it already prices in the graduates whose status lapses first, so the engine
   * must not test monthsToOffer against the window a second time.
   */
  pDestOffer: number;
  /** Months from graduation to first offer, conditional on receiving one. */
  monthsToOffer: PercentileCurve;
  /** Real annual growth in destination compensation, early career. */
  realWageGrowthDest: number;
  sources: readonly SourceRef[];
}

export type MoratoriumTreatment = "capitalized" | "interest-serviced";

export interface LoanTerms {
  /** Amount sanctioned by the lender, in this currency. Fixed at signing. */
  sanctioned: number;
  currency: Currency;
  /** Annual nominal rate, e.g. 0.1125 for 11.25 percent. */
  nominalRate: number;
  /** Months after course end before amortization starts. */
  moratoriumMonths: number;
  /** Amortization tenure in months, starting after the moratorium. */
  tenureMonths: number;
  /**
   * Whether interest accruing during study and moratorium is capitalized into
   * principal, or serviced monthly by the family.
   */
  moratorium: MoratoriumTreatment;
  /** Rate premium on any top-up borrowed above the sanctioned amount. */
  topUpRatePremium: number;
  source: SourceRef;
}

export interface Assistantship {
  /** P(holds a funded assistantship for the bulk of the program). */
  probability: number;
  /** Destination-currency annual stipend when held. */
  annualStipend: number;
  /** Fraction of tuition waived when held, 0 to 1. */
  tuitionWaiverFraction: number;
  source: SourceRef;
}

export interface CostProfile {
  /** Destination-currency tuition per academic year, before any waiver. */
  tuitionPerYear: number;
  /** Destination-currency all-in living cost per month while studying. */
  livingPerMonthStudy: number;
  /** Destination-currency all-in living cost per month once employed there. */
  livingPerMonthWorking: number;
  /** Visa, SEVIS, flights, deposits, initial setup. Destination currency. */
  oneTimeCosts: number;
  /** Real annual escalation applied to tuition and living costs. */
  realEscalation: number;
  source: SourceRef;
}

/** Immigration regime governing the right to stay and work after study. */
export interface ImmigrationRegime {
  id: string;
  label: string;
  /** Months of post-study work authorization before any extension. */
  postStudyWorkMonths: number;
  /** Additional months available to qualifying graduates. */
  stemExtensionMonths: number;
  /** Whether this program qualifies for that extension. */
  stemEligible: boolean;
  /** P(selected) in a single annual work-visa lottery registration. */
  lotterySelectionProbability: number;
  /**
   * P(the employer is willing to sponsor at all), applied before the lottery.
   * Modelled separately because it is a different failure mode: a graduate can
   * hold a good offer and still never reach a lottery registration.
   */
  employerSponsorshipRate: number;
  /** Days of unemployment permitted before status is lost. */
  unemploymentGraceDays: number;
  sources: readonly SourceRef[];
}

/** Macro assumptions shared across all paths in a corridor. */
export interface MacroPriors {
  /** Home units per 1 destination unit at t=0, e.g. INR per USD. */
  fxSpot: number;
  /** Annual drift in the FX rate. Positive means the home currency weakens. */
  fxDrift: number;
  /** Annual volatility of the FX rate. */
  fxVol: number;
  /** Annual home-currency CPI inflation, used to deflate to real terms. */
  homeInflation: number;
  /** Annual destination-currency CPI inflation. */
  destInflation: number;
  /** Effective all-in income tax rate in the destination country. */
  destEffectiveTaxRate: number;
  /** Effective all-in income tax rate at home. */
  homeEffectiveTaxRate: number;
  sources: readonly SourceRef[];
}

/** The life the student would have led without the degree. This sets the bar. */
export interface Counterfactual {
  /** Home-currency annual gross salary starting at t=0 without the degree. */
  startingSalary: number;
  /** Real annual growth of that salary. */
  realGrowth: number;
  /** Home-currency annual living cost while working at home. */
  livingPerYear: number;
  source: SourceRef;
}

/** Home labour market on the branch where the student returns. */
export interface HomeReturnMarket {
  /** Home-currency annual salary on return, before the foreign-degree premium. */
  baseSalary: PercentileCurve;
  /** Multiplier applied for holding the foreign degree. */
  foreignDegreePremium: number;
  /** Months of job search after returning home. */
  monthsToOffer: number;
  realGrowth: number;
  source: SourceRef;
}

export interface Corridor {
  id: string;
  label: string;
  homeCurrency: Currency;
  destCurrency: Currency;
  macro: MacroPriors;
  immigration: ImmigrationRegime;
  homeReturn: HomeReturnMarket;
}

export interface StudentInput {
  corridor: Corridor;
  program: ProgramOutcomes;
  cost: CostProfile;
  loan: LoanTerms;
  assistantship: Assistantship;
  counterfactual: Counterfactual;
  /** Length of the program in months. */
  programMonths: number;
  /** Age when the program starts. Drives the "still repaying at 35" metric. */
  ageAtStart: number;
  /** Home-currency cash the family contributes, reducing what must be borrowed. */
  familyContribution: number;
  /** Fraction of post-tax monthly surplus directed at prepayment, 0 to 1. */
  prepaymentAggressiveness: number;
}

export interface SimulationConfig {
  paths: number;
  horizonMonths: number;
  /** Seed string. Same seed plus same inputs gives identical output, forever. */
  seed: string;
}

/** Outcome of a single simulated life. */
export interface PathOutcome {
  gotDestJob: boolean;
  visaSelected: boolean;
  returnedHome: boolean;
  monthToReturnHome: number | null;
  firstYearWageDest: number;
  /** Home-currency principal actually drawn, including any top-up. */
  principalDrawn: number;
  /** Home-currency borrowing above the sanctioned amount, caused by FX drift. */
  fxShortfall: number;
  totalInterestAccrued: number;
  monthsToPayoff: number | null;
  /**
   * True when the student was still carrying destination-priced debt after
   * returning home to a home-currency income. The nightmare branch.
   */
  repaidFromHomeIncome: boolean;
  /** First month the degree path's real net worth overtakes and stays ahead. */
  breakEvenMonth: number | null;
  /** Real home-currency net worth at each year end, degree path. */
  netWorthByYear: number[];
  /** Real home-currency net worth at each year end, counterfactual path. */
  counterfactualByYear: number[];
  /** Debt at amortization start over first-year post-tax income, both in INR. */
  debtToIncome: number;
}

export interface Summary {
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
}

export interface SimulationResult {
  config: SimulationConfig;
  paths: number;
  /** Fraction of paths where a destination-country offer arrived. */
  pDestJob: number;
  /** Fraction of paths where the work visa lottery came through. */
  pVisaSelected: number;
  /** Fraction of paths ending with a return home. */
  pReturnHome: number;
  /** THE metric: repaying destination-priced debt on a home-currency income. */
  pRepayFromHomeIncome: number;
  /** Fraction of paths still carrying the loan at age 35. */
  pStillRepayingAt35: number;
  /** Fraction of paths that never overtake the counterfactual in the horizon. */
  pNeverBreakEven: number;
  /** Fraction of paths where the sanctioned loan fails to cover costs. */
  pFxShortfall: number;
  breakEvenMonth: Summary;
  netWorthYear7: Summary;
  netWorthYear15: Summary;
  firstYearWageDest: Summary;
  monthsToPayoff: Summary;
  debtToIncome: Summary;
  /** Real home-currency net position at year 7 in the worst decile. */
  tailCostYear7: number;
}

export interface Lever {
  id: string;
  label: string;
  /** Human-readable statement of what changes. */
  change: string;
  /** Change in P(repay from home income). Negative is an improvement. */
  deltaPRepayFromHomeIncome: number;
  /** Change in p10 real net worth at year 7. Positive is an improvement. */
  deltaTailYear7: number;
  /** Change in median break-even month. Negative is an improvement. */
  deltaBreakEvenMedian: number;
  /** Composite rank score. Higher means more tail risk removed. */
  score: number;
  /** What the student has to do, and what it plausibly costs them. */
  cost: string;
}
