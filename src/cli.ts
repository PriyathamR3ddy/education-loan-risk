/**
 * Downside CLI.
 *
 *   node src/cli.ts                       run the reference scenario
 *   node src/cli.ts --paths 50000         more paths, tighter tails
 *   node src/cli.ts --loan 6000000        override the sanctioned amount
 *   node src/cli.ts --no-levers           skip the counterfactual sweep
 *   node src/cli.ts --json                machine-readable output
 */

import { referenceStudent, collectSources } from "./data/corridors/in-us-cs.ts";
import { DEFAULT_CONFIG, simulateDetailed } from "./engine/simulate.ts";
import { evaluateLevers } from "./engine/levers.ts";
import type { SimulationConfig, StudentInput } from "./engine/types.ts";
import { buildReceipt, renderReceipt } from "./receipt/receipt.ts";
import { histogram, inr, months, pct, rule, usd } from "./format.ts";

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "true");
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const num = (k: string, d: number) => {
  const v = flags.get(k);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const config: SimulationConfig = {
  paths: num("paths", DEFAULT_CONFIG.paths),
  horizonMonths: num("horizon", DEFAULT_CONFIG.horizonMonths),
  seed: flags.get("seed") ?? DEFAULT_CONFIG.seed,
};

const input: StudentInput = structuredClone(referenceStudent);
if (flags.has("loan")) input.loan.sanctioned = num("loan", input.loan.sanctioned);
if (flags.has("rate")) input.loan.nominalRate = num("rate", input.loan.nominalRate);
if (flags.has("tuition")) input.cost.tuitionPerYear = num("tuition", input.cost.tuitionPerYear);
if (flags.has("family")) input.familyContribution = num("family", input.familyContribution);

const started = performance.now();
const { result, outcomes } = simulateDetailed(input, config);
const levers = flags.has("no-levers") ? [] : evaluateLevers(input, result, config);
const elapsed = performance.now() - started;

const receipt = buildReceipt(input, config, result, levers, collectSources(input));

if (flags.has("json")) {
  console.log(JSON.stringify({ result, levers, receipt }, null, 2));
  process.exit(0);
}

const sources = collectSources(input);
const placeholders = sources.filter((s) => s.placeholder);

console.log("");
console.log(rule("="));
console.log("  DOWNSIDE  -  outcome distribution for a cross-border education loan");
console.log(rule("="));

if (placeholders.length > 0) {
  console.log("");
  console.log("  !! CALIBRATION WARNING");
  console.log(`  ${placeholders.length} of ${sources.length} inputs are placeholder priors, not ingested data.`);
  console.log("  These numbers exercise the model correctly. They are NOT a forecast and must");
  console.log("  not be shown to a student. Run the ingesters in ingest/ before that.");
}

console.log("");
console.log(`  Scenario     ${input.program.label}`);
console.log(`  Corridor     ${input.corridor.label}`);
console.log(
  `  Borrowing    ${input.loan.currency === "INR" ? inr(input.loan.sanctioned) : usd(input.loan.sanctioned)}` +
    ` at ${pct(input.loan.nominalRate)} over ${months(input.loan.tenureMonths)}` +
    `, ${input.loan.moratorium}`,
);
console.log(`  Family cash  ${inr(input.familyContribution)}`);
console.log(
  `  If you stay  ${inr(input.counterfactual.startingSalary)}/yr today, growing ${pct(input.counterfactual.realGrowth, 0)} real`,
);
console.log(`  Simulated    ${result.paths.toLocaleString("en-US")} lives over ${months(config.horizonMonths)}, seed "${config.seed}"`);

console.log("");
console.log(rule());
console.log("  THE BRANCH");
console.log(rule());
console.log(`  Receives any US offer                       ${pct(result.pDestJob).padStart(8)}`);
console.log(`  Clears sponsorship and the H-1B lottery     ${pct(result.pVisaSelected).padStart(8)}`);
console.log(`  Ends up back in India                       ${pct(result.pReturnHome).padStart(8)}`);
console.log("");
console.log(`  >> Repaying a dollar-priced degree on a rupee income   ${pct(result.pRepayFromHomeIncome).padStart(8)}`);
console.log(`     Still carrying the loan at age 35                   ${pct(result.pStillRepayingAt35).padStart(8)}`);
console.log(`     Never overtakes staying home, inside ${months(config.horizonMonths).padEnd(6)}         ${pct(result.pNeverBreakEven).padStart(8)}`);
console.log(`     Sanctioned loan fails to cover the bill               ${pct(result.pFxShortfall).padStart(8)}`);

console.log("");
console.log(rule());
console.log("  NET POSITION AT YEAR 7, versus never having gone (real rupees, today)");
console.log(rule());
console.log(
  histogram(
    outcomes.map((o) => (o.netWorthByYear[6] ?? NaN) - (o.counterfactualByYear[6] ?? NaN)),
    { bins: 14, width: 42, label: inr },
  ).join("\n"),
);
console.log("");
console.log(`  Worst decile   ${inr(result.tailCostYear7)}   <- the number that should drive the decision`);
console.log(`  Median         ${inr(result.netWorthYear7.p50)}`);
console.log(`  Best decile    ${inr(result.netWorthYear7.p90)}`);

console.log("");
console.log(rule());
console.log("  WHEN IT PAYS BACK");
console.log(rule());
console.log(
  `  Break-even vs staying home   p25 ${months(result.breakEvenMonth.p25)}` +
    `   median ${months(result.breakEvenMonth.p50)}   p90 ${months(result.breakEvenMonth.p90)}`,
);
console.log(`  Loan cleared in              median ${months(result.monthsToPayoff.p50)}   p90 ${months(result.monthsToPayoff.p90)}`);
console.log(
  `  Debt at first EMI / income   median ${result.debtToIncome.p50.toFixed(2)}x   p90 ${result.debtToIncome.p90.toFixed(2)}x`,
);
console.log(
  `  First-year US comp           p10 ${usd(result.firstYearWageDest.p10)}   median ${usd(result.firstYearWageDest.p50)}   p90 ${usd(result.firstYearWageDest.p90)}`,
);

if (levers.length > 0) {
  console.log("");
  console.log(rule());
  console.log("  LEVERS, ranked by how much of the left tail they remove");
  console.log(rule());
  for (const [i, l] of levers.entries()) {
    const dp = (-l.deltaPRepayFromHomeIncome * 100).toFixed(1);
    console.log("");
    console.log(`  ${i + 1}. ${l.label}`);
    console.log(`     ${l.change}`);
    console.log(
      `     tail risk ${dp.padStart(5)} pts   worst-decile ${(l.deltaTailYear7 >= 0 ? "+" : "") + inr(l.deltaTailYear7)}` +
        `   break-even ${l.deltaBreakEvenMedian >= 0 ? "+" : ""}${l.deltaBreakEvenMedian.toFixed(0)}mo`,
    );
    console.log(`     costs you: ${l.cost}`);
  }
}

console.log("");
console.log(rule());
console.log(renderReceipt(receipt));
console.log("");
console.log(`  (${(elapsed / 1000).toFixed(2)}s)`);
console.log("");
