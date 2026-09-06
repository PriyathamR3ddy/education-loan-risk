/**
 * Fields of study.
 *
 * PLACEHOLDER PRIORS, like everything else in src/data. Each field is waiting on
 * the same two sources: DOL LCA filings for the wage curve, joined by SOC, and
 * College Scorecard field-of-study earnings, joined by CIP. Both codes are
 * recorded here so that ingestion is a lookup rather than a judgement call.
 *
 * Field of study is not decoration on this model. It moves three things that
 * matter, and the third is the one applicants routinely discover too late:
 *
 *  1. the wage curve, which sets what the good branch is worth;
 *  2. the probability of an offer at all, which sets how often you reach it;
 *  3. STEM eligibility, which decides whether post-study work authorisation runs
 *     for 12 months or 36 — and therefore whether you get one shot at the visa
 *     lottery or three.
 *
 * That third one is close to binary. A non-STEM graduate gets a single
 * registration; a STEM graduate gets three. Same person, same salary, wildly
 * different odds of still being in the country five years later.
 */

import type { ProgramOutcomes, SourceRef } from "../engine/types.ts";

const pending = (id: string, label: string, kind: SourceRef["kind"], url?: string): SourceRef => ({
  id,
  label: `PRIOR pending ingestion from: ${label}`,
  kind,
  ...(url === undefined ? {} : { url }),
  placeholder: true,
});

const LCA = pending(
  "dol-oflc-lca",
  "DOL OFLC H-1B LCA disclosure files, by SOC and worksite",
  "public-filing",
  "https://www.dol.gov/agencies/eta/foreign-labor/performance",
);

const SCORECARD = pending(
  "ed-college-scorecard",
  "US Dept of Education College Scorecard, field-of-study earnings by CIP",
  "gov-statistic",
  "https://collegescorecard.ed.gov/data/",
);

export interface FieldOfStudy {
  program: ProgramOutcomes;
  /**
   * Whether this field qualifies for the 24-month STEM extension. Decides
   * whether the graduate gets one lottery registration or three.
   */
  stemEligible: boolean;
}

const wage = (p10: number, p25: number, p50: number, p75: number, p90: number) => ({
  points: [
    { p: 0.1, v: p10 },
    { p: 0.25, v: p25 },
    { p: 0.5, v: p50 },
    { p: 0.75, v: p75 },
    { p: 0.9, v: p90 },
  ],
  source: LCA,
});

const searchMonths = {
  points: [
    { p: 0.1, v: 0 },
    { p: 0.25, v: 1 },
    { p: 0.5, v: 3 },
    { p: 0.75, v: 6 },
    { p: 0.9, v: 10 },
  ],
  source: LCA,
};

const slowerSearch = {
  points: [
    { p: 0.1, v: 1 },
    { p: 0.25, v: 2 },
    { p: 0.5, v: 4 },
    { p: 0.75, v: 8 },
    { p: 0.9, v: 12 },
  ],
  source: LCA,
};

export const FIELDS: Record<string, FieldOfStudy> = {
  cs: {
    stemEligible: true,
    program: {
      id: "ms-cs",
      label: "Computer Science / Software",
      cip: "11.0701",
      soc: ["15-1252", "15-1211"],
      firstYearWage: wage(78_000, 95_000, 115_000, 140_000, 175_000),
      pDestOffer: 0.72,
      monthsToOffer: searchMonths,
      realWageGrowthDest: 0.04,
      sources: [LCA, SCORECARD],
    },
  },
  data: {
    stemEligible: true,
    program: {
      id: "ms-data",
      label: "Data Science / Analytics",
      cip: "30.7001",
      soc: ["15-2051", "15-1221"],
      firstYearWage: wage(72_000, 88_000, 108_000, 132_000, 165_000),
      pDestOffer: 0.68,
      monthsToOffer: searchMonths,
      realWageGrowthDest: 0.04,
      sources: [LCA, SCORECARD],
    },
  },
  ece: {
    stemEligible: true,
    program: {
      id: "ms-ece",
      label: "Electrical / Computer Engineering",
      cip: "14.1001",
      soc: ["17-2071", "17-2061"],
      firstYearWage: wage(72_000, 86_000, 104_000, 126_000, 158_000),
      pDestOffer: 0.62,
      monthsToOffer: slowerSearch,
      realWageGrowthDest: 0.035,
      sources: [LCA, SCORECARD],
    },
  },
  mech: {
    stemEligible: true,
    program: {
      id: "ms-mech",
      label: "Mechanical / Industrial Engineering",
      cip: "14.1901",
      soc: ["17-2141", "17-2112"],
      firstYearWage: wage(62_000, 72_000, 86_000, 102_000, 125_000),
      pDestOffer: 0.5,
      monthsToOffer: slowerSearch,
      realWageGrowthDest: 0.03,
      sources: [LCA, SCORECARD],
    },
  },
  is: {
    stemEligible: true,
    program: {
      id: "ms-is",
      label: "Information Systems / IT Management",
      cip: "11.0401",
      soc: ["15-1211", "11-3021"],
      firstYearWage: wage(66_000, 80_000, 96_000, 118_000, 145_000),
      pDestOffer: 0.6,
      monthsToOffer: slowerSearch,
      realWageGrowthDest: 0.035,
      sources: [LCA, SCORECARD],
    },
  },
  business: {
    // The consequential one. Most general management programmes are not
    // STEM-designated, which cuts post-study work authorisation from 36 months
    // to 12 and leaves a single lottery registration instead of three.
    stemEligible: false,
    program: {
      id: "ms-business",
      label: "Business / Management (non-STEM)",
      cip: "52.0201",
      soc: ["11-3021", "13-1111"],
      firstYearWage: wage(60_000, 74_000, 92_000, 118_000, 155_000),
      pDestOffer: 0.52,
      monthsToOffer: slowerSearch,
      realWageGrowthDest: 0.045,
      sources: [LCA, SCORECARD],
    },
  },
};

export const FIELD_KEYS = Object.keys(FIELDS);
