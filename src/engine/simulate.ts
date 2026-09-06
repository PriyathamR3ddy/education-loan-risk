/**
 * Monte Carlo runner and aggregation.
 *
 * The output deliberately leads with probabilities of specific bad futures
 * rather than an expected return. Students do not experience an expectation;
 * they experience one draw, and the thing keeping them awake is the left tail.
 */

import type {
  Lever,
  PathOutcome,
  SimulationConfig,
  SimulationResult,
  StudentInput,
} from "./types.ts";
import { createRng } from "./rng.ts";
import { fractionWhere, percentileSorted, summarize } from "./dist.ts";
import { buildGrowthTables, simulatePath } from "./path.ts";

export const DEFAULT_CONFIG: SimulationConfig = {
  paths: 20000,
  horizonMonths: 180,
  seed: "downside-v1",
};

export function simulate(
  input: StudentInput,
  config: SimulationConfig = DEFAULT_CONFIG,
): SimulationResult {
  return simulateDetailed(input, config).result;
}

/** Same run, but keeps every path so callers can chart the actual shape. */
export function simulateDetailed(
  input: StudentInput,
  config: SimulationConfig = DEFAULT_CONFIG,
): { result: SimulationResult; outcomes: PathOutcome[] } {
  const rng = createRng(config.seed);
  const tables = buildGrowthTables(input, config.horizonMonths);
  const outcomes: PathOutcome[] = new Array(config.paths);
  for (let i = 0; i < config.paths; i++) {
    outcomes[i] = simulatePath(input, config.horizonMonths, rng, tables);
  }
  return { result: aggregate(outcomes, input, config), outcomes };
}

function aggregate(
  outcomes: readonly PathOutcome[],
  input: StudentInput,
  config: SimulationConfig,
): SimulationResult {
  const horizonYears = Math.floor(config.horizonMonths / 12);
  const yearIndex = (y: number) => Math.min(y, horizonYears) - 1;

  const netWorth7 = outcomes.map((o) => o.netWorthByYear[yearIndex(7)] ?? NaN);
  const netWorth15 = outcomes.map(
    (o) => o.netWorthByYear[yearIndex(Math.min(15, horizonYears))] ?? NaN,
  );

  // Break-even is only summarized over paths that actually break even; the ones
  // that never do are reported separately rather than folded in as a large
  // number, which would make the median meaningless.
  const breakEven = outcomes
    .map((o) => o.breakEvenMonth)
    .filter((m): m is number => m !== null);

  const payoff = outcomes
    .map((o) => o.monthsToPayoff)
    .filter((m): m is number => m !== null);

  const wages = outcomes.filter((o) => o.gotDestJob).map((o) => o.firstYearWageDest);

  const stillRepayingAt35 = fractionWhere(outcomes, (o) => {
    if (o.principalDrawn <= 0) return false;
    if (o.monthsToPayoff === null) return true;
    return input.ageAtStart + o.monthsToPayoff / 12 > 35;
  });

  return {
    config,
    paths: outcomes.length,
    pDestJob: fractionWhere(outcomes, (o) => o.gotDestJob),
    pVisaSelected: fractionWhere(outcomes, (o) => o.visaSelected),
    pReturnHome: fractionWhere(outcomes, (o) => o.returnedHome),
    pRepayFromHomeIncome: fractionWhere(outcomes, (o) => o.repaidFromHomeIncome),
    pStillRepayingAt35: stillRepayingAt35,
    pNeverBreakEven: fractionWhere(outcomes, (o) => o.breakEvenMonth === null),
    pFxShortfall: fractionWhere(outcomes, (o) => o.fxShortfall > 0),
    breakEvenMonth: summarize(breakEven),
    netWorthYear7: summarize(netWorth7),
    netWorthYear15: summarize(netWorth15),
    firstYearWageDest: summarize(wages),
    monthsToPayoff: summarize(payoff),
    debtToIncome: summarize(outcomes.map((o) => o.debtToIncome)),
    tailCostYear7: percentileSorted(
      [...netWorth7].sort((a, b) => a - b),
      0.1,
    ),
  };
}

export type { Lever };
