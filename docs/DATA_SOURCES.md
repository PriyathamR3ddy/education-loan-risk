# Data sources

## The rule

No number enters the model without a `SourceRef`. Every input carries its
provenance, its vintage, and a `placeholder` flag. Anything flagged
`placeholder: true` is an assumption, renders with a warning wherever it
surfaces, and marks the Decision Receipt `UNCALIBRATED`.

**Nothing flagged `placeholder` may be shown to a real student.** A test asserts
the reference scenario stays uncalibrated until the ingestion work is done.

## Calibration checklist

| Input | Source | Status |
|---|---|---|
| First-year compensation | DOL OFLC LCA disclosure files | ingester written, not run |
| Employment rate by program | College Scorecard field-of-study, by CIP | not started |
| Lottery selection rate | USCIS H-1B registration statistics | not started |
| Employer sponsorship rate | LCA filings joined to employer headcount | not started |
| Cost of attendance | Institution-published CoA and I-20 figures | not started |
| FX spot, drift, vol | RBI reference rate, forward curve | not started |
| Loan terms | Published lender schedules of charges | not started |
| Home-return salary | Contributed alumni outcomes + survey data | needs the loop |

## Why these sources

The organizing principle: **prefer data produced by someone with no stake in the
student's decision.**

Placement brochures, ranking sites and consultant claims are all authored by
parties paid on the outcome. Government filings are not. An employer files an LCA
to sponsor a worker under penalty of perjury; nobody files one to impress an
applicant. That asymmetry is the entire reason this tool can claim to be less
biased than the alternatives, and it is worth more than any modelling
sophistication.

## The LCA caveats

Read `ingest/lca.ts` before quoting any figure it produces. In summary:

1. An LCA wage is the **offered wage**, a floor the employer commits to. Bonus,
   equity and most variable pay are excluded. It understates real earnings at
   companies that pay heavily in stock. Never label the output "salary".
2. The population is **workers being sponsored**, so it is conditional on having
   already cleared the employment and sponsorship branches. That makes it the
   right curve for the engine's stay branch and the wrong curve for any
   unconditional question.
3. **A filing is not a hire.** Certified LCAs include roles never filled and
   duplicate filings.
4. There is **no graduation year and no institution**, so program-level claims
   need an employer-and-title bridge that does not exist yet. Until it does,
   treat the output as an occupation-and-geography curve.

## The gap that only the loop closes

Two inputs cannot be sourced from any public dataset:

- what graduates **actually earn** on returning home, and
- what actually happened to people who made **this specific decision**.

No government collects it and no incumbent can credibly ask for it. That is what
the Decision Receipt's 18- and 36-month follow-up is for, and it is why the
outcome dataset compounds rather than commoditizes. See `BUSINESS.md`.

## Adding a source

1. Write an ingester in `ingest/` that emits a `PercentileCurve` with
   `placeholder: false` and a real `vintage`.
2. Add tests over a fixture that assert the filter rules and that the recovered
   percentiles match a known spread.
3. Replace the prior in `src/data/corridors/`.
4. Document the caveats in the ingester's header, at the top, before the code.
   If a caveat would change how a student reads the number, it goes in the
   `SourceRef.label` too, so it travels onto the receipt.
