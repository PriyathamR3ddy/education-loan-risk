import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FIELDS, FIELD_KEYS } from "../src/data/programs.ts";
import { simulate } from "../src/engine/simulate.ts";
import { referenceStudent } from "../src/data/corridors/in-us-cs.ts";
import type { SimulationConfig } from "../src/engine/types.ts";

const cfg: SimulationConfig = { paths: 2000, horizonMonths: 180, seed: "fields" };

describe("field catalog", () => {
  it("is not empty and every entry is well formed", () => {
    assert.ok(FIELD_KEYS.length >= 5);
    for (const key of FIELD_KEYS) {
      const f = FIELDS[key]!;
      assert.ok(f.program.label.length > 0, `${key} needs a label`);
      assert.match(f.program.cip, /^\d\d\.\d{4}$/, `${key} needs a real CIP code`);
      assert.ok(f.program.soc.length > 0, `${key} needs at least one SOC code`);
      assert.ok(f.program.pDestOffer > 0 && f.program.pDestOffer < 1, `${key} offer rate`);
    }
  });

  it("has wage curves that ascend with percentile", () => {
    for (const key of FIELD_KEYS) {
      const pts = FIELDS[key]!.program.firstYearWage.points;
      for (let i = 1; i < pts.length; i++) {
        assert.ok(pts[i]!.p > pts[i - 1]!.p, `${key} percentiles must ascend`);
        assert.ok(pts[i]!.v > pts[i - 1]!.v, `${key} wages must ascend with percentile`);
      }
    }
  });

  it("keeps every field marked as an unsourced prior", () => {
    for (const key of FIELD_KEYS) {
      assert.equal(FIELDS[key]!.program.firstYearWage.source.placeholder, true);
    }
  });

  it("includes at least one non-STEM field, because that is the point", () => {
    assert.ok(
      FIELD_KEYS.some((k) => !FIELDS[k]!.stemEligible),
      "a catalog where everything is STEM hides the biggest difference field of study makes",
    );
  });
});

describe("field of study changes the outcome", () => {
  const run = (key: string) => {
    const f = FIELDS[key]!;
    const input = structuredClone(referenceStudent);
    input.program = structuredClone(f.program);
    input.corridor.immigration.stemEligible = f.stemEligible;
    return simulate(input, cfg);
  };

  it("gives a non-STEM graduate materially worse odds of staying", () => {
    // One lottery registration instead of three. Same person, same loan.
    const stem = run("cs");
    const nonStem = run("business");
    assert.ok(
      nonStem.pVisaSelected < stem.pVisaSelected * 0.7,
      `non-STEM ${nonStem.pVisaSelected} should be far below STEM ${stem.pVisaSelected}`,
    );
  });

  it("carries that through to the repayment risk", () => {
    assert.ok(run("business").pRepayFromHomeIncome > run("cs").pRepayFromHomeIncome);
  });

  it("separates fields by their employment odds", () => {
    assert.ok(run("cs").pDestJob > run("mech").pDestJob);
  });
});
