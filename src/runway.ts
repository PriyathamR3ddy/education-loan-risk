/**
 * Downside, second stage: already here.
 *
 *   node src/runway.ts
 *   node src/runway.ts --rent 2600 --savings 6000
 *   node src/runway.ts --status opt --target 0.05
 *
 * Written to be read by the person carrying the loan, not by an analyst. No
 * percentiles, no distributions, no jargon: dollars a month and months of
 * cushion, which is how someone in this position actually thinks.
 */

import { referenceResident } from "./data/corridors/in-us-cs.ts";
import {
  DEFAULT_RESIDENT_HORIZON,
  simulateResident,
  type ResidentInput,
  type VisaStatus,
} from "./engine/resident.ts";
import {
  monthlySurplusToday,
  prepaymentFrontier,
  residentAdvice,
  solveSafeDiscretionary,
} from "./engine/solve.ts";
import { inr, months, pct, rule, usd } from "./format.ts";

const argv = process.argv.slice(2);
const flag = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (k: string, d: number): number => {
  const v = Number(flag(k));
  return Number.isFinite(v) ? v : d;
};

const input: ResidentInput = structuredClone(referenceResident);
input.spend.rent = num("rent", input.spend.rent);
input.spend.discretionary = num("discretionary", input.spend.discretionary);
input.savings = num("savings", input.savings);
input.salary = num("salary", input.salary);
input.loan.outstanding = num("outstanding", input.loan.outstanding);
input.prepaymentAggressiveness = num("prepay", input.prepaymentAggressiveness);
const status = flag("status");
if (status === "opt" || status === "stem-opt" || status === "h1b") {
  input.status = status as VisaStatus;
}
const target = num("target", 0.1);

const config = {
  paths: num("paths", 5000),
  horizonMonths: DEFAULT_RESIDENT_HORIZON,
  seed: flag("seed") ?? "downside-resident-v1",
};

const started = performance.now();
const base = simulateResident(input, config);
const cash = monthlySurplusToday(input);
const safe = solveSafeDiscretionary(input, config, target);
const advice = residentAdvice(input, config);
const frontier = prepaymentFrontier(input, config);
const elapsed = performance.now() - started;

const fx = input.corridor.macro.fxSpot;
const short = base.runwayMonths < base.visaClockMonths;

console.log("");
console.log(rule("="));
console.log("  ALREADY HERE  -  what you can spend, and where to give ground");
console.log(rule("="));
console.log("");
console.log("  !! Placeholder priors, not ingested data. Not a forecast.");

console.log("");
console.log(rule());
console.log("  YOUR MONTH, IN PLAIN TERMS");
console.log(rule());
console.log(`  You take home                 ${usd(cash.takeHome)}`);
console.log(`  You spend on living           ${usd(cash.spending)}`);
console.log(`  The loan takes                ${usd(cash.instalment)}`);
console.log(`  Left over                     ${usd(cash.surplus)}   (${inr(cash.surplus * fx)})`);
console.log("");
if (cash.surplus <= 0) {
  console.log("  You are spending more than you earn. Nothing below fixes that on its own.");
} else {
  console.log(`  So you are putting away about ${usd(cash.surplus)} a month, before anything goes wrong.`);
}

console.log("");
console.log(rule());
console.log("  IF YOU LOST YOUR JOB TOMORROW");
console.log(rule());
console.log(`  Your savings would last       ${base.runwayMonths.toFixed(1)} months`);
console.log(`  Your visa gives you           ${base.visaClockMonths.toFixed(1)} months to find another one`);
console.log("");
if (short) {
  console.log("  Your money runs out before your visa does. That is the wrong way round: you would");
  console.log("  be out of cash while you still had time left to job-hunt. Building the cushion is");
  console.log("  worth more to you right now than anything else on this page.");
} else {
  console.log("  You can cover the whole window your visa allows. Past that point extra savings buy");
  console.log("  you nothing, because the thing that runs out is permission to stay, not money.");
}

console.log("");
console.log(rule());
console.log("  OVER THE NEXT TEN YEARS");
console.log(rule());
console.log(`  You lose a job at some point                      ${pct(base.pLaidOff, 0).padStart(6)}`);
console.log(`  You end up back in India                          ${pct(base.pForcedReturn, 0).padStart(6)}`);
console.log(`  You go back still owing on the loan               ${pct(base.pForcedReturnWhileOwing, 0).padStart(6)}`);
console.log(`  You miss a payment at some point                  ${pct(base.pDistress, 0).padStart(6)}`);
console.log("");
console.log(`  Call it a ${pct(base.pBadOutcome, 0)} chance that something goes properly wrong.`);
console.log(`  The loan is fully paid off in about ${months(base.monthsToPayoff.p50)} if nothing does.`);

