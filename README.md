# Downside

**An outcome distribution for a cross-border education loan. Not a calculator.**

Every tool a prospective international student can reach today answers the wrong
question. They compute an average: *this degree returns X%*. But a student does
not live an average. They live one draw from a distribution that is sharply
bimodal and gated by a lottery:

- **They stay.** Dollar income against a rupee loan. Comfortable, quick payoff.
- **They go home.** Rupee income at a fraction of that, against a debt sized in
  dollars. The tail that ends careers and mortgages family property.

Roughly three quarters of the paths in the reference scenario end in the second
branch. Averaging the two produces a number that describes neither, which is why
"unclear cost" is a misdiagnosis: the costs are published. The *shape* is not.

Downside simulates the branch explicitly and reports what a student actually
needs to decide: not the expected return, but the probability and size of the
outcome that would ruin them, and which single change removes the most of it.

---

## Quickstart

No install, no dependencies. Node 22.18+ runs the TypeScript directly.

```bash
node src/cli.ts
```

```bash
node src/cli.ts --paths 50000 --loan 7500000 --rate 0.135
```

```bash
node --test "test/*.test.ts"
```

Sample output, reference scenario (India → US MS CS, ₹62L borrowed at 11.25%):

```
  THE BRANCH
  Receives any US offer                          71.8%
  Clears sponsorship and the H-1B lottery        24.9%
  Ends up back in India                          75.1%

  >> Repaying a dollar-priced degree on a rupee income      44.5%
     Still carrying the loan at age 35                       6.9%
     Never overtakes staying home, inside 15y               26.0%
     Sanctioned loan fails to cover the bill                 64.5%

  Worst decile   -Rs 35.7 L   <- the number that should drive the decision
  Median         +Rs 79.4 L
```

That last block is the product. A student who has seen it is having a different
conversation with their family than one who has seen "average ROI: 4.2 years".

### The interactive version

`web/index.html` is the same engine with sliders and a chart, in a single file
with no build step and no dependencies. Open it directly, or serve the folder:

```bash
npx --yes serve web
```

The page ships its own transcription of the engine so it can run offline. Two
copies of a model invite drift, and a UI that quietly disagrees with the CLI is
worse than no UI, so `test/web-parity.test.ts` extracts the engine back out of
the HTML and requires it to match the TypeScript original **exactly** — same
seed, same draws, same bits.

---

## What is actually in here

| Path | What it does |
|---|---|
| `src/engine/path.ts` | One simulated life, month by month. The branch logic. |
| `src/engine/simulate.ts` | Monte Carlo runner and aggregation. |
| `src/engine/levers.ts` | Counterfactual sweep, ranked by tail risk removed. |
| `src/engine/dist.ts` | Empirical percentile sampling, summary statistics. |
| `src/receipt/receipt.ts` | The Decision Receipt: hashed, seeded, reproducible. |
| `src/data/corridors/` | Corridor and program inputs. **Currently all priors.** |
| `ingest/lca.ts` | Turns DOL visa filings into a real wage curve. |
| `web/index.html` | The interactive UI. One file, no build, no dependencies. |

### Three things it does that a calculator does not

**1. It carries the loan in the loan's own currency.** A ₹62L rupee loan and a
$70k dollar loan of identical size are different instruments. One hedges the
stay-abroad branch and wrecks the return-home branch; the other does the
reverse. The engine models both and the lever sweep shows the tradeoff has a
sign that depends on your odds of staying — which is why generic advice about it
is worthless.

**2. It models the sanctioned amount running out.** A facility sized in rupees at
signing has to pay dollar bills for two years. In the reference scenario the
sanctioned loan fails to cover the bill on 64% of paths, forcing a top-up at a
penalty rate. No student is told this in advance, and it is arguably the single
most actionable output here.

**3. Everything is compared against not going.** The counterfactual — the salary
you would have earned at home, the family capital that would have kept
compounding — runs in parallel on every path. "Break-even" means overtaking that,
not merely clearing the loan.

---

## Status: the model works, the data does not exist yet

**Every input in `src/data/corridors/` is a placeholder prior.** They are
order-of-magnitude plausible and they exercise the model correctly. Not one has
been ingested from a source. The CLI says so on every run, the Decision Receipt
marks itself `UNCALIBRATED`, and a test asserts it stays that way until the data
lands.

This is deliberate and it is the honest shape of the project right now. The
engine is the easy half. The defensible half is the calibration, and that is a
data-engineering job, not a modelling one. See `docs/DATA_SOURCES.md` for the
checklist and `docs/METHODOLOGY.md` for what the model assumes and where it is
known to be wrong.

Do not put these numbers in front of a real student.

---

## The Decision Receipt

Every run emits a hashed, seeded record of the assumptions committed to and what
they implied. Same seed and same inputs reproduce it exactly, forever; change one
assumption and the hash moves.

It does three jobs, and the third is the business:

1. **It is the artifact you hand your parents.** A co-signer arguing about vibes
   versus a co-signer holding a document is a different conversation.
2. **It carries provenance on every input**, so a claim sourced from a placement
   brochure cannot masquerade as one sourced from a federal filing.
3. **It is what gets reopened in 18 and 36 months** to ask what actually
   happened. That is the close-the-loop flow, and it is the only route to an
   outcome dataset that joins realized results back to the decisions that
   produced them. No consultant, ranking site or lender can credibly ask that
   question. See `docs/BUSINESS.md`.

---

## Roadmap

- [x] Monte Carlo engine, branch logic, lever sweep
- [x] Decision Receipt with reproducible hashing
- [x] LCA ingestion with the caveats documented
- [ ] Ingest one real FY of LCA data and replace the wage curve
- [ ] College Scorecard field-of-study join by CIP
- [ ] Institution cost-of-attendance scraper
- [x] Web front end for the distribution and the receipt
- [ ] Close-the-loop outcome collection
- [ ] Second corridor (India → Germany or Canada) to test generality
