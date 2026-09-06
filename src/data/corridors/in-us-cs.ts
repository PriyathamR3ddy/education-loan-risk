/**
 * Corridor: India -> United States, MS in Computer Science.
 *
 * READ THIS BEFORE TRUSTING ANY NUMBER IN THIS FILE.
 *
 * Every value below is a PLACEHOLDER PRIOR. They are order-of-magnitude
 * plausible and they exercise the model correctly, but not one of them has been
 * ingested from a source yet. They exist so the engine can be run, tested and
 * demonstrated before the data pipeline lands.
 *
 * Each one carries the source it is *waiting on*, so replacing priors with real
 * data is a mechanical job: run the ingesters in ingest/, and swap the curve
 * while flipping `placeholder` to false. Nothing may be shown to a real student
 * while `placeholder` is true. See docs/DATA_SOURCES.md.
 */

import type {
  Assistantship,
  Corridor,
  CostProfile,
  Counterfactual,
  LoanTerms,
  ProgramOutcomes,
  SourceRef,
  StudentInput,
} from "../../engine/types.ts";

const pending = (
  id: string,
  label: string,
  kind: SourceRef["kind"],
  url?: string,
): SourceRef => ({
  id,
  label: `PRIOR pending ingestion from: ${label}`,
  kind,
  ...(url === undefined ? {} : { url }),
  placeholder: true,
});

export const LCA_SOURCE = pending(
  "dol-oflc-lca",
  "DOL OFLC H-1B LCA disclosure files (employer, job title, certified wage, worksite)",
  "public-filing",
  "https://www.dol.gov/agencies/eta/foreign-labor/performance",
);

export const SCORECARD_SOURCE = pending(
  "ed-college-scorecard",
  "US Dept of Education College Scorecard, field-of-study earnings and debt by CIP",
  "gov-statistic",
  "https://collegescorecard.ed.gov/data/",
);

export const USCIS_SOURCE = pending(
  "uscis-h1b-registration",
  "USCIS H-1B cap registration selection statistics",
  "gov-statistic",
  "https://www.uscis.gov/working-in-the-united-states/h-1b-specialty-occupations",
);

export const FX_SOURCE = pending(
  "rbi-fx-reference",
  "RBI USD/INR reference rate and implied forward curve",
  "gov-statistic",
  "https://www.rbi.org.in/",
);

export const COA_SOURCE = pending(
  "institution-coa",
  "Institution-published cost of attendance and I-20 financial documentation",
  "public-filing",
);

export const NBFC_SOURCE = pending(
  "in-education-lender-terms",
  "Published Indian education-lender schedules of charges",
  "survey",
);

export const HOME_MARKET_SOURCE = pending(
  "in-return-salary",
  "Contributed alumni outcomes plus Indian salary survey data",
  "contributed",
);

export const corridorIndiaUsa: Corridor = {
  id: "in-us",
  label: "India to United States",
  homeCurrency: "INR",
  destCurrency: "USD",
  macro: {
    fxSpot: 88,
    fxDrift: 0.03,
    fxVol: 0.06,
    homeInflation: 0.05,
    destInflation: 0.025,
    destEffectiveTaxRate: 0.28,
    homeEffectiveTaxRate: 0.2,
    sources: [FX_SOURCE],
  },
  immigration: {
    id: "us-f1-opt-h1b",
    label: "F-1 with OPT, STEM extension, and the H-1B cap lottery",
    postStudyWorkMonths: 12,
    stemExtensionMonths: 24,
    stemEligible: true,
    lotterySelectionProbability: 0.28,
    employerSponsorshipRate: 0.55,
    unemploymentGraceDays: 150,
    sources: [USCIS_SOURCE],
  },
  homeReturn: {
    baseSalary: {
      points: [
        { p: 0.1, v: 900_000 },
        { p: 0.25, v: 1_300_000 },
        { p: 0.5, v: 1_800_000 },
        { p: 0.75, v: 2_600_000 },
        { p: 0.9, v: 3_800_000 },
      ],
      source: HOME_MARKET_SOURCE,
    },
    foreignDegreePremium: 1.15,
    monthsToOffer: 3,
    realGrowth: 0.06,
    source: HOME_MARKET_SOURCE,
  },
};

export const programMsCs: ProgramOutcomes = {
  id: "ms-cs-generic-r1",
  label: "MS Computer Science, generic US R1 public",
  cip: "11.0701",
  soc: ["15-1252", "15-1211"],
  firstYearWage: {
    points: [
      { p: 0.1, v: 78_000 },
      { p: 0.25, v: 95_000 },
      { p: 0.5, v: 115_000 },
      { p: 0.75, v: 140_000 },
      { p: 0.9, v: 175_000 },
    ],
    source: LCA_SOURCE,
  },
  pDestOffer: 0.72,
  monthsToOffer: {
    points: [
      { p: 0.1, v: 0 },
      { p: 0.25, v: 1 },
      { p: 0.5, v: 3 },
      { p: 0.75, v: 6 },
      { p: 0.9, v: 10 },
    ],
    source: LCA_SOURCE,
  },
  realWageGrowthDest: 0.04,
  sources: [LCA_SOURCE, SCORECARD_SOURCE],
};

export const costTypicalPublic: CostProfile = {
  tuitionPerYear: 30_000,
  livingPerMonthStudy: 1_400,
  livingPerMonthWorking: 2_600,
  oneTimeCosts: 4_500,
  realEscalation: 0.02,
  source: COA_SOURCE,
};

export const loanTypicalInrUnsecured: LoanTerms = {
  sanctioned: 6_200_000,
  currency: "INR",
  nominalRate: 0.1125,
  moratoriumMonths: 12,
  tenureMonths: 120,
  moratorium: "capitalized",
  topUpRatePremium: 0.03,
  source: NBFC_SOURCE,
};

export const assistantshipTypical: Assistantship = {
  probability: 0.25,
  annualStipend: 22_000,
  tuitionWaiverFraction: 0.9,
  source: COA_SOURCE,
};

export const counterfactualIndiaCs: Counterfactual = {
  startingSalary: 1_200_000,
  realGrowth: 0.07,
  livingPerYear: 480_000,
  source: HOME_MARKET_SOURCE,
};

/** A complete, runnable reference scenario. */
export const referenceStudent: StudentInput = {
  corridor: corridorIndiaUsa,
  program: programMsCs,
  cost: costTypicalPublic,
  loan: loanTypicalInrUnsecured,
  assistantship: assistantshipTypical,
  counterfactual: counterfactualIndiaCs,
  programMonths: 21,
  ageAtStart: 23,
  familyContribution: 1_500_000,
  prepaymentAggressiveness: 0.5,
};

/** Every source touched by the reference scenario, for receipt provenance. */
export function collectSources(input: StudentInput): SourceRef[] {
  const refs: SourceRef[] = [
    ...input.corridor.macro.sources,
    ...input.corridor.immigration.sources,
    input.corridor.homeReturn.source,
    input.corridor.homeReturn.baseSalary.source,
    ...input.program.sources,
    input.program.firstYearWage.source,
    input.program.monthsToOffer.source,
    input.cost.source,
    input.loan.source,
    input.assistantship.source,
    input.counterfactual.source,
  ];
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