console.log("");
console.log(rule());
console.log("  WHAT YOU CAN SPEND ON YOURSELF");
console.log(rule());
if (safe.infeasible) {
  console.log(`  There is no amount that gets you under ${pct(target, 0)}. Even if you spent nothing at`);
  console.log(`  all beyond rent, food and travel, the chance of trouble would still be ${pct(safe.achievedRisk, 0)}.`);
  console.log("  The problem is not your coffee. It is your rent, your cushion, or the loan itself.");
} else {
  console.log(`  You currently spend        ${usd(safe.requestedDiscretionary)} a month on things you choose`);
  console.log(`  You could safely spend     ${usd(safe.safeDiscretionary)} a month`);
  const delta = safe.safeDiscretionary - safe.requestedDiscretionary;
  if (delta >= 0) {
    console.log(`  So you have room for       ${usd(delta)} more (${inr(delta * fx)}) without taking on real risk.`);
  } else {
    console.log(`  You are over by            ${usd(-delta)} a month (${inr(-delta * fx)}).`);
  }
}

console.log("");
console.log(rule());
console.log("  WHERE TO GIVE GROUND  -  biggest difference first");
console.log(rule());
for (const [i, a] of advice.entries()) {
  const drop = (a.riskBefore - a.riskAfter) * 100;
  const verdict =
    drop > 0.5
      ? `  (${drop.toFixed(1)} points better)`
      : drop < -0.5
        ? `  (${(-drop).toFixed(1)} points WORSE)`
        : "  (barely moves it)";
  console.log("");
  console.log(`  ${i + 1}. ${a.action}`);
  console.log(`     Chance of trouble ${pct(a.riskBefore, 0)} -> ${pct(a.riskAfter, 0)}${verdict}`);
  const pocket =
    a.monthlyGain >= 0
      ? `keeps ${usd(a.monthlyGain)} more a month in your pocket`
      : `costs you ${usd(-a.monthlyGain)} a month`;
  const cushion =
    a.runwayAfter > a.runwayBefore + 0.05
      ? `, cushion ${a.runwayBefore.toFixed(1)} -> ${a.runwayAfter.toFixed(1)} months`
      : "";
  console.log(`     It ${pocket}${cushion}.`);
  console.log(`     You give up: ${a.giveUp}`);
}

const best = advice[0];
const bestDrop = best === undefined ? 0 : (best.riskBefore - best.riskAfter) * 100;
// Where the freed-up money should go is not a matter of opinion here: the
// frontier below computes it. Asserting "save it, do not prepay" would
// contradict the table on the same page, which is exactly the kind of confident
// mismatch that makes a tool untrustworthy.
const safestSplit = [...frontier].sort((a, b) => a.pBadOutcome - b.pBadOutcome)[0]!;

if (best !== undefined) {
  console.log("");
  console.log("  " + rule("-", 74));
  if (bestDrop < 1) {
    console.log("  Honestly: none of these moves the needle much on its own. Your risk here is");
    console.log("  not really about spending — it is that a layoff would put you out of cash");
    console.log(`  before your visa runs out. Getting your cushion past ${base.visaClockMonths.toFixed(0)} months is the`);
    console.log("  thing that actually changes your position.");
  } else {
    console.log(`  If you only do one thing: ${best.action.toLowerCase()}.`);
  }
  const current = input.prepaymentAggressiveness;
  const dir =
    safestSplit.aggressiveness > current + 0.05
      ? `send more of it at the loan — ${pct(safestSplit.aggressiveness, 0)} of what is left over, up from ${pct(current, 0)}`
      : safestSplit.aggressiveness < current - 0.05
        ? `keep more of it in the bank — put ${pct(safestSplit.aggressiveness, 0)} at the loan instead of ${pct(current, 0)}`
        : `keep splitting it as you are, around ${pct(current, 0)} at the loan`;
  console.log(`  Whatever it frees up, ${dir}.`);
}

console.log("");
console.log(rule());
console.log("  PAY THE LOAN DOWN FAST, OR KEEP THE CASH?");
console.log(rule());
console.log("   to the loan | trouble | back home owing | paid off in | if it goes badly");
for (const p of frontier) {
  console.log(
    `      ${pct(p.aggressiveness, 0).padStart(8)}   ` +
      `${pct(p.pBadOutcome, 0).padStart(7)}   ` +
      `${pct(p.pForcedReturnWhileOwing, 0).padStart(13)}   ` +
      `${months(p.medianMonthsToPayoff).padStart(10)}   ` +
      `${inr(p.finalNetWorthP10).padStart(14)}`,
  );
}

const safest = [...frontier].sort((a, b) => a.pBadOutcome - b.pBadOutcome)[0]!;
const richest = [...frontier].sort((a, b) => b.finalNetWorthP10 - a.finalNetWorthP10)[0]!;
const maxStep = frontier[frontier.length - 1]!;
console.log("");
if (safest.aggressiveness < maxStep.aggressiveness) {
  console.log(`  Putting everything at the loan is not the safest thing to do. ${pct(safest.aggressiveness, 0)} is.`);
  console.log("  Past that you are paying down a balance with the cash that keeps you in the");
  console.log("  country, and the country is the thing that pays the loan.");
} else {
  console.log("  Here, clearing it fastest is also the safest thing to do — the debt is only");
  console.log("  dangerous while it exists.");
}
if (richest.aggressiveness < safest.aggressiveness) {
  console.log("");
  console.log("  One catch worth sitting with: in the futures where it goes badly anyway, the");
  console.log("  people who kept their cash end up better off. Clearing the loan removes the");
  console.log("  loan. It does not remove the chance you are sent home.");
}

console.log("");
console.log(`  (${(elapsed / 1000).toFixed(2)}s)`);
console.log("");
