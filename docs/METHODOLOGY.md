# Methodology

What the engine assumes, how it computes, and — the section that matters — where
it is known to be wrong.

## The object being computed

For a given student, program, cost profile and loan, the engine simulates N
independent lives over a 15-year horizon at monthly resolution, and reports the
distribution of outcomes rather than their mean.

Each life resolves a sequence of branches:

```
                          ┌─ secures destination employment (p)
                          │       ┌─ employer sponsors (s)
   enrol ─ study ─ graduate       │       ┌─ wins a lottery in ≤3 attempts
                          │       │       │
                          │       │       ├─ YES ─→ stays. dest income, home debt.
                          │       │       └─ NO  ─┐
                          │       └─ no sponsor  ─┤
                          └─ no offer ───────────┴─→ returns home.
                                                     home income, dest-sized debt.
```

The reference corridor puts the stay branch at roughly 25%. Everything the tool
says is downstream of that number, which is why calibrating it honestly matters
more than any refinement to the financial mathematics.

## Conventions

**Nominal, then deflated.** Every cash flow is computed in nominal units of its
own currency, converted at the path's nominal FX rate, and deflated to real
home-currency units of today only at the moment a figure is recorded. Mixing real
and nominal quantities is the classic way this class of model goes quietly wrong.

**The loan is carried in the loan's currency.** Not the home currency. A
destination-currency loan hedges the stay branch and worsens the return branch;
a home-currency loan does the reverse. Collapsing both into one currency at spot
would erase the single most interesting tradeoff in the problem.

**Family capital is charged, not free.** Money the family puts in is spent
capital that stops compounding, so the degree path starts at negative that
amount while the counterfactual starts at zero. Without this, adding family cash
would appear to create net worth.

**Common random numbers for levers.** Every counterfactual re-run shares the
baseline's seed, so the two runs see identical FX paths, wage draws and lottery
outcomes. The difference between them is the lever rather than Monte Carlo
noise. Without this a 20k-path run cannot resolve a two-point change in tail
probability and the ranking is meaningless.

## Stochastic components

| Component | Treatment |
|---|---|
| FX | Geometric Brownian motion on the nominal rate, annual drift and vol |
| First-year compensation | Inverse-CDF sample from an empirical percentile curve |
| Months to offer | Empirical curve, clamped to the authorized search window |
| Employment | Bernoulli on `pDestOffer` |
| Sponsorship | Bernoulli, independent of the lottery |
| Lottery | Up to three annual Bernoulli registrations while authorized |
| Assistantship | Bernoulli, fixed for the program |
| Home salary on return | Empirical curve times a foreign-degree premium |

Tails beyond the published percentile range are extended log-linearly using the
slope of the nearest observed segment. This keeps them positive and monotone
without inventing a fatter tail than the data supports.

## Known limitations

Listed because a buyer will find them anyway, and finding them undocumented is
worse than finding them disclosed.

1. **`pDestOffer` is a joint probability.** It means "secures employment inside
   the authorized search window", already pricing in graduates whose status
   lapses first. `monthsToOffer` is conditional on it and is *clamped* to the
   window rather than tested against it. Testing both independently double-counts
   the same failure and understates employment by roughly half — an earlier
   version of this engine did exactly that.

2. **Winning the lottery is treated as staying permanently.** No H-1B
   non-renewal, no layoff-triggered 60-day clock, no green-card queue. For Indian
   nationals specifically, the employment-based green card backlog is measured in
   decades and has real financial consequences this model ignores entirely. This
   flatters the stay branch.

3. **Wage draws are independent of employment timing.** In reality a graduate who
   searches for five months takes a worse offer than one who signs before
   graduating. Modelling them as independent understates the correlation between
   bad outcomes, and therefore understates the tail.

4. **No unemployment after the first job.** Once employed, the path stays
   employed. No recession, no layoff, no gap. Straightforwardly optimistic.

5. **FX is a GBM.** No jumps, no regime changes, no correlation with the
   destination labour market — although in reality a US downturn moves the
   employment probability and the rupee together, which would fatten the joint
   tail.

6. **Family capital earns zero real return** in the counterfactual. Modest and
   conservative in the degree path's favour.

7. **One program, one offer.** No modelling of the admissions portfolio, of
   transferring, or of dropping out. Non-completion is not a rare event in this
   population and its absence flatters every path.

8. **The counterfactual is a point input**, not a distribution. The stay-home
   salary is as uncertain as the go-abroad one, and treating it as certain
   understates variance on both sides of the comparison.

Items 2, 3, 4 and 7 all bias in the same direction: **the true left tail is
fatter than this model reports.** Nothing here should be read as a reason for
confidence.

## Validation

The test suite checks the branch logic against closed-form results rather than
snapshots. `pDestJob` must recover the `pDestOffer` it was given, and
`pVisaSelected` must match `p_offer × p_sponsor × (1 − (1 − p_lottery)³)` to
within Monte Carlo error. Amortization is checked against a hand-computed
payment and against full amortization of the balance over the tenure. Percentile
sampling is checked by drawing 40,000 samples and recovering the input curve's
own percentiles.

Monotonicity is asserted where the direction is unambiguous: raising the interest
rate must worsen the tail; raising employment odds must improve the median and
reduce repayment risk; borrowing nothing must drive repayment risk to exactly
zero.

## Reproducibility

The RNG is seeded mulberry32 over an FNV-1a hash of a human-readable seed string.
Reproducibility is a product feature, not a testing convenience: a Decision
Receipt states its seed, so anyone the student hands it to can re-run the exact
simulation years later and get the same numbers. That is the basis on which the
receipt is evidence rather than a screenshot.
